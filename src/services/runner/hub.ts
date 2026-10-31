/**
 * Runner hub: the server side of LFG Desktop runners.
 *
 * Tracks which runner devices are connected, offers each queued job ONLY to a
 * device owned by the job's user, and turns what the runner reports back into
 * ticket logs and ticket status. Shared data (tickets, logs, chat) stays on the
 * server; the coding itself happens on the person's own computer.
 *
 * Routing rule: a job carries the userId of the person who started it, and only
 * that person's devices ever see it. Nobody's Claude Code login works for anyone else.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { runnerDevices, runnerJobs } from "../../db/schema/runners.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { projects } from "../../db/schema/projects.ts";
import { addLog, attachLogOutput, formatToolUse } from "../ticket-logs.ts";
import { broadcastToUser } from "../../ws/connection-manager.ts";
import { RUNNER_PROTOCOL_VERSION, type ClaudeTaskPayload, type RunnerToServer, type ServerToRunner } from "./protocol.ts";

export interface RunnerConn {
  deviceId: string;
  userId: string;
  deviceName: string;
  send(message: ServerToRunner): void;
  close(code?: number, reason?: string): void;
}

/** How long a running job survives its runner dropping off before it is failed. */
export const LOST_RUNNER_GRACE_MS = 2 * 60_000;

const ACTIVE = ["offered", "running"] as const;
const conns = new Map<string, RunnerConn>();
const lostTimers = new Map<string, ReturnType<typeof setTimeout>>();
// `${jobId}:${toolUseId}` → the command log row, so a tool_result folds into it.
const toolRows = new Map<string, string>();

// ── Device tokens ────────────────────────────────────────────────────

export const hashRunnerToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createRunnerDevice(userId: string, name: string): Promise<{ id: string; token: string }> {
  const token = `lfgr_${randomBytes(32).toString("base64url")}`;
  const [row] = await db.insert(runnerDevices).values({
    userId,
    name: name.trim().slice(0, 80) || "My computer",
    tokenHash: hashRunnerToken(token),
    tokenPrefix: token.slice(0, 10),
  }).returning({ id: runnerDevices.id });
  return { id: row!.id, token };
}

export async function authenticateRunnerToken(token: string | null | undefined) {
  if (!token || !token.startsWith("lfgr_")) return null;
  const [device] = await db.select().from(runnerDevices)
    .where(and(eq(runnerDevices.tokenHash, hashRunnerToken(token)), isNull(runnerDevices.revokedAt)))
    .limit(1);
  return device ?? null;
}

export async function revokeRunnerDevice(userId: string, deviceId: string): Promise<boolean> {
  const updated = await db.update(runnerDevices).set({ revokedAt: new Date() })
    .where(and(eq(runnerDevices.id, deviceId), eq(runnerDevices.userId, userId), isNull(runnerDevices.revokedAt)))
    .returning({ id: runnerDevices.id });
  conns.get(deviceId)?.close(4001, "Device revoked");
  return updated.length > 0;
}

export const isDeviceConnected = (deviceId: string) => conns.has(deviceId);
export const userHasConnectedRunner = (userId: string) => [...conns.values()].some(c => c.userId === userId);

// ── Connection lifecycle ─────────────────────────────────────────────

export async function runnerOpened(conn: RunnerConn): Promise<void> {
  conns.get(conn.deviceId)?.close(4002, "Replaced by a newer connection");
  conns.set(conn.deviceId, conn);
  await db.update(runnerDevices).set({ lastSeenAt: new Date() }).where(eq(runnerDevices.id, conn.deviceId));
  conn.send({ type: "welcome", deviceId: conn.deviceId, deviceName: conn.deviceName, protocol: RUNNER_PROTOCOL_VERSION });
  broadcastToUser(conn.userId, { type: "runner_status", deviceId: conn.deviceId, connected: true });
}

