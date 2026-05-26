/**
 * Agent Scheduler — Cron-based task scheduling for agents
 *
 * Uses setInterval-based polling. On every tick:
 *   1. Load enabled schedules
 *   2. For each schedule whose cron matches *now* (in its timezone):
 *      - Skip if the agent has an in-flight run (concurrency lock, R1)
 *      - Skip if the agent is in circuit-broken state (too many failures)
 *      - Call runCommand() with autoStart=true so stopped agents wake up (F3)
 *      - On throw, schedule up to `maxRetries` attempts (R4)
 *   3. Update lastRunAt/nextRunAt
 *
 * On boot, also runs a catch-up pass (R3) that fires any schedules whose
 * nextRunAt is in the past (missed while the server was down).
 */

import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { agents, agentSchedules } from "../db/schema/agents.ts";
import { runCommand, getAgentByRunId } from "./agent-manager.ts";
import { agentBus } from "../events/agent-bus.ts";
import { getActiveRunForAgent } from "./agent-runs.ts";
import { isAgentCircuitBroken } from "./agent-notifier.ts";

const activeTimers = new Map<string, ReturnType<typeof setInterval>>();
const CHECK_INTERVAL_MS = 60_000;

// Tracks minute buckets we've already fired for a given schedule, to guard
// against double-fire if checkSchedules() is invoked twice inside one minute.
const firedBuckets = new Map<string, string>(); // scheduleId -> "YYYY-MM-DDTHH:MM"

function minuteBucket(d: Date, tz: string): string {
  // Use Intl to get the local time in the schedule's timezone so "9am PT"
  // means 9am PT even if the server is in UTC.
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
  } catch {
    // Invalid timezone — fall back to UTC
    return d.toISOString().slice(0, 16);
  }
}

function localTimeFields(d: Date, tz: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hour12: false,
    });
    const parts = dtf.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const weekdayStr = get("weekday").toLowerCase();
    const weekdayMap: Record<string, number> = {
      sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    };
    return {
      minute: parseInt(get("minute"), 10) || 0,
      hour: parseInt(get("hour"), 10) || 0,
      dayOfMonth: parseInt(get("day"), 10) || 0,
      month: parseInt(get("month"), 10) || 0,
      dayOfWeek: weekdayMap[weekdayStr.slice(0, 3)] ?? 0,
    };
  } catch {
    return {
      minute: d.getUTCMinutes(),
      hour: d.getUTCHours(),
      dayOfMonth: d.getUTCDate(),
      month: d.getUTCMonth() + 1,
      dayOfWeek: d.getUTCDay(),
    };
  }
}

function cronMatches(expression: string, now: Date, tz = "UTC"): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const { minute, hour, dayOfMonth, month, dayOfWeek } = localTimeFields(now, tz);

  return (
    matchField(parts[0]!, minute) &&
    matchField(parts[1]!, hour) &&
    matchField(parts[2]!, dayOfMonth) &&
    matchField(parts[3]!, month) &&
    matchField(parts[4]!, dayOfWeek)
  );
}

function matchField(expr: string, value: number): boolean {
  if (expr === "*") return true;

  if (expr.startsWith("*/")) {
    const step = parseInt(expr.slice(2), 10);
    return !isNaN(step) && step > 0 && value % step === 0;
  }

  const values = expr.split(",");
  for (const v of values) {
    if (v.includes("-")) {
      const rangeParts = v.split("-").map(Number);
      const start = rangeParts[0]!;
      const end = rangeParts[1]!;
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) return true;
    } else {
      if (parseInt(v, 10) === value) return true;
    }
  }

  return false;
}

/**
 * Calculate the next run time (UTC Date) for a cron expression in a given
 * timezone. Approximate — scans the next 8 days at minute granularity.
 */
function nextCronRun(expression: string, tz = "UTC"): Date {
  const now = new Date();
  const cap = 8 * 24 * 60; // 8 days of minutes
  for (let i = 1; i <= cap; i++) {
    const candidate = new Date(now.getTime() + i * 60_000);
    candidate.setUTCSeconds(0, 0);
    if (cronMatches(expression, candidate, tz)) return candidate;
  }
  return new Date(now.getTime() + 86_400_000);
}

/**
 * Core dispatch path for a single schedule firing. Shared between the
 * normal tick and the boot catch-up path. Handles retries internally.
 */
