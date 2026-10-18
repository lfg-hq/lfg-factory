import {test,expect} from 'bun:test';
import {createConnectionChecker} from '../src/services/chatgpt-connection-check.ts';
test('checks access without returning tokens, and caches repeated clicks per user',async()=>{
 let calls=0;const check=createConnectionChecker(async()=>{calls++;return 'secret';});
 const result=await check('a');expect(result.status).toBe('ready');expect(JSON.stringify(result)).not.toContain('secret');
 await check('a');expect(calls).toBe(1);await check('b');expect(calls).toBe(2);
});
test('a slow refresh returns promptly and subsequent checks share the ongoing operation',async()=>{
 let done!:(token:string)=>void,calls=0;
 const check=createConnectionChecker(()=>{calls++;return new Promise(resolve=>done=resolve);},5);
 expect((await check('a')).status).toBe('checking');expect((await check('a')).status).toBe('checking');expect(calls).toBe(1);
 done('secret');expect((await check('a')).status).toBe('ready');
});
test('distinguishes reconnection from infrastructure errors without exposing internals',async()=>{
 expect((await createConnectionChecker(async()=>{throw Error('not connected');})('a')).status).toBe('reconnect');
 const result=await createConnectionChecker(async()=>{throw Error('VM private-detail failed');})('a');
 expect(result.status).toBe('unavailable');expect(JSON.stringify(result)).not.toContain('private-detail');
});
