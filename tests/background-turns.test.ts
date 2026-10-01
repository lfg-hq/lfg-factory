import { test, expect } from 'bun:test';
import { BackgroundTurn, findBackgroundTurn, detachBackgroundSocket } from '../src/ws/background-turns.ts';
import type { WsConnection } from '../src/ws/types.ts';
function socket() { const received: string[] = []; return { received, send(text:string) { received.push(text); return text.length; }, data: {} } as any; }
function owner(ws:any, conversationId='chat', userId='owner'): WsConnection { return {ws, userId, conversationId, isStreaming:true,stopRequested:false,abortController:new AbortController()}; }
test('navigation detaches delivery without cancelling generation; return replays then receives live output', () => {
 const first=socket(), conn=owner(first), turn=new BackgroundTurn(conn);
 try {
  turn.transport.send(JSON.stringify({type:'ai_chunk',chunk:'Before'}));
  detachBackgroundSocket(first);
  turn.transport.send(JSON.stringify({type:'ai_chunk',chunk:'After'}));
  expect(conn.abortController!.signal.aborted).toBe(false);
  expect(first.received).toHaveLength(1);
  expect(findBackgroundTurn('owner','chat')).toBe(turn);
  expect(findBackgroundTurn('other','chat')).toBeUndefined();
  expect(findBackgroundTurn('owner','other')).toBeUndefined();
  const returning=socket();
  turn.events.forEach(e=>returning.send(e)); turn.subscribers.add(returning);
  turn.transport.send(JSON.stringify({type:'ai_chunk',chunk:'End',is_final:true}));
  expect(returning.received.map((e:string)=>JSON.parse(e).chunk)).toEqual(['Before','After','End']);
  // Stop from the new connection targets the original controller.
  findBackgroundTurn('owner','chat')!.owner.abortController!.abort();
  expect(conn.abortController!.signal.aborted).toBe(true);
 } finally {turn.finish();}
 expect(findBackgroundTurn('owner','chat')).toBeUndefined();
 expect(turn.events).toHaveLength(0);
});
test('new conversation becomes resumable and dead sockets never interrupt output', () => {
 const ws=socket(), conn=owner(ws);conn.conversationId=undefined;
 const turn=new BackgroundTurn(conn);
 try {
  ws.send=()=>{throw Error('closed');};
  expect(()=>turn.transport.send(JSON.stringify({type:'conversation_created',conversationId:'new-chat'}))).not.toThrow();
  expect(findBackgroundTurn('owner','new-chat')).toBe(turn);
  expect(turn.subscribers.size).toBe(0);
  expect(conn.abortController!.signal.aborted).toBe(false);
 } finally {turn.finish();}
});
