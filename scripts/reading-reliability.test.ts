import { test, expect } from 'bun:test';
import { readingBudget, abortable, repositoryFetch, withRepositorySignal, ReadingError } from '../src/services/reading-budget.ts';
import { recoverCodebaseQuery } from '../src/services/codebase-query-api.ts';
import { readingTools } from '../src/ai/reading-policy.ts';

test('idle limit and overall budget are distinct; activity only resets idle', async () => {
  const idle = readingBudget(undefined, 500, 10);
  await expect(abortable(new Promise(() => {}), idle.signal)).rejects.toMatchObject({ code: 'investigation_idle' });
  idle.dispose();
  const busy = readingBudget(undefined, 40, 20);
  const tick = setInterval(busy.activity, 5);
  try { await expect(abortable(new Promise(() => {}), busy.signal)).rejects.toMatchObject({ code: 'investigation_budget' }); }
  finally { clearInterval(tick); busy.dispose(); }
});

test('parent cancellation retains the exact reason', async () => {
  const parent = new AbortController();
  const budget = readingBudget(parent.signal);
  const reason = new Error('User stopped');
  parent.abort(reason);
  expect(budget.signal.reason).toBe(reason);
  budget.dispose();
});

test('partial findings survive interruption with the correct failure classification', () => {
  const partial = recoverCodebaseQuery(new ReadingError('repository_timeout', 'Search timed out'), 'Found duplicated styles.', [], 'feature/ui');
  expect(partial.answer).toBe('Found duplicated styles.');
  expect(partial.branch).toBe('feature/ui');
  expect(partial.incomplete).toContain('repository_timeout');
  const step = recoverCodebaseQuery(new Error('Model unavailable'), '', [{ text: 'The layout uses shared CSS.' }]);
  expect(step.answer).toContain('shared CSS');
  expect(step.incomplete).not.toContain('180');
});

test('repository body timeout, cancellation, and concurrent scope isolation', async () => {
  const original = globalThis.fetch;
  const signals: AbortSignal[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    signals.push(init.signal);
    return { arrayBuffer: () => new Promise(() => {}), status: 200, headers: new Headers() };
  }) as any;
  try {
    await expect(repositoryFetch('https://example.invalid', {}, 10)).rejects.toMatchObject({ code: 'repository_timeout' });
    expect(signals[0]!.aborted).toBe(true);
    const a = new AbortController(), b = new AbortController();
    const first = withRepositorySignal(a.signal, () => repositoryFetch('https://example.invalid', {}, 500));
    const second = withRepositorySignal(b.signal, () => repositoryFetch('https://example.invalid', {}, 500));
    const reason = new Error('cancel A');
    a.abort(reason);
    await expect(first).rejects.toBe(reason);
    expect(signals[2]!.aborted).toBe(false);
    b.abort(new Error('cancel B'));
    await expect(second).rejects.toThrow('cancel B');
  } finally { globalThis.fetch = original; }
});

test('document-first guard, duplicate reads, failed scan cap, per-turn isolation', async () => {
  let scans = 0;
  const original = {
    getFileContent: { execute: async () => ({ found: true, content: 'audit' }) },
    queryCodebase: { execute: async () => { scans++; return { error: 'repository unavailable' }; } },
  };
  const a = readingTools(original, 'Read the frontend audit report and suggest improvements');
  expect((await a.queryCodebase.execute({ question: 'frontend' }, {})).error).toContain('document first');
  expect(scans).toBe(0);
  await a.getFileContent.execute({}, {});
  await Promise.all([a.queryCodebase.execute({ question: 'frontend' }, {}), a.queryCodebase.execute({ question: 'frontend' }, {})]);
  expect(scans).toBe(1);
  await a.queryCodebase.execute({ question: 'narrower' }, {});
  expect((await a.queryCodebase.execute({ question: 'another' }, {})).error).toContain('Stop scanning');
  expect(scans).toBe(2);
  const b = readingTools(original, 'Read the audit report');
  expect((await b.queryCodebase.execute({ question: 'frontend' }, {})).error).toContain('document first');
  expect(original.queryCodebase.execute).not.toBe(a.queryCodebase.execute);
});

test('repository cache reuses data but separates credentials and turns', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response('file contents'); }) as any;
  try {
    const controller = new AbortController();
    const cache = new Map<string, Response>();
    const read = (auth: string, target = cache) => withRepositorySignal(controller.signal,
      () => repositoryFetch('https://example.invalid/file', { headers: { Authorization: auth } }), undefined, target);
    expect(await (await read('A')).text()).toBe('file contents');
    expect(await (await read('A')).text()).toBe('file contents');
    expect(requests).toBe(1);
    await read('B');
    await read('A', new Map());
    expect(requests).toBe(3);
  } finally { globalThis.fetch = original; }
});