async function fireSchedule(
  schedule: typeof agentSchedules.$inferSelect,
  agent: typeof agents.$inferSelect,
  reason: "cron" | "catchup"
): Promise<void> {
  console.log(
    `[agent-scheduler] Firing schedule "${schedule.name}" for agent "${agent.name}" (reason=${reason})`
  );

  // Concurrency lock
  const active = await getActiveRunForAgent(agent.id);
  if (active) {
    console.log(
      `[agent-scheduler] Skip "${schedule.name}": agent has active run ${active.id} (status=${active.status})`
    );
    return;
  }

  // Circuit breaker
  if (isAgentCircuitBroken(agent.agentId)) {
    console.warn(
      `[agent-scheduler] Skip "${schedule.name}": agent ${agent.agentId} is circuit-broken`
    );
    return;
  }

  const maxRetries = schedule.maxRetries ?? 0;
  let attempt = 0;
  let lastError: Error | null = null;
  let parentRunId: string | null = null;

  while (attempt <= maxRetries) {
    try {
      const result = await runCommand(agent.agentId, agent.userId, {
        prompt: schedule.command,
        triggerType: "cron",
        scheduleId: schedule.id,
        autoStart: true,
        retryCount: attempt,
        parentRunId,
      });

      await db
        .update(agentSchedules)
        .set({
          lastRunAt: new Date(),
          nextRunAt: nextCronRun(schedule.cronExpression, schedule.timezone ?? "UTC"),
          updatedAt: new Date(),
        })
        .where(eq(agentSchedules.id, schedule.id));

      agentBus.emit("agent.schedule_triggered", {
        agentId: agent.agentId,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
      });
      return; // success — exit retry loop
    } catch (err) {
      lastError = err as Error;
      console.warn(
        `[agent-scheduler] Attempt ${attempt + 1}/${maxRetries + 1} failed for "${schedule.name}": ${lastError.message}`
      );
      parentRunId = null; // we can't link retries without the runId, skip for now
      attempt += 1;
      if (attempt <= maxRetries) {
        // Exponential backoff — 5s * 2^(attempt-1)
        const backoff = 5000 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  console.error(
    `[agent-scheduler] "${schedule.name}" failed after ${maxRetries + 1} attempts: ${lastError?.message}`
  );
  agentBus.emit("agent.error", {
    agentId: agent.agentId,
    userId: agent.userId,
    error: `Scheduled task "${schedule.name}" failed: ${lastError?.message ?? "unknown"}`,
  });

  // Still advance nextRunAt so we don't spin
  await db
    .update(agentSchedules)
    .set({
      lastRunAt: new Date(),
      nextRunAt: nextCronRun(schedule.cronExpression, schedule.timezone ?? "UTC"),
      updatedAt: new Date(),
    })
    .where(eq(agentSchedules.id, schedule.id));
}

async function checkSchedules(): Promise<void> {
  try {
    const now = new Date();
    const schedules = await db
      .select({
        schedule: agentSchedules,
        agent: agents,
      })
      .from(agentSchedules)
      .innerJoin(agents, eq(agentSchedules.agentId, agents.id))
      .where(eq(agentSchedules.enabled, true));

    for (const { schedule, agent } of schedules) {
      const tz = schedule.timezone ?? "UTC";
      if (!cronMatches(schedule.cronExpression, now, tz)) continue;

      // De-dupe per minute bucket (prevents double fire if tick bunches)
      const bucket = minuteBucket(now, tz);
      const bucketKey = `${schedule.id}:${bucket}`;
      if (firedBuckets.get(schedule.id) === bucket) continue;
      firedBuckets.set(schedule.id, bucket);

      // Fire asynchronously — don't block the tick loop
      fireSchedule(schedule, agent, "cron").catch((err) => {
        console.error(
          `[agent-scheduler] Unhandled error firing schedule ${bucketKey}:`,
          (err as Error).message
        );
      });
    }

    // Gc old buckets (keep only last 4 entries per schedule is enough)
    if (firedBuckets.size > 500) {
      const keys = Array.from(firedBuckets.keys()).slice(0, firedBuckets.size - 500);
      for (const k of keys) firedBuckets.delete(k);
    }
  } catch (err) {
    console.error("[agent-scheduler] Check cycle error:", (err as Error).message);
  }
}

/**
 * R3 — On boot, fire any schedules whose nextRunAt is in the past.
 * Cap how far back we catch up (max 1 day) to avoid a thundering herd
 * after a long outage.
 */
async function catchUpMissedRuns(): Promise<void> {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 86_400_000);
    const schedules = await db
      .select({ schedule: agentSchedules, agent: agents })
      .from(agentSchedules)
      .innerJoin(agents, eq(agentSchedules.agentId, agents.id))
      .where(eq(agentSchedules.enabled, true));

    for (const { schedule, agent } of schedules) {
      if (!schedule.nextRunAt) continue;
      if (schedule.nextRunAt > now) continue; // not due
      if (schedule.nextRunAt < oneDayAgo) {
        // More than a day late — don't fire, just reset
        await db
          .update(agentSchedules)
          .set({
            nextRunAt: nextCronRun(schedule.cronExpression, schedule.timezone ?? "UTC"),
            updatedAt: new Date(),
          })
          .where(eq(agentSchedules.id, schedule.id));
        continue;
      }
      console.log(
        `[agent-scheduler] Catch-up: firing missed schedule "${schedule.name}" (was due ${schedule.nextRunAt.toISOString()})`
      );
      fireSchedule(schedule, agent, "catchup").catch((err) => {
        console.error("[agent-scheduler] catch-up error:", (err as Error).message);
      });
    }
  } catch (err) {
    console.error("[agent-scheduler] Catch-up pass error:", (err as Error).message);
  }
}

export function startAgentScheduler(): void {
  console.log("[agent-scheduler] Starting agent scheduler (check interval: 60s)");

  const timer = setInterval(checkSchedules, CHECK_INTERVAL_MS);
  activeTimers.set("__global__", timer);

  // Initial tick after a short delay — gives the app time to finish booting
  setTimeout(checkSchedules, 5_000);

  // Catch-up pass for missed runs
  setTimeout(catchUpMissedRuns, 8_000);
}

// ── Schedule CRUD ────────────────────────────────────────────────────

export async function addSchedule(
  agentId: string,
  schedule: { name: string; cronExpression: string; command: string; timezone?: string; maxRetries?: number }
): Promise<typeof agentSchedules.$inferSelect> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.agentId, agentId))
    .limit(1);

  if (!agent) throw new Error("Agent not found");

  const tz = schedule.timezone ?? "UTC";
  const rows = await db
    .insert(agentSchedules)
    .values({
      agentId: agent.id,
      name: schedule.name,
      cronExpression: schedule.cronExpression,
      command: schedule.command,
      timezone: tz,
      maxRetries: schedule.maxRetries ?? 0,
      nextRunAt: nextCronRun(schedule.cronExpression, tz),
    })
    .returning();
  const row = rows[0]!;

  console.log(`[agent-scheduler] Added schedule "${schedule.name}" for agent ${agentId}`);
  return row;
}

