/**
 * Dev Preview API — run the connected client project live in its sandbox and
 * surface a preview URL for the Preview tab.
 *   GET    /api/projects/:projectId/preview            → current state
 *   POST   /api/projects/:projectId/preview/setup      → (re)build + run (async)
 *   POST   /api/projects/:projectId/preview/stop       → stop the app
 *   PUT    /api/projects/:projectId/preview/manifest   → save an edited manifest
 */
import { Hono } from "hono";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess } from "../../auth/project-access.ts";
import { db } from "../../config/db.ts";
import { projectEnvironments } from "../../db/schema/project-environments.ts";
import { projects, projectEnvironmentVariables } from "../../db/schema/projects.ts";
import { encryptSecret } from "../../utils/crypto.ts";
import { getPreviewState, setupPreview, restartPreview, stopPreview, detectManifest, manifestSchema, capturePreviewScreenshot, getPreviewBranches, reprobeProfile, getAppRuntimeLog, setServiceEnabled } from "../../services/dev-preview.ts";
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

// Multi-app: toggle a companion service on/off (persists + restarts the enabled set).
previewApi.post("/:projectId/preview/services", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const body = await c.req.json().catch(() => ({} as any));
  const name = String(body.name ?? "").trim();
  if (!name) return c.json({ error: "Missing service name" }, 400);
  const res = await setServiceEnabled(access.project.id, user.id, name, body.enabled !== false);
  return res.ok ? c.json(res, 202) : c.json(res, 400);
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
  const p = access.project as { ticketBuildIsolation?: string; previewBranchMode?: string; dbMode?: string };
  return c.json({
    ticketBuildIsolation: p.ticketBuildIsolation ?? "isolated",
    previewBranchMode: p.previewBranchMode ?? "worktree",
    dbMode: p.dbMode ?? "auto",
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
  if (body.dbMode === "auto" || body.dbMode === "new" || body.dbMode === "provided") patch.dbMode = body.dbMode;
  if (!Object.keys(patch).length) return c.json({ error: "Nothing valid to update" }, 400);
  patch.updatedAt = new Date();
  await db.update(projects).set(patch).where(eq(projects.id, access.project.id));
  return c.json({ ok: true, ...patch });
});

// ── Environment variables CRUD ───────────────────────────────────────
// Values are never returned (secret or not); the UI only needs metadata + masking.
previewApi.get("/:projectId/env-vars", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const rows = await db
    .select()
    .from(projectEnvironmentVariables)
    .where(eq(projectEnvironmentVariables.projectId, access.project.id))
    .orderBy(asc(projectEnvironmentVariables.key));
  return c.json({
    envVars: rows.map((e) => ({
      id: e.id,
      key: e.key,
      isSecret: e.isSecret,
      isRequired: e.isRequired,
      hasValue: e.hasValue,
      description: e.description ?? "",
    })),
  });
});

// Bulk import (e.g. an uploaded .env): upsert many at once. Body: { text: "<.env>" } or
// { vars: [{key,value,description?,isSecret?}] }. Only overwrites values that are given.
previewApi.post("/:projectId/env-vars/bulk", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const body = await c.req.json().catch(() => ({} as any));
  let entries: { key: string; value: string; description?: string; isSecret?: boolean }[] = [];
  if (typeof body.text === "string") {
    // Parse .env text: KEY=VALUE lines, skip comments/blanks, strip `export ` + quotes.
    for (const raw of body.text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
      let value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) entries.push({ key, value });
    }
  } else if (Array.isArray(body.vars)) {
    entries = body.vars.filter((v: any) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v?.key ?? ""));
  }
  if (!entries.length) return c.json({ error: "No valid KEY=VALUE entries found." }, 400);
  let count = 0;
  for (const e of entries) {
    const hasValue = typeof e.value === "string" && e.value.length > 0;
    await db
      .insert(projectEnvironmentVariables)
      .values({
        projectId: access.project.id,
        key: e.key,
        encryptedValue: hasValue ? encryptSecret(String(e.value)) : "",
        isSecret: e.isSecret !== false,
        isRequired: false,
        hasValue,
        description: String(e.description ?? ""),
        createdById: user.id,
      })
      .onConflictDoUpdate({
        target: [projectEnvironmentVariables.projectId, projectEnvironmentVariables.key],
        set: { ...(hasValue ? { encryptedValue: encryptSecret(String(e.value)), hasValue: true } : {}), updatedAt: new Date() },
      });
    count++;
  }
  return c.json({ ok: true, count });
});

// Live app runtime log (the running app's own stdout — auth/email/errors), tailed on demand.
previewApi.get("/:projectId/preview/app-logs", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  return c.json({ log: await getAppRuntimeLog(access.project.id) });
});

// Create or update by key (upsert on the (projectId, key) unique index).
previewApi.post("/:projectId/env-vars", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const body = await c.req.json().catch(() => ({} as any));
  const key = String(body.key ?? "").trim();
  if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return c.json({ error: "Invalid env var name" }, 400);
  const hasValue = typeof body.value === "string" && body.value.length > 0;
  const isSecret = body.isSecret !== false; // default secret
  await db
    .insert(projectEnvironmentVariables)
    .values({
      projectId: access.project.id,
      key,
      encryptedValue: hasValue ? encryptSecret(String(body.value)) : "",
      isSecret,
      isRequired: !!body.isRequired,
      hasValue,
      description: String(body.description ?? ""),
      createdById: user.id,
    })
    .onConflictDoUpdate({
      target: [projectEnvironmentVariables.projectId, projectEnvironmentVariables.key],
      set: {
        // Only overwrite the stored value when a new one is provided (blank = keep).
        ...(hasValue ? { encryptedValue: encryptSecret(String(body.value)), hasValue: true } : {}),
        isSecret,
        ...(body.description !== undefined ? { description: String(body.description) } : {}),
        updatedAt: new Date(),
      },
    });
  return c.json({ ok: true });
});

previewApi.patch("/:projectId/env-vars/:id", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const body = await c.req.json().catch(() => ({} as any));
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.value === "string" && body.value.length > 0) {
    patch.encryptedValue = encryptSecret(body.value);
    patch.hasValue = true;
  }
  if (body.description !== undefined) patch.description = String(body.description);
  if (body.isSecret !== undefined) patch.isSecret = !!body.isSecret;
  await db
    .update(projectEnvironmentVariables)
    .set(patch)
    .where(and(eq(projectEnvironmentVariables.id, c.req.param("id")!), eq(projectEnvironmentVariables.projectId, access.project.id)));
  return c.json({ ok: true });
});

previewApi.delete("/:projectId/env-vars/:id", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.param("projectId")!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  await db
    .delete(projectEnvironmentVariables)
    .where(and(eq(projectEnvironmentVariables.id, c.req.param("id")!), eq(projectEnvironmentVariables.projectId, access.project.id)));
  return c.json({ ok: true });
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
