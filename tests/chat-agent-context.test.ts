// The long-conversation behaviour the chat agent depends on: what must still be true
// after history has been condensed, more than once, and across turns. Deterministic:
// no model, network or production database.
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { compactContext, ledgerLines, loadedSkills, splitLedger, summaryLimit, withLedger, handoffInstruction } from '../src/ai/context-compaction.ts';
import { compactToolSteps, toolDigest } from '../src/ai/history-budget.ts';
import { loadConversationHandoff, saveConversationCheckpoint } from '../src/ai/conversation-handoff.ts';
import { appendToLastUser, isContextOverflow, turnContextBlock } from '../src/ai/turn-context.ts';
import { formatPlan, planProgress, planTools, readPlan } from '../src/ai/tools/plan-tools.ts';
import { ticketEventMessage } from '../src/services/build-summary-turn.ts';

const call = (id: string, toolName: string, input: unknown) => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] });
const result = (id: string, toolName: string, value: unknown) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: typeof value === 'string' ? { type: 'text', value } : { type: 'json', value } }] });
const SKILL = 'Ticket delivery workflow. ' + 'Step: write acceptance criteria. '.repeat(400); // ~13k chars, far above the prune threshold
const filler = (n: number) => 'lorem ipsum '.repeat(n);

/** A long working session: a constraint, a skill, a document, tickets, a build, then lots of reading. */
function session(): any[] {
  const rows: any[] = [
    { role: 'user', content: 'Build invoicing. Never email customers without my approval.' },
    call('s1', 'loadSkill', { id: 'ticket-delivery' }), result('s1', 'loadSkill', { found: true, id: 'ticket-delivery', instructions: SKILL }),
    call('e1', 'startEpic', { name: 'Invoicing' }), result('e1', 'startEpic', { epicId: 'epic-7f3a' }),
    call('d1', 'streamDocumentContent', { name: 'Invoicing PRD', content: filler(3000) }), result('d1', 'streamDocumentContent', { saved: true, id: 'doc-91bc' }),
    call('t1', 'createTickets', { tickets: [{ name: 'Invoice model' }, { name: 'PDF export' }] }), result('t1', 'createTickets', { created: [{ id: 'tk-1', key: 'INV-1' }, { id: 'tk-2', key: 'INV-2' }] }),
    { role: 'assistant', content: 'PRD saved and two tickets created.' },
    { role: 'user', content: 'Start the build.' },
    call('b1', 'startBuildRun', { ticketIds: ['tk-1', 'tk-2'] }), result('b1', 'startBuildRun', { runId: 'run-55' }),
  ];
  for (let i = 0; i < 12; i++) rows.push(call('q' + i, 'queryCodebase', { question: 'part ' + i }), result('q' + i, 'queryCodebase', filler(1500)));
  rows.push({ role: 'assistant', content: 'Build started.' }, { role: 'user', content: 'Now check the PDF layout.' },
    call('z1', 'getFileContent', { id: 'doc-91bc' }), result('z1', 'getFileContent', 'current doc'));
  return rows;
}

test('after a condense the agent still has its IDs, its skill, its plan and the user request', async () => {
  const rows = session();
  const saved: any[] = [];
  const out = await compactContext(rows, 0, async () => 'Objective: invoicing. Constraint: never email customers without approval.', 12000, undefined, undefined, {
    onSummarized: info => { saved.push(info); }, restore: () => 'Your working plan:\n1. [x] PRD\n2. [>] Build INV-1, INV-2',
  });
  const head = String(out[0]!.content);
  // IDs come from the mechanical ledger, not from the model-written summary (which named none).
  for (const id of ['epic-7f3a', 'doc-91bc', 'INV-1', 'INV-2', 'run-55']) expect(head).toContain(id);
  expect(head).not.toContain('queryCodebase(');           // reads are not actions
  expect(head).toContain('[>] Build INV-1, INV-2');       // the live plan is re-attached
  // The skill's full instructions are carried across as a real call/result pair.
  const skill = out.find((m: any) => m.role === 'tool' && m.content[0].toolName === 'loadSkill') as any;
  expect(skill.content[0].output.value.instructions).toBe(SKILL);
  expect(out.some((m: any) => m.role === 'user' && m.content === 'Now check the PDF layout.')).toBe(true);
  // What is saved as the checkpoint has the ledger but not the plan (the plan is live state).
  expect(saved).toHaveLength(1);
  expect(saved[0].summary).toContain('run-55');
  expect(saved[0].summary).not.toContain('current-plan');
  expect(saved[0].degraded).toBe(false);
  expect(saved[0].cut).toBeGreaterThan(10);
});

