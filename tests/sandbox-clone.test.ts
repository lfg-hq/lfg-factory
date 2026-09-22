import {test,expect} from 'bun:test';
import {submitClone,waitForClone} from '../src/services/sandbox/clone-v2.ts';

test('clone polls at ten seconds and uses generated workspace identity',async()=>{
 let time=0;let calls=0;const waits:number[]=[];
 const result=await waitForClone('accepted-id',{now:()=>time,wait:async ms=>{waits.push(ms);time+=ms;},status:async()=>++calls===3?{status:'running',name:'clone-generated'}:{status:'accepted'}});
 expect(waits).toEqual([10000,10000]);expect(result).toEqual({jobId:'accepted-id',workspaceId:'clone-generated'});
});
test('clone error preserves provider reason',async()=>{
 await expect(waitForClone('id',{status:async()=>({status:'error',error_message:'source resume failed'})})).rejects.toThrow('source resume failed');
});
test('unknown running identity does not report ready',async()=>{
 let time=0;
 await expect(waitForClone('id',{now:()=>time,wait:async ms=>{time+=ms;},status:async()=>({status:'running'})})).rejects.toThrow('saved request');
});
test('status transport failure is surfaced without resubmission',async()=>{
 let calls=0;
 await expect(waitForClone('id',{status:async()=>{calls++;throw new Error('network down');}})).rejects.toThrow('network down');
 expect(calls).toBe(1);
});
test('clone POST is sent once without body, even if its outcome is uncertain',async()=>{
 const original=globalThis.fetch;const token=process.env.MAGS_API_TOKEN;process.env.MAGS_API_TOKEN='test';let calls=0;
 globalThis.fetch=(async (_url:any,options:any)=>{calls++;expect(options.method).toBe('POST');expect(options.body).toBeUndefined();throw new Error('connection lost');}) as any;
 try {await expect(submitClone('source')).rejects.toThrow('connection lost');expect(calls).toBe(1);}
 finally {globalThis.fetch=original;if(token===undefined)delete process.env.MAGS_API_TOKEN;else process.env.MAGS_API_TOKEN=token;}
});

test('clone errors preserve HTTP diagnostics for HTML, empty and JSON responses',async()=>{
 const original=globalThis.fetch;const token=process.env.MAGS_API_TOKEN;process.env.MAGS_API_TOKEN='private-test-token';
 try {
  for(const [status,body,type,expected] of [[502,'<html>Bad gateway private-test-token</html>','text/html','Bad gateway'],[202,'','application/json','empty response body'],[401,'{"error":"denied"}','application/json','denied'],[200,'null','application/json','invalid response']] as const) {
   let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(body,{status,headers:{'content-type':type}});}) as any;
   let failure:any;try{await submitClone('source');}catch(e){failure=e;}
   expect(failure.statusCode).toBe(status);expect(failure.message).toContain(expected);expect(failure.message).not.toContain('private-test-token');expect(calls).toBe(1);
  }
  globalThis.fetch=(async()=>new Response('{"request_id":"accepted"}',{status:202})) as any;
  expect(await submitClone('source')).toBe('accepted');
 }finally{globalThis.fetch=original;if(token===undefined)delete process.env.MAGS_API_TOKEN;else process.env.MAGS_API_TOKEN=token;}
});
