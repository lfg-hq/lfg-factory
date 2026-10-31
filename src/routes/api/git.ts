/** The Git tab: the project's branches on GitHub, and opening PRs / merging / deleting them. */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess } from "../../auth/project-access.ts";
import { db } from "../../config/db.ts";
import { githubTokens } from "../../db/schema/users.ts";
import { resolveGitActor } from "../../services/git-access.ts";
import { resolveRepo } from "../../ai/tools/codebase-tools.ts";
import { deleteBranch, githubBranchOverview, mergeBranch, mergePullRequest, openPullRequest, type BranchOverview } from "../../services/github-branches.ts";
import type { Gh } from "../../services/ticket-diff-github.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const gitApi = new Hono<AuthEnv>();
gitApi.use("*", requireAuth);

// The overview costs one compare per branch, so repeat loads within a few seconds share it.
const cache = new Map<string, { at: number; data: BranchOverview }>();
const CACHE_MS = 15_000;

type Ctx = { get: (k: "user") => { id: string }; req: { param: (k: string) => string | undefined; header: (k: string) => string | undefined; url: string } };
async function resolve(c: Ctx): Promise<{ error: string; status: 400 | 403 | 404 } | { gh: Gh; projectId: string; canEdit: boolean }> {
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
  return { gh: { owner: repo.owner, repo: repo.repo, token: token.accessToken }, projectId: project.id, canEdit: access.role === "owner" || access.permissions.canEditFiles };
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

gitApi.get("/:projectId/git/branches", async (c) => {
  const r = await resolve(c);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const hit = cache.get(r.projectId);
  if (hit && Date.now() - hit.at < CACHE_MS && c.req.query("fresh") !== "1") return c.json({ ...hit.data, canEdit: r.canEdit });
  try {
    const data = await githubBranchOverview(r.gh);
    if (!data.error) cache.set(r.projectId, { at: Date.now(), data });
    return c.json({ ...data, canEdit: r.canEdit });
  } catch (e) {
    return c.json({ error: `Couldn't reach GitHub: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
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