test('a second condense keeps the ledger and the skill, and never feeds the old plan to the summarizer', async () => {
  const first = await compactContext(session(), 0, async () => 'first summary', 12000, undefined, undefined, { restore: () => 'OLD PLAN TEXT' });
  const more: any[] = [...first];
  for (let i = 0; i < 12; i++) more.push(call('r' + i, 'readUrl', { url: 'u' + i }), result('r' + i, 'readUrl', filler(1500)));
  more.push(call('m1', 'sendTicketMessage', { ticketId: 'tk-2', message: 'fix margins' }), result('m1', 'sendTicketMessage', { operationId: 'op-777' }),
    call('y1', 'getTicketDetails', { ticketId: 'tk-2' }), result('y1', 'getTicketDetails', 'details'),
    call('y2', 'getTicketDetails', { ticketId: 'tk-1' }), result('y2', 'getTicketDetails', 'details'));
  const seen: string[] = [];
  const second = await compactContext(more, 0, async (e) => { seen.push(e); return 'second summary'; }, 12000, undefined, undefined, { restore: () => 'NEW PLAN TEXT' });
  const head = String(second[0]!.content);
  expect(head).toContain('second summary');
  for (const id of ['epic-7f3a', 'doc-91bc', 'INV-2', 'run-55', 'op-777']) expect(head).toContain(id);
  expect(head).toContain('NEW PLAN TEXT');
  expect(head).not.toContain('OLD PLAN TEXT');
  expect(seen.join('\n')).not.toContain('OLD PLAN TEXT');
  expect(seen.join('\n')).not.toContain('actions-ledger');
  expect(loadedSkills(second)).toHaveLength(2); // still one complete loadSkill pair
});

test('pruning old tool output never shortens a loaded skill', async () => {
  const rows = session();
  // Budget large enough that pruning alone fits: no summary is needed.
  const out = await compactContext(rows, 0, async () => { throw new Error('should not summarize'); }, 40000);
  const skill = out.find((m: any) => m.role === 'tool' && m.content[0].toolName === 'loadSkill') as any;
  expect(skill.content[0].output.value.instructions).toBe(SKILL);
  expect(JSON.stringify(out)).toContain('Earlier tool output shortened');
});

test('handoffs scale with the model instead of a fixed 9,000 characters', () => {
  expect(summaryLimit(16000)).toBe(9000);
  expect(summaryLimit(116000)).toBe(23200);
  expect(summaryLimit(226400)).toBe(45280);
  expect(summaryLimit(1_000_000)).toBe(60000);
  expect(handoffInstruction(45000)).toContain('at most 30000 characters');
  expect(handoffInstruction()).toContain('## Work done');
});

test('the ledger is deduplicated and keeps the newest entries when it outgrows its limit', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `- createTickets({"n":${i}}) → {"id":"tk-${i}"}`);
  const text = withLedger('summary', [...lines, ...lines]);
  const back = splitLedger(text);
  expect(back.body).toBe('summary');
  expect(new Set(back.lines).size).toBe(back.lines.length);
  expect(back.lines.at(-1)).toContain('tk-399');
  expect(back.lines.length).toBeLessThan(400);
  expect(text).toContain('older entries dropped');
  expect(ledgerLines([call('a', 'setEnvVar', { key: 'K', value: 'sk-' + 'a'.repeat(30) }), result('a', 'setEnvVar', { ok: true })])).toHaveLength(1);
  expect(withLedger('s', ledgerLines([call('a', 'setEnvVar', { value: 'sk-' + 'a'.repeat(30) }), result('a', 'setEnvVar', { ok: true })]))).not.toContain('sk-aaaa');
});

