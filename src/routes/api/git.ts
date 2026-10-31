/** The Git tab: the project's branches on GitHub, and opening PRs / merging / deleting them. */
import { Hono } from "hono";
import { and, eq, isNotNull } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess } from "../../auth/project-access.ts";
import { db } from "../../config/db.ts";
import { githubTokens } from "../../db/schema/users.ts";
import { epics } from "../../db/schema/epics.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { modelSelections } from "../../db/schema/chat.ts";
import { teamApiKeys } from "../../services/llm-access.ts";
import { selectedSubscriptionModel } from "../../services/subscription-execution.ts";
import { reviewPullRequest, type PrReview } from "../../services/pr-review.ts";
import { resolveGitActor } from "../../services/git-access.ts";
import { resolveRepo } from "../../ai/tools/codebase-tools.ts";
import { deleteBranch, githubBranchOverview, mergeBranch, mergePullRequest, openPullRequest, type BranchOverview } from "../../services/github-branches.ts";
import type { Gh } from "../../services/ticket-diff-github.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const gitApi = new Hono<AuthEnv>();
gitApi.use("*", requireAuth);

// The overview costs one compare per branch, so repeat loads within a few seconds share it.
const cache = new Map<string, { at: number; data: BranchOverview & { epics: unknown[] } }>();
const CACHE_MS = 15_000;

type Ctx = { get: (k: "user") => { id: string }; req: { param: (k: string) => string | undefined; header: (k: string) => string | undefined; url: string } };
async function resolve(c: Ctx): Promise<{ error: string; status: 400 | 403 | 404 } | { gh: Gh; projectId: string; canEdit: boolean; userId: string }> {
  const access = await getProjectAccess(c.req.param("projectId")!, c.get("user").id);
  if (!access) return { error: "Project not found", status: 404 };
  const project = access.project;
  const repo = resolveRepo(project);
  if (!repo) return { error: "No repository is linked to this project yet.", status: 400 };
  if ((project as { repoProvider?: string }).repoProvider === "gitlab") return { error: "The Git tab supports GitHub repositories for now; this project uses GitLab.", status: 400 };
  const actor = resolveGitActor(project, c.get("user").id);
  const [token] = await db.select().from(githubTokens).where(eq(githubTokens.userId, actor.gitUserId)).limit(1);
  if (!token?.accessToken) {
    const hint = actor.usingOwnCollaboratorToken ? " This project doesn't share the owner's Git; ask the owner to enable “Share Git access”." : "";
    return { error: `No GitHub token is connected. Connect GitHub in Settings.${hint}`, status: 400 };
  }
  return { gh: { owner: repo.owner, repo: repo.repo, token: token.accessToken }, projectId: project.id, userId: c.get("user").id, canEdit: access.role === "owner" || access.permissions.canEditFiles };
}

async function mutating(c: Ctx) {
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) return { error: "Invalid origin", status: 403 as const };
  const r = await resolve(c);
  if ("error" in r) return r;
  if (!r.canEdit) return { error: "You don't have permission to change this project's branches.", status: 403 as const };
  cache.delete(r.projectId);
  return r;
}

/** The project's epics and ticket branches: how the Git tab groups branches, and what each merges into. */
async function workMap(projectId: string) {
  const epicRows = await db.select({ id: epics.id, key: epics.epicKey, name: epics.name, goal: epics.goal, status: epics.status, branch: epics.branch, baseBranch: epics.baseBranch })
    .from(epics).where(eq(epics.projectId, projectId));
  const ticketRows = await db.select({ id: projectTickets.id, key: projectTickets.ticketKey, name: projectTickets.name, status: projectTickets.status, epicId: projectTickets.epicId, branch: projectTickets.githubBranch })
    .from(projectTickets).where(and(eq(projectTickets.projectId, projectId), isNotNull(projectTickets.githubBranch)));
  const epicById = new Map(epicRows.map((e) => [e.id, e]));
  const bases: Record<string, string> = {};
  for (const e of epicRows) if (e.branch && e.baseBranch) bases[e.branch] = e.baseBranch;
  for (const t of ticketRows) { const e = t.epicId ? epicById.get(t.epicId) : undefined; if (t.branch && e?.branch) bases[t.branch] = e.branch; }
  return { epicRows, ticketRows, bases };
}

