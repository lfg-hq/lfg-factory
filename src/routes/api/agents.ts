/**
 * Agents API Routes
 *
 * CRUD, lifecycle, data room, memory, messages, and schedule management.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { agents, agentMessages, agentDataFiles, agentSchedules } from "../../db/schema/agents.ts";
import { messages } from "../../db/schema/chat.ts";
import {
  createAgent,
  startAgent,
  stopAgent,
  sendCommand,
  syncMemory,
  deleteAgent,
  getAgentStatus,
} from "../../services/agent-manager.ts";
import { runAgentTask } from "../../services/agent-runner.ts";
import { addSchedule, removeSchedule, updateSchedule, runScheduleNow } from "../../services/agent-scheduler.ts";
import { syncDataRoom } from "../../services/agent-sandbox.ts";
import { listSecrets, upsertSecret, deleteSecret } from "../../services/agent-secrets.ts";
import { listRunsForAgent } from "../../services/agent-runs.ts";
import { sandboxes } from "../../db/schema/sandbox.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const agentsApi = new Hono<AuthEnv>();
agentsApi.use("*", requireAuth);

// ── CRUD ──────────────────────────────────────────────────────────────

agentsApi.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req
    .json<{
      name?: string;
      personality?: string;
      instructions?: string;
      composio_toolkits?: string[];
    }>()
    .catch(() => ({} as Record<string, never>));

  const agent = await createAgent({
    userId: user.id,
    name: body.name?.trim() || "New Agent",
    personality: body.personality,
    instructions: body.instructions,
    composioToolkits: body.composio_toolkits,
  });

  // If created with instructions, seed the conversation so the AI responds
  // immediately on load.
  if (body.instructions?.trim() && agent.conversationId) {
    await db.insert(messages).values({
      conversationId: agent.conversationId,
      role: "user",
      content: body.instructions.trim(),
    });
  }

  return c.json({ agent }, 201);
});

agentsApi.put("/:agentId", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const body = await c.req.json<{
    name?: string;
    personality?: string;
    instructions?: string;
    composio_toolkits?: string[];
    auto_stop_after_idle_ms?: number | null;
    run_timeout_ms?: number | null;
  }>();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.personality !== undefined) updates.personality = body.personality;
  if (body.instructions !== undefined) updates.instructions = body.instructions;
  if (body.composio_toolkits !== undefined) updates.composioToolkits = body.composio_toolkits;
  if (body.auto_stop_after_idle_ms !== undefined) updates.autoStopAfterIdleMs = body.auto_stop_after_idle_ms;
  if (body.run_timeout_ms !== undefined) updates.runTimeoutMs = body.run_timeout_ms;

  await db.update(agents).set(updates).where(eq(agents.id, agent.id));

  return c.json({ status: "ok" });
});

agentsApi.delete("/:agentId", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const result = await deleteAgent(agentId, user.id);
  if (!result.deleted) return c.json({ error: result.message }, 404);
  return c.json({ status: "ok", message: result.message });
});

// ── Lifecycle ─────────────────────────────────────────────────────────

agentsApi.post("/:agentId/start", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();

  // Fire and forget — status updates come via WebSocket
  startAgent(agentId, user.id).catch((err) => {
    console.error(`[agents-api] Start failed:`, (err as Error).message);
  });

  return c.json({ status: "ok", message: "Starting agent..." });
});

agentsApi.post("/:agentId/stop", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();

  try {
    await stopAgent(agentId, user.id);
    return c.json({ status: "ok", message: "Agent stopped" });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

agentsApi.post("/:agentId/command", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const body = await c.req.json<{ prompt: string }>();

  if (!body.prompt?.trim()) return c.json({ error: "Prompt is required" }, 400);

  try {
    await sendCommand(agentId, body.prompt.trim(), user.id);
    return c.json({ status: "ok", message: "Command sent" });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

agentsApi.get("/:agentId/status", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const result = await getAgentStatus(agentId, user.id);
  if (!result) return c.json({ error: "Agent not found" }, 404);
  return c.json(result);
});

// ── Data Room ─────────────────────────────────────────────────────────

agentsApi.get("/:agentId/data", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  // Sync data room if agent is running
  if (agent.status === "running" && agent.sandboxId) {
    const sandbox = await db.select().from(sandboxes).where(eq(sandboxes.id, agent.sandboxId)).then((r) => r[0]);
    if (sandbox?.magsWorkspaceId) {
      await syncDataRoom(sandbox.magsWorkspaceId, agent.id).catch(() => {});
    }
  }

  const files = await db
    .select()
    .from(agentDataFiles)
    .where(eq(agentDataFiles.agentId, agent.id))
    .orderBy(desc(agentDataFiles.createdAt));

  return c.json({
    files: files.map((f) => ({
      id: f.id,
      file_name: f.fileName,
      file_type: f.fileType,
      file_size: f.fileSize,
      description: f.description,
      created_at: f.createdAt,
    })),
  });
});

agentsApi.post("/:agentId/data", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "No file uploaded" }, 400);

  const localDir = `uploads/agents/${agent.id}`;
  const localPath = `${localDir}/${file.name}`;
  const fs = await import("node:fs/promises");
  await fs.mkdir(localDir, { recursive: true });
  await fs.writeFile(localPath, Buffer.from(await file.arrayBuffer()));

  const rows = await db
    .insert(agentDataFiles)
    .values({
      agentId: agent.id,
      fileName: file.name,
      fileType: file.name.split(".").pop() ?? "unknown",
      filePath: localPath,
      fileSize: file.size,
    })
    .returning();
  const row = rows[0]!;

  return c.json({ file: { id: row.id, file_name: row.fileName } }, 201);
});

agentsApi.get("/:agentId/data/:fileId", async (c) => {
  const user = c.get("user");
  const { agentId, fileId } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const [file] = await db
    .select()
    .from(agentDataFiles)
    .where(and(eq(agentDataFiles.id, fileId), eq(agentDataFiles.agentId, agent.id)))
    .limit(1);

  if (!file) return c.json({ error: "File not found" }, 404);

  const fs = await import("node:fs/promises");
  try {
    await fs.access(file.filePath);
  } catch {
    return c.json({ error: "File data missing" }, 404);
  }

  const fileData = await fs.readFile(file.filePath);
  return new Response(fileData, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
    },
  });
});

agentsApi.delete("/:agentId/data/:fileId", async (c) => {
  const user = c.get("user");
  const { agentId, fileId } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  await db
    .delete(agentDataFiles)
    .where(and(eq(agentDataFiles.id, fileId), eq(agentDataFiles.agentId, agent.id)));

  return c.json({ status: "ok" });
});

// ── Memory ────────────────────────────────────────────────────────────

agentsApi.get("/:agentId/memory", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  return c.json({
    memory: agent.memoryContent ?? "",
    last_synced_at: agent.memoryLastSyncedAt,
  });
});

agentsApi.put("/:agentId/memory", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const body = await c.req.json<{ memory: string }>();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  await db
    .update(agents)
    .set({ memoryContent: body.memory, updatedAt: new Date() })
    .where(eq(agents.id, agent.id));

  return c.json({ status: "ok" });
});

agentsApi.post("/:agentId/sync-memory", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();

  const memory = await syncMemory(agentId);
  return c.json({ status: "ok", memory: memory ?? "" });
});

// ── Messages ──────────────────────────────────────────────────────────

agentsApi.get("/:agentId/messages", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const conversationType = c.req.query("type") ?? "individual";

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const msgs = await db
    .select()
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.agentId, agent.id),
        eq(agentMessages.conversationType, conversationType)
      )
    )
    .orderBy(desc(agentMessages.createdAt))
    .limit(100);

  return c.json({
    messages: msgs.reverse().map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.createdAt,
    })),
  });
});

agentsApi.post("/:agentId/messages", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const body = await c.req.json<{ content: string; conversation_type?: string }>();

  if (!body.content?.trim()) return c.json({ error: "Content required" }, 400);

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const msgRows = await db
    .insert(agentMessages)
    .values({
      agentId: agent.id,
      conversationType: body.conversation_type ?? "individual",
      role: "user",
      content: body.content.trim(),
    })
    .returning();
  const msg = msgRows[0]!;

  // Dispatch to sandbox if it's already running. For draft agents, the
  // chat-side LLM (in onboarding mode) handles the conversation directly —
  // no sandbox needed. For idle/stopped/error states, the chat-side LLM's
  // `runInSandbox` tool will lazy-start the sandbox if it decides compute is
  // needed; we no longer silently drop messages.
  if (agent.status === "running") {
    sendCommand(agentId, body.content.trim(), user.id).catch((err) => {
      console.error("[agents-api] sendCommand error:", (err as Error).message);
    });
  }

  return c.json({ message: { id: msg.id, role: msg.role, content: msg.content } }, 201);
});

// ── Schedules ─────────────────────────────────────────────────────────

agentsApi.get("/:agentId/schedules", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const schedules = await db
    .select()
    .from(agentSchedules)
    .where(eq(agentSchedules.agentId, agent.id))
    .orderBy(desc(agentSchedules.createdAt));

  return c.json({
    schedules: schedules.map((s) => ({
      id: s.id,
      name: s.name,
      cron_expression: s.cronExpression,
      command: s.command,
      enabled: s.enabled,
      last_run_at: s.lastRunAt,
      next_run_at: s.nextRunAt,
    })),
  });
});

agentsApi.post("/:agentId/schedules", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const body = await c.req.json<{
    name: string;
    cron_expression: string;
    command: string;
  }>();

  if (!body.name || !body.cron_expression || !body.command) {
    return c.json({ error: "name, cron_expression, and command are required" }, 400);
  }

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const schedule = await addSchedule(agentId, {
    name: body.name,
    cronExpression: body.cron_expression,
    command: body.command,
  });

  return c.json({ schedule: { id: schedule.id, name: schedule.name } }, 201);
});

agentsApi.put("/:agentId/schedules/:scheduleId", async (c) => {
  const user = c.get("user");
  const { agentId, scheduleId } = c.req.param();
  const body = await c.req.json<{
    name?: string;
    cron_expression?: string;
    command?: string;
    enabled?: boolean;
  }>();

  // Verify ownership
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  await updateSchedule(scheduleId, {
    name: body.name,
    cronExpression: body.cron_expression,
    command: body.command,
    enabled: body.enabled,
  });

  return c.json({ status: "ok" });
});

agentsApi.delete("/:agentId/schedules/:scheduleId", async (c) => {
  const user = c.get("user");
  const { agentId, scheduleId } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  await removeSchedule(scheduleId);
  return c.json({ status: "ok" });
});

agentsApi.post("/:agentId/schedules/:scheduleId/run-now", async (c) => {
  const user = c.get("user");
  const { agentId, scheduleId } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  try {
    // Fire & forget — response comes back via WS
    runScheduleNow(scheduleId, user.id).catch((err) => {
      console.error("[agents-api] runScheduleNow error:", (err as Error).message);
    });
    return c.json({ status: "ok", message: "Schedule triggered" });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ── Run Now (manual) — Phase 2 T1 ────────────────────────────────────

agentsApi.post("/:agentId/run", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const body = await c.req.json<{
    prompt: string;
    payload?: Record<string, unknown>;
    auto_start?: boolean;
  }>();

  if (!body.prompt?.trim()) return c.json({ error: "Prompt is required" }, 400);

  try {
    const result = await runAgentTask({
      agentId,
      userId: user.id,
      prompt: body.prompt.trim(),
      triggerType: "manual",
      payload: body.payload ?? null,
    });
    return c.json({ status: result.status, run_id: result.runId, output: result.output });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ── Runs — Phase 1 F2 read API ───────────────────────────────────────

agentsApi.get("/:agentId/runs", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const runs = await listRunsForAgent(agent.id, limit);
  return c.json({
    runs: runs.map((r) => ({
      id: r.id,
      schedule_id: r.scheduleId,
      trigger_type: r.triggerType,
      status: r.status,
      prompt: r.prompt.slice(0, 200),
      started_at: r.startedAt,
      finished_at: r.finishedAt,
      exit_code: r.exitCode,
      output_summary: r.outputSummary,
      error_message: r.errorMessage,
      retry_count: r.retryCount,
      created_at: r.createdAt,
    })),
  });
});

// ── Secrets — Phase 1 F1 ─────────────────────────────────────────────

agentsApi.get("/:agentId/secrets", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const secrets = await listSecrets(agentId, user.id);
  return c.json({
    secrets: secrets.map((s) => ({
      id: s.id,
      key: s.key,
      description: s.description,
      service: s.service,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
    })),
  });
});

agentsApi.post("/:agentId/secrets", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const body = await c.req.json<{
    key: string;
    value: string;
    description?: string;
    service?: string;
  }>();

  if (!body.key || !body.value) {
    return c.json({ error: "key and value required" }, 400);
  }

  try {
    const secret = await upsertSecret(agentId, user.id, {
      key: body.key,
      value: body.value,
      description: body.description,
      service: body.service,
    });
    return c.json({ secret: { id: secret.id, key: secret.key } }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

agentsApi.delete("/:agentId/secrets/:secretId", async (c) => {
  const user = c.get("user");
  const { agentId, secretId } = c.req.param();
  const ok = await deleteSecret(agentId, user.id, secretId);
  if (!ok) return c.json({ error: "Secret not found" }, 404);
  return c.json({ status: "ok" });
});

// ── Structured State — Phase 4 S1 (read/write via web UI) ────────────

agentsApi.get("/:agentId/state", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();

  const [agent] = await db
    .select({ state: agents.state })
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);
  return c.json({ state: (agent.state as Record<string, unknown> | null) ?? {} });
});

agentsApi.put("/:agentId/state", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();
  const body = await c.req.json<{ state: Record<string, unknown> }>();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  await db
    .update(agents)
    .set({ state: body.state ?? {}, updatedAt: new Date() })
    .where(eq(agents.id, agent.id));

  return c.json({ status: "ok" });
});

export default agentsApi;