test('saved tool steps keep their call/result structure and real content', () => {
  const doc = 'Section text. '.repeat(2500); // 35k chars: a document the agent read
  const steps = [call('a', 'getFileContent', { id: 'doc-1' }), result('a', 'getFileContent', doc), { role: 'assistant', content: 'Read it.' }];
  const kept = compactToolSteps(steps);
  expect(kept).toHaveLength(3);
  expect(kept[1].content[0].output.value).toBe(doc);          // was cut to ~3.6k
  expect(steps[1].content[0].output.value).toBe(doc);          // original untouched
  // Far over the per-turn cap: results shrink, the shape does not turn into prose.
  const many: any[] = [];
  for (let i = 0; i < 40; i++) many.push(call('c' + i, 'readUrl', { url: 'u' + i }), result('c' + i, 'readUrl', 'x'.repeat(39000)));
  const bounded = compactToolSteps(many, 200_000);
  expect(bounded).toHaveLength(80);
  expect(bounded.every((m: any) => Array.isArray(m.content))).toBe(true);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(200_000);
  expect(JSON.stringify(bounded)).not.toContain('Summary of prior tool activity');
  const skill = compactToolSteps([call('s', 'loadSkill', { id: 'x' }), result('s', 'loadSkill', { found: true, id: 'x', instructions: 'i'.repeat(90000) })], 1000);
  expect(skill[1].content[0].output.value.instructions.length).toBe(90000);
  expect(toolDigest(steps)).toContain('getFileContent({"id":"doc-1"})');
});

test("the server's turn context rides on the user's message, which stays last", () => {
  const messages: any[] = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Why did the call drop?' }];
  expect(appendToLastUser(messages, turnContextBlock(['Recent background operation results: built', 'Saved notes: login']))).toBe(true);
  expect(messages.at(-1).role).toBe('user');
  expect(messages.at(-1).content.startsWith('Why did the call drop?')).toBe(true);
  expect(messages.at(-1).content).toContain('not written by the user');
  expect(messages.every((m) => m.role !== 'system')).toBe(true);
  const multi: any[] = [{ role: 'user', content: [{ type: 'text', text: 'see image' }, { type: 'image', image: new Uint8Array(2) }] }];
  appendToLastUser(multi, turnContextBlock(['note']));
  expect(multi[0].content).toHaveLength(3);
  expect(turnContextBlock([])).toBe('');
  expect(appendToLastUser([{ role: 'assistant', content: 'x' }], 'ctx')).toBe(false);
});

test('provider context-overflow errors are recognized; other errors are not', () => {
  expect(isContextOverflow({ message: 'Your input exceeds the context window of this model.' })).toBe(true);
  expect(isContextOverflow({ code: 'context_length_exceeded', message: 'ChatGPT subscription request failed.' })).toBe(true);
  expect(isContextOverflow({ message: 'prompt is too long: 210000 tokens > 200000 maximum' })).toBe(true);
  expect(isContextOverflow({ message: "This model's maximum context length is 128000 tokens" })).toBe(true);
  expect(isContextOverflow({ message: 'You have hit your ChatGPT usage limit' })).toBe(false);
  expect(isContextOverflow({ message: 'rate_limit_exceeded' })).toBe(false);
  expect(isContextOverflow(undefined)).toBe(false);
});

