import { test, expect, mock } from "bun:test";

const saved: any[] = [];
const advanced: any[] = [];
let rejectNotification = false;
mock.module('../src/config/db.ts', () => ({ db: {
  select() {
    const query: any = {
      from() { return query; }, where() { return query; },
      limit() { return Promise.resolve([{ name: 'Ticket', projectId: 'internal', ownerId: 'owner', publicProjectId: 'public' }]); },
    };
    return query;
  },
} }));
mock.module('../src/services/notify.ts', () => ({ notify: async (p: any) => {
  if (rejectNotification) throw new Error('offline');
  saved.push(p);
} }));
mock.module('../src/services/activity-log.ts', () => ({ logActivity: async () => {} }));
mock.module('../src/ws/connection-manager.ts', () => ({ broadcastToUser: () => {} }));
mock.module('../src/services/build-queue.ts', () => ({ onTicketFinished: async (...args: any[]) => { advanced.push(args); return true; } }));
const { emit } = await import('../src/events/bus.ts');
const { registerEventHandlers } = await import('../src/events/handlers.ts');
registerEventHandlers();
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('CLI exit does not notify or advance before Git finalization', async () => {
  emit({ type: 'ticket.cli_finished', ticketId: 'cli', status: 'complete', exitCode: 0 });
  await settle();
  expect(saved).toHaveLength(0); expect(advanced).toHaveLength(0);
});
test('finalized build creates a durable cross-project notification and advances once', async () => {
  emit({ type: 'ticket.execution_finished', ticketId: 'built', projectId: 'internal', status: 'complete', exitCode: 0 });
  await settle();
  expect(saved[0]).toMatchObject({ userId: 'owner', projectId: 'public', type: 'build_complete', targetId: 'built', link: '/projects/public/tickets?ticket=built' });
  emit({ type: 'ticket.execution_finished', ticketId: 'built', projectId: 'internal', status: 'complete', exitCode: 0 });
  await settle();
  expect(advanced).toHaveLength(1);
});
test('failure is actionable and a fast retry can notify again', async () => {
  emit({ type: 'ticket.execution_finished', ticketId: 'retry', status: 'failed', exitCode: 1 });
  await settle();
  emit({ type: 'ticket.execution_started', ticketId: 'retry', sandboxId: 'sandbox' });
  await settle();
  emit({ type: 'ticket.execution_finished', ticketId: 'retry', status: 'failed', exitCode: 1 });
  await settle();
  expect(saved.filter(n => n.targetId === 'retry')).toHaveLength(2);
  expect(saved.at(-1).type).toBe('build_failed');
});
test('notification failure cannot strand the build queue', async () => {
  rejectNotification = true;
  emit({ type: 'ticket.execution_finished', ticketId: 'offline', status: 'failed', exitCode: 1 });
  await settle();
  expect(advanced.at(-1)).toEqual(['offline', 'failed']);
  rejectNotification = false;
});
test('needs-attention events reach the saved inbox', async () => {
  emit({ type: 'ticket.needs_attention', ticketId: 'question', reason: 'Waiting', question: 'Which environment?' });
  await settle();
  expect(saved.at(-1)).toMatchObject({ type: 'build_attention', targetId: 'question', message: 'Ticket — Which environment?' });
});
