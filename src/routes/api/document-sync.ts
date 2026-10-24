import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.ts";
import type { auth } from "../../auth/index.ts";
import { getProjectAccess } from "../../auth/project-access.ts";
import { projectSyncStatus, saveSyncTarget, syncProjectDocuments, syncProvider, syncTargetsFor, connectedToolkits } from "../../services/document-sync.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };

// /api/document-sync — a user's knowledge-base destinations (Settings → Integrations).
export const documentSyncSettingsApi = new Hono<AuthEnv>();
documentSyncSettingsApi.use("*", requireAuth);

documentSyncSettingsApi.get("/providers", async (c) => {
  const user = c.get("user");
  if (c.req.query("fresh") === "1") await connectedToolkits(user.id, true);
  return c.json({ providers: await syncTargetsFor(user.id) });
});

const targetInput = z.object({ destination: z.string().max(500).optional(), autoSync: z.boolean().optional() });
documentSyncSettingsApi.put("/providers/:provider", async (c) => {
  const user = c.get("user");
  const provider = syncProvider(c.req.param("provider"));
  if (!provider) return c.json({ error: "Unknown provider" }, 404);
  const parsed = targetInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid settings" }, 400);
  await saveSyncTarget(user.id, provider.key, parsed.data);
  const providers = await syncTargetsFor(user.id);
  return c.json({ provider: providers.find((p) => p.key === provider.key) });
});

// /api/projects/:projectId/document-sync — status and manual sync for one project.
export const documentSyncProjectApi = new Hono<AuthEnv>();
documentSyncProjectApi.use("*", requireAuth);

documentSyncProjectApi.get("/:projectId/document-sync", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId"), user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  return c.json(await projectSyncStatus(user.id, access.project));
});

const syncInput = z.object({
  providers: z.array(z.string().max(40)).max(20).optional(),
  fileIds: z.array(z.string().max(80)).max(500).optional(),
  force: z.boolean().optional(),
});
documentSyncProjectApi.post("/:projectId/document-sync", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId"), user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const parsed = syncInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid sync request" }, 400);
  try {
    const results = await syncProjectDocuments(user.id, access.project, {
      ...parsed.data,
      providers: parsed.data.providers?.map((p) => p.toUpperCase()),
    });
    if (!results.length) return c.json({ error: "No knowledge base is ready. Connect one in Settings → Integrations." }, 400);
    return c.json({ results, status: await projectSyncStatus(user.id, access.project) });
  } catch (err) {
    return c.json({ error: (err as Error).message || "Sync failed" }, 409);
  }
});
