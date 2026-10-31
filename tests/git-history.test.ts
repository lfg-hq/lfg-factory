// TEST-ONLY deterministic parent histories. No live Git calls or mutations.
import { test, expect } from 'bun:test';
import { createGitProvider } from '../src/services/git-provider.ts';
import { buildHistory } from '../src/services/git-history.ts';
const sha = (n: number) => n.toString(16).padStart(40, '0');
for (const provider of ['github', 'gitlab'] as const) test(`${provider} immutable history pagination preserves multi-parent merges; failures are safe`, async () => {
  const seen: URL[] = [];
  const p = createGitProvider({ provider, owner: 'fixture', repo: 'fixture', token: 'fixture-secret' }, (async (url: string) => {
    const u = new URL(url); seen.push(u);
    expect(u.searchParams.get(provider === 'github' ? 'sha' : 'ref_name')).toBe(sha(4));
    if (u.searchParams.get('page') === '2') return new Response('TEST ONLY private source', { status: 403, headers: { 'x-request-id': 'fixture-request', 'x-github-request-id': 'fixture-request' } });
    return Response.json(provider === 'github' ? [{ sha: sha(4), parents: [{ sha: sha(2) }, { sha: sha(3) }] }] : [{ id: sha(4), parent_ids: [sha(2), sha(3)] }], { headers: provider === 'github' ? { link: '<https://untrusted.invalid>; rel="next"' } : { 'x-next-page': '2' } });
  }) as typeof fetch);
  const first = await p.history(sha(4));
  expect(first).toMatchObject({ items: [{ sha: sha(4), parents: [sha(2), sha(3)] }], complete: false, nextPage: 2 });
  const failed = await p.history(sha(4), first.nextPage!);
  expect(failed).toMatchObject({ complete: false, nextPage: 2, errors: [{ code: 'PROVIDER_ACCESS_DENIED', providerRequestId: 'fixture-request' }] });
  expect(JSON.stringify(failed)).not.toMatch(/private source|fixture-secret/);
  expect(seen.every(u => u.host !== 'untrusted.invalid')).toBe(true);
  await expect(p.history('moving-ref')).rejects.toMatchObject({ code: 'INVALID_HISTORY_BOUNDS' });
  await expect(p.history(sha(4), 0)).rejects.toMatchObject({ code: 'INVALID_HISTORY_BOUNDS' });
});
test('dedup shared commits, actual splits/merge edges, bounded roots and no branchless nodes', async () => {
  const p = createGitProvider({ provider: 'github', owner: 'fixture', repo: 'fixture', token: 'fixture' });
  let active = 0, peak = 0;
  p.history = async (root) => {
    peak = Math.max(peak, ++active); await Bun.sleep(1); active--;
    return { items: [{ sha: root, parents: [sha(2), sha(3)] }, { sha: sha(2), parents: [sha(1)] }, { sha: sha(3), parents: [sha(1)] }, { sha: sha(1), parents: [sha(0)] }], complete: false, nextPage: 2, errors: [] };
  };
  const rows = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, branch: `b${i}`, headSha: sha(i + 4), refState: 'present', integration: { status: 'unknown' } }));
  const g = await buildHistory(p, [...rows, { id: 'none', branch: null, headSha: null, refState: 'no_branch', integration: { status: 'unknown' } }, { ...rows[0]!, id: 'absent', branch: 'deleted', headSha: null, refState: 'absent' }], [{ id: 'epic', rowIds: rows.map(r => r.id) }]);
  expect(peak).toBeLessThanOrEqual(3);
  expect(g.heads).toHaveLength(16); expect(g.heads.some(h => h.rowId === 'none')).toBe(false);
  expect(g.heads.filter(h => h.sha && !h.history)).toHaveLength(3);
  expect(g.nodes.filter(c => c.sha === sha(1))).toHaveLength(1);
  expect(g.edges).toContainEqual({ parentSha: sha(2), childSha: sha(4) });
  expect(g.edges).toContainEqual({ parentSha: sha(3), childSha: sha(4) });
  expect(g.edges).toContainEqual({ parentSha: sha(1), childSha: sha(3) });
  expect(g.nodes.some(c => c.sha === sha(0))).toBe(false); // bounded missing-parent boundary
  expect(g.complete).toBe(false);
});
