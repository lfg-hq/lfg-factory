import {test,expect,mock,beforeEach} from 'bun:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
// Real git in a temp directory stands in for the sandbox, so the "is this work on
// GitHub?" script is exercised for real. The database is a small in-memory fake.
let rows:any[], ticket:any, calls:string[], deleted:string[], journalFile:string|null;
const db={
 select:(fields?:any)=>({from:(table:any)=>({where:()=>Promise.resolve(table.name==='tickets'?[ticket]:rows)})}),
 update:(table:any)=>({set:(v:any)=>({where:async()=>{if(table.name==='tickets')Object.assign(ticket,v);else rows.forEach(r=>Object.assign(r,v));}})}),
 delete:()=>({where:async()=>{calls.push('row-deleted');}}),
 insert:()=>({values:()=>({onConflictDoNothing:()=>({returning:async()=>[{id:'lock'}]})})}),
};
mock.module('../src/config/db.ts',()=>({db}));
mock.module('../src/db/schema/tickets.ts',()=>({projectTickets:{name:'tickets'}}));
mock.module('../src/db/schema/sandbox.ts',()=>({sandboxes:{name:'sandbox'}}));
mock.module('drizzle-orm',()=>({and:()=>0,desc:()=>0,eq:()=>0,inArray:()=>0,lt:()=>0}));
mock.module('../src/services/ticket-code.ts',()=>({shellQuote:(s:string)=>`'${s.replace(/'/g,`'\\''`)}'`}));
mock.module('../src/services/mags.ts',()=>({
 execOnWorkspace:async(_w:string,command:string)=>{
   if(command.includes('.lfg-journal-')) return {exitCode:0,output:journalFile ?? ''};
   const r=spawnSync('bash',['-c',command.replaceAll('/data/project',repo)],{encoding:'utf8'});return {exitCode:r.status ?? 1,output:(r.stdout||'')+(r.stderr||'')};
 },
 setNoSleep:async(_w:string,pin:boolean)=>{calls.push('pin:'+pin);},deleteWorkspace:async(w:string)=>{deleted.push(w);},findJob:async()=>null,newWorkspaceV2:async()=>{throw new Error('unexpected');},
}));
mock.module('../src/services/ticket-chat-turn.ts',()=>({isChatTurnActive:()=>false}));
mock.module('../src/services/ticket-workspace-checkpoint.ts',()=>({checkpointTicketWorkspace:async()=>{calls.push('checkpoint');},discardTicketCheckpoint:async()=>{calls.push('discard');},readTicketCheckpoint:async()=>null,restoreTicketCheckpoint:async()=>false}));
mock.module('../src/services/ticket-sandbox-clone.ts',()=>({createTicketSandbox:async()=>{throw new Error('unexpected');}}));
mock.module('../src/services/repo-auth.ts',()=>({resolveRepoAuth:async()=>null}));
mock.module('../src/services/git-access.ts',()=>({resolveGitActor:()=>({gitUserId:'u'})}));
process.env.TICKET_SANDBOX_GRACE_MIN='0';
const m=await import('../src/services/ticket-sandbox-retire.ts');
let repo='';
const git=(...a:string[])=>spawnSync('git',['-C',repo,...a],{encoding:'utf8'}).stdout.trim();
beforeEach(()=>{
  const origin=mkdtempSync(join(tmpdir(),'lfg-origin-'));spawnSync('git',['init','--bare','-q',origin]);
  repo=mkdtempSync(join(tmpdir(),'lfg-work-'));spawnSync('git',['init','-q','-b','feature/x',repo]);
  git('config','user.email','t@t');git('config','user.name','t');
  writeFileSync(join(repo,'a.txt'),'1');git('add','.');git('commit','-qm','one');git('remote','add','origin',origin);git('push','-q','origin','feature/x');
  rows=[{id:'s1',ticketId:'t1',magsWorkspaceId:'clone-1',workspaceType:'ticket',status:'busy',currentBranch:'feature/x',updatedAt:new Date(0)}];
  ticket={id:'t1',branch:'feature/x',sha:null,q:'none',details:{}};calls=[];deleted=[];journalFile=null;
});
test('pushed work: no checkpoint, row idle, VM allowed to sleep, then swept',async()=>{
  await m.retireTicketSandbox('t1','clone-1','Build');
  expect(rows[0].status).toBe('idle');expect(calls).toContain('discard');expect(calls).not.toContain('checkpoint');expect(calls).toContain('pin:false');
  rows[0].updatedAt=new Date(0);
  expect(await m.sweepIdleTicketSandboxes()).toBe(1);expect(deleted).toEqual(['clone-1']);
});
test('uncommitted edits are checkpointed before the VM can be deleted',async()=>{
  writeFileSync(join(repo,'a.txt'),'2');
  await m.retireTicketSandbox('t1','clone-1');
  expect(calls).toContain('checkpoint');expect(rows[0].status).toBe('idle');
});
test('an unpushed commit counts as local work',async()=>{
  writeFileSync(join(repo,'b.txt'),'x');git('add','.');git('commit','-qm','two');
  await m.retireTicketSandbox('t1','clone-1');
  expect(calls).toContain('checkpoint');
});
test('a VM whose state cannot be read is held, never deleted',async()=>{
  rows[0].currentBranch='other';ticket.branch='other';
  await m.retireTicketSandbox('t1','clone-1');
  expect(rows[0].status).toBe('held');rows[0].updatedAt=new Date(0);
  expect(await m.sweepIdleTicketSandboxes()).toBe(0);expect(deleted).toEqual([]);
});
test('sandboxes parked before this change are not swept unless enabled',async()=>{
  rows[0].status='sleeping';rows[0].updatedAt=new Date('2026-09-01');
  expect(await m.sweepIdleTicketSandboxes()).toBe(0);expect(deleted).toEqual([]);
});
test('a recent busy sandbox is left alone by the sweeper',async()=>{
  rows[0].updatedAt=new Date(Date.now()-60_000);
  expect(await m.sweepIdleTicketSandboxes()).toBe(0);
});
test('the journal the agent wrote is saved to the ticket and injected next turn',async()=>{
  journalFile='**Changed**: login form\n**Open**: none';
  await m.retireTicketSandbox('t1','pv-preview','Follow-up');
  expect(ticket.details.workJournal).toHaveLength(1);
  const block=m.workJournalBlock(ticket.details);
  expect(block).toContain('Follow-up');expect(block).toContain('login form');
  expect(m.ticketJournalInstruction('t1')).toContain(m.ticketJournalPath('t1'));
});
