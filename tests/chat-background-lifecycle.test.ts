import { test, expect, mock } from 'bun:test';
import { cancellableStream } from '../src/ai/stream-cancellation.ts';
let request:any, calls=0, finish:()=>void;
let hangProvider = false;
let history:any[]=[];
mock.module('../src/ai/stream-handler.ts',()=>({describeAttachedImages:async()=>'',handleStream:async(r:any)=>{request=r;calls++;if(hangProvider){hangProvider=false;try{for await(const event of cancellableStream({[Symbol.asyncIterator]:()=>({next:()=>new Promise<IteratorResult<string>>(()=>{})})},r.abortController.signal)){} }catch(error:any){if(error.name!=='AbortError')throw error;}return {conversationId:'chat'};}await new Promise<void>(resolve=>{finish=resolve;});return {conversationId:'chat'};}}));
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
  await onMessage(first,JSON.stringify({type:'message',message:'follow up',client_message_id:'queued',conversation_id:'chat'}));
  onClose(first);
  expect(request.abortController.signal.aborted).toBe(false);
  request.ws.send(JSON.stringify({type:'ai_chunk',chunk:'Background',is_final:false}));
  onOpen(second);
  await onMessage(second,JSON.stringify({type:'sync_state'}));
  expect(second.received.find((e:any)=>e.type==='background_resume').events.map((e:any)=>e.chunk)).toEqual(['First','Background']);
  expect(second.received.find((e:any)=>e.type==='sync_state_response').is_streaming).toBe(true);
  expect(second.received.find((e:any)=>e.type==='chat_queue').items[0].id).toBe('queued');
  await onMessage(second,JSON.stringify({type:'message',message:'follow up',client_message_id:'queued',conversation_id:'chat'}));
  expect(calls).toBe(1);
  expect(second.received.at(-1).items[0].message).toBe('follow up');
  await onMessage(second,JSON.stringify({type:'queue_remove',id:'queued'}));
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

test('steering waits for the prior tool to finish and then runs the selected follow-up with files',async()=>{
 const ws=socket('steer-user');onOpen(ws);
 const before=calls;
 const running=onMessage(ws,JSON.stringify({type:'message',message:'first',conversation_id:'chat'}));
 try {
  const original=request;
  await onMessage(ws,JSON.stringify({type:'message',client_message_id:'later',message:'later',conversation_id:'chat'}));
  await onMessage(ws,JSON.stringify({type:'message',client_message_id:'steer',message:'change direction',conversation_id:'chat',files:[{id:'spec',name:'spec.docx'}]}));
  await onMessage(ws,JSON.stringify({type:'queue_steer',id:'steer'}));
  expect(original.abortController.signal.aborted).toBe(true);
  expect(calls).toBe(before+1); // Abort requested, but the old tool hasn't returned.
  finish!();await new Promise(resolve=>setTimeout(resolve,0));
  expect(calls).toBe(before+2);expect(request.userMessage).toBe('change direction');expect(request.files[0].id).toBe('spec');
  expect(ws.received.filter((e:any)=>e.type==='chat_queue').at(-1).items[0].id).toBe('later');
  await onMessage(ws,JSON.stringify({type:'queue_remove',id:'later'}));
 } finally {finish!();await running;onClose(ws);}
});

test('queued messages advance automatically in order without another browser send',async()=>{
 const ws=socket('queue-user');onOpen(ws);
 const running=onMessage(ws,JSON.stringify({type:'message',message:'first',conversation_id:'chat'}));
 try {
  for(const text of ['second','third'])await onMessage(ws,JSON.stringify({type:'message',message:text,conversation_id:'chat'}));
  finish!();await new Promise(resolve=>setTimeout(resolve,0));expect(request.userMessage).toBe('second');
  finish!();await new Promise(resolve=>setTimeout(resolve,0));expect(request.userMessage).toBe('third');
 } finally {finish!();await running;onClose(ws);}
});

 test('steer releases a hung provider and starts the queued turn without provider acknowledgement',async()=>{
 const ws=socket('hung-provider-user');onOpen(ws);hangProvider=true;
 const running=onMessage(ws,JSON.stringify({type:'message',message:'first',conversation_id:'chat'}));
 const original=request;
 try {
  await onMessage(ws,JSON.stringify({type:'message',client_message_id:'steer-hung',message:'new direction',conversation_id:'chat'}));
  await onMessage(ws,JSON.stringify({type:'queue_steer',id:'steer-hung'}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(request.userMessage).toBe('new direction');
  const count=ws.received.length;
  original.ws.send(JSON.stringify({type:'ai_chunk',chunk:'late old result',is_final:true}));
  expect(ws.received.length).toBe(count);
  expect(ws.received.filter((e:any)=>e.type==='chat_queue').at(-1).items).toEqual([]);
 } finally {finish!();await running;onClose(ws);}
});
