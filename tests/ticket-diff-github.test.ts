import { test, expect } from 'bun:test';
import { githubTicketDiff, parseAuthedGithubUrl } from '../src/services/ticket-diff-github.ts';

const gh = { owner: 'o', repo: 'r', token: 't' };
const file = { filename: 'src/a.ts', additions: 3, deletions: 1, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' };
const commit = { sha: 'abcdef1234', commit: { message: 'feat: intake\n\nbody', author: { date: '2026-10-22T00:00:00Z' } } };
function fake(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const fetcher = (async (url: string) => {
    const path = String(url).replace('https://api.github.com/repos/o/r', ''); seen.push(path);
    const body = routes[path];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

test('parses owner, repo and token from an authenticated clone URL', () => {
  expect(parseAuthedGithubUrl('https://x-access-token:abc@github.com/jitinp/recruiting.git')).toEqual({ owner: 'jitinp', repo: 'recruiting', token: 'abc' });
  expect(parseAuthedGithubUrl('https://oauth2:abc@gitlab.com/a/b.git')).toBeNull();
});

test('unmerged ticket: compares its branch with the epic branch', async () => {
  const { fetcher } = fake({
    '/branches?per_page=100': [{ name: 'epic/e1' }, { name: 'feature/t' }],
    '/compare/epic/e1...feature/t': { ahead_by: 1, files: [file], commits: [commit] },
  });
  const d = await githubTicketDiff(gh, 'epic/e1', 'feature/t', fetcher);
  expect(d.merged).toBe(false);
  expect(d.files).toEqual([{ path: 'src/a.ts', added: 3, removed: 1 }]);
  expect(d.commits[0]).toMatchObject({ sha: 'abcdef1', subject: 'feat: intake' });
  expect(d.diff).toContain('diff --git a/src/a.ts b/src/a.ts');
});

test('merged ticket: diffs from the epic as it was just before the merge', async () => {
  const { fetcher, seen } = fake({
    '/branches?per_page=100': [{ name: 'epic/e1' }, { name: 'feature/t' }],
    '/compare/epic/e1...feature/t': { ahead_by: 0, files: [], commits: [] },
    '/commits/feature/t': { sha: 'tip' },
    '/commits?sha=epic/e1&per_page=100': [{ sha: 'm', parents: [{ sha: 'before' }, { sha: 'tip' }] }],
    '/compare/before...feature/t': { ahead_by: 1, files: [file], commits: [commit] },
  });
  const d = await githubTicketDiff(gh, 'epic/e1', 'feature/t', fetcher);
  expect(d.merged).toBe(true);
  expect(d.files).toHaveLength(1);
  expect(seen).toContain('/compare/before...feature/t');
});

test('a branch not pushed yet reads as a plain explanation', async () => {
  const { fetcher } = fake({ '/branches?per_page=100': [{ name: 'main' }] });
  const d = await githubTicketDiff(gh, 'main', 'feature/t', fetcher);
  expect(d.error).toContain("isn't on GitHub yet");
});
