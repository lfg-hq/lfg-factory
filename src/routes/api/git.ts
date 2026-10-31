import { Hono } from 'hono';
import { requireAuth } from '../../auth/middleware.ts';
import type { auth } from '../../auth/index.ts';
import { getProjectAccess, requirePermission, PermissionError } from '../../auth/project-access.ts';
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
import { gitReviews } from '../../db/schema/git-reviews.ts';
import { gitContext } from '../../services/git-context.ts';
import { queueReview, retryReview, priorReviews, createReviewedPR, reviewBody, reviewRepository, ReviewError } from '../../services/git-review.ts';

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
// All review endpoints recheck project access and resolve the acting Git account.
// Findings contain private repository information, so even polling requires Git access.
for (const route of [
  ['POST', 'reviews'], ['GET', 'reviews'], ['GET', 'reviews/:id'],
  ['POST', 'reviews/:id/retry'], ['POST', 'pull-requests'],
] as const) {
  gitApi.on(route[0], `/projects/:projectId/git/${route[1]}`, async c => {
    const correlationId = c.res.headers.get('X-Correlation-ID')!;
    try {
      if (route[0] === 'POST') {
        const origin = c.req.header('Origin');
        if (origin && origin !== new URL(c.req.url).origin) throw new ReviewError('ORIGIN_DENIED', 403);
        if (!c.req.header('Content-Type')?.startsWith('application/json')) throw new ReviewError('JSON_REQUIRED', 400);
        if (Number(c.req.header('Content-Length') || 0) > 60_000) throw new ReviewError('REQUEST_TOO_LARGE', 400);
      }
      const access = await getProjectAccess(c.req.param('projectId')!, c.get('user').id);
      if (!access) throw new ReviewError('PROJECT_ACCESS_DENIED', 404);
      if (route[0] === 'POST' && !requirePermission(access, 'canEditFiles')) throw new ReviewError('CODE_PERMISSION_REQUIRED', 403);
      const provider = await gitContext(access.project, c.get('user').id);
      if (route[1] === 'reviews' && route[0] === 'GET') return c.json({ reviews: await priorReviews(access.project.id), correlationId });
      const raw = route[0] === 'POST' ? await c.req.text() : '{}';
      if (raw.length > 60_000) throw new ReviewError('REQUEST_TOO_LARGE', 400);
      let input: any;
      try { input = JSON.parse(raw); } catch { throw new ReviewError('INVALID_JSON', 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReviewError('INVALID_JSON', 400);
      if (route[1] === 'reviews' && route[0] === 'POST') {
        const review = await queueReview(access.project, c.get('user').id, provider, input.headRef, input.baseRef, correlationId);
        return c.json({ review, correlationId }, 202);
      }
      const id = route[1] === 'pull-requests' ? input.reviewId : c.req.param('id');
      const [row] = await db.select().from(gitReviews).where(and(eq(gitReviews.id, id || ''), eq(gitReviews.projectId, access.project.id))).limit(1);
      if (!row || row.repo !== reviewRepository(provider) || row.provider !== provider.provider) throw new ReviewError('REVIEW_NOT_FOUND', 404);
      if (route[1].endsWith('/retry')) return c.json({ review: await retryReview(row), correlationId }, 202);
      if (route[1] === 'pull-requests') return c.json({ ...await createReviewedPR(access.project, c.get('user').id, provider, row, input, correlationId), correlationId });
      let stale = true, freshness = 'unavailable';
      let freshnessError: string | undefined;
      try {
        const [head, base] = await Promise.all([provider.ref(row.headRef), provider.ref(row.baseRef)]);
        stale = head !== row.headSha || base !== row.baseSha; freshness = stale ? 'stale' : 'current';
      } catch (e) { freshnessError = e instanceof GitProviderError ? e.code : 'REF_CHECK_UNAVAILABLE'; c.set('gitPartial', true); c.set('gitErrorCode', freshnessError); }
      return c.json({ review: row, stale, freshness, freshnessError, suggestedBody: row.status === 'completed' ? reviewBody(row) : '', correlationId });
    } catch (e) {
      const code = e instanceof PermissionError ? 'CODE_PERMISSION_REQUIRED' : e instanceof GitProviderError ? e.code : 'GIT_REVIEW_UNAVAILABLE';
      c.set('gitErrorCode', code);
      const messages: Record<string, string> = {
        REVIEW_STALE: 'Source or destination changed. Run a new review before creating a PR.',
        REVIEW_NOT_COMPLETED: 'Wait for a completed review. If blocked or incomplete, resolve the reported issue and retry.',
        PR_CREATION_BUSY: 'Another creation for this source and destination is in progress or awaiting provider reconciliation. Check open PRs before retrying.',
        PR_CREATION_UNCERTAIN: 'Creation may have reached the provider. Check open PRs, then retry confirmation to reconcile; no second creation will be sent.',
        ACKNOWLEDGMENT_REQUIRED: 'Read and acknowledge the findings before confirming creation.',
        GIT_DISCONNECTED: 'Connect your Git account in Settings → Integrations and retry.',
      };
      const status = e instanceof PermissionError ? 403 : e instanceof GitProviderError && [400, 403, 404, 409, 422].includes(e.status) ? e.status : 502;
      return c.json({ error: messages[code] || 'Unable to complete this Git operation. Check project permissions and connected Git/model accounts, then retry.', code, correlationId }, status as 400 | 403 | 404 | 409 | 422 | 502);
    }
  });
}
export default gitApi;