export function runnerClosed(conn: RunnerConn): void {
  if (conns.get(conn.deviceId) !== conn) return; // an older, replaced connection
  conns.delete(conn.deviceId);
  broadcastToUser(conn.userId, { type: "runner_status", deviceId: conn.deviceId, connected: false });
  void (async () => {
    // Not yet accepted: hand it back so another of this person's computers can take it.
    await db.update(runnerJobs).set({ status: "queued", deviceId: null })
      .where(and(eq(runnerJobs.deviceId, conn.deviceId), eq(runnerJobs.status, "offered")));
    // Already running: the laptop may just be switching networks. Give it a while.
    const running = await db.select({ id: runnerJobs.id }).from(runnerJobs)
      .where(and(eq(runnerJobs.deviceId, conn.deviceId), eq(runnerJobs.status, "running")));
    for (const { id } of running) {
      if (lostTimers.has(id)) continue;
      lostTimers.set(id, setTimeout(() => {
        lostTimers.delete(id);
        if (conns.has(conn.deviceId)) return;
        void finishJob(id, conn.deviceId, { ok: false, error: `Lost contact with ${conn.deviceName}.` });
      }, LOST_RUNNER_GRACE_MS));
    }
    await dispatchQueued(conn.userId);
  })().catch(e => console.error("[runner] close handling failed:", e));
}

// One computer's messages are handled strictly in order, so its log reads in order.
const inbox = new WeakMap<RunnerConn, Promise<void>>();

export function runnerMessage(conn: RunnerConn, raw: string | Buffer): Promise<void> {
  const next = (inbox.get(conn) ?? Promise.resolve()).then(() => handleRunnerMessage(conn, raw));
  inbox.set(conn, next.catch(() => {}));
  return next;
}

async function handleRunnerMessage(conn: RunnerConn, raw: string | Buffer): Promise<void> {
  let msg: RunnerToServer;
  try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); }
  catch { conn.send({ type: "error", message: "Invalid JSON" }); return; }

  if (msg.type === "pong") return;
  if (msg.type === "hello") {
    await db.update(runnerDevices).set({
      lastSeenAt: new Date(),
      platform: msg.platform?.slice(0, 40) ?? null,
      appVersion: msg.appVersion?.slice(0, 40) ?? null,
      claudeVersion: msg.claudeVersion?.slice(0, 80) ?? null,
    }).where(eq(runnerDevices.id, conn.deviceId));
    // Anything this device was running that it no longer knows about died with it.
    const active = new Set(msg.activeJobIds ?? []);
    const mine = await db.select({ id: runnerJobs.id }).from(runnerJobs)
      .where(and(eq(runnerJobs.deviceId, conn.deviceId), eq(runnerJobs.status, "running")));
    for (const { id } of mine) {
      if (active.has(id)) { clearTimeout(lostTimers.get(id)); lostTimers.delete(id); }
      else await finishJob(id, conn.deviceId, { ok: false, error: `${conn.deviceName} restarted while this job was running.` });
    }
    await dispatchQueued(conn.userId);
    return;
  }

  if (!("jobId" in msg) || typeof msg.jobId !== "string") return;
  const job = await jobForDevice(msg.jobId, conn.deviceId);
  if (!job) { conn.send({ type: "error", message: `Unknown job ${msg.jobId}` }); return; }

  switch (msg.type) {
    case "job.accepted": {
      if (job.status !== "offered") return;
      await db.update(runnerJobs).set({ status: "running", startedAt: new Date() }).where(eq(runnerJobs.id, job.id));
      await ticketUpdate(job, { status: "in_progress", queueStatus: "executing" },
        `Running on ${conn.deviceName} with Claude Code.`);
      return;
    }
    case "job.rejected": {
      if (job.status !== "offered") return;
      await db.update(runnerJobs).set({ status: "rejected", error: msg.reason?.slice(0, 500) ?? null, finishedAt: new Date() })
        .where(eq(runnerJobs.id, job.id));
      await ticketUpdate(job, { status: "open", queueStatus: "none" },
        `${conn.deviceName} declined this job${msg.reason ? `: ${msg.reason.slice(0, 300)}` : "."}`);
      return;
    }
    case "job.progress": {
      if (job.status === "running") await logToTicket(job, String(msg.text).slice(0, 1000), "agent_progress");
      return;
    }
    case "job.agent_event": {
      if (job.status === "running" && msg.event && typeof msg.event === "object") await logAgentEvent(job, msg.event);
      return;
    }
    case "job.finished": {
      await finishJob(job.id, conn.deviceId, msg);
      return;
    }
  }
}

