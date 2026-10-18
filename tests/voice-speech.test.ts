import { test, expect } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { createVoiceRoutes, resolveVoiceEnvironmentKey } from '../src/routes/api/voice.ts';
import { generateVoiceSpeech } from '../src/services/voice-speech.ts';
const auth = async(c:any,next:any)=>{if(c.req.header('X-Test-User')!=='actor') return c.json({error:'unauthorized'},401);c.set('user',{id:'actor'});await next();};
const headers = {'X-Test-User':'actor','Content-Type':'application/json'};

test('natural speech uses fixed model, voice and style; provider secrets do not escape',async()=>{
 let body:any;
 const audio=await generateVoiceSpeech('Let me check.','private-key',new AbortController().signal,(async(url:any,init:any)=>{
  expect(url).toBe('https://api.openai.com/v1/audio/speech');expect(init.headers.Authorization).toBe('Bearer private-key');
  body=JSON.parse(init.body);return new Response(new Uint8Array([1,2,3]));
 }) as typeof fetch);
 expect(body.voice).toBe('marin');expect(body.model).toBe('gpt-4o-mini-tts');expect(body.instructions).toContain('naturally');expect(audio.byteLength).toBe(3);
 await expect(generateVoiceSpeech('Hello','key',new AbortController().signal,(async()=>new Response('sensitive provider body',{status:402})) as typeof fetch)).rejects.toThrow('insufficient API credit');
});

test('voice route checks auth, project authorization and input before synthesis',async()=>{
 let calls=0;
 const router=createVoiceRoutes({auth,key:async(user,project)=>{expect(user).toBe('actor');if(project)throw new HTTPException(403,{message:'Project access denied'});return 'key';},speech:async()=>{calls++;return new Uint8Array([1]).buffer;}});
 expect((await router.request('/',{method:'POST',body:JSON.stringify({text:'hello'}),headers:{'Content-Type':'application/json'}})).status).toBe(401);
 expect((await router.request('/',{method:'POST',headers,body:JSON.stringify({text:'hello',projectId:'236cef6d-5f35-4ae0-a179-e49682d0afdc'})})).status).toBe(403);
 expect((await router.request('/',{method:'POST',headers,body:JSON.stringify({text:'x'.repeat(1201)})})).status).toBe(400);
 expect(calls).toBe(0);
 const response=await router.request('/',{method:'POST',headers,body:JSON.stringify({text:'Let me check.'})});
 expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('audio/mpeg');expect(response.headers.get('cache-control')).toBe('no-store');expect(calls).toBe(1);
});

test('missing credentials disable voice and prevent synthesis',async()=>{
 const router=createVoiceRoutes({auth,key:async()=>null,speech:async()=>{throw new Error('must not call');}});
 expect(await (await router.request('/',{headers})).json()).toMatchObject({natural:false});
 expect((await router.request('/',{method:'POST',headers,body:JSON.stringify({text:'hello'})})).status).toBe(409);
});

test('provider failures return safe errors and release concurrency slots',async()=>{
 const router=createVoiceRoutes({auth,key:async()=> 'key',speech:async()=>{throw new Error('private-key');}});
 for(let i=0;i<3;i++){
  const response=await router.request('/',{method:'POST',headers,body:JSON.stringify({text:'hello'})});
  expect(response.status).toBe(502);expect(await response.text()).not.toContain('private-key');
 }
});

test('provider authentication failures are actionable and distinct from app login failures',async()=>{
 for (const statusCode of [401,403]) {
  const router=createVoiceRoutes({auth,key:async()=> 'secret-key',speech:async()=>{throw Object.assign(new Error('secret-key'),{statusCode});}});
  const response=await router.request('/',{method:'POST',headers,body:JSON.stringify({text:'hello'})});
  expect(response.status).toBe(409);
  const body=await response.json();
  expect(body.code).toBe(statusCode===401?'voice_key_rejected':'voice_access_denied');
  expect(body.error).toContain('administrator');
  expect(JSON.stringify(body)).not.toContain('secret-key');
 }
});


test('voice uses the environment key only after authorization, and treats blank keys as absent',async()=>{
 const allowed=async(user:string,project?:string|null)=>{expect(user).toBe('actor');expect(project).toBe('project');return {canUseKey:true};};
 expect(await resolveVoiceEnvironmentKey('actor','project',allowed,()=> '  server-key  ')).toBe('server-key');
 for(const key of [undefined,'','   ']) expect(await resolveVoiceEnvironmentKey('actor','project',allowed,()=>key)).toBeNull();
 expect(await resolveVoiceEnvironmentKey('actor',null,async()=>({canUseKey:false}),()=>{throw new Error('must not read key');})).toBeNull();
 await expect(resolveVoiceEnvironmentKey('actor','project',async()=>{throw new HTTPException(403);},()=> 'server-key')).rejects.toThrow();
});
