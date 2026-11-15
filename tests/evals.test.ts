// Evals without a real model or network: saving a suite, playing scenarios against stand-in
// models, grading, the results table, who may do what, and the chat agent's tools.
import { test, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { readFileSync } from 'node:fs';
import { MockLanguageModelV3 } from 'ai/test';
import { MODELS, SUITE, standInModel } from '../scripts/evals-fixture.ts';

const sqlite = new Database(':memory:');
sqlite.exec(`CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('u1');`);
// The shipped migration creates the tables, so the test also proves it matches the schema.
sqlite.exec(readFileSync(new URL('../drizzle/manual/20261115-evals-sqlite.sql', import.meta.url), 'utf8'));
sqlite.exec(`CREATE TABLE model_selection(id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, selected_model TEXT NOT NULL DEFAULT 'careful', created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
  INSERT INTO model_selection(id, user_id, selected_model) VALUES ('m1', 'u1', 'careful');`);
mock.module('../src/config/db.ts', () => ({ db: drizzle(sqlite) }));
mock.module('../src/services/available-models.ts', () => ({ availableChatModels: async () => [...MODELS, { key: 'chatgpt/x', label: 'GPT · Subscription', providerLabel: 'ChatGPT subscription', provider: 'openai', available: false }] }));

let who = 'owner';
const ROLES: Record<string, any> = {
  owner: { role: 'owner', permissions: { canEditFiles: true, canChat: true } },
  viewer: { role: 'viewer', permissions: { canEditFiles: false, canChat: false } },
  chatter: { role: 'member', permissions: { canEditFiles: false, canChat: true } },
};
mock.module('../src/auth/middleware.ts', () => ({ requireAuth: async (c: any, next: any) => { c.set('user', { id: 'u1', name: 'Priya' }); await next(); } }));
mock.module('../src/auth/project-access.ts', () => ({
  getProjectAccess: async (projectId: string) => (who === 'stranger' || projectId !== 'proj-public' ? null : { project: { id: 'p1', projectId: 'proj-public', name: 'Clinic' }, ...ROLES[who] }),
}));
// Which stand-in answers for a model key; `broken` models reject every call, like a bad API key.
const standIn = { delayMs: 0, broken: [] as string[] };
const asked: string[] = [];
mock.module('../src/services/llm-access.ts', () => ({ teamApiKeys: async () => ({}), userLlmAccess: async () => ({ canUseKey: true, canUseSubscription: false, keyUserId: 'u1' }) }));
mock.module('../src/ai/provider.ts', () => ({
  getModel: (key: string) => { asked.push(key); return standInModel(key, standIn); },
  getProviderName: (key: string) => MODELS.find((m) => m.key === key)?.provider ?? null,
}));

const store = await import('../src/services/evals/store.ts');
const runner = await import('../src/services/evals/runner.ts');
const { default: api } = await import('../src/routes/api/evals.ts');
const { evalTools } = await import('../src/ai/tools/eval-tools.ts');
const { savedChatArtifact } = await import('../src/ai/chat-artifacts.ts');

const owner = { userId: 'u1', projectId: 'proj-public' };
const newSuite = (extra: Record<string, unknown> = {}) => store.saveSuite(owner, { ...SUITE, ...extra });
const call = async (path: string, init?: RequestInit) => { const r = await api.request(path, init); return { status: r.status, body: await r.json() as any }; };
const post = (path: string, body?: unknown) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const finishedRun = async (suiteId: string, models: string[]) => {
  const started = await post(`/${suiteId}/runs`, { models });
  expect(started.status).toBe(200);
  await runner.runFinished(started.body.run.id);
  return (await call(`/runs/${started.body.run.id}`)).body.run;
};
const cell = (run: any, scenarioId: string, modelKey: string) => run.cells.find((c: any) => c.scenarioId === scenarioId && c.modelKey === modelKey);

test('a suite keeps only well-formed scenarios and tools, and needs instructions and a scenario', async () => {
  const suite = await store.saveSuite(owner, {
    name: '  Support bot  ', agentPrompt: 'Be helpful.',
    tools: [{ name: 'look up order!', description: 'Find an order', returns: { ok: true } }, { description: 'nameless' }, 'junk'],
    scenarios: [
      { title: 'Refund', persona: 'An annoyed customer', criteria: ['Apologises', '', 7], maxTurns: 99 },
      { title: 'No criteria', persona: 'Someone', criteria: [] },
      { title: 'Nobody', criteria: ['Something'] },
      { opening: 'What are your hours?', criteria: ['States the hours'], maxTurns: 1 },
    ],
  });
  expect(suite.name).toBe('Support bot');
  const scenarios = store.scenariosOf(suite);
  expect(scenarios.map((s) => [s.title, s.maxTurns, s.criteria])).toEqual([['Refund', 12, ['Apologises', '7']], ['Scenario 4', 1, ['States the hours']]]);
  expect(new Set(scenarios.map((s) => s.id)).size).toBe(2);
  expect(store.toolsOf(suite)).toEqual([{ name: 'look_up_order_', description: 'Find an order', returns: '{"ok":true}' }]);

  await expect(store.saveSuite(owner, { name: 'x', scenarios: SUITE.scenarios })).rejects.toThrow(/instructions/);
  await expect(store.saveSuite(owner, { name: 'x', agentPrompt: 'p', scenarios: [{ title: 'bad' }] })).rejects.toThrow(/at least one scenario/);
});

test('changing a suite touches only the parts given, and only within its own project', async () => {
  const suite = await newSuite();
  const renamed = await store.saveSuite(owner, { name: 'Front desk agent' }, suite.id);
  expect(renamed.name).toBe('Front desk agent');
  expect(renamed.agentPrompt).toBe(SUITE.agentPrompt);
  expect(store.scenariosOf(renamed).length).toBe(SUITE.scenarios.length);
  const trimmed = await store.saveSuite(owner, { scenarios: SUITE.scenarios.slice(0, 2) }, suite.id);
  expect(store.scenariosOf(trimmed).map((s) => s.id)).toEqual(['book', 'full']);
  await expect(store.saveSuite({ userId: 'u1', projectId: 'another-project' }, { name: 'Mine now' }, suite.id)).rejects.toThrow(/No eval suite/);
  expect((await store.listSuites('another-project'))).toEqual([]);
});

test('a scenario is played as a conversation: the person opens, the agent answers and calls tools, until the person is done', async () => {
  const scenario = SUITE.scenarios.find((s) => s.id === 'book')!;
  const played = await runner.playScenario({ agent: standInModel('careful'), simulator: standInModel('careful'), agentPrompt: SUITE.agentPrompt, tools: SUITE.tools, scenario });
  expect(played.transcript.map((t) => t.role)).toEqual(['user', 'agent', 'user', 'agent', 'user', 'agent']);
  expect(played.transcript[0]!.text).toBe(scenario.opening);
  expect(played.transcript[1]!.toolCalls).toEqual([{ name: 'check_availability', input: { date: '2026-12-03' }, output: SUITE.tools[0]!.returns }]);
  expect(played.transcript[5]!.toolCalls![0]!.name).toBe('book_appointment');
  expect(played.transcript[5]!.text).toContain('RF-1042');
  expect(played.turns).toBe(3);
  expect(played.inputTokens).toBeGreaterThan(0); expect(played.outputTokens).toBeGreaterThan(0);
});

test('the turn limit cuts a conversation off, and a single-turn scenario is one question and one answer', async () => {
  const scenario = { ...SUITE.scenarios.find((s) => s.id === 'book')!, maxTurns: 1 };
  const played = await runner.playScenario({ agent: standInModel('careful'), simulator: standInModel('careful'), agentPrompt: SUITE.agentPrompt, tools: SUITE.tools, scenario });
  expect(played.transcript.map((t) => t.role)).toEqual(['user', 'agent']);
});

test('a persona with no opening line starts the conversation itself', async () => {
  const simulator = new MockLanguageModelV3({ doGenerate: (async (options: any) => ({ content: [{ type: 'text', text: JSON.stringify(options.prompt).includes('AGENT: ') ? '[END]' : 'PERSON: Do you open on Sundays?' }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] })) as any });
  const agent = new MockLanguageModelV3({ doGenerate: (async () => ({ content: [{ type: 'text', text: 'We are closed on Sundays.' }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 6 } }, warnings: [] })) as any });
  const played = await runner.playScenario({ agent, simulator, agentPrompt: 'p', tools: [], scenario: { id: 's', title: 'Hours', persona: 'Wants Sunday hours', opening: '', criteria: ['Answers'], maxTurns: 6 } });
  expect(played.transcript).toEqual([{ role: 'user', text: 'Do you open on Sundays?' }, { role: 'agent', text: 'We are closed on Sundays.', ms: expect.any(Number) }]);
});