async function jobForDevice(jobId: string, deviceId: string) {
  const [job] = await db.select().from(runnerJobs).where(and(eq(runnerJobs.id, jobId), eq(runnerJobs.deviceId, deviceId))).limit(1);
  return job ?? null;
}

// ── Dispatch ─────────────────────────────────────────────────────────

export async function enqueueJob(input: { userId: string; projectId: string; ticketId: string | null; payload: ClaudeTaskPayload }) {
  const [job] = await db.insert(runnerJobs).values({
    userId: input.userId,
    projectId: input.projectId,
    ticketId: input.ticketId,
    type: "claude_task",
    payload: JSON.stringify(input.payload),
    branch: input.payload.branch,
  }).returning();
  await dispatchQueued(input.userId);
  const [fresh] = await db.select().from(runnerJobs).where(eq(runnerJobs.id, job!.id)).limit(1);
  return fresh!;
}

/** Offer this user's queued jobs, oldest first, to one of their connected devices. */
export async function dispatchQueued(userId: string): Promise<void> {
  const conn = [...conns.values()].filter(c => c.userId === userId).at(-1);
  if (!conn) return;
  const queued = await db.select().from(runnerJobs)
    .where(and(eq(runnerJobs.userId, userId), eq(runnerJobs.status, "queued")))
    .orderBy(asc(runnerJobs.createdAt));
  for (const job of queued) {
    const claimed = await db.update(runnerJobs).set({ status: "offered", deviceId: conn.deviceId })
      .where(and(eq(runnerJobs.id, job.id), eq(runnerJobs.status, "queued")))
      .returning({ id: runnerJobs.id });
    if (!claimed.length) continue;
    conn.send({ type: "job.offer", job: { id: job.id, type: "claude_task", payload: JSON.parse(job.payload) } });
    await logToTicket(job, `Sent to ${conn.deviceName}. Waiting for it to start.`, "agent_progress");
  }
}

/** Cancel every unfinished runner job on a ticket. Returns how many were active. */
export async function cancelTicketJobs(ticketId: string): Promise<number> {
  const jobs = await db.select().from(runnerJobs)
    .where(and(eq(runnerJobs.ticketId, ticketId), inArray(runnerJobs.status, ["queued", ...ACTIVE])));
  for (const job of jobs) {
    await db.update(runnerJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(runnerJobs.id, job.id));
    if (job.deviceId) conns.get(job.deviceId)?.send({ type: "job.cancel", jobId: job.id });
    clearTimeout(lostTimers.get(job.id)); lostTimers.delete(job.id);
  }
  return jobs.length;
}

