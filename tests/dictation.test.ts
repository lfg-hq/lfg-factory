import {test,expect} from 'bun:test';
import {connectDictation,transcribeDictation} from '../src/services/dictation.ts';
import {createVoiceRoutes} from '../src/routes/api/voice.ts';
const auth=async(c:any,next:any)=>{if(c.req.header('X-Test-User')!=='actor')return c.json({error:'unauthorized'},401);c.set('user',{id:'actor'});await next();};
const headers={'X-Test-User':'actor','Content-Type':'application/json'};
const body=JSON.stringify({sdp:'v=0\r\no=dictation-test-session',keywords:['LFG'],prompt:'Software project'});
const audio=()=>{const f=new FormData();f.set('audio',new File(['audio'],'recording.webm',{type:'audio/webm'}));f.set('context',JSON.stringify({keywords:['LFG']}));return f;};
test('transcription uses current models with context, automatic language and no speech output',async()=>{
 await connectDictation('v=0','secret',new AbortController().signal,{keywords:['LFG']},(async(_url:any,init:any)=>{
  const s=JSON.parse(init.body.get('session'));
  expect(s.type).toBe('transcription');expect(s.audio.input.transcription.model).toBe('gpt-live-transcribe');
  expect(s.audio.input.transcription.keywords).toEqual(['LFG']);expect(s.audio.input.turn_detection).toBeNull();expect(s.audio.input.transcription.delay).toBe('low');
  expect(s.audio.output).toBeUndefined();expect(s.audio.input.transcription.language).toBeUndefined();
  return new Response('answer');
 }) as typeof fetch);
 const text=await transcribeDictation(new File(['audio'],'recording.webm'),'secret',new AbortController().signal,{keywords:['LFG']},(async(_url:any,init:any)=>{
  expect(init.body.get('model')).toBe('gpt-transcribe');expect(init.body.getAll('keywords[]')).toEqual(['LFG']);return Response.json({text:'Hello, LFG.'});
 }) as typeof fetch);
 expect(text).toBe('Hello, LFG.');
});
test('dictation authorizes both endpoints and rejects malformed or oversized files',async()=>{
 let calls=0;
 const router=createVoiceRoutes({auth,key:async(_u,p)=>p?null:'key',speech:async()=>new ArrayBuffer(0),dictation:async()=>{calls++;return 'answer';},transcribe:async()=>{calls++;return 'Hello, LFG.';}});
 expect((await router.request('/dictation/session',{method:'POST',body,headers:{'Content-Type':'application/json'}})).status).toBe(401);
 expect((await router.request('/dictation/session',{method:'POST',headers,body:JSON.stringify({sdp:'v=0\r\no=dictation-test-session',projectId:'236cef6d-5f35-4ae0-a179-e49682d0afdc'})})).status).toBe(409);
 expect((await router.request('/dictation/session',{method:'POST',headers,body:'{"sdp":"bad"}'})).status).toBe(400);
 expect(calls).toBe(0);
 expect((await router.request('/dictation/session',{method:'POST',headers,body})).status).toBe(200);
 const response=await router.request('/dictation/transcribe',{method:'POST',headers:{'X-Test-User':'actor'},body:audio()});
 expect(await response.json()).toEqual({text:'Hello, LFG.'});expect(response.headers.get('cache-control')).toBe('no-store');
 const invalid=audio();invalid.set('audio',new File(['data'],'x.html',{type:'text/html'}));
 expect((await router.request('/dictation/transcribe',{method:'POST',headers:{'X-Test-User':'actor'},body:invalid})).status).toBe(400);
 const large=audio();large.set('audio',new File([new Uint8Array(10*1024*1024+1)],'big.webm',{type:'audio/webm'}));
 expect((await router.request('/dictation/transcribe',{method:'POST',headers:{'X-Test-User':'actor'},body:large})).status).toBe(400);
});
test('transcription errors are sanitized and release request slots',async()=>{
 const router=createVoiceRoutes({auth,key:async()=> 'secret',speech:async()=>new ArrayBuffer(0),transcribe:async()=>{throw Object.assign(new Error('secret'),{statusCode:401});}});
 for(let i=0;i<3;i++){
  const r=await router.request('/dictation/transcribe',{method:'POST',headers:{'X-Test-User':'actor'},body:audio()});
  expect(r.status).toBe(502);expect(await r.text()).not.toContain('secret');
 }
});
