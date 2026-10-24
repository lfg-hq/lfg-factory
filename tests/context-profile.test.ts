import { test, expect, afterEach } from 'bun:test';
import { contextProfile, recordTokenScale, tokenScale } from '../src/ai/context-profile.ts';
import { compactContext, estimateContextTokens } from '../src/ai/context-compaction.ts';
import { createPiSubscriptionModel } from '../src/ai/pi-subscription-model.ts';

afterEach(() => { delete process.env.CHAT_CONTEXT_BUDGET_TOKENS; });

test('each model gets its own budget, capped per connection type', () => {
  // ChatGPT subscription: 93% of Astra's 272k window, condensing at ~190k (was 96k for every model).
  expect(contextProfile('chatgpt/gpt-6-astra')).toEqual({ route: 'subscription', window: 272000, budget: 252960 });
  // API keys pay per input token: the same model is capped by the cost ceiling.
  expect(contextProfile('gpt-6-astra')).toMatchObject({ route: 'api', window: 272000, budget: 200000 });
  expect(contextProfile('claude_4.6_sonnet')).toMatchObject({ window: 1000000, budget: 200000 });
  expect(contextProfile('claude_4.5_haiku').budget).toBe(186000);
  expect(contextProfile('glm_5.2').window).toBe(200000); // from llm-models.json
  expect(contextProfile('unknown-model').budget).toBe(Math.floor(128000 * 0.93));
});

test('an operator-set fixed budget still applies to every model', () => {
  process.env.CHAT_CONTEXT_BUDGET_TOKENS = '128000';
  expect(contextProfile('chatgpt/gpt-6-astra').budget).toBe(128000);
});

test('real token counts calibrate the estimate, within bounds', () => {
  expect(tokenScale('c1')).toBe(1);
  // The failed turn: OpenAI counted 64,099 where we estimated ~93,000.
  expect(recordTokenScale('c1', 64099, 93000)).toBeCloseTo(0.69, 2);
  expect(tokenScale('c1')).toBeCloseTo(0.69, 2);
  expect(recordTokenScale('c2', 1000, 100000)).toBe(0.35); // never trusts one odd step too far
  expect(recordTokenScale('c3', 200000, 100000)).toBe(1);  // never inflates past the raw estimate
  expect(recordTokenScale('c4', undefined, 1000)).toBeNull();
});

const big = (n: number) => 'x'.repeat(n);
const turn = (i: number, size: number): any[] => [
  { role: 'user', content: 'request ' + i },
  { role: 'assistant', content: [{ type: 'tool-call', toolName: 'read', toolCallId: 't' + i, input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolName: 'read', toolCallId: 't' + i, output: { type: 'text', value: big(size) } }] },
  { role: 'assistant', content: 'done ' + i },
];
// Long assistant replies: nothing the free steps can shorten, so only a summary helps.
const chatty = (i: number): any[] => [{ role: 'user', content: 'ask ' + i }, { role: 'assistant', content: 'answer ' + i + ' ' + big(6000) }];

test('the conversation that failed would not condense under its real budget', async () => {
  const rows = [...turn(1, 120000), ...turn(2, 120000)]; // ~80k raw estimate
  const { budget } = contextProfile('chatgpt/gpt-6-astra');
  const out = await compactContext(rows, 13000, async () => { throw new Error('should not summarize'); }, budget, undefined, undefined, { scale: 0.69 });
  expect(out).toBe(rows);
});

test('older images are dropped before any summary; the current request keeps its screenshots', async () => {
  const img = { type: 'image', image: 'data', mediaType: 'image/png' };
  const rows: any[] = [
    { role: 'user', content: [{ type: 'text', text: 'old' }, img, img, img, img, img, img] },
    { role: 'assistant', content: 'seen' },
    { role: 'user', content: [{ type: 'text', text: 'now' }, img] },
  ];
  const stages: string[] = [];
  const out = await compactContext(rows, 0, async () => { throw new Error('should not summarize'); }, 16000, undefined, undefined, { onStage: s => stages.push(s) });
  expect(stages).toEqual(['images']);
  expect(JSON.stringify(out[0])).toContain('Earlier image or file omitted');
  expect(out[2]).toEqual(rows[2]);
});

test('a failed summary drops older history instead of failing the turn', async () => {
  const rows = [...chatty(1), ...chatty(2), ...chatty(3), { role: 'user', content: 'latest' } as any];
  const stages: string[] = [];
  const out = await compactContext(rows, 0, async () => { throw new Error('summarizer down'); }, 6000, undefined, undefined, { onStage: s => stages.push(s) });
  expect(stages).toContain('fallback');
  expect(JSON.stringify(out[0])).toContain('Earlier conversation was omitted');
  expect(out.at(-1)).toEqual(rows.at(-1));
});

test('a cancelled turn is not swallowed by the fallback', async () => {
  const rows = [...chatty(1), ...chatty(2), ...chatty(3), { role: 'user', content: 'latest' } as any];
  const abort = new AbortController(); abort.abort();
  await expect(compactContext(rows, 0, async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, 6000, undefined, undefined, { signal: abort.signal })).rejects.toThrow('aborted');
});

test('only a request too large on its own still fails, with our own message', async () => {
  await expect(compactContext([{ role: 'user', content: big(60000) }], 0, async () => 's', 16000)).rejects.toThrow('too large for the model');
});

test('the subscription sends the conversation as its prompt cache key', async () => {
  let seen: any;
  const transport: any = (_m: any, _c: any, opts: any) => { seen = opts; return (async function* () { yield { type: 'done', reason: 'stop', message: { content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } } }; })(); };
  const model = createPiSubscriptionModel('gpt-6-astra', async () => 'token', transport);
  const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], providerOptions: { openai: { promptCacheKey: 'conv-1' } } } as any);
  const reader = stream.getReader(); while (!(await reader.read()).done) { /* drain */ }
  expect(seen.sessionId).toBe('conv-1');
});
