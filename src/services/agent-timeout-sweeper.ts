/**
 * Agent Timeout Sweeper
 *
 * Background job that:
 *   R2 — kills agent runs whose timeoutAt has passed (wall-clock timeout)
 *   F3 — stops agents that have been idle longer than autoStopAfterIdleMs
 *
 * Runs once per minute. Intentionally fault-tolerant — individual failures
 * don't halt the sweep.
 */

import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "../config/db.ts";
import { agents } from "../db/schema/agents.ts";
import { findTimedOutRuns, finishRun } from "./agent-runs.ts";
import { stopAgent } from "./agent-manager.ts";
import { agentBus } from "../events/agent-bus.ts";

const SWEEP_INTERVAL_MS = 60_000;
let sweeperTimer: ReturnType<typeof setInterval> | null = null;

async function sweepTimedOutRuns(): Promise<void> {
  try {
    const timedOut = await findTimedOutRuns();
    if (!timedOut.length) return;

    console.warn(`[agent-sweeper] Found ${timedOut.length} timed-out run(s)`);

    for (const run of timedOut) {
      try {
        const closed = await finishRun(run.id, {
          status: "timeout",
          errorMessage: `Run exceeded wall-clock timeout (${run.timeoutAt?.toISOString() ?? "n/a"})`,
        });
        if (closed) {
          const [agent] = await db
            .select()
            .from(agents)
            .where(eq(agents.id, closed.agentId))
            .limit(1);
          if (agent) {
            agentBus.emit("agent.error", {
              agentId: agent.agentId,
              userId: agent.userId,
              error: `Run ${run.id.slice(0, 8)} timed out`,
            });
          }
        }
      } catch (err) {
        console.error(`[agent-sweeper] Failed to close run ${run.id}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error("[agent-sweeper] sweepTimedOutRuns error:", (err as Error).message);
  }
}

async function sweepIdleAgents(): Promise<void> {
  try {
    // Find agents that are running, have an autoStop policy, and have been
    // idle past their threshold. Skip agents with an active run.
    const candidates = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.status, "running"),
          isNotNull(agents.autoStopAfterIdleMs),
          isNotNull(agents.lastActivityAt)
        )
      );

    const now = Date.now();
    for (const agent of candidates) {
      if (agent.currentRunId) continue; // mid-run, don't touch
      const idleMs = agent.autoStopAfterIdleMs ?? 0;
      if (idleMs <= 0) continue;
      const lastMs = agent.lastActivityAt ? agent.lastActivityAt.getTime() : now;
      if (now - lastMs < idleMs) continue;

      console.log(
        `[agent-sweeper] Auto-stopping idle agent ${agent.agentId} (idle for ${Math.round(
          (now - lastMs) / 60_000
        )}min, threshold ${Math.round(idleMs / 60_000)}min)`
      );

      try {
        await stopAgent(agent.agentId, agent.userId);
      } catch (err) {
        console.error(
          `[agent-sweeper] Failed to auto-stop ${agent.agentId}:`,
          (err as Error).message
        );
      }
    }
  } catch (err) {
    console.error("[agent-sweeper] sweepIdleAgents error:", (err as Error).message);
  }
}

async function tick(): Promise<void> {
  await Promise.all([sweepTimedOutRuns(), sweepIdleAgents()]);
}

export function startAgentTimeoutSweeper(): void {
  if (sweeperTimer) return;
  console.log("[agent-sweeper] Starting timeout sweeper (interval: 60s)");
  sweeperTimer = setInterval(tick, SWEEP_INTERVAL_MS);
  setTimeout(tick, 10_000);
}

export function stopAgentTimeoutSweeper(): void {
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
}

