import { test, expect, mock } from 'bun:test';
let request:any, calls=0, finish:()=>void;
let history:any[]=[];
mock.module('../src/ai/stream-handler.ts',()=>({describeAttachedImages:async()=>'',handleStream:async(r:any)=>{request=r;calls++;await new Promise<void>(resolve=>{finish=resolve;});return {conversationId:'chat'};}}));
mock.module('../src/config/db.ts',()=>({db:{select:()=>({from:()=>({where:()=>({orderBy:()=>({limit:async()=>history,then:(resolve:any)=>Promise.resolve(history).then(resolve)})})})})}}));
mock.module('../src/services/dev-preview.ts',()=>({runPreviewChat:async()=>'',restartPreview:async()=>{},getPreviewState:async()=>null}));
mock.module('../src/auth/project-access.ts',()=>({getProjectAccess:async()=>null}));
const {onOpen,onClose,onMessage}=await import('../src/ws/chat-handler.ts');
function socket(userId='u') {const received:any[]=[];return {data:{userId,sessionId:'s',conversationId:'chat'},received,send(text:string){received.push(JSON.parse(text));return text.length;}} as any;}
test('real handler survives disconnect, resumes another socket, prevents duplicate turn and accepts Stop',async()=>{
 const first=socket(), second=socket();
 onOpen(first);
 const running=onMessage(first,JSON.stringify({type:'message',message:'Build plan',conversation_id:'chat'}));
 try {
  request.ws.send(JSON.stringify({type:'ai_chunk',chunk:'First',is_final:false}));
  onClose(first);
  expect(request.abortController.signal.aborted).toBe(false);
  request.ws.send(JSON.stringify({type:'ai_chunk',chunk:'Background',is_final:false}));
  onOpen(second);
  await onMessage(second,JSON.stringify({type:'sync_state'}));
  expect(second.received.find((e:any)=>e.type==='background_resume').events.map((e:any)=>e.chunk)).toEqual(['First','Background']);
  expect(second.received.find((e:any)=>e.type==='sync_state_response').is_streaming).toBe(true);
  await onMessage(second,JSON.stringify({type:'message',message:'duplicate',conversation_id:'chat'}));
  expect(calls).toBe(1);
  request.ws.send(JSON.stringify({type:'ai_chunk',chunk:'Live',is_final:false}));
  expect(second.received.at(-1).chunk).toBe('Live');
  await onMessage(second,JSON.stringify({type:'stop_generation'}));
  expect(request.abortController.signal.aborted).toBe(true);
  expect(request.abortReason()).toBe('stopped');
 } finally {finish!();await running;onClose(second);}
 history=[{id:'done',role:'assistant',content:'Completed while away'}];
 const third=socket();onOpen(third);
 try {
  await onMessage(third,JSON.stringify({type:'sync_state'}));
  expect(third.received.find((e:any)=>e.type==='background_resume').messages[0].content).toBe('Completed while away');
  expect(third.received.find((e:any)=>e.type==='sync_state_response').is_streaming).toBe(false);
 } finally {onClose(third);}
});
