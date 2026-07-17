import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { instantApps } from "../../db/schema/instant.ts";
import { projects } from "../../db/schema/projects.ts";
import { sandboxes } from "../../db/schema/sandbox.ts";
import { execOnWorkspace } from "../../services/mags.ts";
import {
  deleteInstantApp,
  exportInstantAppToGitHub,
  getInstantAppArchive,
  retryInstantBuild,
} from "../../services/instant-app.ts";
import { testInstantApp } from "../../services/instant-tester.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const instantApi = new Hono<AuthEnv>();
instantApi.use("*", requireAuth);

async function resolveProjectForUser(userId: string, publicProjectId: string) {
  const [project] = await db
    .select({ id: projects.id, projectId: projects.projectId })
    .from(projects)
    .where(and(eq(projects.projectId, publicProjectId), eq(projects.ownerId, userId)))
    .limit(1);
  return project ?? null;
}

async function getAppForUser(userId: string, appId: string, internalProjectId?: string) {
  const predicates = [eq(instantApps.userId, userId), eq(instantApps.appId, appId)];
  if (internalProjectId) predicates.push(eq(instantApps.projectId, internalProjectId));

  const [row] = await db
    .select({ app: instantApps, sandbox: sandboxes })
    .from(instantApps)
    .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
    .where(and(...predicates))
    .limit(1);

  return row ?? null;
}

async function fetchWorkspaceLogs(workspaceId: string, offset: number) {
  const cmd =
    offset > 0
      ? `tail -c +${offset + 1} /data/project/dev.log 2>/dev/null || echo ''`
      : "tail -n 200 /data/project/dev.log 2>/dev/null || echo ''";
  const result = await execOnWorkspace(workspaceId, cmd, { timeout: 15_000 });
  const logs = result.output ?? "";
  return {
    logs,
    offset: offset + Buffer.byteLength(logs, "utf8"),
  };
}

async function rebuildWorkspace(workspaceId: string) {
  const cmd =
    "cd /data/project && (pkill -f 'next start' 2>/dev/null || true) && npm run build && nohup npm start -p 8080 -H 0.0.0.0 > dev.log 2>&1 &";
  await execOnWorkspace(workspaceId, cmd, { timeout: 180_000 });
}

// Standalone endpoints (must be declared before project-scoped dynamic segment)
instantApi.get("/apps/:appId/env", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  const row = await getAppForUser(user.id, appId);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ env_vars: (row.app.envVars as Record<string, string> | null) ?? {} });
});

instantApi.post("/apps/:appId/env", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  const row = await getAppForUser(user.id, appId);
  if (!row) return c.json({ error: "Not found" }, 404);

  const body = await c.req
    .json<{ env_vars?: Record<string, string> }>()
    .catch(() => ({ env_vars: {} as Record<string, string> }));
  const envVars = body.env_vars ?? {};
  await db
    .update(instantApps)
    .set({ envVars, updatedAt: new Date() })
    .where(eq(instantApps.id, row.app.id));
  return c.json({ env_vars: envVars });
});

instantApi.get("/apps/:appId/logs", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  const row = await getAppForUser(user.id, appId);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!row.sandbox?.magsWorkspaceId) return c.json({ logs: "", error: "No sandbox available" });

  const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;
  const payload = await fetchWorkspaceLogs(row.sandbox.magsWorkspaceId, offset);
  return c.json(payload);
});

instantApi.post("/apps/:appId/rebuild", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  const row = await getAppForUser(user.id, appId);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!row.sandbox?.magsWorkspaceId) return c.json({ error: "No workspace available" }, 400);

  await rebuildWorkspace(row.sandbox.magsWorkspaceId);
  return c.json({ status: "ok", message: "Rebuild started" });
});

// QA: run the cloud-browser smoke test over every screen. Fire-and-forget —
// results stream back over WS (notification_type: "instant_app_test").
instantApi.post("/apps/:appId/qa", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  const row = await getAppForUser(user.id, appId);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!row.sandbox?.magsWorkspaceId) return c.json({ error: "No workspace available — build the app first." }, 400);
  if (!row.app.previewUrl) return c.json({ error: "App has no preview URL — build it first." }, 400);

  void testInstantApp({
    appId: row.app.appId,
    appDbId: row.app.id,
    userId: user.id,
    conversationId: row.app.conversationId,
    appName: row.app.name,
    previewUrl: row.app.previewUrl,
    buildWorkspaceId: row.sandbox.magsWorkspaceId,
  });
  return c.json({ status: "started" });
});

// Restore/resume: deterministically bring the app back. Provisions a fresh VM and
// clones from GitHub if the sandbox was reaped (or reuses a live VM). No LLM involved.
instantApi.post("/apps/:appId/restore", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  const row = await getAppForUser(user.id, appId);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!row.app.conversationId) return c.json({ error: "App has no conversation to restore" }, 400);
  const result = await retryInstantBuild({ userId: user.id, conversationId: row.app.conversationId });
  if (!result.started) return c.json({ error: result.reason ?? "Could not restore" }, 400);
  return c.json({ status: "ok", message: "Restore started" });
});

// ── Delete app (stop VM + remove records) ─────────────────────────
instantApi.delete("/apps/:appId", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  const result = await deleteInstantApp({ userId: user.id, appId });
  if (!result.deleted) return c.json({ error: result.message }, 404);
  return c.json({ status: "ok", message: result.message });
});

