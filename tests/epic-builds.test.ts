import {test,expect,mock,beforeEach} from 'bun:test';
import {projects} from '../src/db/schema/projects.ts';
import {projectTickets,ticketStages} from '../src/db/schema/tickets.ts';
let enabled=true,role='owner',foreign=false,docs:any[]=[],rows:any[]=[],active:any=null;
let writes:any[]=[],runs:any[]=[],resumes=0,counter=0;
const project={id:'p',projectId:'public',name:'Demo'};
mock.module('../src/config/db.ts',()=>({db:{
 select:()=>({from:(table:any)=>{
   const result=()=>table===projects?[{...project,epicBuildsEnabled:enabled}]:table===ticketStages?[{id:'backlog',name:'Backlog'}]:rows;
   const q:any={where:()=>q,orderBy:()=>q,limit:()=>q,then:(yes:any,no:any)=>Promise.resolve(result()).then(yes,no)};return q;
 }}),
 insert:(table:any)=>({values:(values:any)=>({onConflictDoNothing:async()=>{writes.push(values);rows=values.map((v:any)=>({...v,status:'open'}));}})}),
}}));
mock.module('../src/auth/project-access.ts',()=>({getProjectAccess:async()=>role==='none'?null:{role,project,permissions:{canManageTickets:role!=="viewer",canChat:role!=="viewer"}}}));
mock.module('../src/services/epics.ts',()=>({getEpic:async()=>({id:'e',projectId:foreign?'other':'p',name:'Feature',status:'draft'}),listEpicDocs:async()=>docs}));
mock.module('../src/services/build-queue.ts',()=>({
 getActiveRun:async()=>active,
 cancelBlockedRun:async(p:string,id:string)=>{if(active?.runId!==id||active.status!=="blocked")return false;active=null;return true;},
 resumeBlockedRun:async()=>{resumes++;return true;},
 createBuildRun:async(opts:any)=>{runs.push(opts);active={runId:'run',epicId:'e',status:'running'};return {runId:'run',queued:opts.ticketIds.length};},
}));
mock.module('../src/utils/ticket-keys.ts',()=>({nextTicketKey:async()=>`T-${++counter}`}));
const {buildEpicTool,EPIC_BUILD_PROMPT}=await import('../src/ai/tools/epic-build-tools.ts');
const run=(args:any={})=>(buildEpicTool({projectId:'p',userId:'u',conversationId:'chat'}).execute as any)({epicId:'e',approvedByUser:true,...args},{toolCallId:'call',messages:[]});
const steps=[{name:'Core',description:'Implement the approved feature core.',acceptanceCriteria:['Works','Tested'],sourceDocumentId:'prd',priority:'Medium',complexity:'medium'},{name:'UI',description:'Implement and verify the feature interface.',acceptanceCriteria:['Accessible','Responsive'],sourceDocumentId:'prd',priority:'Medium',complexity:'medium'}];
beforeEach(()=>{enabled=true;role='owner';foreign=false;docs=[{id:'prd',fileType:'prd'},{id:'tech',fileType:'tech_analysis'}];rows=[];writes=[];runs=[];active=null;resumes=0;counter=0;});
test('off by default path cannot build and does not create hidden work',async()=>{enabled=false;expect((await run({steps})).error).toContain('disabled');expect(writes).toHaveLength(0);});
test('approval, access, project and document boundaries prevent execution',async()=>{
 expect((await run({approvedByUser:false,steps})).error).toContain('approval');
 role='viewer';expect((await run({steps})).error).toContain('permission');role='owner';
 foreign=true;expect((await run({steps})).error).toContain('not found');foreign=false;
 docs=[];expect((await run({steps})).error).toContain('PRD');docs=[{id:'prd',fileType:'prd'}];
 expect((await run({steps:[{...steps[0],sourceDocumentId:'foreign'}]})).error).toContain('belonging');
 expect(writes).toHaveLength(0);expect(runs).toHaveLength(0);
});
test('approved feature creates one atomic ordered plan and starts one epic run',async()=>{
 const result=await run({steps});expect(result.status).toBe('building');expect(result).not.toHaveProperty('tickets');
 expect(writes).toHaveLength(1);expect(writes[0].map((v:any)=>v.executionOrder)).toEqual([0]);
 expect(writes[0][0].description).toContain('Implement and verify the feature interface.');expect(writes[0][0].acceptanceCriteria).toEqual(['Works','Tested','Accessible','Responsive']);expect(runs[0].ticketIds).toHaveLength(1);
 expect(writes[0].every((v:any)=>v.epicId==='e'&&v.conversationId==='chat')).toBe(true);
 expect(runs[0]).toMatchObject({projectId:'p',epicId:'e',epicBuild:true,afterBuild:'preview',conversationId:'chat'});
 await run({steps});expect(writes).toHaveLength(1);expect(runs).toHaveLength(1);
});
test('concurrent requests coalesce instead of duplicating plans',async()=>{await Promise.all([run({steps}),run({steps})]);expect(writes).toHaveLength(1);expect(runs).toHaveLength(1);});
test('blocked feature resumes without regenerating work',async()=>{active={runId:'r',epicId:'e',status:'blocked'};expect((await run()).status).toBe('resuming');expect(resumes).toBe(1);expect(writes).toHaveLength(0);});
test('another active epic is not resumed or mixed into this feature',async()=>{active={runId:'r',epicId:'different',status:'blocked'};expect((await run()).error).toContain('Another');expect(resumes).toBe(0);});
test('existing work is reused and completed work is not rebuilt',async()=>{rows=[{id:'done',status:'done'},{id:'left',status:'open'}];await run();expect(writes).toHaveLength(0);expect(runs[0].ticketIds).toEqual(['left']);});
test('prompt makes documents and build approval separate',()=>{expect(EPIC_BUILD_PROMPT).toContain('not authorization to build');expect(EPIC_BUILD_PROMPT).toContain('single build ticket');});

