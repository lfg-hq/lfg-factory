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
