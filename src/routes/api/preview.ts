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
import { getPreviewState, setupPreview, stopPreview, detectManifest, manifestSchema } from "../../services/dev-preview.ts";
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
  }).catch((e) => console.error("[preview] setup failed:", e));

  return c.json({ ok: true, status: "detecting" }, 202);
});

previewApi.post("/:projectId/preview/stop", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  await stopPreview(access.project.id, user.id);
  return c.json({ ok: true });
});

// Re-run detection only (returns the manifest for review, does not run the app).
previewApi.post("/:projectId/preview/detect", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try {
    const manifest = await detectManifest(access.project.id);
    await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, access.project.id));
    return c.json({ manifest });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
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
