import {test,expect} from 'bun:test';
import {confirmTicketStopped,ticketStopVerificationScript} from '../src/services/ticket-stop-verification.ts';
const rows=[{ws:'ticket-vm',type:'ticket'},{ws:'chat-vm',type:'ticket-chat'}];
test('every dedicated sandbox must confirm stopped',async()=>{
 const checked:string[]=[];
 await confirmTicketStopped(rows,async ws=>{checked.push(ws);return {exitCode:0,output:'TICKET_PROCESSES_STOPPED\n'};});
 expect(checked).toEqual(['ticket-vm','chat-vm']);
});
test('live processes, failed inspections and network errors cannot unlock ticket',async()=>{
 for(const result of [{exitCode:1,output:'processes remain'},{exitCode:0,output:''}]) await expect(confirmTicketStopped(rows,async()=>result)).rejects.toThrow('not confirmed');
 await expect(confirmTicketStopped(rows,async()=>{throw new Error('unreachable');})).rejects.toThrow('unreachable');
});
test('shared and worktree sandboxes use scoped inspection while dedicated ones stay dedicated',async()=>{
 const scopes:boolean[]=[];
 await confirmTicketStopped([{ws:'pv-shared',type:'ticket-worktree'},{ws:'legacy',type:'ticket-worktree'},{ws:'dedicated',type:'ticket'}],async(_,shared)=>{scopes.push(shared);return {exitCode:0,output:'TICKET_PROCESSES_STOPPED'};});
 expect(scopes).toEqual([true,true,false]);
});
test('missing workspace IDs and unknown types report the actual record problem',async()=>{
 await expect(confirmTicketStopped([{ws:null,type:'ticket'}],async()=>({exitCode:0}))).rejects.toThrow('no workspace ID');
 await expect(confirmTicketStopped([{ws:'vm',type:'unknown'}],async()=>({exitCode:0}))).rejects.toThrow('unsupported sandbox type unknown');
});
test('inspection script is valid Python',()=>{
 const script=ticketStopVerificationScript().split("\n").slice(1,-1).join('\n');
 const result=Bun.spawnSync(['python3','-c','import ast,sys;ast.parse(sys.stdin.read())'],{stdin:Buffer.from(script)});
 expect(result.exitCode).toBe(0);
});

test('scoped inspection ignores other ticket agents and catches this ticket process',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'stop-proc-'));
 try {
  const proc=(pid:string,cwd:string,command:string)=>{const dir=join(root,pid);mkdirSync(dir);writeFileSync(join(dir,'stat'),pid+' (process) S 1 1');writeFileSync(join(dir,'cmdline'),command);symlinkSync(cwd,join(dir,'cwd'));};
  proc('81001','/data/wt-ticket-other','pi-coding-agent');
  const script=ticketStopVerificationScript('/data/wt-ticket-target').split('\n').slice(1,-1).join('\n').replaceAll("'/proc'",JSON.stringify(root)).replaceAll("'/proc/%s/stat'",JSON.stringify(root+'/%s/stat'));
  const run=()=>Bun.spawnSync(['python3','-c',script]);
  expect(run().exitCode).toBe(0);
  proc('81002','/data/wt-ticket-target/subdir','dotnet build');
  const blocked=run();expect(blocked.exitCode).not.toBe(0);expect(blocked.stderr.toString()).toContain('81002');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('clone request without a workspace does not block stopping the real ticket sandbox',async()=>{
 const checked:string[]=[];
 await confirmTicketStopped([{ws:null,type:'ticket-clone'},{ws:'real-ticket',type:'ticket'}],async ws=>{checked.push(ws);return {exitCode:0,output:'TICKET_PROCESSES_STOPPED'};});
 expect(checked).toEqual(['real-ticket']);
});
test('clone with an allocated workspace must also be confirmed stopped',async()=>{
 const checked:string[]=[];
 await expect(confirmTicketStopped([{ws:null,type:'ticket-clone'},{ws:'allocated-clone',type:'ticket-clone'}],async ws=>{checked.push(ws);return {exitCode:1,output:'process remains'};})).rejects.toThrow('process remains');
 expect(checked).toEqual(['allocated-clone']);
});
