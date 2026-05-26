/**
 * Agent Runs — per-task-execution records
 *
 * Every time an agent is told to do something (cron, manual, webhook, or
 * the initial start instructions), we create a row in agent_run. That row
 * travels with the execution: status transitions, timing, exit code, any
 * error message. Downstream systems (scheduler, timeout sweeper, notifier,
 * UI) all key off this table instead of inferring state from messages.
 */

import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { db } from "../config/db.ts";
import { agents, agentTaskRuns } from "../db/schema/agents.ts";
import { agentBus } from "../events/agent-bus.ts";

export type RunTrigger = "cron" | "manual" | "webhook" | "start" | "chat";
export type RunStatus = "queued" | "running" | "success" | "error" | "timeout" | "cancelled";

export interface AgentRunRow {
  id: string;
  agentId: string;
  scheduleId: string | null;
  triggerType: string;
  status: string;
  prompt: string;
  triggerPayload: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
  outputSummary: string | null;
  errorMessage: string | null;
  retryCount: number;
  parentRunId: string | null;
  timeoutAt: Date | null;
  createdAt: Date;
}

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000; // 30 minutes

export async function createRun(input: {
  agentRowId: string;
  scheduleId?: string | null;
  triggerType: RunTrigger;
  prompt: string;
  payload?: Record<string, unknown> | null;
  parentRunId?: string | null;
  retryCount?: number;
  timeoutMs?: number | null;
}): Promise<AgentRunRow> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const timeoutAt = new Date(Date.now() + timeoutMs);

  const rows = await db
    .insert(agentTaskRuns)
    .values({
      agentId: input.agentRowId,
      scheduleId: input.scheduleId ?? null,
      triggerType: input.triggerType,
      status: "queued",
      prompt: input.prompt,
      triggerPayload: input.payload ?? null,
      parentRunId: input.parentRunId ?? null,
      retryCount: input.retryCount ?? 0,
      timeoutAt,
    })
    .returning();
  return rows[0]! as AgentRunRow;
}

export async function markRunStarted(runId: string): Promise<void> {
  await db
    .update(agentTaskRuns)
    .set({
      status: "running",
      startedAt: new Date(),
    })
    .where(eq(agentTaskRuns.id, runId));

  // Also thread the current run onto the agent so the CLI callback can find it
  const [run] = await db
    .select({ agentId: agentTaskRuns.agentId })
    .from(agentTaskRuns)
    .where(eq(agentTaskRuns.id, runId))
    .limit(1);

  if (run) {
    await db
      .update(agents)
      .set({ currentRunId: runId, lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(agents.id, run.agentId));
  }
}

export async function finishRun(
  runId: string,
  result: {
    status: Extract<RunStatus, "success" | "error" | "timeout" | "cancelled">;
    exitCode?: number | null;
    outputSummary?: string | null;
    errorMessage?: string | null;
  }
): Promise<AgentRunRow | null> {
  const now = new Date();

  const updated = await db
    .update(agentTaskRuns)
    .set({
      status: result.status,
      finishedAt: now,
      exitCode: result.exitCode ?? null,
      outputSummary: result.outputSummary ?? null,
      errorMessage: result.errorMessage ?? null,
    })
    .where(eq(agentTaskRuns.id, runId))
    .returning();

  const row = updated[0];
  if (!row) return null;

  // Clear the agent's currentRunId if it still points at this run
  await db
    .update(agents)
    .set({ currentRunId: null, lastActivityAt: now, updatedAt: now })
    .where(and(eq(agents.id, row.agentId), eq(agents.currentRunId, runId)));

  // Emit event for notifier + UI
  const [agentRow] = await db
    .select({ userId: agents.userId, agentId: agents.agentId })
    .from(agents)
    .where(eq(agents.id, row.agentId))
    .limit(1);

  if (agentRow) {
    if (result.status === "success") {
      agentBus.emit("agent.command_completed", {
        agentId: agentRow.agentId,
        userId: agentRow.userId,
      });
    } else {
      agentBus.emit("agent.error", {
        agentId: agentRow.agentId,
        userId: agentRow.userId,
        error: result.errorMessage ?? `Run ${result.status}`,
      });
    }
  }

  return row as AgentRunRow;
}

/**
 * Look up the active (queued or running) run for an agent. Used by the
 * scheduler to enforce "one run at a time" and by the CLI callback to
 * find the run to close.
 */
export async function getActiveRunForAgent(
  agentRowId: string
): Promise<AgentRunRow | null> {
  const rows = await db
    .select()
    .from(agentTaskRuns)
    .where(
      and(
        eq(agentTaskRuns.agentId, agentRowId),
        inArray(agentTaskRuns.status, ["queued", "running"])
      )
    )
    .orderBy(desc(agentTaskRuns.createdAt))
    .limit(1);
  return (rows[0] as AgentRunRow | undefined) ?? null;
}

export async function listRunsForAgent(
  agentRowId: string,
  limit = 50
): Promise<AgentRunRow[]> {
  const rows = await db
    .select()
    .from(agentTaskRuns)
    .where(eq(agentTaskRuns.agentId, agentRowId))
    .orderBy(desc(agentTaskRuns.createdAt))
    .limit(limit);
  return rows as AgentRunRow[];
}

/**
 * Find runs that exceeded their timeout. Called by the timeout sweeper.
 */
export async function findTimedOutRuns(): Promise<AgentRunRow[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(agentTaskRuns)
    .where(
      and(
        inArray(agentTaskRuns.status, ["queued", "running"]),
        lt(agentTaskRuns.timeoutAt, now)
      )
    );
  return rows as AgentRunRow[];
}

/**
 * Cancel any still-active run for an agent — used when stopping an agent
 * or deleting it. Does NOT emit error events (user-initiated).
 */
export async function cancelActiveRuns(agentRowId: string, reason: string): Promise<number> {
  const active = await db
    .select({ id: agentTaskRuns.id })
    .from(agentTaskRuns)
    .where(
      and(
        eq(agentTaskRuns.agentId, agentRowId),
        inArray(agentTaskRuns.status, ["queued", "running"])
      )
    );

  if (active.length === 0) return 0;

  const now = new Date();
  await db
    .update(agentTaskRuns)
    .set({
      status: "cancelled",
      finishedAt: now,
      errorMessage: reason,
    })
    .where(
      and(
        eq(agentTaskRuns.agentId, agentRowId),
        inArray(agentTaskRuns.status, ["queued", "running"])
      )
    );

  await db
    .update(agents)
    .set({ currentRunId: null, updatedAt: now })
    .where(eq(agents.id, agentRowId));

  return active.length;
}
