import { GitProviderError, type GitCommit, type GitHistory, type GitProvider } from './git-provider.ts';
export type HistoryRow = { id: string; branch: string | null; headSha: string | null; refState: string; integration: { status: string } };
export type HistoryHead = { rowId: string; branch: string; sha: string | null; refState: string; historical: boolean; history: GitHistory | null };
/** Associations select scopes, NEVER edges. Only provider parent metadata creates edges. */
export async function buildHistory(provider: GitProvider, rows: HistoryRow[], scopes: { id: string; rowIds: string[] }[], historical: { rowId: string; branch: string; sha: string }[] = []) {
  const heads: HistoryHead[] = rows.filter(r => r.branch).map(r => ({ rowId: r.id, branch: r.branch!, sha: r.headSha, refState: r.refState, historical: false, history: null }));
  for (const h of historical) if (!heads.some(v => v.rowId === h.rowId && v.sha === h.sha)) heads.push({ ...h, refState: 'historical', historical: true, history: null });
  const roots = [...new Set(heads.flatMap(h => h.sha ? [h.sha] : []))];
  const histories = new Map<string, GitHistory>();
  // First 12 unique heads, three concurrent calls. Unfetched heads remain attached and loadable.
  let index = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (index < Math.min(12, roots.length)) {
      const sha = roots[index++]!;
      try { histories.set(sha, await provider.history(sha)); }
      catch (e) { histories.set(sha, { items: [], complete: false, nextPage: 1, errors: [{ code: e instanceof GitProviderError ? e.code : 'HISTORY_UNAVAILABLE' }] }); }
    }
  }));
  const nodes = new Map<string, GitCommit>();
  for (const head of heads) {
    head.history = head.sha ? histories.get(head.sha) ?? null : null;
    for (const c of head.history?.items || []) nodes.set(c.sha, c);
  }
  const edges = [...nodes.values()].flatMap(c => c.parents.map(parentSha => ({ parentSha, childSha: c.sha })));
  return { nodes: [...nodes.values()], edges, heads: heads.map(h => ({ ...h, history: h.history ? { ...h.history, items: undefined } : null })), scopes,
    complete: heads.every(h => h.sha && h.history?.complete), pageSize: 30 };
}