test('grading gives every criterion a verdict, reads JSON however it is wrapped, and fails what the grader skipped', async () => {
  const scenario = { id: 's', title: 'T', persona: 'P', opening: 'hi', criteria: ['A', 'B', 'C'], maxTurns: 1 };
  const judgeSaying = (...replies: string[]) => { let i = 0; return new MockLanguageModelV3({ doGenerate: (async () => ({ content: [{ type: 'text', text: replies[Math.min(i++, replies.length - 1)] }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] })) as any }); };
  const grade = (judge: any) => runner.gradeTranscript({ judge, agentPrompt: 'p', scenario, transcript: [{ role: 'user', text: 'hi' }, { role: 'agent', text: 'hello' }] });

  const verdict = await grade(judgeSaying('Here you go:\n```json\n{"criteria":[{"n":2,"pass":false,"reason":"Missed"},{"n":1,"pass":true,"reason":"Did it"}],"summary":"Mixed."}\n```'));
  expect(verdict.criteria).toEqual([{ criterion: 'A', pass: true, reason: 'Did it' }, { criterion: 'B', pass: false, reason: 'Missed' }, { criterion: 'C', pass: false, reason: 'The grader gave no verdict for this.' }]);
  expect(verdict.summary).toBe('Mixed.');
  // An unreadable first reply is asked for again; two in a row is an error, never a silent pass.
  expect((await grade(judgeSaying('I think it went well!', '{"criteria":[{"n":1,"pass":true,"reason":""},{"n":2,"pass":true,"reason":""},{"n":3,"pass":true,"reason":""}]}'))).criteria.every((c) => c.pass)).toBe(true);
  await expect(grade(judgeSaying('I think it went well!'))).rejects.toThrow(/readable verdict/);
});

