import {test,expect,mock,beforeEach} from 'bun:test';
let existing:any, job:any, probes:any[], calls:string[], locked=false, created=0, checkpoint:any=null, failFind=false;
const db={
 select:()=>({from:(table:any)=>({where:()=>{
   const rows=table.name==='tickets'?[{queueStatus:'none'}]:existing?[existing]:[];
   return {then:(resolve:any)=>Promise.resolve(rows).then(resolve),orderBy:()=>({limit:async()=>rows})};
 }})}),
 insert:()=>({values:(v:any)=>({onConflictDoNothing:()=>({returning:async()=>{if(locked)return [];locked=true;return [{id:v.id}];}}),then:(resolve:any)=>Promise.resolve().then(resolve)})}),
 update:()=>({set:()=>({where:async()=>{}})}),delete:()=>({where:async()=>{locked=false;}}),
};
mock.module('../src/config/db.ts',()=>({db}));
mock.module('../src/db/schema/tickets.ts',()=>({projectTickets:{name:'tickets'}}));
mock.module('../src/db/schema/sandbox.ts',()=>({sandboxes:{name:'sandbox'}}));
mock.module('drizzle-orm',()=>({and:()=>0,desc:()=>0,eq:()=>0,inArray:()=>0}));
mock.module('../src/services/ticket-code.ts',()=>({shellQuote:(s:string)=>JSON.stringify(s)}));
mock.module('../src/services/mags.ts',()=>({
 execOnWorkspace:async(_w:string,command:string)=>{calls.push(command);const r=probes.shift() ?? {exitCode:0,output:'feature/ticket'};if(r instanceof Error)throw r;return r;},
 findJob:async()=>{if(failFind)throw new Error('provider network unavailable');return job;},
 setNoSleep:async(_w:string,pin:boolean)=>{calls.push('pin:'+pin);},newWorkspaceV2:async()=>{throw new Error('unexpected fresh VM');},
}));
mock.module('../src/services/ticket-sandbox-clone.ts',()=>({createTicketSandbox:async()=>{created++;return {workspaceId:'replacement',jobId:'new-job',cloneIntentId:'intent'};}}));
mock.module('../src/services/repo-auth.ts',()=>({resolveRepoAuth:async()=>({authUrl:'https://repo',token:'secret'})}));
mock.module('../src/services/git-access.ts',()=>({resolveGitActor:()=>({gitUserId:'owner'})}));
mock.module('../src/services/ticket-chat-turn.ts',()=>({isChatTurnActive:()=>false}));
mock.module('../src/services/ticket-workspace-checkpoint.ts',()=>({readTicketCheckpoint:async()=>checkpoint,checkpointTicketWorkspace:async()=>{calls.push('checkpoint');},restoreTicketCheckpoint:async()=>{calls.push('restore');return true;}}));
const {openTicketWorkspace}=await import('../src/services/ticket-workspace.ts');
const options:any={project:{id:'p',ownerId:'owner'},ticket:{id:'t',githubBranch:'feature/ticket'},actorId:'owner',canRestore:true};
beforeEach(()=>{existing={magsWorkspaceId:'old',workspaceType:'ticket',ticketId:'t'};job=null;probes=[];calls=[];locked=false;created=0;checkpoint=null;failFind=false;});
test('live checkout is reused without resetting edits or creating a VM',async()=>{expect((await openTicketWorkspace(options)).workspaceId).toBe('old');expect(created).toBe(0);expect(calls).toHaveLength(1);});
test('sleeping checkout wakes in place',async()=>{probes=[new Error('asleep'),{exitCode:0,output:'feature/ticket'}];job={jobId:'job',status:'sleeping'};expect((await openTicketWorkspace(options)).workspaceId).toBe('old');expect(calls).toContain('pin:true');expect(created).toBe(0);});
test('expired checkout is replaced from durable checkpoint',async()=>{probes=[new Error('404')];job={status:'completed'};checkpoint={branch:'feature/ticket'};expect((await openTicketWorkspace(options)).workspaceId).toBe('replacement');expect(created).toBe(1);expect(calls).toContain('restore');expect(calls).not.toContain('checkpoint');});
test('legacy ticket restores recorded commit rather than default branch',async()=>{probes=[new Error('404')];job={status:'completed'};const sha='a'.repeat(40);await openTicketWorkspace({...options,ticket:{...options.ticket,githubCommitSha:sha}});expect(calls.find(c=>c.includes('git clone'))).toContain(sha);expect(calls).not.toContain('restore');});
test('uncertain provider failure never creates another VM',async()=>{probes=[new Error('network')];failFind=true;await expect(openTicketWorkspace(options)).rejects.toThrow('network');expect(created).toBe(0);expect(locked).toBe(false);});
test('viewer cannot provision an expired workspace',async()=>{probes=[new Error('404')];job={status:'completed'};await expect(openTicketWorkspace({...options,canRestore:false})).rejects.toThrow('editor');expect(created).toBe(0);});
test('concurrent opener cannot allocate a duplicate',async()=>{locked=true;await expect(openTicketWorkspace(options)).rejects.toThrow('busy');expect(created).toBe(0);});
test('mismatched saved branch is never restored',async()=>{probes=[new Error('404')];job={status:'completed'};checkpoint={branch:'other'};await expect(openTicketWorkspace(options)).rejects.toThrow('branch');expect(created).toBe(0);});

test('missing listing plus a network failure is not proof of expiry',async()=>{probes=[new Error('network')];job=null;await expect(openTicketWorkspace(options)).rejects.toThrow('uncertain');expect(created).toBe(0);});
test('a live wrong branch is preserved',async()=>{probes=[{exitCode:0,output:'other'}];await expect(openTicketWorkspace(options)).rejects.toThrow('another branch');expect(created).toBe(0);});

test('restore starts from the remote branch head, the recorded commit only as fallback',async()=>{probes=[new Error('404')];job={status:'completed'};const sha='b'.repeat(40);await openTicketWorkspace({...options,ticket:{...options.ticket,githubCommitSha:sha}});const clone=calls.find(c=>c.includes('git clone'))!;expect(clone.indexOf('refs/remotes/origin/feature/ticket')).toBeLessThan(clone.indexOf(sha));});
test('an awake sandbox that never answers is set aside and a fresh one restores the work',async()=>{probes=[new Error('timeout'),new Error('timeout'),new Error('timeout'),new Error('timeout')];job={jobId:'job',status:'running'};expect((await openTicketWorkspace(options)).workspaceId).toBe('replacement');expect(created).toBe(1);},20000);
