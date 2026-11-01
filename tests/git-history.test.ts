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
    return Response.json(provider === 'github' ? [{ sha: sha(4), parents: [{ sha: sha(2) }, { sha: sha(3) }], commit: { message: 'TEST FIXTURE summary\nBody not a summary', committer: {date:'2026-01-02T03:04:05+02:00'} } }] : [{ id: sha(4), parent_ids: [sha(2), sha(3)], title:'TEST FIXTURE summary', committed_date:'2026-01-02T03:04:05+02:00' }], { headers: provider === 'github' ? { link: '<https://untrusted.invalid>; rel="next"' } : { 'x-next-page': '2' } });
  }) as typeof fetch);
  const first = await p.history(sha(4));
  expect(first).toMatchObject({ items: [{ sha: sha(4), parents: [sha(2), sha(3)], summary:'TEST FIXTURE summary', committedAt:'2026-01-02T01:04:05.000Z' }], complete: false, nextPage: 2 });
  const failed = await p.history(sha(4), first.nextPage!);
  expect(failed).toMatchObject({ complete: false, nextPage: 2, errors: [{ code: 'PROVIDER_ACCESS_DENIED', providerRequestId: 'fixture-request' }] });
  expect(JSON.stringify(failed)).not.toMatch(/private source|fixture-secret/);
  expect(seen.every(u => u.host !== 'untrusted.invalid')).toBe(true);
  await expect(p.history('moving-ref')).rejects.toMatchObject({ code: 'INVALID_HISTORY_BOUNDS' });
  await expect(p.history(sha(4), 0)).rejects.toMatchObject({ code: 'INVALID_HISTORY_BOUNDS' });
});
for (const provider of ['github', 'gitlab'] as const) test(`${provider} missing or invalid activity remains null without extra requests`, async () => {
  let calls = 0;
  const p = createGitProvider({provider,owner:'fixture',repo:'fixture',token:'TEST_ONLY'}, (async () => {
    calls++;
    return Response.json(provider === 'github'
      ? [{sha:sha(1),parents:[],commit:{message:null,committer:{date:'not a date'}}},{sha:sha(2),parents:[]}]
      : [{id:sha(1),parent_ids:[],title:null,committed_date:'not a date'},{id:sha(2),parent_ids:[]}]);
  }) as typeof fetch);
  const history = await p.history(sha(2));
  expect(history.items.map(c => [c.summary,c.committedAt])).toEqual([[null,null],[null,null]]);
  expect(calls).toBe(1);
});
test('dedup shared commits, actual splits/merge edges, bounded roots and no branchless nodes', async () => {
  const p = createGitProvider({ provider: 'github', owner: 'fixture', repo: 'fixture', token: 'fixture' });
  let active = 0, peak = 0;
  p.history = async (root) => {
    peak = Math.max(peak, ++active); await Bun.sleep(1); active--;
    return { items: [{ sha: root, parents: [sha(2), sha(3)], summary:'TEST FIXTURE preserved', committedAt:'2026-01-01T00:00:00.000Z' }, ...[{ sha: sha(2), parents: [sha(1)] }, { sha: sha(3), parents: [sha(1)] }, { sha: sha(1), parents: [sha(0)] }].map(c => ({...c,summary:null,committedAt:null}))], complete: false, nextPage: 2, errors: [] };
  };
  const rows = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, branch: `b${i}`, headSha: sha(i + 4), refState: 'present', integration: { status: 'unknown' } }));
  const g = await buildHistory(p, [...rows, { id: 'none', branch: null, headSha: null, refState: 'no_branch', integration: { status: 'unknown' } }, { ...rows[0]!, id: 'absent', branch: 'deleted', headSha: null, refState: 'absent' }], [{ id: 'epic', rowIds: rows.map(r => r.id) }]);
  expect(peak).toBeLessThanOrEqual(3);
  expect(g.heads).toHaveLength(16); expect(g.heads.some(h => h.rowId === 'none')).toBe(false);
  expect(g.heads.filter(h => h.sha && !h.history)).toHaveLength(3);
  expect(g.nodes.filter(c => c.sha === sha(1))).toHaveLength(1);
  expect(g.nodes.find(c => c.sha === sha(4))).toMatchObject({summary:'TEST FIXTURE preserved',committedAt:'2026-01-01T00:00:00.000Z'});
  expect(g.edges).toContainEqual({ parentSha: sha(2), childSha: sha(4) });
  expect(g.edges).toContainEqual({ parentSha: sha(3), childSha: sha(4) });
  expect(g.edges).toContainEqual({ parentSha: sha(1), childSha: sha(3) });
  expect(g.nodes.some(c => c.sha === sha(0))).toBe(false); // bounded missing-parent boundary
  expect(g.complete).toBe(false);
});