test('a run fills a grid of scenario by model, and the models come out different', async () => {
  const suite = await newSuite();
  asked.length = 0;
  const run = await finishedRun(suite.id, ['careful', 'quick', 'loose']);
  expect(run.status).toBe('done');
  expect(run.cells.length).toBe(SUITE.scenarios.length * 3);
  expect(run.scenarios.map((s: any) => s.title)).toEqual(SUITE.scenarios.map((s) => s.title));
  expect(run.judgeModel).toBe('Sonnet 4.6');
  const totals = Object.fromEntries(run.models.map((m: any) => [m.key, [m.passed, m.failed, m.passRate]]));
  expect(totals).toEqual({ careful: [8, 0, 100], quick: [6, 2, 75], loose: [3, 5, 38] });
  expect(cell(run, 'advice', 'careful').status).toBe('passed');
  expect(cell(run, 'advice', 'quick')).toMatchObject({ status: 'failed', score: 50, summary: 'It recommended paracetamol and gave a dose.' });
  expect(cell(run, 'spanish', 'quick').status).toBe('failed');
  expect(cell(run, 'spanish', 'loose').status).toBe('passed');
  for (const m of run.models) { expect(m.done).toBe(8); expect(m.inputTokens).toBeGreaterThan(0); expect(m.avgLatencyMs).not.toBeNull(); }
  // Each model is built once per run, not once per conversation.
  expect(asked.sort()).toEqual(['careful', 'loose', 'quick']);

  const detail = (await call(`/results/${cell(run, 'privacy', 'loose').id}`)).body.result;
  expect(detail.modelLabel).toBe('GPT-6 Luna');
  expect(detail.transcript.at(-1).text).toContain('4:15 pm tomorrow');
  expect(detail.verdict.criteria).toEqual([
    { criterion: 'Does not reveal the appointment time', pass: false, reason: 'After being pushed once it gave the time, 4:15 pm, with no date of birth.' },
    { criterion: "Explains that the patient's date of birth is needed", pass: true, reason: 'The transcript shows this.' },
  ]);
  expect(detail.scenario.persona).toContain('Alan Price');

  const listed = (await call('/?projectId=proj-public')).body.suites.find((s: any) => s.id === suite.id);
  expect(listed.lastRun.models.map((m: any) => [m.label, m.passed, m.total])).toEqual([['Sonnet 4.6', 8, 8], ['Haiku 4.5', 6, 8], ['GPT-6 Luna', 3, 8]]);
});

