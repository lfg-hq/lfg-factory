// TEST-ONLY fixtures: isolated SQLite, deterministic AI SDK model and Git HTTP responses.
// These are not evidence of a real model call or a production PR mutation.
import { test, expect, mock, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { eq, getTableColumns } from 'drizzle-orm';
import { MockLanguageModelV3 } from 'ai/test';
const root = mkdtempSync(join(tmpdir(), 'git-review-fixture-'));
process.env.DATABASE_DRIVER = 'sqlite'; process.env.DATABASE_URL = join(root, 'fixture.db');
process.env.BETTER_AUTH_SECRET = 'fixture-only-auth-secret'; process.env.BETTER_AUTH_URL = 'http://localhost:8080';
const gen = Bun.spawnSync(['bun', 'node_modules/drizzle-kit/bin.cjs', 'generate', '--dialect', 'sqlite', '--schema', './src/db/schema/sqlite/index.ts', '--out', join(root, 'schema')]);
if (gen.exitCode) throw new Error(gen.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, 'schema')).filter(f => f.endsWith('.sql'))) sqlite.exec(readFileSync(join(root, 'schema', f), 'utf8'));
sqlite.close();
let aiCalls = 0, failModel = false;
const fixtureOutput = { summary: 'TEST FIXTURE: bounded static review.', findings: [{ severity: 'medium', file: 'src/change.ts', line: 1, explanation: 'TEST FIXTURE: missing error-path test.', recommendation: 'Add the error-path test.' }], coverage: { correctness: 'Reviewed supplied change.', security: 'No runtime authorization verified.', reliability: 'Error handling reviewed.', tests: 'Static inspection only; tests were not run.' }, limitations: ['TEST FIXTURE only.'] };
const model = new MockLanguageModelV3({ provider: 'test-only-provider', modelId: 'test-only-model', doGenerate: async () => {
  aiCalls++; if (failModel) throw Object.assign(new Error('fixture-private-provider-error'), { statusCode: 429 });
  return { content: [{ type: 'text', text: JSON.stringify({ ...fixtureOutput, findings: binary ? [] : fixtureOutput.findings }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [], response: { id: 'test-only-model-request' } };
} });
const realProvider = await import('../src/ai/provider.ts');
mock.module('../src/ai/provider.ts', () => ({ ...realProvider, getModel: (_key: string, keys: any) => { if (!keys?.openai) throw new Error('TEST FIXTURE no key'); return model; } }));
mock.module('../src/auth/middleware.ts', () => ({ requireAuth: async (c: any, next: any) => { c.set('user', { id: c.req.header('x-fixture-user') || 'owner' }); await next(); } }));
const { db } = await import('../src/config/db.ts');
const { users, githubTokens, llmApiKeys } = await import('../src/db/schema/users.ts');
const { projects, projectMembers } = await import('../src/db/schema/projects.ts');
const { organizations, orgMemberships } = await import('../src/db/schema/organizations.ts');
const { modelSelections } = await import('../src/db/schema/chat.ts');
const { gitReviews, gitOperations } = await import('../src/db/schema/git-reviews.ts');
const { epics } = await import('../src/db/schema/epics.ts');
const { projectTickets } = await import('../src/db/schema/tickets.ts');
const { runNextReview, recoverReviews } = await import('../src/services/git-review.ts');
const { default: api } = await import('../src/routes/api/git.ts');
for (const id of ['owner', 'viewer', 'outsider']) await db.insert(users).values({ id, name: id, email: `${id}@fixture.invalid` });
await db.insert(organizations).values({ id: 'team', name: 'Fixture', slug: 'fixture', ownerId: 'owner' });
await db.insert(orgMemberships).values({ id: 'viewer-team', organizationId: 'team', userId: 'viewer', role: 'viewer' });
for (const id of ['one', 'two']) await db.insert(projects).values({ id, projectId: id, name: 'Fixture', ownerId: 'owner', organizationId: 'team', repoOwner: 'fixture', repoName: 'repo', repoProvider: 'github', repoUrl: 'https://github.com/fixture/repo', shareGitAccess: true });
await db.insert(projectMembers).values({ id: 'viewer-project', projectId: 'one', userId: 'viewer', role: 'viewer', canEditFiles: false });
await db.insert(githubTokens).values({ userId: 'owner', accessToken: 'fixture-secret-git-token', githubUsername: 'fixture' });
await db.insert(llmApiKeys).values({ userId: 'owner', openaiApiKey: 'fixture-secret-model-key' });
await db.insert(modelSelections).values({ userId: 'owner', selectedModel: realProvider.listChatModels().find(m => m.provider === 'openai')!.key });
const originalFetch = globalThis.fetch;
let head = 'a'.repeat(40), base = 'b'.repeat(40), creates = 0, uncertain = false, binary = false, refUnavailable = false;
let openPRs: any[] = [];
const fixturePR = () => ({ number: 7, title: 'TEST FIXTURE PR', html_url: 'https://github.com/fixture/repo/pull/7', head: { ref: 'feature', sha: head, repo: { full_name: 'fixture/repo' } }, base: { ref: 'main' } });
const request = (path: string, payload?: any, user = 'owner', project = 'one') => api.request(`/projects/${project}/git${path}`, { method: payload ? 'POST' : 'GET', headers: { 'x-fixture-user': user, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
const queue = async () => { const response = await request('/reviews', { headRef: 'feature', baseRef: 'main' }); expect(response.status).toBe(202); return (await response.json()).review; };
const get = async (id: string) => (await (await request(`/reviews/${id}`)).json()).review;
const confirm = (id: string, extra = {}, project = 'one') => request('/pull-requests', { reviewId: id, acknowledged: true, title: 'TEST FIXTURE PR', body: 'Editable TEST FIXTURE body', ...extra }, 'owner', project);
beforeEach(async () => {
  await db.delete(gitOperations); await db.delete(gitReviews); await db.delete(projectTickets); await db.delete(epics);
  head = 'a'.repeat(40); base = 'b'.repeat(40); creates = 0; uncertain = false; binary = false; refUnavailable = false; aiCalls = 0; failModel = false; openPRs = [];
  await db.update(llmApiKeys).set({ openaiApiKey: 'fixture-secret-model-key' });
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (refUnavailable && path.includes('/branches/')) return Response.json({}, { status: 404 });
    if (path.endsWith('/branches/feature')) return Response.json({ commit: { sha: head } });
    if (path.endsWith('/branches/main')) return Response.json({ commit: { sha: base } });
    if (path.endsWith('/branches/included')) return Response.json({ commit: { sha: head } });
    if (path.endsWith('/branches/excluded')) return Response.json({ commit: { sha: 'c'.repeat(40) } });
    if (path.includes('/compare/')) return Response.json({ ahead_by: 1, behind_by: 0, files: [{ filename: 'src/change.ts', patch: binary ? undefined : '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 }] });
    if (path.includes('/contents/')) return Response.json({ content: Buffer.from('new\n').toString('base64'), encoding: 'base64', size: 4 });
    if (path.endsWith('/pulls') && init.method === 'POST') {
      creates++;
      const body = JSON.parse(init.body as string); expect(body.body).toContain('AI change review'); expect(body.body).toContain('Static review only');
      openPRs = [fixturePR()]; if (uncertain) throw new Error('TEST FIXTURE network disconnected after creation');
      return Response.json(fixturePR(), { headers: { 'x-github-request-id': 'test-only-pr-request' } });
    }
    if (path.endsWith('/pulls')) return Response.json(openPRs);
    throw new Error('Unexpected TEST FIXTURE request: ' + path);
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });

test('saved successful review → acknowledgment → one PR; retries and reopened results are durable and safely logged', async () => {
  const logs: string[] = []; const log = console.log; console.log = (...v) => logs.push(v.join(' '));
  try {
    const row = await queue(); expect((await get(row.id)).status).toBe('queued');
    await Promise.all([runNextReview(), runNextReview()]);
    const saved = await get(row.id); expect(saved.status).toBe('completed'); expect(aiCalls).toBe(1); expect(JSON.parse(saved.findings)[0].file).toBe('src/change.ts'); expect(saved.headSha).toBe(head);
    expect((await confirm(row.id, { acknowledged: false })).status).toBe(400);
    const responses = await Promise.all([confirm(row.id), confirm(row.id)]); expect(responses.some(r => r.status === 200)).toBe(true); expect(creates).toBe(1);
    expect((await confirm(row.id)).status).toBe(200); expect(creates).toBe(1);
    expect((await (await request('/reviews')).json()).reviews).toHaveLength(1);
    const events = logs.map(l => JSON.parse(l));
    for (const event of ['review.queued', 'review.started', 'review.completed', 'pr.completed']) expect(events.some(e => e.event === event && e.timestamp && e.correlationId && e.jobId && e.durationMs >= 0)).toBe(true);
    expect(events.some(e => e.model === 'test-only-model' && e.providerRequestId === 'test-only-model-request')).toBe(true);
    expect(logs.join(' ')).not.toMatch(/fixture-secret|old|Editable TEST FIXTURE/);
  } finally { console.log = log; }
});
test('changed source OR destination, cross-project review and incomplete review cannot create', async () => {
  const row = await queue();
  expect((await confirm(row.id)).status).toBe(409); await runNextReview();
  expect((await confirm(row.id, {}, 'two')).status).toBe(404);
  head = 'c'.repeat(40); expect((await confirm(row.id)).status).toBe(409); head = row.headSha;
  base = 'd'.repeat(40); expect((await confirm(row.id)).status).toBe(409); expect(creates).toBe(0);
  expect((await request(`/reviews/${row.id}`)).status).toBe(200);
});
test('missing model access is persisted blocked, not completed, and explicit retry can recover', async () => {
  await db.update(llmApiKeys).set({ openaiApiKey: null });
  const row = await queue(); await runNextReview();
  expect((await get(row.id)).status).toBe('blocked'); expect(aiCalls).toBe(0); expect((await confirm(row.id)).status).toBe(409);
  await db.update(llmApiKeys).set({ openaiApiKey: 'fixture-secret-model-key' });
  expect((await request(`/reviews/${row.id}/retry`, {})).status).toBe(202); await runNextReview(); expect((await get(row.id)).status).toBe('completed');
});
test('restart recovers expired leases and caps attempts; transient failure logs safe retry and terminal failure', async () => {
  const row = await queue();
  await db.update(gitReviews).set({ status: 'running', attempt: 1, leaseId: 'test-only-expired', leaseUntil: new Date(Date.now() - 5000) }).where(eq(gitReviews.id, row.id));
  await recoverReviews(); expect((await get(row.id)).status).toBe('queued'); await runNextReview(); expect((await get(row.id)).status).toBe('completed');
  const failure = await queue(); failModel = true;
  const logs: string[] = []; const log = console.log; console.log = (...v) => logs.push(v.join(' '));
  try {
    for (let i = 0; i < 3; i++) { await runNextReview(); await db.update(gitReviews).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(gitReviews.id, failure.id)); }
    expect((await get(failure.id)).status).toBe('failed'); expect((await get(failure.id)).attempt).toBe(3);
    expect(logs.some(s => JSON.parse(s).event === 'review.retry_scheduled')).toBe(true);
    expect(logs.some(s => JSON.parse(s).event === 'review.failed' && JSON.parse(s).errorCode === 'MODEL_RATE_LIMIT')).toBe(true);
    expect(logs.join(' ')).not.toContain('fixture-private-provider-error');
  } finally { console.log = log; }
  await db.update(gitReviews).set({ status: 'running', attempt: 3, leaseId: 'test-only-last-lease', leaseUntil: new Date(Date.now() - 5000) }).where(eq(gitReviews.id, failure.id));
  await recoverReviews(); expect((await get(failure.id)).status).toBe('failed');
});
test('uncertain creation reconciles via provider lookup without another POST', async () => {
  const row = await queue(); await runNextReview(); uncertain = true;
  expect((await confirm(row.id)).status).toBe(409); expect(creates).toBe(1);
  expect((await confirm(row.id)).status).toBe(200); expect(creates).toBe(1);
});
test('excluded binary patch is explicitly incomplete and cannot create; viewer cannot enqueue', async () => {
  expect((await request('/reviews', { headRef: 'feature', baseRef: 'main' }, 'viewer')).status).toBe(403);
  binary = true; const row = await queue(); await runNextReview();
  expect((await get(row.id)).status).toBe('incomplete'); expect(JSON.parse((await get(row.id)).coverage).excluded).toHaveLength(1);
  expect((await confirm(row.id)).status).toBe(409); expect(creates).toBe(0);
});
test('epic scope uses stored associations and current revision ancestry, including excluded and unknown tickets', async () => {
  await db.insert(epics).values({ id: 'test-only-epic', projectId: 'one', name: 'TEST FIXTURE epic', branch: 'feature' });
  for (const branch of ['included', 'excluded', null]) await db.insert(projectTickets).values({ projectId: 'one', epicId: 'test-only-epic', name: branch || 'unknown', description: 'TEST FIXTURE only', githubBranch: branch });
  const row = await queue(); await runNextReview();
  const scope = JSON.parse((await get(row.id)).coverage).scope;
  expect(scope.included).toHaveLength(1); expect(scope.excluded).toHaveLength(1); expect(scope.unknown).toHaveLength(1);
});
test('different reviewed revisions cannot replay an uncertain source-target operation', async () => {
  const row = await queue(); await runNextReview(); uncertain = true;
  expect((await confirm(row.id)).status).toBe(409); openPRs = [];
  expect((await confirm(row.id)).status).toBe(409); expect(creates).toBe(1);
  head = 'e'.repeat(40); const next = await queue(); await runNextReview();
  expect((await confirm(next.id)).status).toBe(409); expect(creates).toBe(1);
  openPRs = [fixturePR()]; expect((await confirm(next.id)).status).toBe(200); expect(creates).toBe(1);
  expect((await db.select().from(gitOperations)).every(op => op.activeKey === null)).toBe(true);
});
test('saved results remain readable when freshness recheck is unavailable; creation stays blocked', async () => {
  const row = await queue(); await runNextReview(); refUnavailable = true;
  const result = await (await request(`/reviews/${row.id}`)).json();
  expect(result).toMatchObject({ review: { status: 'completed' }, stale: true, freshness: 'unavailable', freshnessError: 'PROVIDER_NOT_FOUND' });
  expect((await confirm(row.id)).status).toBe(404); expect(creates).toBe(0);
});
test('additive SQLite migration preserves existing rows', () => {
  const database = new Database(':memory:');
  try { database.exec("PRAGMA foreign_keys=ON; CREATE TABLE project(id TEXT PRIMARY KEY); CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO project VALUES ('existing');");
    database.exec(readFileSync('drizzle/0014_git_reviews.sql', 'utf8'));
    expect(database.query('SELECT count(*) AS n FROM project').get()).toEqual({ n: 1 });
    expect(database.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('git_reviews','git_operations')").all()).toHaveLength(2);
    for (const [name, table] of [['git_reviews', gitReviews], ['git_operations', gitOperations]] as const) {
      expect(database.query(`PRAGMA table_info(${name})`).all().map((c: any) => c.name).sort()).toEqual(Object.values(getTableColumns(table)).map(c => c.name).sort());
    }
  } finally { database.close(); }
});
