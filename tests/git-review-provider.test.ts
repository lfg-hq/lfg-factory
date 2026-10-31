// TEST-ONLY provider HTTP fixtures. No real tokens, AI calls or PR mutations.
import { test, expect } from 'bun:test';
import { createGitProvider } from '../src/services/git-provider.ts';
const head = 'a'.repeat(40), base = 'b'.repeat(40);
for (const provider of ['github', 'gitlab'] as const) test(`${provider}: immutable bounded review context and explicit PR mutation use native APIs`, async () => {
  const paths: string[] = [], mutations: any[] = [];
  const adapter = createGitProvider({ provider, owner: 'fixture/group', repo: 'repo', token: 'test-only-secret-token' }, (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname; paths.push(url);
    if (init.method === 'POST') {
      mutations.push(JSON.parse(init.body as string));
      return Response.json(provider === 'github' ? { number: 5, html_url: 'https://github.com/fixture/group/repo/pull/5' } : { iid: 5, web_url: 'https://gitlab.com/fixture/group/repo/-/merge_requests/5' });
    }
    if (path.includes('/branches/')) return Response.json({ commit: { id: head, sha: head } });
    if (path.includes('/compare')) return Response.json(provider === 'github' ? { files: [{ filename: 'src/code.ts', patch: '@@ -1 +1 @@\n-before\n+after', additions: 1, deletions: 1 }] } : { compare_timeout: false, diffs: [{ new_path: 'src/code.ts', diff: '@@ -1 +1 @@\n-before\n+after' }] });
    return Response.json({ encoding: 'base64', content: Buffer.from('after').toString('base64'), size: 5 });
  }) as typeof fetch);
  expect(await adapter.ref('feature/nested')).toBe(head);
  const changes = await adapter.reviewChanges(base, head); expect(changes.files[0]?.context).toBe('after'); expect(changes.excluded).toEqual([]);
  expect(paths.filter(p => p.includes('compare'))[0]).toContain(base); expect(paths.filter(p => p.includes('compare'))[0]).toContain(head);
  expect(paths.at(-1)).toContain(`ref=${head}`); expect(mutations).toHaveLength(0);
  expect((await adapter.createPullRequest('feature/nested', 'main', 'TEST FIXTURE title', 'TEST FIXTURE body')).id).toBe(5);
  expect(mutations[0]).toMatchObject(provider === 'github' ? { head: 'feature/nested', base: 'main' } : { source_branch: 'feature/nested', target_branch: 'main' });
});
test('secret, binary and truncated patches are excluded without forwarding their context', async () => {
  let contextRequests = 0;
  const adapter = createGitProvider({ provider: 'github', owner: 'fixture', repo: 'repo', token: 'test-only-secret-token' }, (async (url: string) => {
    if (!url.includes('/compare/')) contextRequests++;
    return Response.json({ files: [
      { filename: '.env', patch: '+TEST_FIXTURE_SECRET=value' },
      { filename: 'image.png' },
      { filename: 'src/truncated.ts', patch: '+one', additions: 8, deletions: 0 },
      { filename: 'src/secret.ts', patch: '+token = "test-fixture-secret-value"' },
    ] });
  }) as typeof fetch);
  const changes = await adapter.reviewChanges(base, head); expect(changes.files).toHaveLength(0); expect(changes.excluded).toHaveLength(4); expect(contextRequests).toBe(0);
});
test('oversized and provider-truncated diffs fail closed', async () => {
  const adapter = createGitProvider({ provider: 'gitlab', owner: 'fixture', repo: 'repo', token: 'test-only-secret-token' }, (async () => Response.json({ compare_timeout: true, diffs: [] })) as typeof fetch);
  await expect(adapter.reviewChanges(base, head)).rejects.toMatchObject({ code: 'DIFF_INCOMPLETE' });
  const oversized = createGitProvider({ provider: 'github', owner: 'fixture', repo: 'repo', token: 'test-only-secret-token' }, (async () => Response.json({ files: Array.from({ length: 41 }, () => ({})) })) as typeof fetch);
  await expect(oversized.reviewChanges(base, head)).rejects.toMatchObject({ code: 'DIFF_TOO_LARGE' });
});
