/**
 * LFG Desktop runner API (session-authenticated; the runner itself uses /ws/runner).
 *
 * GET    /api/runner/devices       — this person's computers, with live status
 * POST   /api/runner/devices       — pair a computer; returns its token ONCE
 * DELETE /api/runner/devices/:id   — revoke a computer (disconnects it)
 * GET    /api/runner/jobs          — this person's recent runner jobs
 */

import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { env } from "../../config/env.ts";
import { runnerDevices, runnerJobs } from "../../db/schema/runners.ts";
import { createRunnerDevice, isDeviceConnected, revokeRunnerDevice } from "../../services/runner/hub.ts";
import type { auth } from "../../auth/index.ts";

type Env = { Variables: { user: typeof auth.$Infer.Session.user } };
const runnerApi = new Hono<Env>();
runnerApi.use("*", requireAuth as any);

runnerApi.get("/devices", async (c) => {
  const user = c.get("user");
  const rows = await db.select({
    id: runnerDevices.id, name: runnerDevices.name, tokenPrefix: runnerDevices.tokenPrefix,
    platform: runnerDevices.platform, appVersion: runnerDevices.appVersion, claudeVersion: runnerDevices.claudeVersion,
    lastSeenAt: runnerDevices.lastSeenAt, createdAt: runnerDevices.createdAt,
  }).from(runnerDevices)
    .where(and(eq(runnerDevices.userId, user.id), isNull(runnerDevices.revokedAt)))
    .orderBy(desc(runnerDevices.createdAt));
  return c.json({ devices: rows.map(d => ({ ...d, connected: isDeviceConnected(d.id) })) });
});

runnerApi.post("/devices", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  const { id, token } = await createRunnerDevice(user.id, body.name ?? "");
  return c.json({ id, token, serverUrl: env.APP_URL || env.BETTER_AUTH_URL }, 201);
});

runnerApi.delete("/devices/:id", async (c) => {
  const ok = await revokeRunnerDevice(c.get("user").id, c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

runnerApi.get("/jobs", async (c) => {
  const rows = await db.select({
    id: runnerJobs.id, projectId: runnerJobs.projectId, ticketId: runnerJobs.ticketId, deviceId: runnerJobs.deviceId,
    status: runnerJobs.status, branch: runnerJobs.branch, commitSha: runnerJobs.commitSha, error: runnerJobs.error,
    createdAt: runnerJobs.createdAt, finishedAt: runnerJobs.finishedAt,
  }).from(runnerJobs).where(eq(runnerJobs.userId, c.get("user").id)).orderBy(desc(runnerJobs.createdAt)).limit(50);
  return c.json({ jobs: rows });
});

export default runnerApi;
