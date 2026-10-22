import { test, expect } from 'bun:test';
import { githubTicketDiff, parseAuthedGithubUrl, revertTicketMerge } from '../src/services/ticket-diff-github.ts';

const gh = { owner: 'o', repo: 'r', token: 't' };
const file = (name = 'src/a.ts') => ({ filename: name, additions: 3, deletions: 1, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' });
const commit = (sha: string, parents: string[], message = 'feat: work', date = '2026-10-22T16:51:00Z') => ({ sha, parents: parents.map((p) => ({ sha: p })), commit: { message, committer: { date }, author: { date } } });
function fake(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = (init?.method && init.method !== 'GET' ? init.method + ' ' : '') + String(url).replace('https://api.github.com/repos/o/r', ''); seen.push(path);
    const body = routes[path];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}
const branches = [{ name: 'epic/e1' }, { name: 'feature/t' }];

test('parses owner, repo and token from an authenticated clone URL', () => {
  expect(parseAuthedGithubUrl('https://x-access-token:abc@github.com/jitinp/recruiting.git')).toEqual({ owner: 'jitinp', repo: 'recruiting', token: 'abc' });
  expect(parseAuthedGithubUrl('https://oauth2:abc@gitlab.com/a/b.git')).toBeNull();
});

test('unmerged ticket: one pending round compared with the epic branch', async () => {
  const { fetcher } = fake({
    '/branches?per_page=100': branches,
    '/commits?sha=feature/t&per_page=100': [commit('t1', ['e0'])],
    '/commits?sha=epic/e1&per_page=100': [commit('e0', ['e-1'])],
    '/compare/epic/e1...feature/t': { ahead_by: 1, files: [file()], commits: [commit('t1', ['e0'])] },
  });
  const d = await githubTicketDiff(gh, 'epic/e1', 'feature/t', fetcher);
  expect(d.merged).toBe(false);
  expect(d.rounds!.map((r) => r.id)).toEqual(['pending']);
  expect(d.files).toEqual([{ path: 'src/a.ts', added: 3, removed: 1 }]);
  expect(d.canRevert).toBe(false);
});

test('ticket merged twice lists both merges, newest first; other tickets merged into its branch are not its rounds', async () => {
  // Ticket line: t2 (merge of epic into ticket, parents t1 + e2) -> t1 -> e0. e2 merged ANOTHER ticket (o1).
  const { fetcher } = fake({
    '/branches?per_page=100': branches,
    '/commits?sha=feature/t&per_page=100': [commit('t3', ['t2']), commit('t2', ['t1', 'e2']), commit('t1', ['e0']), commit('o1', ['e0'])],
    '/commits?sha=epic/e1&per_page=100': [commit('m2', ['e2', 't3'], 'merge 2', '2026-10-22T16:51:00Z'), commit('e2', ['m1', 'o1'], 'other ticket'), commit('m1', ['e0', 't1'], 'merge 1', '2026-10-22T13:40:00Z')],
    '/compare/epic/e1...feature/t': { ahead_by: 0, files: [], commits: [] },
    '/compare/e2...t3': { files: [file('src/b.ts'), file('src/c.ts')], commits: [commit('t3', ['t2'], 'rebuild')] },
    '/compare/e0...t1': { files: [file()], commits: [commit('t1', ['e0'], 'first build', '2026-10-22T13:39:00Z')] },
  });
  const d = await githubTicketDiff(gh, 'epic/e1', 'feature/t', fetcher);
  expect(d.rounds!.map((r) => r.mergeSha)).toEqual(['m2', 'm1']);
  expect(d.rounds![1]!.commits[0]).toMatchObject({ sha: 't1', subject: 'first build' });
  expect(d.round).toBe('m2');
  expect(d.files.map((f) => f.path)).toEqual(['src/b.ts', 'src/c.ts']);
  expect(d.canRevert).toBe(true); // m2 is the epic's newest commit
  const older = await githubTicketDiff(gh, 'epic/e1', 'feature/t', fetcher, 'm1');
  expect(older.files.map((f) => f.path)).toEqual(['src/a.ts']);
  expect(older.canRevert).toBe(false);
});

test('a branch not pushed yet reads as a plain explanation', async () => {
  const { fetcher } = fake({ '/branches?per_page=100': [{ name: 'main' }] });
  const d = await githubTicketDiff(gh, 'main', 'feature/t', fetcher);
  expect(d.error).toContain("isn't on GitHub yet");
});

test('undo restores the pre-merge tree as a new commit, only when the merge is the epic tip', async () => {
  const { fetcher, seen } = fake({
    '/git/ref/heads/epic/e1': { object: { sha: 'm2' } },
    '/git/commits/m2': { parents: [{ sha: 'e2' }, { sha: 't3' }] },
    '/git/commits/e2': { tree: { sha: 'tree-e2' } },
    'POST /git/commits': { sha: 'rv1' },
    'PATCH /git/refs/heads/epic/e1': { object: { sha: 'rv1' } },
  });
  expect(await revertTicketMerge(gh, 'epic/e1', 'm2', 'Revert', fetcher)).toEqual({ ok: true, sha: 'rv1' });
  expect(seen).toContain('PATCH /git/refs/heads/epic/e1');
  const stale = await revertTicketMerge(gh, 'epic/e1', 'm1', 'Revert', fetcher);
  expect(stale.ok).toBe(false);
});
