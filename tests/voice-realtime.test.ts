import {test,expect} from 'bun:test';
import {connectRealtimeVoice,realtimeVoiceSession} from '../src/services/voice-realtime.ts';
import {createVoiceRoutes} from '../src/routes/api/voice.ts';
const auth=async(c:any,next:any)=>{if(c.req.header('X-Test-User')!=='actor')return c.json({error:'unauthorized'},401);c.set('user',{id:'actor'});await next();};
const headers={'X-Test-User':'actor','Content-Type':'application/json'};
const body=JSON.stringify({sdp:'v=0\r\no=voice-test-session'});
test('Realtime session uses audio, interruption detection and a single project delegation tool',async()=>{
 const answer=await connectRealtimeVoice('v=0','private-key',new AbortController().signal,(async(url:any,init:any)=>{
  expect(url).toBe('https://api.openai.com/v1/realtime/calls');expect(init.headers.Authorization).toBe('Bearer private-key');
  expect(init.body.get('sdp')).toBe('v=0');
  const session=JSON.parse(init.body.get('session'));expect(session).toEqual(realtimeVoiceSession);
  expect(session.audio.output.voice).toBe('coral');expect(session.audio.input.turn_detection.interrupt_response).toBe(true);
  expect(session.tools.map((t:any)=>t.name)).toEqual(['ask_project_agent']);return new Response('v=0\r\nanswer');
 }) as typeof fetch);
 expect(answer).toContain('answer');
 await expect(connectRealtimeVoice('v=0','secret',new AbortController().signal,(async()=>new Response('secret',{status:401})) as typeof fetch)).rejects.toThrow('Realtime voice connection failed');
});
test('session endpoint authorizes project access, validates SDP, and returns no API key',async()=>{
 let calls=0;
 const router=createVoiceRoutes({auth,key:async(_user,project)=>project?null:'private-key',speech:async()=>new ArrayBuffer(0),realtime:async()=>{calls++;return 'v=0\r\nanswer';}});
 expect((await router.request('/session',{method:'POST',body,headers:{'Content-Type':'application/json'}})).status).toBe(401);
 expect((await router.request('/session',{method:'POST',headers,body:'{"sdp":"bad"}'})).status).toBe(400);
 expect((await router.request('/session',{method:'POST',headers,body:JSON.stringify({sdp:'v=0\r\no=voice-test-session',projectId:'236cef6d-5f35-4ae0-a179-e49682d0afdc'})})).status).toBe(409);
 expect(calls).toBe(0);
 const r=await router.request('/session',{method:'POST',headers,body});expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(await r.text()).toBe('v=0\r\nanswer');
});
test('Realtime provider error is sanitized and releases connection slot',async()=>{
 const router=createVoiceRoutes({auth,key:async()=> 'secret',speech:async()=>new ArrayBuffer(0),realtime:async()=>{throw Object.assign(new Error('secret'),{statusCode:401});}});
 for(let i=0;i<3;i++){const r=await router.request('/session',{method:'POST',headers,body});expect(r.status).toBe(502);expect(await r.text()).not.toContain('secret');}
});
