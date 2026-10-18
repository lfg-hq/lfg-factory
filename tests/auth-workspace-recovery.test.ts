import {test,expect} from 'bun:test';
import {startAuthWorkspaceWithRecovery} from '../src/services/auth-workspace-recovery.ts';
test('terminal startup failure gets one fresh VM and cleans up the failed attempt',async()=>{
 const names:string[]=[],cleaned:string[]=[];let retries=0;
 const result=await startAuthWorkspaceWithRecovery({name:()=>`auth-${names.length}`,create:async name=>{names.push(name);if(names.length===1)throw Error(`VM '${name}' ended unexpectedly with status: error`);return 'ready';},cleanup:async name=>{cleaned.push(name);},onRetry:()=>{retries++;}});
 expect(result).toBe('ready');expect(names).toEqual(['auth-0','auth-1']);expect(cleaned).toEqual(['auth-0']);expect(retries).toBe(1);
});
test('two failures stop recovery even when cleanup fails',async()=>{
 let calls=0;
 await expect(startAuthWorkspaceWithRecovery({name:()=>`auth-${calls}`,create:async()=>{calls++;throw Error('ended unexpectedly with status: error');},cleanup:async()=>{throw Error('already gone');}})).rejects.toThrow('after two attempts');
 expect(calls).toBe(2);
});
test('ambiguous timeouts and authentication errors do not create replacement VMs',async()=>{
 for(const message of ['VM did not start within 25000ms','401 unauthorized','database unavailable']){
  let calls=0,cleanups=0;
  await expect(startAuthWorkspaceWithRecovery({name:()=> 'auth',create:async()=>{calls++;throw Error(message);},cleanup:async()=>{cleanups++;}})).rejects.toThrow(message);
  expect(calls).toBe(1);expect(cleanups).toBe(0);
 }
});