// These three use a real in-memory SQLite database, so they need the SQLite schema:
//   DATABASE_DRIVER=sqlite DATABASE_URL=:memory: bun test tests/chat-agent-context.test.ts
const dbTest = process.env.DATABASE_DRIVER === 'postgresql' ? test.skip : test;
function memoryStore() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE conversation (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER, user_role TEXT, content_if_file TEXT, tool_steps TEXT);
    CREATE TABLE conversation_context (conversation_id TEXT PRIMARY KEY, summary TEXT NOT NULL, through_id TEXT NOT NULL, through_at INTEGER NOT NULL);
    CREATE TABLE conversation_plan (conversation_id TEXT PRIMARY KEY, items TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));`);
  return { sqlite, store: drizzle(sqlite) as any };
}

dbTest('a handoff written mid-turn becomes the checkpoint the next turn starts from', async () => {
  const { sqlite, store } = memoryStore();
  const insert = sqlite.prepare('INSERT INTO message (id, conversation_id, role, content, created_at, user_role, content_if_file) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 6; i++) insert.run('m' + i, 'c', i % 2 ? 'assistant' : 'user', 'text ' + i, 100 + i, 'default', '[]');
  await saveConversationCheckpoint('c', withLedger('mid-turn summary', ['- startEpic({}) → {"epicId":"epic-1"}']), { id: 'm3', createdAt: new Date(103 * 1000) }, store);
  const next = await loadConversationHandoff('c', async () => { throw new Error('reading only'); }, store, { compact: false });
  expect(next?.throughId).toBe('m3');
  expect(String(next?.message.content)).toContain('mid-turn summary');
  expect(String(next?.message.content)).toContain('epic-1');
  // A later, newer handoff replaces it.
  await saveConversationCheckpoint('c', 'newer', { id: 'm5', createdAt: new Date(105 * 1000) }, store);
  expect((await loadConversationHandoff('c', async () => '', store, { compact: false }))?.throughId).toBe('m5');
  sqlite.close();
});

dbTest('the rolling handoff records tool work the reply never mentioned, and only condenses early when overdue', async () => {
  const { sqlite, store } = memoryStore();
  const insert = sqlite.prepare('INSERT INTO message (id, conversation_id, role, content, created_at, user_role, content_if_file, tool_steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const steps = JSON.stringify([call('t', 'createTickets', { tickets: [{ name: 'Refunds' }] }), result('t', 'createTickets', { created: [{ id: 'tk-9', key: 'PAY-9' }] }), { role: 'assistant', content: 'Done.' }]);
  for (let i = 0; i < 44; i++) insert.run('m' + String(i).padStart(3, '0'), 'c', i % 2 ? 'assistant' : 'user', i % 2 ? 'Done.' : 'next ' + i, 100 + i, 'default', '[]', i === 1 ? steps : null);
  // 44 unsummarized rows is not overdue: a turn start only reads.
  expect(await loadConversationHandoff('c', async () => { throw new Error('not overdue'); }, store, { compact: 'overdue' })).toBeNull();
  const seen: string[] = [];
  const handoff = await loadConversationHandoff('c', async (e) => { seen.push(e); return 'rolling summary'; }, store);
  expect(seen.join('\n')).toContain('Tool activity in this turn');
  expect(seen.join('\n')).toContain('createTickets(');
  expect(String(handoff?.message.content)).toContain('PAY-9'); // via the ledger, though the summary omitted it
  // Next refresh: the ledger is lifted out before the model sees the previous handoff, and survives.
  for (let i = 44; i < 130; i++) insert.run('m' + String(i).padStart(3, '0'), 'c', i % 2 ? 'assistant' : 'user', 'later ' + i, 100 + i, 'default', '[]', null);
  const again: string[] = [];
  const overdue = await loadConversationHandoff('c', async (e) => { again.push(e); return 'second rolling summary'; }, store, { compact: 'overdue' });
  expect(again.length).toBeGreaterThan(0);                     // over 80 unsummarized rows: condensed before the turn
  expect(again.join('\n')).not.toContain('actions-ledger');
  expect(String(overdue?.message.content)).toContain('PAY-9');
  sqlite.close();
});

dbTest('the plan is stored per conversation, shown while open, and silent once finished', async () => {
  const { sqlite, store } = memoryStore();
  const updates: string[] = [];
  const { updatePlan } = planTools({ conversationId: 'c', onUpdate: items => updates.push(planProgress(items)) }, store);
  const run = (items: any[]) => (updatePlan as any).execute({ items }, {});
  expect(await run([{ step: 'Write PRD', status: 'done', note: 'doc-91bc' }, { step: 'Build INV-1', status: 'in_progress' }, { step: 'Verify PDF', status: 'pending' }]))
    .toEqual({ saved: true, progress: 'Plan 1/3 done · now: Build INV-1' });
  const text = formatPlan(await readPlan('c', store));
  expect(text).toContain('1. [x] Write PRD — doc-91bc');
  expect(text).toContain('2. [>] Build INV-1');
  await run([{ step: 'Write PRD', status: 'done' }, { step: 'Build INV-1', status: 'done' }]);
  expect(formatPlan(await readPlan('c', store))).toBe('');
  expect(await readPlan('other', store)).toEqual([]);
  expect(updates).toHaveLength(2);
  sqlite.close();
});

test('ticket outcome events ask for a re-check, never grant approval', () => {
  const done = ticketEventMessage({ kind: 'change_done', ticket: 'INV-2 — PDF export', ticketId: 'tk-2', detail: 'Merged into feature/invoicing.' });
  expect(done).toContain('not approval for new work');
  expect(done).toContain('re-run the check');
  expect(done).toContain('do not start builds');
  const failed = ticketEventMessage({ kind: 'failed', ticket: 'INV-1', ticketId: 'tk-1', detail: 'x'.repeat(5000) });
  expect(failed).toContain('Ask before retrying');
  expect(failed.length).toBeLessThan(2400);
});
