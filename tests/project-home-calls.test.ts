// How a call LFG was in shows on the project Home.
import { test, expect } from 'bun:test';
const { callCard } = await import('../src/services/project-home.ts');

const base = { id: 'm1', title: 'Sprint planning', status: 'ended', conversationId: 'c1', createdAt: new Date('2026-11-15T10:00:00Z') };

test('a finished call shows when, how long, and its recap as plain text', () => {
  const card = callCard({ ...base, recap: '## Recap\n**Card payments** ship first.\n- Sam owns [refunds](https://x.test)', startedAt: new Date('2026-11-15T10:01:00Z'), endedAt: new Date('2026-11-15T10:35:00Z') });
  expect(card).toMatchObject({ live: false, minutes: 34, at: '2026-11-15T10:01:00.000Z', conversationId: 'c1' });
  expect(card.recap).toBe('Card payments ship first. Sam owns refunds');
});

test('a long recap is cut at a word, a live call has no length, and no recap stays empty', () => {
  const long = callCard({ ...base, recap: 'word '.repeat(80), startedAt: null, endedAt: null });
  expect(long.recap!.length).toBeLessThanOrEqual(220);
  expect(long.recap!.endsWith('word…')).toBe(true);
  expect(callCard({ ...base, status: 'in_call', recap: null, startedAt: new Date(), endedAt: null })).toMatchObject({ live: true, minutes: null, recap: null });
});