async function finishJob(jobId: string, deviceId: string,
  result: { ok: boolean; branch?: string; commitSha?: string | null; summary?: string; error?: string }): Promise<void> {
  clearTimeout(lostTimers.get(jobId)); lostTimers.delete(jobId);
  const updated = await db.update(runnerJobs).set({
    status: result.ok ? "succeeded" : "failed",
    commitSha: result.commitSha?.slice(0, 64) ?? null,
    summary: result.summary?.slice(0, 4000) ?? null,
    error: result.error?.slice(0, 2000) ?? null,
    finishedAt: new Date(),
  }).where(and(eq(runnerJobs.id, jobId), eq(runnerJobs.deviceId, deviceId), inArray(runnerJobs.status, [...ACTIVE])))
    .returning();
  const job = updated[0];
  if (!job) return; // cancelled, or already finished
  for (const key of toolRows.keys()) if (key.startsWith(`${jobId}:`)) toolRows.delete(key);

  if (!result.ok) {
    await ticketUpdate(job, { status: "failed", queueStatus: "none" }, `Build on your computer failed: ${result.error ?? "unknown error"}`, "cli_error");
    return;
  }
  const pushed = !!result.commitSha;
  await ticketUpdate(job,
    pushed
      ? { status: "review", queueStatus: "none", githubBranch: result.branch ?? job.branch, githubCommitSha: result.commitSha!, lastExecutionAt: new Date() }
      : { status: "open", queueStatus: "none", lastExecutionAt: new Date() },
    pushed
      ? `Pushed ${(result.commitSha ?? "").slice(0, 7)} to ${result.branch ?? job.branch}.`
      : "Claude Code finished without changing any files.");
}

// ── Ticket side effects ──────────────────────────────────────────────

type TicketPatch = Partial<typeof projectTickets.$inferInsert>;

async function projectOwner(projectId: string): Promise<string | undefined> {
  const [row] = await db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return row?.ownerId;
}

async function ticketUpdate(job: typeof runnerJobs.$inferSelect, patch: TicketPatch, message: string,
  logType: "agent_progress" | "cli_error" = "agent_progress") {
  if (!job.ticketId) return;
  await db.update(projectTickets).set({ ...patch, updatedAt: new Date() }).where(eq(projectTickets.id, job.ticketId));
  const ownerId = await projectOwner(job.projectId);
  await addLog(job.ticketId, message, logType, ownerId);
  for (const userId of new Set([ownerId, job.userId].filter(Boolean) as string[])) {
    broadcastToUser(userId, { type: "ticket_status", ticketId: job.ticketId, status: patch.status, queueStatus: patch.queueStatus });
  }
}

async function logToTicket(job: typeof runnerJobs.$inferSelect, text: string,
  type: "agent_progress" | "ai_response" | "command" | "cli_error") {
  if (!job.ticketId || !text.trim()) return;
  await addLog(job.ticketId, text, type, await projectOwner(job.projectId));
}

/** Claude Code stream-json → ticket log rows (text, tool calls, tool output folded in). */
async function logAgentEvent(job: typeof runnerJobs.$inferSelect, event: Record<string, unknown>) {
  if (!job.ticketId) return;
  const ownerId = await projectOwner(job.projectId);
  const message = event.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? message!.content as Array<Record<string, any>> : [];
  if (event.type === "assistant") {
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        await addLog(job.ticketId, block.text, "ai_response", ownerId);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const logId = await addLog(job.ticketId, formatToolUse(block.name, block.input ?? {}), "command", ownerId);
        if (block.id && logId) toolRows.set(`${job.id}:${block.id}`, logId);
      }
    }
  } else if (event.type === "user") {
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const text = typeof block.content === "string" ? block.content
        : Array.isArray(block.content) ? block.content.map((b: { text?: string }) => b.text ?? "").join("\n") : "";
      const key = `${job.id}:${block.tool_use_id ?? ""}`;
      const logId = toolRows.get(key);
      if (logId) { await attachLogOutput(logId, text, job.ticketId, ownerId); toolRows.delete(key); }
    }
  } else if (event.type === "result" && event.is_error) {
    await addLog(job.ticketId, `Claude Code error: ${String(event.result ?? event.subtype ?? "unknown")}`.slice(0, 1000), "cli_error", ownerId);
  }
}

/** Test hook: forget connections and timers between test cases. */
export function _resetRunnerHubForTests() {
  conns.clear();
  for (const t of lostTimers.values()) clearTimeout(t);
  lostTimers.clear();
  toolRows.clear();
}
