import type { GitBranch, GitComparison, GitPage, GitPR, GitProvider } from './git-provider.ts';
import { buildHistory } from './git-history.ts';
export type WorkspaceEpic = { id: string; name: string; epicKey: string | null; branch: string | null; baseBranch: string | null; baseSha: string | null; parentEpicId?: string | null };
export type WorkspaceTicket = { id: string; ticketKey?: string | null; title: string; epicId: string | null; githubBranch: string | null; status: string; queueStatus?: string | null; executionActive?: boolean; destination: string };
export type Integration = { status: 'integrated' | 'not_integrated' | 'unknown'; evidence: string; ahead: number | null; behind: number | null };
/** Historical PRs prove only their exact head, in the same repository and destination.
 * The merge result must still be contained in the current destination (force-push safe). */
export async function integrationFor(head: GitBranch | undefined, destination: GitBranch | undefined, prs: GitPage<GitPR>, identity: string, compare: GitProvider['compare']): Promise<Integration> {
  const unknown: Integration = { status: 'unknown', evidence: 'Comparison unavailable or missing ref', ahead: null, behind: null };
  if (!head || !destination) return unknown;
  const c = await compare(destination.headSha, head.headSha);
  if (c.complete && c.ahead === 0) return { status: 'integrated', evidence: head.headSha === destination.headSha ? 'Identical refs · no unique work' : 'Current revision contained in destination', ahead: c.ahead, behind: c.behind };
  for (const p of prs.items.filter(p => p.merged && p.sourceRepo?.toLowerCase() === identity.toLowerCase() && p.source === head.branch && p.destination === destination.branch && p.headSha === head.headSha && p.mergeSha)) {
    const evidence = await compare(destination.headSha, p.mergeSha!);
    if (evidence.complete && evidence.ahead === 0) return { status: 'integrated', evidence: `Verified merged PR #${p.id} · current head (squash/rebase supported)`, ahead: c.ahead, behind: c.behind };
  }
  return c.complete && prs.complete ? { status: 'not_integrated', evidence: 'Current revision not contained; no matching merged PR evidence', ahead: c.ahead, behind: c.behind } : { ...unknown, ahead: c.ahead, behind: c.behind };
}
export async function buildGitWorkspace(provider: GitProvider, epics: WorkspaceEpic[], tickets: WorkspaceTicket[], previewTicketId: string | null, reconcileMerged?: (prs: GitPR[]) => Promise<void>) {
  const info = await provider.info();
  const [branches, openPRs, mergedPRs] = await Promise.all([provider.branches(), provider.pullRequests(), provider.pullRequests(true)]);
  if (mergedPRs.complete && reconcileMerged) await reconcileMerged(mergedPRs.items);
  const refs = new Map(branches.items.map(b => [b.branch, b]));
  const comparisons = new Map<string, Promise<GitComparison>>();
  const compare: GitProvider['compare'] = (base, head) => {
    const key = `${base}:${head}`;
    if (!comparisons.has(key)) comparisons.set(key, provider.compare(base, head));
    return comparisons.get(key)!;
  };
  const used = new Set<string>([info.defaultBranch]);
  const row = async (id: string, name: string, branch: string | null, destination: string | null, baseSha: string | null, ticket?: WorkspaceTicket, overview = false) => {
    if (branch) used.add(branch);
    const ref = branch ? refs.get(branch) : undefined;
    const refState = !branch ? 'no_branch' : ref ? 'present' : branches.complete ? 'absent' : 'unavailable';
    const integration = await integrationFor(ref, destination ? refs.get(destination) : undefined, mergedPRs, provider.identity, compare);
    const defaultComparison = overview ? { branch: info.defaultBranch, baseSha: refs.get(info.defaultBranch)?.headSha ?? null,
      integration: destination === info.defaultBranch ? integration : await integrationFor(ref, refs.get(info.defaultBranch), mergedPRs, provider.identity, compare) } : null;
    return { id, name, ticketKey: ticket?.ticketKey ?? null, branch, headSha: ref?.headSha ?? null, refState, missingRef: refState === 'absent', protected: ref?.protected ?? false, destination, baseSha: destination ? refs.get(destination)?.headSha ?? null : null, storedBaseSha: baseSha,
      integration, defaultComparison,
      activeUse: { preview: !!ticket && ticket.id === previewTicketId, execution: !!ticket?.executionActive || ticket?.queueStatus === 'executing', queued: ticket?.queueStatus === 'queued' },
      pullRequests: openPRs.items.filter(p => p.sourceRepo?.toLowerCase() === provider.identity.toLowerCase() && p.source === branch && p.destination === destination),
    };
  };
  const groups = [];
  // Sequential groups + small row batches bound provider concurrency, even in large repositories.
  for (const epic of epics) {
    const delivery = await row(epic.id, epic.name, epic.branch, epic.baseBranch || info.defaultBranch, epic.baseSha, undefined, true);
    const children = [];
    for (const ticket of tickets.filter(t => t.epicId === epic.id)) children.push(await row(ticket.id, ticket.title, ticket.githubBranch, ticket.destination, null, ticket));
    delivery.activeUse.execution = children.some(t => t.activeUse.execution);
    groups.push({ ...delivery, epicKey: epic.epicKey, parentEpicId: epic.parentEpicId ?? null, tickets: children });
  }
  const other: Awaited<ReturnType<typeof row>>[] = [];
  for (const ticket of tickets.filter(t => !epics.some(e => e.id === t.epicId))) other.push(await row(ticket.id, ticket.title, ticket.githubBranch, ticket.destination, null, ticket, true));
  for (const b of branches.items.filter(b => !used.has(b.branch))) other.push(await row(`branch:${b.branch}`, b.branch, b.branch, info.defaultBranch, null, undefined, true));
  const ticketRows = [...groups.flatMap(e => e.tickets), ...other.filter(r => tickets.some(t => t.id === r.id))];
  const count = (rows: typeof other) => ({ total: rows.length, integrated: rows.filter(r => r.integration.status === 'integrated').length, notIntegrated: rows.filter(r => r.integration.status === 'not_integrated').length, unknown: rows.filter(r => r.integration.status === 'unknown').length });
  // Ticket associations remain visible, but only stored branch names contribute to branch counts.
  const branchCounts = (rows: typeof other) => ({ ...count(rows.filter(r => r.branch)), associations: rows.length, withoutBranch: rows.filter(r => !r.branch).length });
  const allRows = [...groups.flatMap(g => [g, ...g.tickets]), ...other];
  const defaultRef = refs.get(info.defaultBranch);
  const graph = await buildHistory(provider, [...allRows, { id: 'default', branch: info.defaultBranch, headSha: defaultRef?.headSha ?? null, refState: defaultRef ? 'present' : branches.complete ? 'absent' : 'unavailable', integration: { status: 'integrated' } }], [
    { id: 'pending', rowIds: [...groups, ...other].filter(r => r.branch && r.defaultComparison?.integration.status !== 'integrated').map(r => r.id).concat('default') },
    ...groups.map(g => ({ id: g.id, rowIds: [g.id, ...g.tickets.filter(t => t.branch).map(t => t.id)] })),
    { id: 'other', rowIds: other.filter(r => r.branch).map(r => r.id) },
  ], allRows.flatMap(r => mergedPRs.items.filter(p => p.merged && p.sourceRepo?.toLowerCase() === provider.identity.toLowerCase() && p.source === r.branch && p.destination === r.destination && p.headSha && p.headSha !== r.headSha).map(p => ({ rowId: r.id, branch: r.branch!, sha: p.headSha }))));
  const errors = [...branches.errors, ...openPRs.errors, ...mergedPRs.errors, ...provider.errors, ...graph.heads.flatMap(h => h.history?.errors || [])];
  const comparisonsComplete = refs.has(info.defaultBranch) && [...groups, ...ticketRows, ...other].filter(r => r.branch).every(r => r.integration.status !== 'unknown' && (!r.defaultComparison || r.defaultComparison.integration.status !== 'unknown'));
  return { graph, repository: provider.identity, provider: provider.provider, readOnly: true, defaultBranch: { branch: info.defaultBranch, ...refs.get(info.defaultBranch), missingRef: branches.complete && !refs.has(info.defaultBranch), refState: refs.has(info.defaultBranch) ? 'present' : branches.complete ? 'absent' : 'unavailable' }, epics: groups.map(g => ({ ...g, ticketCounts: branchCounts(g.tickets) })), other, pullRequests: openPRs.items,
    totals: { epics: count(groups), tickets: branchCounts(ticketRows), other: branchCounts(other), openPRs: openPRs.items.length },
    completeness: { complete: branches.complete && openPRs.complete && mergedPRs.complete && comparisonsComplete && graph.complete, history: graph.complete, branches: branches.complete, pullRequests: openPRs.complete, mergeEvidence: mergedPRs.complete, comparisons: comparisonsComplete, errors: errors.slice(0, 30) },
  };
}
