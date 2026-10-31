import { test, expect } from 'bun:test';
import { deleteBranch, githubBranchOverview, mergeBranch, mergePullRequest, openPullRequest } from '../src/services/github-branches.ts';

const gh = { owner: 'o', repo: 'r', token: 't' };
const at = (date: string, sha = 'abcdef123', message = 'Work') => ({ sha, author: { login: 'jo' }, commit: { message, committer: { date } } });
function fake(routes: Record<string, unknown>, statuses: Record<string, number> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace('https://api.github.com/repos/o/r', '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = method === 'GET' ? path : `${method} ${path}`;
    const body = routes[key]; const status = statuses[key] ?? (body === undefined ? 404 : 200);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test('overview: merged by ancestry or by a merged PR, open PRs, stale and counts', async () => {
  const { fetcher } = fake({
    '': { default_branch: 'main' },
    '/branches?per_page=100&page=1': [{ name: 'main', protected: true }, { name: 'feat/a' }, { name: 'feat/squashed' }, { name: 'feat/done' }, { name: 'old' }],
    '/pulls?state=all&per_page=100&sort=created&direction=desc': [
      { number: 9, title: 'A', html_url: 'u9', state: 'open', draft: false, head: { ref: 'feat/a' }, base: { ref: 'main' } },
      { number: 7, title: 'S', html_url: 'u7', state: 'closed', merged_at: '2026-10-01T00:00:00Z', head: { ref: 'feat/squashed' }, base: { ref: 'main' } },
    ],
    '/commits/main': at('2026-10-30T00:00:00Z', 'mainsha00', 'Tip'),
    '/compare/main...feat/a': { ahead_by: 2, behind_by: 1, status: 'diverged', commits: [at('2026-10-29T00:00:00Z'), at('2026-10-30T00:00:00Z', 'a2sha0000', 'Second')] },
    '/compare/main...feat/squashed': { ahead_by: 3, behind_by: 4, status: 'diverged', commits: [at('2026-09-01T00:00:00Z'), at('2026-09-01T00:00:00Z'), at('2026-09-02T00:00:00Z')] },
    '/compare/main...feat/done': { ahead_by: 0, behind_by: 2, status: 'behind', commits: [], merge_base_commit: at('2026-10-20T00:00:00Z') },
    '/compare/main...old': { ahead_by: 1, behind_by: 90, status: 'diverged', commits: [at('2025-01-01T00:00:00Z')] },
  });
  const r = await githubBranchOverview(gh, fetcher);
  expect(r.error).toBeUndefined();
  expect(r.defaultBranch).toBe('main');
  expect(r.branches[0]).toMatchObject({ name: 'main', isDefault: true, protected: true, lastCommit: { sha: 'mainsha', message: 'Tip' } });
  const by = Object.fromEntries(r.branches.map((b) => [b.name, b]));
  expect(by['feat/a']).toMatchObject({ merged: false, aheadBy: 2, pull: { number: 9, state: 'open' }, lastCommit: { message: 'Second' } });
  expect(by['feat/squashed']).toMatchObject({ merged: true, pull: { state: 'merged' } });
  expect(by['feat/done']!.merged).toBe(true);
  expect(r.counts).toEqual({ merged: 2, unmerged: 2, openPulls: 1, stale: 1 });
});

test('overview reports a refused token', async () => {
  const { fetcher } = fake({}, { '': 401 });
  expect((await githubBranchOverview(gh, fetcher)).error).toContain('refused');
});

test('open PR, merge PR, merge branch and delete', async () => {
  const { fetcher, calls } = fake({
    'POST /pulls': { number: 12, title: 'T', html_url: 'u', state: 'open', base: { ref: 'main' } },
    'PUT /pulls/12/merge': { merged: true, sha: 's1' },
    'POST /merges': { sha: 's2' },
    '': { default_branch: 'main' },
  }, { 'POST /merges': 201, 'DELETE /git/refs/heads/feat/a': 204 });
  expect(await openPullRequest(gh, { head: 'feat/a', base: 'main', title: ' T ' }, fetcher)).toMatchObject({ ok: true, pull: { number: 12 } });
  expect(calls.at(-1)!.body).toMatchObject({ head: 'feat/a', base: 'main', title: 'T' });
  expect(await mergePullRequest(gh, 12, 'squash', fetcher)).toEqual({ ok: true, sha: 's1' });
  expect(calls.at(-1)!.body).toEqual({ merge_method: 'squash' });
  expect(await mergeBranch(gh, 'feat/a', 'main', fetcher)).toEqual({ ok: true, sha: 's2' });
  expect(await deleteBranch(gh, 'feat/a', fetcher)).toEqual({ ok: true });
  expect(await deleteBranch(gh, 'main', fetcher)).toMatchObject({ ok: false });
});

test('merge conflicts and blocked PRs say why', async () => {
  const { fetcher } = fake({}, { 'POST /merges': 409, 'PUT /pulls/3/merge': 405 });
  expect(await mergeBranch(gh, 'x', 'main', fetcher)).toMatchObject({ ok: false, error: expect.stringContaining('conflicts') });
  expect(await mergePullRequest(gh, 3, 'merge', fetcher)).toMatchObject({ ok: false, error: expect.stringContaining("can't be merged yet") });
});
