import type { GitBranch, GitComparison, GitPage, GitPR, GitProvider } from './git-provider.ts';
export type WorkspaceEpic = { id: string; name: string; epicKey: string | null; branch: string | null; baseBranch: string | null; baseSha: string | null };
export type WorkspaceTicket = { id: string; title: string; epicId: string | null; githubBranch: string | null; status: string; queueStatus?: string | null; executionActive?: boolean; destination: string };
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
export async function buildGitWorkspace(provider: GitProvider, epics: WorkspaceEpic[], tickets: WorkspaceTicket[], previewTicketId: string | null) {
  const info = await provider.info();
  const [branches, openPRs, mergedPRs] = await Promise.all([provider.branches(), provider.pullRequests(), provider.pullRequests(true)]);
  const refs = new Map(branches.items.map(b => [b.branch, b]));
  const comparisons = new Map<string, Promise<GitComparison>>();
  const compare: GitProvider['compare'] = (base, head) => {
    const key = `${base}:${head}`;
    if (!comparisons.has(key)) comparisons.set(key, provider.compare(base, head));
    return comparisons.get(key)!;
  };
  const used = new Set<string>([info.defaultBranch]);
  const row = async (id: string, name: string, branch: string | null, destination: string | null, baseSha: string | null, ticket?: WorkspaceTicket) => {
    if (branch) used.add(branch);
    const ref = branch ? refs.get(branch) : undefined;
    return { id, name, branch, headSha: ref?.headSha ?? null, missingRef: !ref, protected: ref?.protected ?? false, destination, baseSha: destination ? refs.get(destination)?.headSha ?? null : null, storedBaseSha: baseSha,
      integration: await integrationFor(ref, destination ? refs.get(destination) : undefined, mergedPRs, provider.identity, compare),
      activeUse: { preview: !!ticket && ticket.id === previewTicketId, execution: !!ticket?.executionActive || ticket?.queueStatus === 'executing', queued: ticket?.queueStatus === 'queued' },
      pullRequests: openPRs.items.filter(p => p.sourceRepo?.toLowerCase() === provider.identity.toLowerCase() && p.source === branch && p.destination === destination),
    };
  };
  const groups = [];
  // Sequential groups + small row batches bound provider concurrency, even in large repositories.
  for (const epic of epics) {
    const delivery = await row(epic.id, epic.name, epic.branch, epic.baseBranch || info.defaultBranch, epic.baseSha);
    const children = [];
    for (const ticket of tickets.filter(t => t.epicId === epic.id)) children.push(await row(ticket.id, ticket.title, ticket.githubBranch, ticket.destination, null, ticket));
    delivery.activeUse.preview = children.some(t => t.activeUse.preview);
    delivery.activeUse.execution = children.some(t => t.activeUse.execution);
    groups.push({ ...delivery, epicKey: epic.epicKey, tickets: children });
  }
  const other: Awaited<ReturnType<typeof row>>[] = [];
  for (const ticket of tickets.filter(t => !epics.some(e => e.id === t.epicId))) other.push(await row(ticket.id, ticket.title, ticket.githubBranch, ticket.destination, null, ticket));
  for (const b of branches.items.filter(b => !used.has(b.branch))) other.push(await row(`branch:${b.branch}`, b.branch, b.branch, info.defaultBranch, null));
  const ticketRows = [...groups.flatMap(e => e.tickets), ...other.filter(r => tickets.some(t => t.id === r.id))];
  const count = (rows: typeof other) => ({ total: rows.length, integrated: rows.filter(r => r.integration.status === 'integrated').length, notIntegrated: rows.filter(r => r.integration.status === 'not_integrated').length, unknown: rows.filter(r => r.integration.status === 'unknown').length });
  const errors = [...branches.errors, ...openPRs.errors, ...mergedPRs.errors, ...provider.errors];
  const comparisonsComplete = refs.has(info.defaultBranch) && [...groups, ...ticketRows, ...other].every(r => r.integration.status !== 'unknown');
  return { repository: provider.identity, provider: provider.provider, readOnly: true, defaultBranch: { branch: info.defaultBranch, ...refs.get(info.defaultBranch), missingRef: !refs.has(info.defaultBranch) }, epics: groups, other, pullRequests: openPRs.items,
    totals: { epics: count(groups), tickets: count(ticketRows), other: count(other), openPRs: openPRs.items.length },
    completeness: { complete: branches.complete && openPRs.complete && mergedPRs.complete && comparisonsComplete, branches: branches.complete, pullRequests: openPRs.complete, mergeEvidence: mergedPRs.complete, comparisons: comparisonsComplete, errors: errors.slice(0, 30) },
  };
}
