import { Hono } from 'hono';
import { requireAuth } from '../../auth/middleware.ts';
import type { auth } from '../../auth/index.ts';
import { getProjectAccess, requirePermission } from '../../auth/project-access.ts';
import { resolveGitActor, NO_SHARED_GIT_MESSAGE } from '../../services/git-access.ts';
import { createGitProvider, GitProviderError } from '../../services/git-provider.ts';
import { buildGitWorkspace } from '../../services/git-workspace.ts';
import { resolveTicketAnchor } from '../../services/epics.ts';
import { db } from '../../config/db.ts';
import { env } from '../../config/env.ts';
import { epics } from '../../db/schema/epics.ts';
import { projectTickets } from '../../db/schema/tickets.ts';
import { githubTokens } from '../../db/schema/users.ts';
import { getValidGitlabToken } from '../../services/gitlab-token.ts';
import { ticketExecutions } from '../../db/schema/orchestrator.ts';
import { eq, and } from 'drizzle-orm';

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session; gitErrorCode: string; gitPartial: boolean } };
// Existing application diagnostics use console stdout/stderr; no file logger is installed.
// One bounded structured terminal event per request, collected/rotated by the host.
export function logGitRequest(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: fields.outcome === 'failed' ? 'error' : 'info', service: 'git-workspace', event: 'git.request.completed', retryCount: 0, ...fields }));
}
const gitApi = new Hono<AuthEnv>();
gitApi.use('/projects/:projectId/git/*', async (c, next) => {
  const started = performance.now();
  const correlationId = crypto.randomUUID();
  c.header('X-Correlation-ID', correlationId);
  logGitRequest({ event: 'git.request.started', correlationId, outcome: 'started', durationMs: 0 });
  try {
    await next();
    if (c.res.status === 401) c.res = new Response(JSON.stringify({ error: 'Sign in to view this project repository.', code: 'AUTH_REQUIRED', correlationId }), { status: 401, headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId } });
  }
  finally {
    // Also covers authentication rejection before the handler.
    logGitRequest({ correlationId, outcome: c.res.status >= 400 ? 'failed' : c.get('gitPartial') ? 'partial' : 'completed', durationMs: Math.round(performance.now() - started), status: c.res.status, errorCode: c.get('gitErrorCode') || (c.res.status >= 400 ? 'AUTH_REQUIRED' : undefined) });
  }
});
gitApi.use('/projects/:projectId/git/*', requireAuth);
for (const view of ['branches', 'pull-requests'] as const) gitApi.get(`/projects/:projectId/git/${view}`, async c => {
  const correlationId = c.res.headers.get('X-Correlation-ID')!;
  const fail = (error: string, code: string, status: 400 | 403 | 404 | 502) => { c.set('gitErrorCode', code); return c.json({ error, code, correlationId }, status); };
  let provider: ReturnType<typeof createGitProvider> | undefined;
  const started = performance.now();
  try {
    const access = await getProjectAccess(c.req.param('projectId')!, c.get('user').id);
    if (!access) return fail('Project not found or access denied. Check your project membership.', 'PROJECT_ACCESS_DENIED', 404);
    const project = access.project;
    // Viewing does not require code-management permission. No write endpoint is exposed.
    let canManageCode = false;
    try { canManageCode = requirePermission(access, 'canEditFiles'); } catch { /* read-only member */ }
    const actor = resolveGitActor(project, c.get('user').id);
    const kind = project.repoProvider === 'gitlab' ? 'gitlab' : 'github';
    const owner = project.repoOwner;
    const repo = project.repoName?.replace(/\.git$/, '');
    if (!owner || !repo) return fail('No repository connected. Connect this project to a repository in Settings.', 'NO_REPOSITORY', 400);
    // Repository identity is stored server-side only. Reject conflicting URL metadata.
    const host = kind === 'gitlab' ? new URL(env.GITLAB_BASE_URL).host : 'github.com';
    if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(owner) || !/^[\w.-]+$/.test(repo) || owner.split('/').some(s => s === '.' || s === '..') || repo === '.' || repo === '..') return fail('Repository configuration is invalid. Reconnect this project repository.', 'REPOSITORY_IDENTITY_INVALID', 400);
    if (project.repoUrl) {
      const url = new URL(project.repoUrl);
      if (url.protocol !== 'https:' || url.host !== host || url.username || url.password || decodeURIComponent(url.pathname).replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '') !== `${owner}/${repo}`) return fail('Repository settings disagree. Reconnect this project repository.', 'REPOSITORY_IDENTITY_MISMATCH', 400);
    }
    const token = kind === 'gitlab' ? await getValidGitlabToken(actor.gitUserId) : (await db.select().from(githubTokens).where(eq(githubTokens.userId, actor.gitUserId)).limit(1))[0]?.accessToken;
    if (!token) return fail(actor.usingOwnCollaboratorToken ? NO_SHARED_GIT_MESSAGE : 'Git account disconnected. Connect it under Settings → Integrations, then refresh.', 'GIT_DISCONNECTED', 403);
    provider = createGitProvider({ provider: kind, owner, repo, token, gitlabBaseUrl: env.GITLAB_BASE_URL });
    let data;
    if (view === 'pull-requests') {
      await provider.info(); // Verify stored repository access with this actor's credentials.
      const prs = await provider.pullRequests();
      data = { pullRequests: prs.items, completeness: { complete: prs.complete, errors: prs.errors }, readOnly: true };
    } else {
      const [storedEpics, storedTickets] = await Promise.all([db.select().from(epics).where(eq(epics.projectId, project.id)), db.select().from(projectTickets).where(eq(projectTickets.projectId, project.id))]);
      const activeExecutions = await db.select({ ticketId: ticketExecutions.ticketId }).from(ticketExecutions)
        .innerJoin(projectTickets, eq(projectTickets.id, ticketExecutions.ticketId))
        .where(and(eq(projectTickets.projectId, project.id), eq(ticketExecutions.status, 'running')));
      const tickets = [];
      for (const t of storedTickets) {
        // Refuse cross-project corrupt associations before calling the shared anchor resolver.
        const validEpic = storedEpics.find(e => e.id === t.epicId);
        const anchor = await resolveTicketAnchor({ epicId: validEpic?.id ?? null });
        tickets.push({ ...t, title: t.name, executionActive: activeExecutions.some(e => e.ticketId === t.id), destination: t.epicId ? validEpic?.branch ?? '' : anchor.anchorBranch });
      }
      data = await buildGitWorkspace(provider, storedEpics, tickets, project.previewTicketId);
    }
    if (!data.completeness.complete) {
      c.set('gitPartial', true);
      c.set('gitErrorCode', data.completeness.errors[0]?.code || 'COMPARISON_UNKNOWN');
    }
    logGitRequest({ event: 'git.provider.completed', correlationId, provider: kind, outcome: data.completeness.complete ? 'completed' : 'partial', durationMs: Math.round(performance.now() - started), ...provider.diagnostics(), failureCategories: provider.errors.slice(0, 10).map(e => e.code) });
    return c.json({ ...data, canManageCode, correlationId });
  } catch (e) {
    const error = e instanceof GitProviderError ? e : new GitProviderError('GIT_UNAVAILABLE');
    logGitRequest({ event: 'git.provider.failed', correlationId, outcome: 'failed', provider: provider?.provider, durationMs: Math.round(performance.now() - started), errorCode: error.code, providerRequestId: error.providerRequestId, ...provider?.diagnostics() });
    return fail('Unable to read the repository. Check Git access in Settings → Integrations and refresh.', error.code, error.status === 401 || error.status === 403 ? 403 : 502);
  }
});
export default gitApi;