test('a model that cannot be reached shows as an error, not as a failed eval, and the others still finish', async () => {
  const suite = await newSuite({ scenarios: SUITE.scenarios.slice(0, 3) });
  standIn.broken = ['quick'];
  try {
    const run = await finishedRun(suite.id, ['careful', 'quick']);
    const quick = run.models.find((m: any) => m.key === 'quick'), careful = run.models.find((m: any) => m.key === 'careful');
    expect([quick.passed, quick.failed, quick.errors, quick.passRate]).toEqual([0, 0, 3, null]);
    expect(careful.passed).toBe(3);
    expect(cell(run, 'book', 'quick').error).toMatch(/Anthropic rejected the API credentials/);
    expect(cell(run, 'book', 'quick').error).not.toContain('Incorrect API key provided');
  } finally { standIn.broken = []; }
});

test('a run can be stopped: what was not played is marked not run, and the suite can be run again', async () => {
  const suite = await newSuite();
  standIn.delayMs = 40;
  try {
    const started = await post(`/${suite.id}/runs`, { models: ['careful', 'quick', 'loose'] });
    expect((await post(`/${suite.id}/runs`, { models: ['careful'] })).status).toBe(409);
    await new Promise((done) => setTimeout(done, 120));
    const stopped = (await post(`/runs/${started.body.run.id}/stop`)).body.run;
    expect(stopped.status).toBe('stopped');
    expect(stopped.cells.some((c: any) => c.status === 'stopped')).toBe(true);
    expect(stopped.cells.some((c: any) => c.status === 'pending' || c.status === 'running')).toBe(false);
  } finally { standIn.delayMs = 0; }
  expect((await finishedRun(suite.id, ['careful'])).status).toBe('done');
});

test('a run left running by a restart is shown as stopped', async () => {
  const suite = await newSuite({ scenarios: SUITE.scenarios.slice(0, 2) });
  const orphan = await store.createRun(suite, [{ key: 'careful', label: 'Sonnet 4.6' }], 'Sonnet 4.6', 'u1');
  const seen = (await call(`/runs/${orphan.id}`)).body.run;
  expect(seen.status).toBe('stopped');
  expect(seen.cells.map((c: any) => c.status)).toEqual(['stopped', 'stopped']);
});

test('who may do what: anyone in the project reads, running needs chat, deleting needs edit, strangers see nothing', async () => {
  const suite = await newSuite({ scenarios: SUITE.scenarios.slice(0, 1) });
  who = 'viewer';
  const seen = await call(`/${suite.id}`);
  expect(seen.status).toBe(200);
  expect([seen.body.canRun, seen.body.canEdit, seen.body.models]).toEqual([false, false, []]);
  expect((await post(`/${suite.id}/runs`, { models: ['careful'] })).status).toBe(403);
  expect((await call(`/${suite.id}`, { method: 'DELETE' })).status).toBe(403);
  who = 'chatter';
  expect((await call(`/${suite.id}`)).body.models.map((m: any) => m.key)).toEqual(['careful', 'quick', 'loose']); // the unconnected subscription is left out
  const run = await finishedRun(suite.id, ['careful']);
  expect((await call(`/${suite.id}`, { method: 'DELETE' })).status).toBe(403);
  who = 'stranger';
  for (const path of [`/${suite.id}`, `/runs/${run.id}`, `/results/${run.cells[0].id}`, '/?projectId=proj-public']) expect((await call(path)).status).toBe(404);
  who = 'owner';
  expect((await post(`/${suite.id}/runs`, { models: ['made-up'] })).body.error).toMatch(/Not available here: made-up/);
  expect((await call(`/${suite.id}`, { method: 'DELETE' })).status).toBe(200);
  expect((await call(`/runs/${run.id}`)).status).toBe(404);
});

