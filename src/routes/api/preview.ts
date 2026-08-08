/**
 * Dev Preview API — run the connected client project live in its sandbox and
 * surface a preview URL for the Preview tab.
 *   GET    /api/projects/:projectId/preview            → current state
 *   POST   /api/projects/:projectId/preview/setup      → (re)build + run (async)
 *   POST   /api/projects/:projectId/preview/stop       → stop the app
 *   PUT    /api/projects/:projectId/preview/manifest   → save an edited manifest
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess } from "../../auth/project-access.ts";
import { db } from "../../config/db.ts";
import { projectEnvironments } from "../../db/schema/project-environments.ts";
import { projects } from "../../db/schema/projects.ts";
import { getPreviewState, setupPreview, restartPreview, stopPreview, detectManifest, manifestSchema, capturePreviewScreenshot, getPreviewBranches, reprobeProfile } from "../../services/dev-preview.ts";
import { loadAppProfile, saveAppProfile, appProfileSchema } from "../../services/app-profile.ts";
import type { auth } from "../../auth/index.ts";

type Env = { Variables: { user: typeof auth.$Infer.Session.user } };
const previewApi = new Hono<Env>();
previewApi.use("*", requireAuth as any);

previewApi.get("/:projectId/preview", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  return c.json(await getPreviewState(access.project.id));
});

previewApi.post("/:projectId/preview/setup", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const internalId = access.project.id;

  // Fire-and-forget — status streams over WS + persists on project_environments.
  setupPreview(internalId, {
    userId: user.id,
    branch: typeof body.branch === "string" ? body.branch : undefined,
    rebuildManifest: body.rebuildManifest === true,
    conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
  }).catch((e) => console.error("[preview] setup failed:", e));

  return c.json({ ok: true, status: "detecting" }, 202);
});

previewApi.post("/:projectId/preview/restart", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const ticketId = typeof body.ticketId === "string" && body.ticketId ? body.ticketId : undefined;
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  restartPreview(access.project.id, { userId: user.id, ticketId, conversationId }).catch((e) => console.error("[preview] restart failed:", e));
  return c.json({ ok: true, status: "starting" }, 202);
});

// List the branches that can be previewed: default + each ticket with a live worktree.
previewApi.get("/:projectId/preview/branches", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  return c.json({ branches: await getPreviewBranches(access.project.id) });
});

// Per-project build/preview settings: ticket build isolation + preview branch mode.
previewApi.get("/:projectId/preview/build-settings", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const p = access.project as { ticketBuildIsolation?: string; previewBranchMode?: string };
  return c.json({
    ticketBuildIsolation: p.ticketBuildIsolation ?? "isolated",
    previewBranchMode: p.previewBranchMode ?? "worktree",
  });
});

previewApi.post("/:projectId/preview/build-settings", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (body.ticketBuildIsolation === "isolated" || body.ticketBuildIsolation === "shared") patch.ticketBuildIsolation = body.ticketBuildIsolation;
  if (body.previewBranchMode === "worktree" || body.previewBranchMode === "checkout") patch.previewBranchMode = body.previewBranchMode;
  if (!Object.keys(patch).length) return c.json({ error: "Nothing valid to update" }, 400);
  patch.updatedAt = new Date();
  await db.update(projects).set(patch).where(eq(projects.id, access.project.id));
  return c.json({ ok: true, ...patch });
});

previewApi.post("/:projectId/preview/stop", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  await stopPreview(access.project.id, user.id);
  return c.json({ ok: true });
});

// Screenshot the live preview → S3 → post into the chat conversation.
previewApi.post("/:projectId/preview/screenshot", async (c) => {
  const user = c.get("user");
  const publicProjectId = c.req.param("projectId")!;
  const access = await getProjectAccess(publicProjectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  const result = await capturePreviewScreenshot(access.project.id, user.id, publicProjectId, conversationId);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// Re-run detection only (returns the manifest for review, does not run the app).
previewApi.post("/:projectId/preview/detect", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try {
    const manifest = await detectManifest(access.project.id, user.id);
    await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, access.project.id));
    return c.json({ manifest });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// ── App Profile (the detailed, persisted "how to run this app" plan) ──
previewApi.get("/:projectId/preview/profile", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const loaded = await loadAppProfile(access.project.id);
  return c.json({ profile: loaded?.profile ?? null, version: loaded?.version ?? 0 });
});

previewApi.put("/:projectId/preview/profile", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const parsed = appProfileSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid profile", issues: parsed.error.issues }, 400);
  await saveAppProfile(access.project.id, parsed.data);
  return c.json({ ok: true, profile: parsed.data });
});

// Re-run the probe agent (fire-and-forget; streams to the preview log, then
// broadcasts `preview_profile` with the fresh profile).
previewApi.post("/:projectId/preview/profile/reprobe", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  reprobeProfile(access.project.id, user.id).catch((e) => console.error("[preview] reprobe failed:", e));
  return c.json({ ok: true, status: "probing" }, 202);
});

previewApi.put("/:projectId/preview/manifest", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const parsed = manifestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid manifest", issues: parsed.error.issues }, 400);
  await db.update(projectEnvironments)
    .set({ setupManifest: JSON.stringify(parsed.data), updatedAt: new Date() })
    .where(eq(projectEnvironments.projectId, access.project.id));
  return c.json({ ok: true, manifest: parsed.data });
});

export default previewApi;