test('a standalone build already executing is not queued twice',async()=>{rows=[{id:'running',status:'in_progress',queueStatus:'executing'}];expect((await run()).status).toBe('building');expect(runs).toHaveLength(0);});
test('simultaneous requests for different features never share a build result',async()=>{const results=await Promise.all([run({steps}),run({epicId:'other',steps})]);expect(results[1].error).toContain('Another');expect(runs).toHaveLength(1);});

test('blocked replacement requires exact authorization and reports no queue',async()=>{
 active={runId:'old',epicId:'other',status:'blocked'};
 const refused=await run({steps});expect(refused.queued).toBe(false);expect(refused.blockingRun.status).toBe('blocked');expect(writes).toHaveLength(0);
 expect((await run({steps,replaceBlockedRunId:'wrong'})).status).toBe('not_started');
 expect((await run({steps,replaceBlockedRunId:'old'})).status).toBe('building');expect(runs).toHaveLength(1);
});
test('replacement never cancels running work or invalidates old run for an invalid plan',async()=>{
 active={runId:'old',epicId:'other',status:'running'};
 expect((await run({steps,replaceBlockedRunId:'old'})).status).toBe('not_started');expect(active.status).toBe('running');
 active.status='blocked';docs=[];
 expect((await run({steps,replaceBlockedRunId:'old'})).error).toContain('PRD');expect(active.runId).toBe('old');expect(runs).toHaveLength(0);
});

test('new feature requires a technical plan before creating work',async()=>{
 docs=[{id:'prd',fileType:'prd'}];expect((await run({steps})).error).toContain('technical analysis');expect(writes).toHaveLength(0);
});
test('retry after dispatcher restart reuses the complete ticket and its approved scope',async()=>{
 await run({steps});const saved=rows[0];active=null;rows[0].status='failed';
 await run({steps:[{...steps[0],description:'Changed requirements must not overwrite saved approved work.'}]});
 expect(writes).toHaveLength(1);expect(runs[1].ticketIds).toEqual([saved.id]);expect(rows[0].description).toContain(steps[1].description);
});
test('a verified feature is ready for review without rebuilding or approval',async()=>{
 await run({steps});active=null;rows[0].status='review';expect((await run()).status).toBe('ready_for_review');expect(runs).toHaveLength(1);expect(rows[0].status).toBe('review');
});
