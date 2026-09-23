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
 insert:(table:any)=>({values:async(values:any)=>{writes.push(values);rows=values.map((v:any)=>({...v,status:'open'}));}}),
}}));
mock.module('../src/auth/project-access.ts',()=>({getProjectAccess:async()=>role==='none'?null:{role,project,permissions:{canManageTickets:role!=="viewer",canChat:role!=="viewer"}}}));
mock.module('../src/services/epics.ts',()=>({getEpic:async()=>({id:'e',projectId:foreign?'other':'p',name:'Feature',status:'draft'}),listEpicDocs:async()=>docs}));
mock.module('../src/services/build-queue.ts',()=>({
 getActiveRun:async()=>active,
 resumeBlockedRun:async()=>{resumes++;return true;},
 createBuildRun:async(opts:any)=>{runs.push(opts);active={runId:'run',epicId:'e',status:'running'};return {runId:'run',queued:opts.ticketIds.length};},
}));
mock.module('../src/utils/ticket-keys.ts',()=>({nextTicketKey:async()=>`T-${++counter}`}));
const {buildEpicTool,EPIC_BUILD_PROMPT}=await import('../src/ai/tools/epic-build-tools.ts');
const run=(args:any={})=>(buildEpicTool({projectId:'p',userId:'u',conversationId:'chat'}).execute as any)({epicId:'e',approvedByUser:true,...args},{toolCallId:'call',messages:[]});
const steps=[{name:'Core',description:'Implement the approved feature core.',acceptanceCriteria:['Works','Tested'],sourceDocumentId:'prd',priority:'Medium',complexity:'medium'},{name:'UI',description:'Implement and verify the feature interface.',acceptanceCriteria:['Accessible','Responsive'],sourceDocumentId:'prd',priority:'Medium',complexity:'medium'}];
beforeEach(()=>{enabled=true;role='owner';foreign=false;docs=[{id:'prd',fileType:'prd'}];rows=[];writes=[];runs=[];active=null;resumes=0;counter=0;});
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
 expect(writes).toHaveLength(1);expect(writes[0].map((v:any)=>v.executionOrder)).toEqual([0,1]);
 expect(writes[0].every((v:any)=>v.epicId==='e'&&v.conversationId==='chat')).toBe(true);
 expect(runs[0]).toMatchObject({projectId:'p',epicId:'e',epicBuild:true,afterBuild:'preview',conversationId:'chat'});
 await run({steps});expect(writes).toHaveLength(1);expect(runs).toHaveLength(1);
});
test('concurrent requests coalesce instead of duplicating plans',async()=>{await Promise.all([run({steps}),run({steps})]);expect(writes).toHaveLength(1);expect(runs).toHaveLength(1);});
test('blocked feature resumes without regenerating work',async()=>{active={runId:'r',epicId:'e',status:'blocked'};expect((await run()).status).toBe('resuming');expect(resumes).toBe(1);expect(writes).toHaveLength(0);});
test('another active epic is not resumed or mixed into this feature',async()=>{active={runId:'r',epicId:'different',status:'blocked'};expect((await run()).error).toContain('Another');expect(resumes).toBe(0);});
test('existing work is reused and completed work is not rebuilt',async()=>{rows=[{id:'done',status:'done'},{id:'left',status:'open'}];await run();expect(writes).toHaveLength(0);expect(runs[0].ticketIds).toEqual(['left']);});
test('prompt makes documents and build approval separate',()=>{expect(EPIC_BUILD_PROMPT).toContain('not authorization to build');expect(EPIC_BUILD_PROMPT).toContain('Do not list implementation tickets');});

test('a standalone build already executing is not queued twice',async()=>{rows=[{id:'running',status:'in_progress',queueStatus:'executing'}];expect((await run()).status).toBe('building');expect(runs).toHaveLength(0);});
test('simultaneous requests for different features never share a build result',async()=>{const results=await Promise.all([run({steps}),run({epicId:'other',steps})]);expect(results[1].error).toContain('Another');expect(runs).toHaveLength(1);});
