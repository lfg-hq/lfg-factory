/**
 * Agent Event Bus — Separate event bus for agent lifecycle events
 *
 * Avoids modifying the existing bus.ts. Typed EventEmitter for agent events.
 */

import { EventEmitter } from "node:events";
import { broadcastToUser } from "../ws/connection-manager.ts";

type AgentEventMap = {
  "agent.started": { agentId: string; userId: string };
  "agent.stopped": { agentId: string; userId: string };
  "agent.command_sent": { agentId: string; userId: string; prompt: string };
  "agent.command_completed": { agentId: string; userId: string };
  "agent.schedule_triggered": { agentId: string; scheduleId: string; scheduleName: string };
  "agent.memory_synced": { agentId: string };
  "agent.question": { agentId: string; userId: string; question: string };
  "agent.error": { agentId: string; userId: string; error: string };
};

type AgentEventType = keyof AgentEventMap;

class AgentEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(30);
  }

  emit<T extends AgentEventType>(type: T, payload: AgentEventMap[T]): void {
    if (process.env["NODE_ENV"] !== "production") {
      console.log(`[agent-event] ${type}`, JSON.stringify(payload));
    }
    this.emitter.emit(type, payload);
  }

  on<T extends AgentEventType>(type: T, handler: (payload: AgentEventMap[T]) => void): void {
    this.emitter.on(type, handler as (...args: unknown[]) => void);
  }

  off<T extends AgentEventType>(type: T, handler: (payload: AgentEventMap[T]) => void): void {
    this.emitter.off(type, handler as (...args: unknown[]) => void);
  }
}

export const agentBus = new AgentEventBus();

// ── Default handlers: broadcast status changes to WS ────────────────

agentBus.on("agent.question", ({ agentId, userId, question }) => {
  broadcastToUser(userId, {
    type: "agent_question",
    agent_id: agentId,
    question,
  });
});

agentBus.on("agent.error", ({ agentId, userId, error }) => {
  broadcastToUser(userId, {
    type: "agent_status",
    agent_id: agentId,
    status: "error",
    message: error,
  });
});