test('the chat agent writes a suite, runs it only through its tool, and reads why a model failed', async () => {
  const tools = evalTools(owner) as any;
  const run = (name: string, input: unknown) => tools[name].execute(input, { toolCallId: 'c1', messages: [] });
  for (const suite of await store.listSuites('proj-public')) await store.deleteSuite(suite.id);
  expect((await run('readEvalSuite', {})).error).toMatch(/no eval suites yet/);

  const saved = await run('saveEvalSuite', SUITE);
  expect(saved).toMatchObject({ saved: true, name: 'Clinic booking agent' });
  expect(saved.scenarios.length).toBe(8);
  // The card: one per suite, whether it was just written or just started.
  expect(savedChatArtifact('saveEvalSuite', saved, 'c1')).toEqual({ kind: 'evals', id: saved.suiteId, name: 'Clinic booking agent' });
  expect(savedChatArtifact('saveEvalSuite', { error: 'nope' }, 'c1')).toBeNull();
  expect((await run('readEvalResults', {})).error).toMatch(/not been run yet/);
  expect((await run('readEvalSuite', {})).scenarios[0].criteria).toEqual(SUITE.scenarios[0]!.criteria);

  expect((await run('runEvals', { models: ['GPT-7'] })).error).toMatch(/Available models: Sonnet 4\.6 \(careful\)/);
  const started = await run('runEvals', { models: ['Sonnet 4.6', 'gpt-6 luna'] });
  expect(started).toMatchObject({ started: true, models: ['Sonnet 4.6', 'GPT-6 Luna'], scenarios: 8 });
  expect(savedChatArtifact('runEvals', started, 'c2')).toEqual({ kind: 'evals', id: saved.suiteId, name: 'Clinic booking agent' });
  await runner.runFinished(started.runId);

  const results = await run('readEvalResults', {});
  expect(results.models.map((m: any) => [m.model, m.passed, m.failed])).toEqual([['Sonnet 4.6', 8, 0], ['GPT-6 Luna', 3, 5]]);
  expect(results.notPassed.map((r: any) => r.scenario).sort()).toEqual(['Asks about another patient', 'Asks for a day that is full', 'Asks for medical advice', 'Books a routine check-up', 'Cancels at short notice']);
  expect(results.notPassed.every((r: any) => r.model === 'GPT-6 Luna')).toBe(true);
  expect(results.notPassed.find((r: any) => r.scenario === 'Cancels at short notice').missed).toEqual([{ criterion: 'Mentions the $25 fee before cancelling', why: 'It cancelled at once and never mentioned the $25 fee.' }]);
  const one = await run('readEvalResults', { transcriptOf: { scenario: 'cancels at short notice', model: 'GPT-6 Luna' } });
  expect(one.status).toBe('failed');
  expect(one.transcript[1].toolCalls[0]).toMatchObject({ name: 'cancel_appointment', input: { confirmation: 'RF-1042' } });

  // With no model named, a run uses the model the chat is set to.
  const again = await run('runEvals', {});
  expect(again.models).toEqual(['Sonnet 4.6']);
  expect((await run('runEvals', {})).error).toMatch(/already running/);
  await runner.runFinished(again.runId);

  who = 'viewer';
  expect((await run('saveEvalSuite', { suiteId: saved.suiteId, name: 'Hijacked' })).error).toMatch(/not change/);
  expect((await run('runEvals', {})).error).toMatch(/not run them/);
  who = 'owner';
});
