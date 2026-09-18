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
test('validation-only history identifies reused saved code',()=>{
 expect(group(rows('Retrying validation of saved commit abc','Running the saved ticket:'),{queueStatus:'executing'}) .map((p:any)=>p.status)).toEqual(['saved','working']);
});
test('new build resets previous validation status',()=>{
 expect(group(rows('Running the saved ticket:','✅ Validation passed','Starting Pi build'),{queueStatus:'executing'}).map((p:any)=>p.status)).toEqual(['working','pending']);
});
test('idle incomplete history is not labelled working or passed',()=>{
 expect(group(rows('Reading source'),{status:'open',queueStatus:'none'})[0].status).toBe('unknown');
 expect(group([],{status:'open'}).map((p:any)=>p.status)).toEqual(['pending','pending']);
});

test('truncated validation history with a saved commit never claims the build was skipped',()=>{
 const p=group(rows('Fresh / candidate: Verify build','✅ **Validation passed** for saved commit abc'),{githubCommitSha:'abc',status:'open'});
 expect(p[0].status).toBe('saved'); expect(p[0].rows.length).toBe(0);
});
test('loading earlier history preserves it across refreshes and deduplicates rows',async()=>{
 const original=globalThis.fetch;
 const calls:string[]=[];
 globalThis.fetch=(async(url:any)=>{calls.push(String(url));return {ok:true,json:async()=>String(url).includes('before=')?[{id:'a',createdAt:'2020-01-01',message:'Starting Pi build'}]:[{id:'b',createdAt:'2020-01-02',message:'Running the saved ticket:'}]};}) as any;
 try {
 const api=(globalThis as any).TicketActionPhases;
 await api.load('/test-history');
 const older=await api.load('/test-history',true);
 expect(older.map((r:any)=>r.id)).toEqual(['a','b']);
 expect(calls[1]).toBe('/test-history?before=b');
 expect((await api.load('/test-history')).length).toBe(2);
 }finally{globalThis.fetch=original;}
});
test('a truncated setup log is not evidence that implementation completed',()=>{
 const p=group(rows('Background job abc finished (exit 0, 31s): Environment ready','Fresh / candidate: checking schema','✅ Validation passed'),{githubCommitSha:'abc',status:'open'});
 expect(p[0].status).toBe('saved');
 const unknown=group(rows('Background job abc finished (exit 0, 31s): Environment ready','Fresh / candidate: checking schema'),{queueStatus:'executing'});
 expect(unknown[0].status).toBe('unknown');
});
