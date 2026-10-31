import { db } from '../config/db.ts';
import { eq } from 'drizzle-orm';
import { epics } from '../db/schema/epics.ts';
import { projectTickets } from '../db/schema/tickets.ts';
import { reconcile, serializeGit } from './git-safety.ts';
import type { GitProvider, GitPR } from './git-provider.ts';
/** Only exact linked revisions are reconciled. Never guess associations from branch names. */
export async function reconcileExternalPRs(projectId: string, actorId: string, provider: GitProvider, prs: GitPR[], correlationId: string) {
  await serializeGit(provider.repositoryKey, async () => {
    const storedEpics = await db.select().from(epics).where(eq(epics.projectId, projectId));
    const tickets = await db.select().from(projectTickets).where(eq(projectTickets.projectId, projectId));
    for (const p of prs) {
      if (!p.merged || !p.mergeSha || p.sourceRepo?.toLowerCase() !== provider.identity.toLowerCase()) continue;
      if (!storedEpics.some(e => e.branch === p.source && e.status === 'approved' && e.baseBranch === p.destination) && !tickets.some(t => t.githubBranch === p.source && t.githubMergeCommitSha !== p.mergeSha)) continue;
      await reconcile(projectId, actorId, provider, p, correlationId);
    }
  });
}