// ── Export to GitHub ──────────────────────────────────────────────
instantApi.post("/apps/:appId/export-github", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  const body = await c.req.json<{ repo_name?: string; is_private?: boolean }>().catch(() => ({} as { repo_name?: string; is_private?: boolean }));
  const result = await exportInstantAppToGitHub({
    userId: user.id,
    appId,
    repoName: body.repo_name,
    isPrivate: body.is_private,
  });
  if (!result.success) return c.json({ error: result.message }, 400);
  return c.json({ status: "ok", repo_url: result.repoUrl, message: result.message });
});

// ── Download archive ─────────────────────────────────────────────
instantApi.get("/apps/:appId/download", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  const result = await getInstantAppArchive({ userId: user.id, appId });
  if (!result.success || !result.data) return c.json({ error: result.message }, 400);

  return new Response(result.data, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Content-Length": String(result.data.length),
    },
  });
});

// Project scoped
instantApi.get("/:projectId/apps", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const project = await resolveProjectForUser(user.id, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const apps = await db
    .select()
    .from(instantApps)
    .where(and(eq(instantApps.userId, user.id), eq(instantApps.projectId, project.id)))
    .orderBy(desc(instantApps.createdAt));

  return c.json({
    apps: apps.map((app) => ({
      app_id: app.appId,
      name: app.name,
      description: (app.description ?? "").slice(0, 200),
      status: app.status,
      preview_url: app.previewUrl ?? "",
      created_at: app.createdAt,
    })),
  });
});

instantApi.get("/:projectId/apps/:appId/env", async (c) => {
  const user = c.get("user");
  const { projectId, appId } = c.req.param();
  const project = await resolveProjectForUser(user.id, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const row = await getAppForUser(user.id, appId, project.id);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ env_vars: (row.app.envVars as Record<string, string> | null) ?? {} });
});

instantApi.post("/:projectId/apps/:appId/env", async (c) => {
  const user = c.get("user");
  const { projectId, appId } = c.req.param();
  const project = await resolveProjectForUser(user.id, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const row = await getAppForUser(user.id, appId, project.id);
  if (!row) return c.json({ error: "Not found" }, 404);

  const body = await c.req
    .json<{ env_vars?: Record<string, string> }>()
    .catch(() => ({ env_vars: {} as Record<string, string> }));
  const envVars = body.env_vars ?? {};
  await db
    .update(instantApps)
    .set({ envVars, updatedAt: new Date() })
    .where(eq(instantApps.id, row.app.id));

  return c.json({ env_vars: envVars });
});

instantApi.get("/:projectId/apps/:appId/logs", async (c) => {
  const user = c.get("user");
  const { projectId, appId } = c.req.param();
  const project = await resolveProjectForUser(user.id, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const row = await getAppForUser(user.id, appId, project.id);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!row.sandbox?.magsWorkspaceId) return c.json({ logs: "", error: "No sandbox available" });

  const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;
  const payload = await fetchWorkspaceLogs(row.sandbox.magsWorkspaceId, offset);
  return c.json(payload);
});

instantApi.post("/:projectId/apps/:appId/rebuild", async (c) => {
  const user = c.get("user");
  const { projectId, appId } = c.req.param();
  const project = await resolveProjectForUser(user.id, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const row = await getAppForUser(user.id, appId, project.id);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!row.sandbox?.magsWorkspaceId) return c.json({ error: "No sandbox available" }, 400);

  await rebuildWorkspace(row.sandbox.magsWorkspaceId);
  return c.json({ status: "ok", message: "Rebuild started" });
});

instantApi.post("/:projectId/apps/:appId/restore", async (c) => {
  const user = c.get("user");
  const { projectId, appId } = c.req.param();
  const project = await resolveProjectForUser(user.id, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const row = await getAppForUser(user.id, appId, project.id);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!row.app.conversationId) return c.json({ error: "App has no conversation to restore" }, 400);
  const result = await retryInstantBuild({ userId: user.id, conversationId: row.app.conversationId });
  if (!result.started) return c.json({ error: result.reason ?? "Could not restore" }, 400);
  return c.json({ status: "ok", message: "Restore started" });
});

// ── Project-scoped: Delete ────────────────────────────────────────
instantApi.delete("/:projectId/apps/:appId", async (c) => {
  const user = c.get("user");
  const { projectId, appId } = c.req.param();
  const project = await resolveProjectForUser(user.id, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const result = await deleteInstantApp({ userId: user.id, appId });
  if (!result.deleted) return c.json({ error: result.message }, 404);
  return c.json({ status: "ok", message: result.message });
});

// ── Project-scoped: Export to GitHub ──────────────────────────────
instantApi.post("/:projectId/apps/:appId/export-github", async (c) => {
  const user = c.get("user");
  const { projectId, appId } = c.req.param();
  const project = await resolveProjectForUser(user.id, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const body = await c.req.json<{ repo_name?: string; is_private?: boolean }>().catch(() => ({} as { repo_name?: string; is_private?: boolean }));
  const result = await exportInstantAppToGitHub({
    userId: user.id,
    appId,
    repoName: body.repo_name,
    isPrivate: body.is_private,
  });
  if (!result.success) return c.json({ error: result.message }, 400);
  return c.json({ status: "ok", repo_url: result.repoUrl, message: result.message });
});

// ── Project-scoped: Download archive ─────────────────────────────
instantApi.get("/:projectId/apps/:appId/download", async (c) => {
  const user = c.get("user");
  const { projectId, appId } = c.req.param();
  const project = await resolveProjectForUser(user.id, projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const result = await getInstantAppArchive({ userId: user.id, appId });
  if (!result.success || !result.data) return c.json({ error: result.message }, 400);

  return new Response(result.data, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Content-Length": String(result.data.length),
    },
  });
});

export default instantApi;
