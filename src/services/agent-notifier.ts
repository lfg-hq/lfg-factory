/**
 * Agent Notifier — subscribes to agentBus and surfaces failures
 *
 * Phase 1 F4: when an agent errors out (run failure, start failure, etc),
 * we log it loudly, broadcast to the user's WS, and (in the future) fan
 * out to email / Slack / webhook.
 *
 * This file is the single subscriber registration point — keep all cross-
 * cutting notification logic here so the manager/scheduler stay focused on
 * orchestration.
 */

import { agentBus } from "../events/agent-bus.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";

// Track recent failures per-agent for simple rate-limiting / circuit-breaker
interface FailureState {
  count: number;
  firstAt: number;
  lastAt: number;
}
const failureState = new Map<string, FailureState>();
const FAILURE_WINDOW_MS = 60 * 60_000; // 1 hour
const CIRCUIT_BREAK_THRESHOLD = 5;

function recordFailure(agentId: string): FailureState {
  const now = Date.now();
  const existing = failureState.get(agentId);
  if (!existing || now - existing.firstAt > FAILURE_WINDOW_MS) {
    const fresh = { count: 1, firstAt: now, lastAt: now };
    failureState.set(agentId, fresh);
    return fresh;
  }
  existing.count += 1;
  existing.lastAt = now;
  return existing;
}

export function registerAgentNotifier(): void {
  agentBus.on("agent.error", ({ agentId, userId, error }) => {
    const state = recordFailure(agentId);

    console.error(
      `[agent-notifier] ERROR agent=${agentId} user=${userId} count=${state.count}/${CIRCUIT_BREAK_THRESHOLD}: ${error}`
    );

    broadcastToUser(userId, {
      type: "agent_notification",
      level: "error",
      agent_id: agentId,
      title: "Agent error",
      message: error,
      failure_count: state.count,
    });

    // Circuit breaker: warn the user that the agent is failing repeatedly
    if (state.count === CIRCUIT_BREAK_THRESHOLD) {
      broadcastToUser(userId, {
        type: "agent_notification",
        level: "warning",
        agent_id: agentId,
        title: "Agent failing repeatedly",
        message: `Agent has failed ${state.count} times in the last hour. Consider pausing its schedules and investigating.`,
      });
    }

    // TODO: fan out to email / slack / webhook when those integrations land
  });

  agentBus.on("agent.command_completed", ({ agentId, userId }) => {
    // A successful run resets the failure counter
    failureState.delete(agentId);

    broadcastToUser(userId, {
      type: "agent_notification",
      level: "success",
      agent_id: agentId,
      title: "Run complete",
      message: "Agent finished successfully",
    });
  });

  agentBus.on("agent.schedule_triggered", ({ agentId, scheduleName }) => {
    console.log(`[agent-notifier] schedule-fired agent=${agentId} schedule=${scheduleName}`);
  });

  console.log("[agent-notifier] Registered agent event handlers");
}

/**
 * Exposed for tests / scheduler: check if an agent is currently in a
 * circuit-broken state (too many failures recently).
 */
export function isAgentCircuitBroken(agentId: string): boolean {
  const state = failureState.get(agentId);
  if (!state) return false;
  if (Date.now() - state.firstAt > FAILURE_WINDOW_MS) {
    failureState.delete(agentId);
    return false;
  }
  return state.count >= CIRCUIT_BREAK_THRESHOLD;
}
