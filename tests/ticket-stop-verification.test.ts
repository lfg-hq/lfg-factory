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
test('shared and unknown workspaces are never inspected as dedicated VMs',async()=>{
 let calls=0;
 for(const row of [{ws:'pv-shared',type:'ticket-worktree'},{ws:null,type:'ticket'}])await expect(confirmTicketStopped([row],async()=>{calls++;return {exitCode:0,output:'TICKET_PROCESSES_STOPPED'};})).rejects.toThrow('scoped');
 expect(calls).toBe(0);
});
test('inspection script is valid Python',()=>{
 const script=ticketStopVerificationScript().split("\n").slice(1,-1).join('\n');
 const result=Bun.spawnSync(['python3','-c','import ast,sys;ast.parse(sys.stdin.read())'],{stdin:Buffer.from(script)});
 expect(result.exitCode).toBe(0);
});