gitApi.get("/:projectId/git/branches", async (c) => {
  const r = await resolve(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const hit = cache.get(r.projectId);
  if (hit && Date.now() - hit.at < CACHE_MS && c.req.query("fresh") !== "1") return c.json({ ...hit.data, canEdit: r.canEdit });
  try {
    const { epicRows, ticketRows, bases } = await workMap(r.projectId);
    const overview = await githubBranchOverview(r.gh, fetch, 100, bases);
    const epicByBranch = new Map(epicRows.filter((e) => e.branch).map((e) => [e.branch!, e]));
    const ticketByBranch = new Map(ticketRows.map((t) => [t.branch!, t]));
    // Each branch's place in the work: an epic's branch, a ticket's branch (under its epic), or general.
    const branches = overview.branches.map((b) => {
      const e = epicByBranch.get(b.name), t = ticketByBranch.get(b.name);
      if (b.isDefault) return { ...b, kind: "default" as const };
      if (e) return { ...b, kind: "epic" as const, epicId: e.id };
      if (t) return { ...b, kind: "ticket" as const, epicId: t.epicId ?? null, ticket: { id: t.id, key: t.key, name: t.name, status: t.status } };
      return { ...b, kind: "general" as const };
    });
    const onGithub = new Set(branches.map((b) => b.name));
    const data = {
      ...overview, branches,
      epics: epicRows.filter((e) => branches.some((b) => "epicId" in b && b.epicId === e.id))
        .map((e) => ({ id: e.id, key: e.key, name: e.name, status: e.status, branch: e.branch && onGithub.has(e.branch) ? e.branch : null, baseBranch: e.baseBranch })),
    };
    if (!data.error) cache.set(r.projectId, { at: Date.now(), data });
    return c.json({ ...data, canEdit: r.canEdit });
  } catch (e) {
    return c.json({ error: `Couldn't reach GitHub: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
});

// Pre-PR reviews run in the background (they take a minute or two); the tab polls them.
type ReviewJob = { projectId: string; userId: string; head: string; base: string; message: string; review?: PrReview; error?: string; at: number };
const reviews = new Map<string, ReviewJob>();
const sweepReviews = () => { for (const [id, j] of reviews) if (Date.now() - j.at > 3_600_000) reviews.delete(id); };

gitApi.post("/:projectId/git/review", async (c) => {
  const r = await mutating(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const b = await c.req.json<{ head?: string; base?: string }>().catch(() => ({}) as Record<string, never>);
  const head = String(b.head ?? ""), base = String(b.base ?? "");
  if (!head || !base || head === base) return c.json({ error: "Pick a branch and a different base to review against." }, 400);
  sweepReviews();
  const [sel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, r.userId));
  const subscription = await selectedSubscriptionModel(r.userId, r.projectId);
  const keys = subscription ? undefined : await teamApiKeys(r.userId, r.projectId);
  const { getModel, DEFAULT_MODEL_KEY } = await import("../../ai/provider.ts");
  let model;
  try {
    model = subscription ?? getModel(sel?.selectedModel ?? DEFAULT_MODEL_KEY, {
      anthropic: keys?.anthropicApiKey ?? undefined, openai: keys?.openaiApiKey ?? undefined,
      google: keys?.googleApiKey ?? undefined, kimi: keys?.kimiApiKey ?? undefined,
      deepseek: keys?.deepseekApiKey ?? undefined, glm: keys?.glmApiKey ?? undefined,
    }, { allowEnvFallback: false });
  } catch (e) {
    return c.json({ error: `No AI model is available for the review: ${e instanceof Error ? e.message : String(e)}` }, 400);
  }
  // The ticket / epic this branch delivers, so the review checks it against what was asked.
  const { epicRows } = await workMap(r.projectId);
  const [ticket] = await db.select().from(projectTickets).where(and(eq(projectTickets.projectId, r.projectId), eq(projectTickets.githubBranch, head))).limit(1);
  const epic = epicRows.find((e) => e.branch === head) ?? (ticket?.epicId ? epicRows.find((e) => e.id === ticket.epicId) : undefined);
  const id = crypto.randomUUID();
  const job: ReviewJob = { projectId: r.projectId, userId: r.userId, head, base, message: "Starting review…", at: Date.now() };
  reviews.set(id, job);
  void reviewPullRequest({
    gh: r.gh, base, head, model,
    context: {
      ticket: ticket ? { key: ticket.ticketKey, name: ticket.name, description: ticket.description, acceptanceCriteria: Array.isArray(ticket.acceptanceCriteria) ? ticket.acceptanceCriteria as unknown[] : [] } : undefined,
      epic: epic ? { key: epic.key, name: epic.name, goal: epic.goal } : undefined,
    },
    onProgress: (m) => { job.message = m; },
  }).then((review) => { job.review = review; }).catch((e) => {
    console.error("[git] pre-PR review failed", { projectId: r.projectId, head, error: e instanceof Error ? e.message : String(e) });
    job.error = e instanceof Error ? e.message.replace(/Bearer\s+\S+/gi, "[credential]").slice(0, 600) : "The review failed.";
  });
  return c.json({ id }, 202);
});

gitApi.get("/:projectId/git/review/:reviewId", async (c) => {
  const r = await resolve(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const job = reviews.get(c.req.param("reviewId")!);
  if (!job || job.projectId !== r.projectId || job.userId !== r.userId) return c.json({ error: "Review not found. Start it again." }, 404);
  if (job.error) return c.json({ error: job.error }, 422);
  return job.review ? c.json({ done: true, review: job.review }) : c.json({ done: false, message: job.message });
});

gitApi.post("/:projectId/git/pulls", async (c) => {
  const r = await mutating(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const b = await c.req.json<{ head?: string; base?: string; title?: string; body?: string; draft?: boolean }>().catch(() => ({}) as Record<string, never>);
  const out = await openPullRequest(r.gh, { head: String(b.head ?? ""), base: String(b.base ?? ""), title: String(b.title ?? ""), body: b.body, draft: b.draft });
  return out.ok ? c.json(out) : c.json({ error: out.error }, 422);
});

gitApi.post("/:projectId/git/merge", async (c) => {
  const r = await mutating(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const b = await c.req.json<{ pull?: number; method?: "merge" | "squash" | "rebase"; head?: string; base?: string }>().catch(() => ({}) as Record<string, never>);
  const method = b.method && ["merge", "squash", "rebase"].includes(b.method) ? b.method : "merge";
  const out = b.pull ? await mergePullRequest(r.gh, Number(b.pull), method) : await mergeBranch(r.gh, String(b.head ?? ""), String(b.base ?? ""));
  return out.ok ? c.json(out) : c.json({ error: out.error }, 422);
});

gitApi.delete("/:projectId/git/branches", async (c) => {
  const r = await mutating(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const b = await c.req.json<{ names?: string[] }>().catch(() => ({}) as Record<string, never>);
  const names = (Array.isArray(b.names) ? b.names : []).map(String).filter(Boolean).slice(0, 50);
  if (!names.length) return c.json({ error: "No branch given." }, 400);
  const results = [];
  for (const name of names) results.push({ name, ...(await deleteBranch(r.gh, name)) });
  return c.json({ results });
});

export default gitApi;
