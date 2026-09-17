import {test,expect} from 'bun:test';
import '../public/js/ticket-action-phases.js';
const group=(globalThis as any).TicketActionPhases.group;
const rows=(...messages:string[])=>messages.map(message=>({message,type:'command'}));
test('build and validation have independent results',()=>{
 const p=group(rows('Starting Pi build (model)...','Editing source','**Running the saved ticket:** checking database','Execution failed: SQL refused connection'),{status:'failed'});
 expect(p.map((p:any)=>p.status)).toEqual(['done','error']);expect(p[0].rows.length).toBe(2);
});
test('successful retry clears old validation error without losing history',()=>{
 const p=group(rows('Starting Pi build','Running the saved ticket:','Execution failed: SQL','Retrying validation of saved commit abc','Checking: isolation','✅ **Validation passed** for saved commit abc'),{status:'open',queueStatus:'none'});
 expect(p.map((p:any)=>p.status)).toEqual(['done','done']);expect(p[1].rows.length).toBe(5);
});
test('validation-only history shows skipped development',()=>{
 expect(group(rows('Retrying validation of saved commit abc','Running the saved ticket:'),{queueStatus:'executing'}) .map((p:any)=>p.status)).toEqual(['skipped','working']);
});
test('new build resets previous validation status',()=>{
 expect(group(rows('Running the saved ticket:','✅ Validation passed','Starting Pi build'),{queueStatus:'executing'}).map((p:any)=>p.status)).toEqual(['working','pending']);
});
test('idle incomplete history is not labelled working or passed',()=>{
 expect(group(rows('Reading source'),{status:'open',queueStatus:'none'})[0].status).toBe('unknown');
 expect(group([],{status:'open'}).map((p:any)=>p.status)).toEqual(['pending','pending']);
});
