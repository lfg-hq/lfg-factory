import { test, expect, mock } from 'bun:test';
// Preview copies queue per project instead of hammering the same disk.
process.env.TICKET_CLONE_LOCK_POLL_MS = '5';
const rows = new Map<string, any>();
const db = {
  insert: () => ({ values: (v: any) => ({ onConflictDoNothing: () => ({ returning: async () => { if (rows.has(v.id)) return []; rows.set(v.id, { ...v }); return [rows.get(v.id)]; } }) }) }),
  select: () => ({ from: () => ({ where: async () => [...rows.values()] }) }),
  delete: () => ({ where: async () => { rows.clear(); } }),
  update: () => ({ set: () => ({ where: async () => {} }) }),
};
mock.module('../src/config/db.ts', () => ({ db }));
const { withProjectCloneLock } = await import('../src/services/ticket-sandbox-clone.ts');

test('a second copy in the same project waits for the first and says so', async () => {
  const order: string[] = [], logs: string[] = [];
  let release!: () => void;
  const first = withProjectCloneLock('p1', async m => { logs.push(m); }, () => new Promise<void>(r => { order.push('first start'); release = () => { order.push('first end'); r(); }; }));
  await new Promise(r => setTimeout(r, 10));
  const second = withProjectCloneLock('p1', async m => { logs.push(m); }, async () => { order.push('second start'); });
  await new Promise(r => setTimeout(r, 30));
  expect(order).toEqual(['first start']);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['first start', 'first end', 'second start']);
  expect(logs.some(l => l.includes('Waiting for it to finish'))).toBe(true);
  expect(rows.size).toBe(0);
});

test('a lock left by a dead process is taken over', async () => {
  rows.set('clone-lock-p2', { id: 'clone-lock-p2', updatedAt: new Date(Date.now() - 10 * 60_000) });
  let ran = false;
  await withProjectCloneLock('p2', async () => {}, async () => { ran = true; });
  expect(ran).toBe(true);
});
