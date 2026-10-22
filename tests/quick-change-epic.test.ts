import { test, expect } from 'bun:test';
import { resolveQuickChangeEpic } from '../src/ai/tools/quick-change-tools.ts';

const epic = (id: string, conversationId: string | null, updated = '2026-10-22T10:00:00Z') => ({ id, projectId: 'p', conversationId, updatedAt: new Date(updated) });
const ctx = { userId: 'u', conversationId: 'chat-1' };
const deps = (open: ReturnType<typeof epic>[], created: string[] = []) => ({
  get: async (id: string) => open.find((e) => e.id === id),
  open: async () => open,
  create: async (input: { name: string }) => { created.push(input.name); return epic('new', 'chat-1'); },
});

test('a named epic wins', async () => {
  expect((await resolveQuickChangeEpic('p', ctx, 'e2', 'x', deps([epic('e1', 'chat-1'), epic('e2', 'other')]))).id).toBe('e2');
});
test('without a name, the open epic from this conversation is used (newest first)', async () => {
  const open = [epic('e1', 'chat-1', '2026-10-21T10:00:00Z'), epic('e3', 'chat-1', '2026-10-22T10:00:00Z'), epic('e2', 'other')];
  expect((await resolveQuickChangeEpic('p', ctx, undefined, 'x', deps(open))).id).toBe('e3');
});
test("the project's only open epic is used when this chat has none", async () => {
  expect((await resolveQuickChangeEpic('p', ctx, undefined, 'x', deps([epic('e9', 'other')]))).id).toBe('e9');
});
test('a new epic only when nothing open relates', async () => {
  const created: string[] = [];
  expect((await resolveQuickChangeEpic('p', ctx, undefined, 'Fix footer', deps([epic('a', 'x'), epic('b', 'y')], created))).id).toBe('new');
  expect(created).toEqual(['Fix footer']);
});
