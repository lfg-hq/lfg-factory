/**
 * Agent CLI Callback API
 *
 * Receives pushed JSONL output from agent VMs and serves the state helper
 * endpoints the sandbox CLI can call to read/write structured state.
 *
 * Auth: X-CLI-API-Key header matched against profiles.cliApiKey.
 *
 * Endpoints:
 *   POST /api/v1/cli/agent-output  — streamed JSONL from the agent
 *   GET  /api/v1/cli/agent-state   — read structured state
 *   PUT  /api/v1/cli/agent-state   — merge-update structured state
 */

import { Hono } from "hono";
import { db } from "../../config/db.ts";
import { agents, agentMessages } from "../../db/schema/agents.ts";
import { profiles } from "../../db/schema/users.ts";
import { and, eq } from "drizzle-orm";
import { broadcastToUser } from "../../ws/connection-manager.ts";
import { parseJsonlEvents, extractSessionId } from "../../services/claude-cli.ts";
import { syncMemory } from "../../services/agent-manager.ts";
import { agentBus } from "../../events/agent-bus.ts";
import { finishRun } from "../../services/agent-runs.ts";

export const agentCliRouter = new Hono();

// ── Auth middleware ───────────────────────────────────────────────────

agentCliRouter.use("*", async (c, next) => {
  const apiKey = c.req.header("X-CLI-API-Key");
  if (!apiKey) return c.json({ error: "Missing X-CLI-API-Key header" }, 401);

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.cliApiKey, apiKey))
    .limit(1);

  if (!profile) return c.json({ error: "Invalid API key" }, 401);

  // Stash userId so handlers can use it for ownership checks on the state API
  c.set("cliUserId" as never, profile.userId as never);
  await next();
});

// ── POST /api/v1/cli/agent-output ────────────────────────────────────

agentCliRouter.post("/agent-output", async (c) => {
  let body: { agent_id: string; data: string; done?: boolean; exit_code?: number };
  try {
    body = await c.req.json();
  } catch (err) {
    console.error("[agent-cli/output] JSON parse error:", (err as Error).message);
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { agent_id, data, done, exit_code } = body;
  if (!agent_id || (data == null && !done)) {
    return c.json({ error: "agent_id and data required" }, 400);
  }

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.agentId, agent_id))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  let rawText: string;
  try {
    rawText = data ? Buffer.from(data, "base64").toString("utf-8") : "";
  } catch {
    return c.json({ error: "Invalid base64 data" }, 400);
  }

  const events = parseJsonlEvents(rawText);
  let lastAssistantText = "";

  if (events.length > 0) {
    const sessionId = extractSessionId(events);
    if (sessionId) {
      await db
        .update(agents)
        .set({ cliSessionId: sessionId, updatedAt: new Date() })
        .where(eq(agents.id, agent.id));
    }

    for (const ev of events) {
      try {
        const msg = (ev as any).message;
        const content = Array.isArray(msg?.content) ? msg.content : [];

        if (ev.type === "assistant") {
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              const text = block.text.trim();
              lastAssistantText = text;

              await db.insert(agentMessages).values({
                agentId: agent.id,
                conversationType: "individual",
                role: "assistant",
                content: text,
              });

              broadcastToUser(agent.userId, {
                type: "agent_message",
                agent_id: agent_id,
                agent_name: agent.name,
                role: "assistant",
                content: text,
              });

              const questionMatch = text.match(/\[AGENT_QUESTION:\s*(.*?)\]/);
              if (questionMatch) {
                await db.insert(agentMessages).values({
                  agentId: agent.id,
                  conversationType: "individual",
                  role: "agent_question",
                  content: questionMatch[1],
                });

                agentBus.emit("agent.question", {
                  agentId: agent_id,
                  userId: agent.userId,
                  question: questionMatch[1],
                });
              }
            } else if (block.type === "tool_use" && block.name) {
              broadcastToUser(agent.userId, {
                type: "agent_tool_use",
                agent_id: agent_id,
                agent_name: agent.name,
                tool_name: block.name,
                tool_input: block.input ?? {},
              });
            }
          }
        }
      } catch (err) {
        console.error(`[agent-cli/output] Error processing event type=${ev.type}:`, err);
      }
    }
  } else if (rawText.trim()) {
    broadcastToUser(agent.userId, {
      type: "agent_message",
      agent_id: agent_id,
      agent_name: agent.name,
      role: "system",
      content: rawText.trim().slice(0, 1000),
    });
  }

  // Keep last_activity_at fresh so the idle-sweeper doesn't stop a busy agent
  await db
    .update(agents)
    .set({ lastActivityAt: new Date() })
    .where(eq(agents.id, agent.id));

  if (done) {
    // Sync memory
    try {
      await syncMemory(agent_id);
    } catch {
      // ignore
    }

    // Close out the active run (if any)
    if (agent.currentRunId) {
      const status: "success" | "error" =
        exit_code === undefined ? "success" : exit_code === 0 ? "success" : "error";
      await finishRun(agent.currentRunId, {
        status,
        exitCode: exit_code ?? null,
        outputSummary: lastAssistantText ? lastAssistantText.slice(0, 500) : null,
        errorMessage:
          status === "error" ? `CLI exited with code ${exit_code}` : null,
      }).catch((err) => {
        console.error("[agent-cli/output] finishRun error:", (err as Error).message);
      });
    }

    // Update agent status reflecting CLI exit
    if (exit_code !== undefined) {
      const newStatus = exit_code === 0 ? "idle" : "error";
      await db
        .update(agents)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(eq(agents.id, agent.id));

      broadcastToUser(agent.userId, {
        type: "agent_status",
        agent_id: agent_id,
        status: newStatus,
        message: exit_code === 0 ? "Task completed" : `Task failed (exit code ${exit_code})`,
      });

      agentBus.emit("agent.command_completed", {
        agentId: agent_id,
        userId: agent.userId,
      });
    }
  }

  return c.json({ ok: true });
});

