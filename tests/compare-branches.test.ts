import { test, expect } from 'bun:test';
import { compareGithubBranches } from '../src/services/ticket-diff-github.ts';

const gh = { owner: 'o', repo: 'r', token: 't' };
const at = (date: string) => ({ commit: { committer: { date } } });
function fake(routes: Record<string, unknown>, statuses: Record<string, number> = {}) {
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    const path = String(url).replace('https://api.github.com/repos/o/r', ''); seen.push(path);
    const body = routes[path]; const status = statuses[path] ?? (body === undefined ? 404 : 200);
    return { ok: status === 200, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}
const repo = { default_branch: 'main' };
const branches = [{ name: 'main' }, { name: 'lfg-agent' }, { name: 'feature/a' }, { name: 'feature/b' }];

test('defaults to the repo default branch and reports ahead/behind with tip dates', async () => {
  const { fetcher, seen } = fake({
    '': repo, '/branches?per_page=100&page=1': branches,
    '/compare/main...feature/a': { ahead_by: 2, behind_by: 5, status: 'diverged', commits: [at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z')] },
    '/compare/main...feature/b': { ahead_by: 0, behind_by: 3, status: 'behind', commits: [], merge_base_commit: at('2026-09-01T00:00:00Z') },
    '/compare/main...lfg-agent': { ahead_by: 0, behind_by: 0, status: 'identical', commits: [], merge_base_commit: at('2026-10-03T00:00:00Z') },
  });
  const r = await compareGithubBranches(gh, {}, fetcher);
  expect(r.base).toBe('main');
  expect(r.error).toBeUndefined();
  expect(r.branches).toEqual([
    { name: 'feature/a', aheadBy: 2, behindBy: 5, status: 'diverged', lastCommitDate: '2026-10-02T00:00:00Z' },
    { name: 'feature/b', aheadBy: 0, behindBy: 3, status: 'behind', lastCommitDate: '2026-09-01T00:00:00Z' },
    { name: 'lfg-agent', aheadBy: 0, behindBy: 0, status: 'identical', lastCommitDate: '2026-10-03T00:00:00Z' },
  ]);
  expect(seen).not.toContain('/compare/main...main');
});

test('explicit base, branch filter and truncation', async () => {
  const { fetcher } = fake({
    '': repo, '/branches?per_page=100&page=1': branches,
    '/compare/lfg-agent...feature/a': { ahead_by: 1, behind_by: 0, status: 'ahead', commits: [at('2026-10-05T00:00:00Z')] },
  });
  const r = await compareGithubBranches(gh, { base: 'lfg-agent', only: ['feature/'], limit: 1 }, fetcher);
  expect(r.base).toBe('lfg-agent');
  expect(r.branches.map((b) => b.name)).toEqual(['feature/a']);
  expect(r).toMatchObject({ total: 2, truncated: true, defaultBranch: 'main' });
});

test('pages through more than 100 branches', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `b${String(i).padStart(3, '0')}` }));
  const { fetcher } = fake({ '': repo, '/branches?per_page=100&page=1': page1, '/branches?per_page=100&page=2': [{ name: 'main' }] });
  const r = await compareGithubBranches(gh, { only: ['zzz'] }, fetcher);
  expect(r.error).toBeUndefined();
  expect(r.total).toBe(0);
});

test('errors are truthful: refused token, missing repo, missing base', async () => {
  for (const status of [401, 403]) {
    const r = await compareGithubBranches(gh, {}, fake({}, { '': status }).fetcher);
    expect(r.error).toContain('Reconnect GitHub');
    expect(r.error).not.toContain('Connect GitHub in');
  }
  const missing = await compareGithubBranches(gh, {}, fake({}).fetcher);
  expect(missing.error).toContain('o/r was not found');
  const noBase = await compareGithubBranches(gh, { base: 'develop' }, fake({ '': repo, '/branches?per_page=100&page=1': branches }).fetcher);
  expect(noBase.error).toBe('Branch develop was not found on GitHub. The default branch is main.');
});

test('a branch whose compare fails is marked, not fatal', async () => {
  const { fetcher } = fake({ '': repo, '/branches?per_page=100&page=1': [{ name: 'main' }, { name: 'x' }] });
  const r = await compareGithubBranches(gh, {}, fetcher);
  expect(r.branches).toEqual([{ name: 'x', aheadBy: null, behindBy: null, status: 'not found', lastCommitDate: null }]);
});
