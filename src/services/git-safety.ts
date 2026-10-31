import { db } from '../config/db.ts';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { projects } from '../db/schema/projects.ts';
import { epics } from '../db/schema/epics.ts';
import { projectTickets, ticketMergeHistory } from '../db/schema/tickets.ts';
import { projectEnvironments } from '../db/schema/project-environments.ts';
import { ticketExecutions } from '../db/schema/orchestrator.ts';
import { runtimeValidations } from '../db/schema/runtime-validation.ts';
import { gitOperations } from '../db/schema/git-reviews.ts';
import { sandboxes } from '../db/schema/sandbox.ts';
import { gitMutations } from '../db/schema/git-mutations.ts';
import { getMergeBlockers, maybeSubmitEpicForReview } from './epics.ts';
import { GitProviderError, type GitProvider, type GitPR } from './git-provider.ts';
import { logActivity } from './activity-log.ts';
import { logGitRequest } from './git-logging.ts';

export class GitSafetyError extends GitProviderError { constructor(code: string) { super(code, 409); } }
export function gitSafetyMessage(code: string) {
  const reasons: Record<string, string> = {
    DRAFT: 'Mark the PR ready for review at the provider first.',
    PROVIDER_POLICY_OR_CONFLICT: 'Resolve conflicts, required reviews/checks or protection policy at the provider, then refresh.',
    CHECKS_FAILED_OR_UNKNOWN: 'Wait for all required checks to pass, then refresh.',
    APPROVAL_REQUIRED_OR_UNKNOWN: 'Obtain the required provider approvals, then refresh.',
    UNSUPPORTED_MERGE_QUEUE: 'This repository requires a merge queue. Use the provider link; LFG will not bypass it.',
    NOT_APPROVED: 'Approve the epic through its existing review lifecycle first. Creating a PR is not approval.',
    PARENT_UNMERGED: 'Land the approved parent epic first or resolve its dependency.',
    STALE_PR_OR_DESTINATION: 'The source revision or destination changed. Refresh and confirm the new revision.',
    STALE_REF: 'The branch changed or no longer exists. Refresh before confirming deletion again.',
    DEFAULT_OR_PROTECTED_BRANCH: 'Default and protected branches cannot be deleted here.',
    SELECTED_PREVIEW: 'This branch is selected for preview. Select another preview explicitly before retrying.',
    ACTIVE_PREVIEW: 'A running or preparing preview uses this branch. Stop it or explicitly select another preview first.',
    ACTIVE_BUILD: 'A queued or active build uses this branch. Wait for completion or cancel the build first.',
    ACTIVE_RUNTIME: 'An active sandbox uses this branch. Stop that sandbox before retrying.',
    ACTIVE_VALIDATION: 'A validation job uses this branch. Wait for it to finish first.',
    ACTIVE_GIT_OPERATION: 'A Git operation is active or uncertain. Inspect its provider outcome before retrying.',
    ACTIVE_EPIC_DEPENDENTS: 'The epic still has active children or dependent epics. Resolve them first; deletion never cascades.',
    OPEN_PR_USES_BRANCH: 'An open PR uses this branch as source or destination. Resolve that PR first.',
    EXACT_CONFIRMATION_REQUIRED: 'Type the exact branch name to confirm.',
    UNMERGED_WORK_CONFIRMATION_REQUIRED: 'This branch has unmerged or unknown work. Explicitly confirm the unmerged-work warning to delete it.',
    OUTCOME_UNCERTAIN_CHECK_PROVIDER: 'The prior request may have reached the provider. Inspect the provider link; LFG will reconcile confirmed success but will not resend an uncertain mutation.',
    GIT_DISCONNECTED: 'Connect the acting Git account in Settings → Integrations, then retry.',
    TICKET_DESTINATION_MISMATCH: 'This ticket must merge into its stored epic branch, not another destination.',
    EPIC_DESTINATION_MISMATCH: 'This epic must merge into its declared base branch.',
  };
  return code.split(',').map(c => reasons[c] || 'Operation not confirmed. Refresh the PR/ref and inspect repository permissions and policy at the provider before retrying.').join(' ');
}
const deny = (code: string): never => { throw new GitSafetyError(code); };
const locks = new Map<string, Promise<unknown>>();
/** Whole repository serialization also prevents concurrent source/target operations locally. */
export async function serializeGit<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work); locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}
export function validateConfirmation(input: any, branch: string) {
  if (typeof branch !== 'string' || !branch || branch.length > 250 || /[\x00-\x20~^:?*\\\[]/.test(branch) || branch.includes('..') || branch.includes('@{')) deny('INVALID_BRANCH');
  if (input.confirmation !== branch) deny('EXACT_CONFIRMATION_REQUIRED');
  if (!/^[a-f0-9]{40,64}$/.test(input.expectedSha || '')) deny('EXPECTED_SHA_REQUIRED');
}
export async function localBranchBlockers(projectId: string, branch: string, deleting: boolean): Promise<string[]> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return ['PROJECT_NOT_FOUND'];
  // A repository can be connected to multiple projects. Protect all of its local runtimes,
  // without disclosing the other projects or granting access to their data.
  const repoName = project.repoName?.replace(/\.git$/, '').toLowerCase();
  const peers = repoName && project.repoOwner ? await db.select().from(projects).where(and(
    eq(sql`lower(${projects.repoOwner})`, project.repoOwner.toLowerCase()),
    inArray(sql`lower(${projects.repoName})`, [repoName, `${repoName}.git`]),
    eq(sql`coalesce(${projects.repoProvider}, 'github')`, project.repoProvider || 'github'),
  )) : [project];
  const projectIds = [...new Set([projectId, ...peers.map(p => p.id)])];
  const [tickets, storedEpics, environments, executions, validations, runtimes, operations, mutations] = await Promise.all([
    db.select().from(projectTickets).where(inArray(projectTickets.projectId, projectIds)),
    db.select().from(epics).where(inArray(epics.projectId, projectIds)),
    db.select().from(projectEnvironments).where(inArray(projectEnvironments.projectId, projectIds)),
    db.select({ ticketId: ticketExecutions.ticketId }).from(ticketExecutions).innerJoin(projectTickets, eq(projectTickets.id, ticketExecutions.ticketId)).where(and(inArray(projectTickets.projectId, projectIds), inArray(ticketExecutions.status, ['queued', 'ready', 'running', 'blocked']))),
    db.select().from(runtimeValidations).where(and(inArray(runtimeValidations.projectId, projectIds), inArray(runtimeValidations.status, ['queued', 'running']))),
    db.select().from(sandboxes).where(and(inArray(sandboxes.projectId, projectIds), inArray(sandboxes.status, ['ready', 'busy', 'held', 'cloning', 'unresponsive', 'unconfirmed']))),
    db.select().from(gitOperations).where(and(inArray(gitOperations.projectId, projectIds), inArray(gitOperations.status, ['started', 'uncertain']))),
    db.select().from(gitMutations).where(and(inArray(gitMutations.projectId, projectIds), inArray(gitMutations.status, ['started', 'uncertain']))),
  ]);
  const blockers: string[] = [];
  for (const peer of peers) {
    const selected = tickets.find(t => t.id === peer.previewTicketId);
    const selectedEpic = storedEpics.find(e => e.id === selected?.epicId);
    if (selected && (selected.githubBranch === branch || selectedEpic?.branch === branch)) blockers.push('SELECTED_PREVIEW');
  }
  if (environments.some(e => (e.previewBranch === branch || !e.previewBranch || ['(default)', 'default'].includes(e.previewBranch)) && !['idle', 'stopped'].includes(e.previewStatus))) blockers.push('ACTIVE_PREVIEW');
  const activeTickets = tickets.filter(t => ['queued', 'executing'].includes(t.queueStatus) || executions.some(e => e.ticketId === t.id));
  if (activeTickets.some(t => t.githubBranch === branch || (!t.epicId && branch === 'lfg-agent') || storedEpics.some(e => e.id === t.epicId && (e.branch === branch || e.baseBranch === branch)))) blockers.push('ACTIVE_BUILD');
  if (validations.some(v => v.branch === branch)) blockers.push('ACTIVE_VALIDATION');
  if (runtimes.some(r => r.currentBranch === branch)) blockers.push('ACTIVE_RUNTIME');
  if ([...operations, ...mutations].some(o => o.headRef === branch || o.baseRef === branch)) blockers.push('ACTIVE_GIT_OPERATION');
  if (deleting) {
    if (storedEpics.filter(e => e.branch === branch).some(epic => tickets.some(t => t.epicId === epic.id && !['done', 'archived'].includes(t.status)) || storedEpics.some(e => e.parentEpicId === epic.id && e.status !== 'merged'))) blockers.push('ACTIVE_EPIC_DEPENDENTS');
  }
  return [...new Set(blockers)];
}
export async function mergeBlockers(projectId: string, p: GitPR, provider: GitProvider) {
  const blockers = [...await localBranchBlockers(projectId, p.destination, false), ...await localBranchBlockers(projectId, p.source, false)];
  const storedEpics = await db.select().from(epics).where(eq(epics.projectId, projectId));
  if (p.sourceRepo?.toLowerCase() === provider.identity.toLowerCase()) {
    const epic = storedEpics.find(e => e.branch === p.source);
    if (epic) {
      if (p.destination !== (epic.baseBranch || 'main')) blockers.push('EPIC_DESTINATION_MISMATCH');
      blockers.push(...(await getMergeBlockers(epic)).map(b => b.code.toUpperCase()));
    }
    const tickets = await db.select().from(projectTickets).where(and(eq(projectTickets.projectId, projectId), eq(projectTickets.githubBranch, p.source)));
    for (const ticket of tickets) if (ticket.epicId && storedEpics.find(e => e.id === ticket.epicId)?.branch !== p.destination) blockers.push('TICKET_DESTINATION_MISMATCH');
  }
  return blockers;
}
export async function reconcile(projectId: string, actorId: string, provider: GitProvider, p: GitPR, correlationId: string) {
  if (!p.merged || !p.mergeSha || p.sourceRepo?.toLowerCase() !== provider.identity.toLowerCase()) return;
  // Historical external PRs must not overwrite linkage for a subsequently changed branch.
  try { if (await provider.ref(p.source) !== p.headSha) return; } catch (e) { if (e instanceof GitProviderError && e.code === 'PROVIDER_NOT_FOUND') return; throw e; }
  const linkedEpics = await db.select().from(epics).where(and(eq(epics.projectId, projectId), eq(epics.branch, p.source)));
  for (const epic of linkedEpics) {
    // External merges do not manufacture approval or bless an unexpected destination.
    if (p.destination === (epic.baseBranch || 'main') && epic.status === 'approved') {
      const changed = await db.update(epics).set({ status: 'merged', mergeCommitSha: p.mergeSha, prNumber: p.id, prUrl: p.url, mergedAt: new Date(), updatedAt: new Date() }).where(and(eq(epics.id, epic.id), eq(epics.status, 'approved'))).returning();
      if (changed.length) await logActivity({ projectId, actorType: 'system', activityType: 'git_epic_reconciled', title: 'Provider-confirmed epic promotion reconciled', metadata: { correlationId, number: p.id, mergeSha: p.mergeSha } });
    }
  }
  const tickets = await db.select().from(projectTickets).where(and(eq(projectTickets.projectId, projectId), eq(projectTickets.githubBranch, p.source)));
  for (const t of tickets) {
    if (t.githubCommitSha && t.githubCommitSha !== p.headSha) continue;
    if (t.githubMergeCommitSha === p.mergeSha && t.githubPrNumber === p.id && t.githubMergeStatus === 'merged') continue;
    const epic = t.epicId ? (await db.select().from(epics).where(and(eq(epics.id, t.epicId), eq(epics.projectId, projectId))))[0] : null;
    if (p.destination !== (epic?.branch || 'lfg-agent')) continue;
    // Deterministic primary key makes reconciliation idempotent across restarts and callers.
    const inserted = await db.insert(ticketMergeHistory).values({ id: `git-pr:${projectId}:${provider.provider}:${p.id}:${t.id}:${p.mergeSha}`, ticketId: t.id, action: 'merged', mergeCommitSha: p.mergeSha, performedById: actorId }).onConflictDoNothing().returning();
    if (inserted.length) await logActivity({ projectId, ticketId: t.id, actorType: 'system', activityType: 'git_ticket_reconciled', title: 'Provider-confirmed ticket merge reconciled', metadata: { correlationId, number: p.id, mergeSha: p.mergeSha } });
    await db.update(projectTickets).set({ githubMergeStatus: 'merged', githubMergeCommitSha: p.mergeSha, githubPrNumber: p.id, githubPrUrl: p.url, updatedAt: new Date() }).where(eq(projectTickets.id, t.id));
    await maybeSubmitEpicForReview(t.epicId);
  }
}
export async function inspectMerge(projectId: string, provider: GitProvider, number: number) {
  const state = await provider.mergeState(number);
  return { ...state, blockers: [...state.blockers, ...await mergeBlockers(projectId, state.pullRequest, provider)] };
}
export async function mutateGit(projectId: string, actorId: string, provider: GitProvider, type: 'merge' | 'delete', input: any, correlationId: string) {
  const started = performance.now(); let operationId: string | undefined; let newlyCompleted = false;
  const emit = (event: string, outcome: string, errorCode?: string) => logGitRequest({ service: 'git-safety', event, correlationId, operationId, outcome, durationMs: Math.round(performance.now() - started), errorCode, provider: provider.provider, ...provider.diagnostics() });
  emit('git.mutation.started', 'started');
  try {
    const result = await serializeGit(provider.repositoryKey, async () => {
      const number = Number(input.number);
      if (type === 'merge' && (!Number.isSafeInteger(number) || number < 1)) deny('INVALID_PR_NUMBER');
      const p = type === 'merge' ? await provider.pullRequest(number) : null;
      const branch = type === 'merge' ? p!.source : input.branch;
      validateConfirmation(input, branch);
      if (p && (input.destination !== p.destination || input.expectedSha !== p.headSha)) deny('STALE_PR_OR_DESTINATION');
      const key = new Bun.CryptoHasher('sha256').update(JSON.stringify([projectId, provider.repositoryKey, type, type === 'merge' ? number : branch, input.expectedSha])).digest('hex');
      const [old] = await db.select().from(gitMutations).where(eq(gitMutations.operationKey, key));
      operationId = old?.id;
      if (p?.merged) {
        if (p.headSha !== input.expectedSha || !p.mergeSha) deny('MERGE_OUTCOME_UNCERTAIN');
        await reconcile(projectId, actorId, provider, p, correlationId);
        newlyCompleted = !!old && old.status !== 'completed';
        if (old) await db.update(gitMutations).set({ status: 'completed', activeKey: null, result: JSON.stringify(p), updatedAt: new Date() }).where(eq(gitMutations.id, old.id));
        return p;
      }
      const info = await provider.info();
      const branches = await provider.branches(); if (!branches.complete) deny('BRANCH_STATE_INCOMPLETE');
      const ref = branches.items.find(b => b.branch === branch);
      if (type === 'delete' && !ref && old) {
        newlyCompleted = old.status !== 'completed';
        await db.update(gitMutations).set({ status: 'completed', activeKey: null, result: JSON.stringify({ deleted: branch }), updatedAt: new Date() }).where(eq(gitMutations.id, old.id));
        return { deleted: branch };
      }
      if (old) deny(old.status === 'completed' ? 'OPERATION_ALREADY_COMPLETED' : 'OUTCOME_UNCERTAIN_CHECK_PROVIDER');
      if (type === 'merge') {
        const state = await inspectMerge(projectId, provider, number);
        if (state.pullRequest.headSha !== input.expectedSha || state.pullRequest.destination !== input.destination) deny('STALE_PR_OR_DESTINATION');
        if (state.blockers.length) deny(state.blockers.join(','));
      } else {
        if (!ref || ref.headSha !== input.expectedSha) deny('STALE_REF');
        if (branch === info.defaultBranch || ref?.protected) deny('DEFAULT_OR_PROTECTED_BRANCH');
        const prs = await provider.pullRequests(); if (!prs.complete) deny('PR_STATE_INCOMPLETE');
        if (prs.items.some(p => p.destination === branch || (p.source === branch && p.sourceRepo?.toLowerCase() === provider.identity.toLowerCase()))) deny('OPEN_PR_USES_BRANCH');
        const blockers = await localBranchBlockers(projectId, branch, true); if (blockers.length) deny(blockers.join(','));
        const target = await provider.ref(info.defaultBranch);
        const comparison = await provider.compare(target, input.expectedSha);
        if ((!comparison.complete || comparison.ahead !== 0) && input.confirmUnmerged !== true) deny('UNMERGED_WORK_CONFIRMATION_REQUIRED');
        if (await provider.ref(branch) !== input.expectedSha) deny('STALE_REF');
      }
      const now = new Date(); operationId = crypto.randomUUID();
      const activeKey = `${provider.repositoryKey}:${type === 'merge' ? p!.destination : branch}`;
      const [claimed] = await db.insert(gitMutations).values({ id: operationId, operationKey: key, activeKey, projectId, actorId, repo: provider.identity, provider: provider.provider, type, headRef: branch, baseRef: p?.destination || info.defaultBranch, headSha: input.expectedSha, baseSha: '', acknowledgedAt: now, status: 'started', correlationId, createdAt: now, updatedAt: now }).onConflictDoNothing().returning();
      if (!claimed) deny('OPERATION_BUSY');
      try {
        const result = type === 'merge' ? await provider.mergePullRequest(number, input.expectedSha) : await (async () => {
          await provider.deleteBranch(branch);
          try { await provider.ref(branch); } catch (e) { if (e instanceof GitProviderError && e.code === 'PROVIDER_NOT_FOUND') return { deleted: branch }; throw e; }
          return deny('DELETE_OUTCOME_UNCERTAIN');
        })();
        if (type === 'merge') await reconcile(projectId, actorId, provider, result as GitPR, correlationId);
        await db.update(gitMutations).set({ status: 'completed', activeKey: null, result: JSON.stringify(result), providerRequestId: provider.diagnostics().providerRequestIds.at(-1), updatedAt: new Date() }).where(eq(gitMutations.id, operationId!));
        newlyCompleted = true;
        return result;
      } catch (e) {
        await db.update(gitMutations).set({ status: 'uncertain', errorCode: e instanceof GitProviderError ? e.code : 'MUTATION_UNCERTAIN', updatedAt: new Date() }).where(eq(gitMutations.id, operationId!));
        throw e;
      }
    });
    emit('git.mutation.completed', 'completed');
    if (newlyCompleted) await logActivity({ projectId, actorType: 'user', activityType: `git_${type}_completed`, title: `Git ${type} confirmed by provider`, metadata: { correlationId, operationId } });
    return result;
  } catch (e) {
    const code = e instanceof GitProviderError ? e.code : 'GIT_MUTATION_UNAVAILABLE'; emit('git.mutation.failed', 'failed', code);
    await logActivity({ projectId, actorType: 'user', activityType: `git_${type}_failed`, title: `Git ${type} blocked or needs reconciliation`, metadata: { correlationId, operationId, errorCode: code } });
    throw e;
  }
}
