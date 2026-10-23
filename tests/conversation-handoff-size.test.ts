import { test, expect } from 'bun:test';
import { loadConversationHandoff } from '../src/ai/conversation-handoff.ts';

// Minimal stand-in for the two drizzle queries the handoff makes.
function fakeStore(rows: any[]) {
  const writes: any[] = [];
  let call = 0;
  const query = (result: any[]) => ({ from: () => ({ where: () => Object.assign(Promise.resolve(result), { orderBy: () => Promise.resolve(result) }) }) });
  return {
    writes,
    select: () => (call++ === 0 ? query([]) : query(rows)),
    insert: () => ({ values: (v: any) => { writes.push(v); return { onConflictDoNothing: async () => {} }; } }),
    update: () => ({ set: (v: any) => { writes.push(v); return { where: async () => {} }; } }),
  } as any;
}
const row = (i: number, chars: number, steps?: unknown) => ({ id: 'm' + String(i).padStart(3, '0'), role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(chars), createdAt: new Date(1e12 + i * 1000), userRole: 'default', files: [], steps });

test('a few very large recent turns are summarized even under 40 messages', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => row(i, 30000));
  const store = fakeStore(rows);
  const seen: string[] = [];
  const handoff = await loadConversationHandoff('c', async (evidence) => { seen.push(evidence); return 'summary'; }, store);
  expect(handoff).not.toBeNull();
  expect(seen.length).toBeGreaterThan(0);
  const through = store.writes[0].throughId;
  expect(rows.findIndex((r) => r.id === through)).toBeLessThan(rows.length - 4); // newest rows stay exact
});

test('a short, small conversation is left alone', async () => {
  const store = fakeStore(Array.from({ length: 12 }, (_, i) => row(i, 400)));
  const handoff = await loadConversationHandoff('c', async () => { throw new Error('should not summarize'); }, store);
  expect(handoff).toBeNull();
});

test('replayed tool steps count toward the size, but are not sent to the summarizer', async () => {
  const steps = [{ role: 'tool', content: 'y'.repeat(200000) }];
  const rows = Array.from({ length: 22 }, (_, i) => row(i, 2000, i % 2 ? steps : undefined));
  const store = fakeStore(rows);
  const seen: string[] = [];
  await loadConversationHandoff('c', async (evidence) => { seen.push(evidence); return 'summary'; }, store);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.join('')).not.toContain('yyyy');
});
