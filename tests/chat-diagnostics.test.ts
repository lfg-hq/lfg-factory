import { test, expect, spyOn } from 'bun:test';
import { withChatDiagnostics, chatStage, chatDiagnostic, chatConversation } from '../src/ai/chat-diagnostics.ts';

test('correlates stages, late conversation assignment and cancellation without arbitrary payloads', async () => {
 const log=spyOn(console,'info').mockImplementation(()=>{});
 const controller=new AbortController();
 try {
  await withChatDiagnostics({projectId:'project',signal:controller.signal},async()=>{
   chatConversation('conversation'); chatStage('subscription_access');
   chatDiagnostic('provider_headers_received',{status:401,token:'SECRET',message:'PRIVATE',url:'https://secret'} as any);
   controller.abort();
  });
  const rows=log.mock.calls.map(([line])=>JSON.parse(line as string));
  expect(new Set(rows.map(r=>r.requestId)).size).toBe(1);
  expect(rows.find(r=>r.event==='provider_headers_received')).toMatchObject({conversationId:'conversation',stage:'subscription_access',status:401});
  expect(rows.at(-1).outcome).toBe('cancelled');
  expect(rows.some(r=>r.event==='cancellation_requested')).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(/SECRET|PRIVATE|https:/);
 } finally {log.mockRestore();}
});

test('concurrent chats retain separate request IDs and raw exceptions are omitted',async()=>{
 const log=spyOn(console,'info').mockImplementation(()=>{});
 try {
  await Promise.all(['a','b'].map(conversationId=>withChatDiagnostics({conversationId,signal:new AbortController().signal},async()=>{
   await Promise.resolve();chatStage('model_response');
   if(conversationId==='b')throw new Error('credential-secret');
  }).catch(()=>{})));
  const rows=log.mock.calls.map(([line])=>JSON.parse(line as string));
  const a=rows.filter(r=>r.conversationId==='a'),b=rows.filter(r=>r.conversationId==='b');
  expect(new Set(a.map(r=>r.requestId)).size).toBe(1);
  expect(a[0].requestId).not.toBe(b[0].requestId);
  expect(b.at(-1).outcome).toBe('error');
  expect(JSON.stringify(rows)).not.toContain('credential-secret');
 } finally {log.mockRestore();}
});

test('cancellation from outside the request context remains correlated',async()=>{
 const log=spyOn(console,'info').mockImplementation(()=>{});
 const controller=new AbortController();let finish!:()=>void;
 try {
  const running=withChatDiagnostics({conversationId:'external',signal:controller.signal},()=>new Promise<void>(resolve=>{finish=resolve;}));
  controller.abort();finish();await running;
  const rows=log.mock.calls.map(([line])=>JSON.parse(line as string));
  expect(rows.find(r=>r.event==='cancellation_requested')).toMatchObject({conversationId:'external',requestId:rows[0].requestId});
 } finally {log.mockRestore();}
});
