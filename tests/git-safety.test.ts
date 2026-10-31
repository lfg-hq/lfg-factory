// TEST-ONLY: isolated SQLite and deterministic HTTP fixtures. No real Git/provider mutations.
import { test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { eq } from 'drizzle-orm';
const root = mkdtempSync(join(tmpdir(), 'git-safety-fixture-'));
process.env.DATABASE_DRIVER = 'sqlite'; process.env.DATABASE_URL = join(root, 'fixture.db');
const gen = Bun.spawnSync(['bun', 'node_modules/drizzle-kit/bin.cjs', 'generate', '--dialect', 'sqlite', '--schema', './src/db/schema/sqlite/index.ts', '--out', join(root, 'schema')]);
if (gen.exitCode) throw new Error(gen.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, 'schema')).filter(f => f.endsWith('.sql'))) sqlite.exec(readFileSync(join(root, 'schema', f), 'utf8'));
sqlite.close();
mock.module('../src/auth/middleware.ts', () => ({ requireAuth: async (c: any, next: any) => { c.set('user', { id: c.req.header('x-fixture-user') || 'owner' }); await next(); } }));
const { db } = await import('../src/config/db.ts');
const { users, githubTokens } = await import('../src/db/schema/users.ts');
const { projects, projectMembers } = await import('../src/db/schema/projects.ts');
const { organizations, orgMemberships } = await import('../src/db/schema/organizations.ts');
const { projectEnvironments } = await import('../src/db/schema/project-environments.ts');
const { epics } = await import('../src/db/schema/epics.ts');
const { projectTickets, ticketMergeHistory } = await import('../src/db/schema/tickets.ts');
const { gitMutations } = await import('../src/db/schema/git-mutations.ts');
const { projectActivities } = await import('../src/db/schema/activities.ts');
const { default: api } = await import('../src/routes/api/git.ts');
for (const id of ['owner', 'viewer', 'outsider']) await db.insert(users).values({ id, name: id, email: `${id}@fixture.invalid` });
await db.insert(organizations).values({ id: 'team', name: 'TEST FIXTURE', slug: 'fixture', ownerId: 'owner' });
await db.insert(orgMemberships).values({ id: 'viewer-team', organizationId: 'team', userId: 'viewer', role: 'viewer' });
for (const id of ['one', 'two']) await db.insert(projects).values({ organizationId: 'team', id, projectId: id, name: 'TEST FIXTURE', ownerId: 'owner', repoOwner: 'fixture', repoName: 'repo', repoProvider: 'github', repoUrl: 'https://github.com/fixture/repo', shareGitAccess: true });
await db.insert(projectMembers).values({ id: 'viewer-project', projectId: 'one', userId: 'viewer', role: 'viewer', canEditFiles: false });
await db.insert(githubTokens).values({ userId: 'owner', accessToken: 'fixture-secret-token', githubUsername: 'fixture' });
const sha = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
let branches: any[], prs: any[], pr: any, merges = 0, deletes = 0, fail = false, checks: any, rules: any[], unknown = false;
const originalFetch = globalThis.fetch;
const request = (path: string, body?: any, user = 'owner', method = 'POST', origin?: string) => api.request('/projects/one/git' + path, { method, headers: { 'x-fixture-user': user, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
const merge = (extra = {}, user = 'owner') => request('/pull-requests/7/merge', { confirmation: 'feature', destination: 'main', expectedSha: sha, ...extra }, user);
const del = (extra = {}, user = 'owner') => request('/branches', { branch: 'feature', confirmation: 'feature', expectedSha: sha, confirmUnmerged: true, ...extra }, user, 'DELETE');
const code = async (r: Response) => (await r.json()).code;
beforeEach(async () => {
  await db.delete(gitMutations); await db.delete(ticketMergeHistory); await db.delete(projectTickets); await db.delete(epics); await db.delete(projectEnvironments); await db.delete(projectActivities);
  await db.update(projects).set({ previewTicketId: null });
  branches = [{ name: 'main', commit: { sha: base }, protected: true }, { name: 'feature', commit: { sha }, protected: false }];
  pr = { number: 7, title: '<img src=x onerror=alert(1)>', html_url: 'https://github.com/fixture/repo/pull/7', state: 'open', head: { ref: 'feature', sha, repo: { full_name: 'fixture/repo' } }, base: { ref: 'main' }, draft: false, mergeable: true, mergeable_state: 'clean' };
  prs = []; merges = 0; deletes = 0; fail = false; unknown = false; checks = { total_count: 0, check_runs: [] }; rules = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url), path = u.pathname;
    const json = (body: any, status = 200) => Response.json(body, { status, headers: { 'x-github-request-id': 'test-only-request' } });
    if (path.endsWith('/pulls/7/merge')) { merges++; expect(JSON.parse(init.body as string)).toEqual({ sha, merge_method: 'merge' }); if (unknown) { pr.merged_at = '2026-01-01'; pr.merge_commit_sha = mergeSha; throw Error('fixture-secret-error'); } if (fail) return json({}, 500); pr.merged_at = '2026-01-01'; pr.merge_commit_sha = mergeSha; return json({ merged: true, sha: mergeSha }); }
    if (path.endsWith('/pulls/7')) return json(pr);
    if (path.includes('/git/refs/heads/')) { deletes++; const name = decodeURIComponent(path.split('/heads/')[1]!); branches = branches.filter(b => b.name !== name); if (unknown) throw Error('fixture-secret-error'); return new Response(null, { status: 204 }); }
    if (path.endsWith('/branches')) return json(branches);
    if (path.includes('/branches/') && !path.includes('/rules/')) { const b = branches.find(b => b.name === decodeURIComponent(path.split('/branches/')[1]!)); return json(b || {}, b ? 200 : 404); }
    if (path.endsWith('/pulls')) return json(prs);
    if (path.endsWith('/status')) return json({ total_count: 0, state: 'pending' });
    if (path.endsWith('/check-runs')) return json(checks);
    if (path.includes('/rules/branches/')) return json(rules);
    if (path.includes('/compare/')) return json({ ahead_by: 1, behind_by: 0 });
    if (path === '/repos/fixture/repo') return json({ default_branch: 'main', allow_merge_commit: true });
    throw Error('Unexpected TEST FIXTURE URL: ' + path);
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });
test('eligible exact revision merges once; uncertain provider success reconciles without a second mutation', async () => {
  unknown = true;
  expect((await merge()).status).toBe(502);
  expect((await db.select().from(gitMutations))[0]!.status).toBe('uncertain');
  expect((await merge()).status).toBe(200); expect((await merge()).status).toBe(200); expect(merges).toBe(1);
});
test('draft, conflicts, pending review policy, failed/unknown checks, queue and stale revision block server-side', async () => {
  pr.draft = true; expect(await code(await merge())).toContain('DRAFT'); pr.draft = false;
  for (const state of ['dirty', 'blocked', 'unknown', 'unstable', 'behind']) { pr.mergeable_state = state; expect((await merge()).status).toBe(409); }
  pr.mergeable_state = 'clean';
  for (const conclusion of ['failure', null]) { checks = { total_count: 1, check_runs: [{ status: 'completed', conclusion }] }; expect(await code(await merge())).toContain('CHECKS_FAILED_OR_UNKNOWN'); }
  checks = { total_count: 101, check_runs: [] }; expect((await merge()).status).toBe(409);
  checks = { total_count: 0, check_runs: [] }; rules = [{ type: 'merge_queue' }]; expect(await code(await merge())).toBe('UNSUPPORTED_MERGE_QUEUE'); rules = [];
  expect(await code(await merge({ expectedSha: base }))).toBe('STALE_PR_OR_DESTINATION'); expect((await merge({ destination: 'other' })).status).toBe(409); expect(merges).toBe(0);
});
test('unapproved and dependent epics blocked; approved eligible epic is promoted once with SHA/linkage', async () => {
  await db.insert(epics).values({ id: 'parent', projectId: 'one', name: 'TEST FIXTURE parent', branch: 'parent', status: 'building' });
  await db.insert(epics).values({ id: 'epic', projectId: 'one', name: 'TEST FIXTURE epic', branch: 'feature', baseBranch: 'main', parentEpicId: 'parent' });
  expect(await code(await merge())).toContain('NOT_APPROVED');
  await db.update(epics).set({ status: 'approved' }).where(eq(epics.id, 'epic'));
  expect(await code(await merge())).toContain('PARENT_UNMERGED');
  await db.update(epics).set({ status: 'merged' }).where(eq(epics.id, 'parent'));
  expect((await merge()).status).toBe(200); expect((await merge()).status).toBe(200);
  expect((await db.select().from(epics).where(eq(epics.id, 'epic')))[0]).toMatchObject({ status: 'merged', mergeCommitSha: mergeSha, prNumber: 7 }); expect(merges).toBe(1);
});
test('ticket to epic history is idempotent and cannot target main instead', async () => {
  await db.insert(epics).values({ id: 'epic', projectId: 'one', name: 'TEST FIXTURE epic', branch: 'delivery' });
  await db.insert(projectTickets).values({ id: 'ticket', projectId: 'one', epicId: 'epic', name: 'TEST FIXTURE', description: 'fixture', githubBranch: 'feature' });
  expect(await code(await merge())).toBe('TICKET_DESTINATION_MISMATCH'); pr.base.ref = 'delivery';
  expect((await merge({ destination: 'delivery' })).status).toBe(200); expect((await merge({ destination: 'delivery' })).status).toBe(200);
  expect(await db.select().from(ticketMergeHistory)).toHaveLength(1); expect(merges).toBe(1);
});
test('typed deletion requires unchanged eligible ref, explicit unmerged consent and no default/protected/open PR use', async () => {
  expect(await code(await del({ confirmation: 'wrong' }))).toBe('EXACT_CONFIRMATION_REQUIRED');
  expect(await code(await del({ expectedSha: base }))).toBe('STALE_REF');
  expect(await code(await del({ branch: 'main', confirmation: 'main', expectedSha: base }))).toBe('DEFAULT_OR_PROTECTED_BRANCH');
  branches[1].protected = true; expect((await del()).status).toBe(409); branches[1].protected = false;
  for (const p of [{ ...pr }, { ...pr, head: { ref: 'fork', repo: { full_name: 'external/repo' } }, base: { ref: 'feature' } }]) { prs = [p]; expect(await code(await del())).toBe('OPEN_PR_USES_BRANCH'); }
  prs = []; expect(await code(await del({ confirmUnmerged: false }))).toBe('UNMERGED_WORK_CONFIRMATION_REQUIRED');
  expect(deletes).toBe(0); expect((await del()).status).toBe(200); expect((await del()).status).toBe(200); expect(deletes).toBe(1);
});
test('actual runtime preview, selected preview, queued build and active epic children block deletion', async () => {
  // Another project connected to this same repository must also retain its active runtime.
  await db.insert(projectEnvironments).values({ id: 'env', projectId: 'two', workspaceId: 'fixture-only', previewBranch: 'feature', previewStatus: 'running' });
  expect(await code(await del())).toBe('ACTIVE_PREVIEW'); expect(await code(await merge())).toContain('ACTIVE_PREVIEW'); await db.delete(projectEnvironments);
  await db.insert(projectTickets).values({ id: 'ticket', projectId: 'one', name: 'TEST FIXTURE', description: 'fixture', githubBranch: 'feature' });
  await db.update(projects).set({ previewTicketId: 'ticket' }).where(eq(projects.id, 'one'));
  expect(await code(await del())).toBe('SELECTED_PREVIEW'); await db.update(projects).set({ previewTicketId: null });
  await db.update(projectTickets).set({ queueStatus: 'queued' }); expect(await code(await del())).toBe('ACTIVE_BUILD'); await db.update(projectTickets).set({ queueStatus: 'none', epicId: 'epic' });
  await db.insert(epics).values({ id: 'epic', projectId: 'one', name: 'TEST FIXTURE', branch: 'feature' }); expect(await code(await del())).toBe('ACTIVE_EPIC_DEPENDENTS'); expect(deletes).toBe(0);
});
test('permission/cross-project/origin denial never invokes mutation', async () => {
  expect((await merge({}, 'viewer')).status).toBe(403); expect((await del({}, 'outsider')).status).toBe(404);
  expect((await request('/pull-requests/7/merge', {}, 'owner', 'POST', 'https://evil.invalid')).status).toBe(403);
  expect(merges + deletes).toBe(0);
});
test('safe structured success/failure diagnostics and persisted activity; provider failure never reports success', async () => {
  const logs: string[] = [], original = console.log; console.log = (...args) => logs.push(args.join(' '));
  try {
    expect((await del({ confirmation: 'wrong' })).status).toBe(409); expect((await del()).status).toBe(200);
    const events = logs.map(l => JSON.parse(l));
    for (const outcome of ['failed', 'completed']) expect(events.some(e => e.service === 'git-safety' && e.outcome === outcome && e.timestamp && e.level && e.correlationId && e.durationMs >= 0)).toBe(true);
    expect(logs.join(' ')).not.toMatch(/fixture-secret|onerror|Authorization/);
    const activities = await db.select().from(projectActivities); expect(activities.some(a => a.activityType === 'git_delete_failed')).toBe(true); expect(activities.some(a => a.activityType === 'git_delete_completed')).toBe(true);
    fail = true; expect((await merge()).status).toBe(502); expect((await db.select().from(gitMutations).where(eq(gitMutations.type, 'merge')))[0]!.status).toBe('uncertain');
  } finally { console.log = original; }
});
test('legacy epic promotion cannot publish raw refs or create a second PR; directs to exact revision confirmation', async () => {
  const { default: legacy } = await import('../src/routes/api/epics.ts');
  await db.insert(epics).values({ id: 'epic', projectId: 'one', name: 'TEST FIXTURE', branch: 'feature', baseBranch: 'main', status: 'approved' });
  const response = await legacy.request('/epics/epic/merge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-user': 'owner' }, body: '{}' });
  expect(response.status).toBe(409);
  const body = await response.json(); expect(body.blockers[0].code).toBe('confirmation_required'); expect(body.correlationId).toBeTruthy(); expect(merges + deletes).toBe(0);
});
test('external merges reconcile exact linked heads once, never changed heads or unapproved epics', async () => {
  const { reconcileExternalPRs } = await import('../src/services/git-reconciliation.ts');
  const { gitContext } = await import('../src/services/git-context.ts');
  const [project] = await db.select().from(projects).where(eq(projects.id, 'one'));
  const provider = await gitContext(project, 'owner');
  await db.insert(epics).values({ id: 'epic', projectId: 'one', name: 'TEST FIXTURE', branch: 'delivery' });
  await db.insert(projectTickets).values({ id: 'ticket', projectId: 'one', epicId: 'epic', name: 'TEST FIXTURE', description: 'fixture', githubBranch: 'feature', githubCommitSha: sha });
  const external = { id: 7, title: 'TEST FIXTURE', url: pr.html_url, source: 'feature', sourceRepo: 'fixture/repo', destination: 'delivery', headSha: sha, draft: false, merged: true, mergeSha };
  await reconcileExternalPRs('one', 'owner', provider, [external], 'test-only-external');
  await reconcileExternalPRs('one', 'owner', provider, [external], 'test-only-external');
  expect(await db.select().from(ticketMergeHistory)).toHaveLength(1);
  expect((await db.select().from(projectActivities)).filter(a => a.activityType === 'git_ticket_reconciled')).toHaveLength(1);
  branches[1].commit.sha = base;
  await reconcileExternalPRs('one', 'owner', provider, [{ ...external, mergeSha: base }], 'test-only-changed');
  expect(await db.select().from(ticketMergeHistory)).toHaveLength(1);
  expect(merges + deletes).toBe(0);
});
test('uncertain delete verifies absence before retry and duplicate success does not duplicate activity', async () => {
  unknown = true;
  expect((await del()).status).toBe(502); expect(deletes).toBe(1);
  expect((await del()).status).toBe(200); expect((await del()).status).toBe(200); expect(deletes).toBe(1);
  expect((await db.select().from(projectActivities)).filter(a => a.activityType === 'git_delete_completed')).toHaveLength(1);
});
test('additive SQLite migration preserves existing data', () => {
  const db = new Database(':memory:'); try { db.exec("CREATE TABLE project(id text PRIMARY KEY); INSERT INTO project VALUES ('existing');"); db.exec(readFileSync('drizzle/0015_git_mutations.sql', 'utf8')); expect(db.query('select count(*) as n from project').get()).toEqual({ n: 1 }); } finally { db.close(); }
});