export async function removeSchedule(scheduleId: string): Promise<void> {
  await db.delete(agentSchedules).where(eq(agentSchedules.id, scheduleId));
  console.log(`[agent-scheduler] Removed schedule ${scheduleId}`);
}

export async function updateSchedule(
  scheduleId: string,
  updates: {
    name?: string;
    cronExpression?: string;
    command?: string;
    enabled?: boolean;
    timezone?: string;
    maxRetries?: number;
  }
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.name !== undefined) set.name = updates.name;
  if (updates.cronExpression !== undefined) {
    set.cronExpression = updates.cronExpression;
  }
  if (updates.command !== undefined) set.command = updates.command;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;
  if (updates.timezone !== undefined) set.timezone = updates.timezone;
  if (updates.maxRetries !== undefined) set.maxRetries = updates.maxRetries;

  // Recompute nextRunAt if cron or timezone changed
  if (updates.cronExpression !== undefined || updates.timezone !== undefined) {
    const [existing] = await db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.id, scheduleId))
      .limit(1);
    if (existing) {
      const expr = updates.cronExpression ?? existing.cronExpression;
      const tz = updates.timezone ?? existing.timezone ?? "UTC";
      set.nextRunAt = nextCronRun(expr, tz);
    }
  }

  await db.update(agentSchedules).set(set).where(eq(agentSchedules.id, scheduleId));
}

/**
 * Re-used by the run-now endpoint to trigger a schedule immediately without
 * waiting for its cron to fire. Dispatches via fireSchedule() so all the
 * retry / concurrency / logging plumbing still applies.
 */
export async function runScheduleNow(scheduleId: string, userId: string): Promise<void> {
  const result = await db
    .select({ schedule: agentSchedules, agent: agents })
    .from(agentSchedules)
    .innerJoin(agents, eq(agentSchedules.agentId, agents.id))
    .where(eq(agentSchedules.id, scheduleId))
    .limit(1);

  const row = result[0];
  if (!row) throw new Error("Schedule not found");
  if (row.agent.userId !== userId) throw new Error("Unauthorized");

  await fireSchedule(row.schedule, row.agent, "cron");
}

// Re-export for callers that need to look up runs (e.g. routes)
export { getAgentByRunId };
