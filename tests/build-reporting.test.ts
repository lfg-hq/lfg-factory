import { test, expect, mock } from 'bun:test';
import { ticketLogs, projectTickets } from '../src/db/schema/tickets.ts';
import { projects } from '../src/db/schema/projects.ts';
import { epics } from '../src/db/schema/epics.ts';
import { messages } from '../src/db/schema/chat.ts';

let origin: any;
const chats: any[] = [], notices: any[] = [], sockets: any[] = [];
let rejectChat = false;
mock.module('../src/config/db.ts', () => ({ db: {
  select() { let table: any; const q: any = {
    from(t: any) { table = t; return q; }, where() { return q; },
    limit() { return Promise.resolve(table === ticketLogs ? (origin ? [origin] : []) : table === projectTickets
      ? [{name:'Example', ticketKey:'T-1', projectId:'internal', epicId:'epic', conversationId:'creation-chat'}]
      : table === projects ? [{ownerId:'owner', projectId:'public'}] : table === epics ? [{name:'Feature'}] : []); },
  }; return q; },
  insert(table: any) { return { values(value: any) {
    if (table === ticketLogs) return {onConflictDoUpdate() { origin = value; return Promise.resolve(); }};
    if (table === messages) { if (rejectChat) return Promise.reject(new Error('chat unavailable')); chats.push(value); }
    return Promise.resolve();
  }}; },
} }));
mock.module('../src/services/notify.ts', () => ({ notify: async (p: any) => { notices.push(p); } }));
mock.module('../src/ws/connection-manager.ts', () => ({ broadcastToUser: (userId: string, p: any) => { sockets.push({userId,...p}); } }));
const {setBuildOrigin, getBuildOrigin, reportBuildStatus} = await import('../src/services/build-reporting.ts');

test('legacy ticket creation conversation is never treated as build origin', async () => {
  await reportBuildStatus('ticket','failed','Build failed.');
  expect(notices).toHaveLength(1); expect(chats).toHaveLength(0); expect(sockets).toHaveLength(0);
});
test('chat build sends every status to the inbox and outcomes to the initiating thread', async () => {
  await setBuildOrigin('ticket','request-chat','requester');
  expect(await getBuildOrigin('ticket')).toEqual({conversationId:'request-chat',userId:'requester'});
  for (const status of ['queued','started','attention','failed','stopped','complete']) await reportBuildStatus('ticket',status,status);
  // Queued/started appear on the live build card, not as chat messages.
  expect(chats).toHaveLength(4);
  expect(chats.every(p => p.conversationId === 'request-chat')).toBe(true);
  expect(sockets.every(p => p.conversation_id === 'request-chat' && p.userId === 'requester' && p.build_status)).toBe(true);
  expect(notices.slice(1).map(p => p.type)).toEqual(['build_queued','build_started','build_attention','build_failed','build_stopped','build_complete']);
});
test('ticket-view retry clears the prior chat destination but keeps notifications', async () => {
  await setBuildOrigin('ticket',null,'requester');
  await reportBuildStatus('ticket','complete','Passed');
  expect(chats).toHaveLength(4); expect(sockets).toHaveLength(4);
  expect(notices.at(-1)).toMatchObject({type:'build_complete',userId:'requester',targetId:'ticket'});
});
test('tickets in a build run leave chat reporting to the run', async () => {
  await setBuildOrigin('ticket','run-chat','requester',true);
  expect(await getBuildOrigin('ticket')).toMatchObject({conversationId:'run-chat',inRun:true});
  const before=chats.length;
  await reportBuildStatus('ticket','failed','Failed');
  expect(chats.length).toBe(before); expect(notices.at(-1).type).toBe('build_failed');
});
test('unavailable chat cannot fail the build and the notification is already saved', async () => {
  await setBuildOrigin('ticket','request-chat','requester'); rejectChat = true;
  await expect(reportBuildStatus('ticket','complete','Passed')).resolves.toBeUndefined();
  expect(notices.at(-1).type).toBe('build_complete');
});