// ── Agent State API (Phase 4 S1) ─────────────────────────────────────
// The sandbox CLI calls these to persist structured state (watermarks,
// last synced IDs, counters). The X-CLI-API-Key middleware ensures only
// the calling user's own agents can be touched.

async function assertAgentBelongsToCliUser(
  c: import("hono").Context,
  agentId: string
): Promise<{ ok: boolean; agent?: typeof agents.$inferSelect; response?: Response }> {
  const cliUserId = c.get("cliUserId" as never) as string | undefined;
  if (!cliUserId) {
    return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  }
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, cliUserId)))
    .limit(1);
  if (!agent) {
    return { ok: false, response: c.json({ error: "Agent not found" }, 404) };
  }
  return { ok: true, agent };
}

agentCliRouter.get("/agent-state", async (c) => {
  const agentId = c.req.query("agent_id");
  if (!agentId) return c.json({ error: "agent_id required" }, 400);

  const check = await assertAgentBelongsToCliUser(c, agentId);
  if (!check.ok) return check.response!;

  return c.json({
    agent_id: agentId,
    state: (check.agent!.state as Record<string, unknown> | null) ?? {},
  });
});

agentCliRouter.put("/agent-state", async (c) => {
  let body: { agent_id: string; patch?: Record<string, unknown>; replace?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.agent_id) return c.json({ error: "agent_id required" }, 400);
  if (!body.patch && !body.replace) {
    return c.json({ error: "patch or replace required" }, 400);
  }

  const check = await assertAgentBelongsToCliUser(c, body.agent_id);
  if (!check.ok) return check.response!;
  const agent = check.agent!;

  const existing = (agent.state as Record<string, unknown> | null) ?? {};
  const nextState = body.replace ? body.replace : { ...existing, ...(body.patch ?? {}) };

  await db
    .update(agents)
    .set({ state: nextState, updatedAt: new Date() })
    .where(eq(agents.id, agent.id));

  return c.json({ ok: true, state: nextState });
});
