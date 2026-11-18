import { test, expect } from 'bun:test';
import { createGitProvider } from '../src/services/git-provider.ts';

const files = [
  { filename: 'src/calls.ts', status: 'added', additions: 300, deletions: 0, patch: '+'.repeat(10) },
  { filename: 'bun.lock', status: 'modified', additions: 900, deletions: 5, patch: '+lock' },
  { filename: '.env.production', status: 'added', additions: 3, deletions: 0, patch: '+SECRET=1' },
  { filename: 'src/ui.ts', status: 'modified', additions: 20, deletions: 4, patch: '+ui' },
  ...Array.from({ length: 200 }, (_, i) => ({ filename: `src/gen/f${i}.ts`, status: 'added', additions: 1, deletions: 0, patch: '+x' })),
];
const fake = (async (url: string) => new Response(JSON.stringify({ total_commits: 61, commits: [{ sha: 'abcdef1234', commit: { message: 'Add calls\n\nbody' } }], files }), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

test('changeSummary handles large diffs, skips lockfiles and secrets, samples biggest files first', async () => {
  const p = createGitProvider({ provider: 'github', owner: 'o', repo: 'r', token: 't', gitlabBaseUrl: 'https://gitlab.com' }, fake);
  const s = await p.changeSummary('a'.repeat(40), 'b'.repeat(40));
  expect(s.totalCommits).toBe(61);
  expect(s.commits[0]).toEqual({ sha: 'abcdef1', subject: 'Add calls' });
  expect(s.files.length).toBe(204);
  expect(s.sampled[0]!.file).toBe('src/calls.ts');
  expect(s.sampled.some(f => f.file === 'bun.lock' || f.file === '.env.production')).toBe(false);
  expect(s.additions).toBe(300 + 900 + 3 + 20 + 200);
});
