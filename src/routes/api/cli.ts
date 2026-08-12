/**
 * CLI Callback API
 *
 * Endpoints called by Claude Code CLI running inside Mags VMs.
 * Auth: X-CLI-API-Key header matched against profiles.cliApiKey.
 *
 * POST /api/v1/cli/tasks/bulk/          — update todo task statuses
 * POST /api/v1/cli/status/              — update ticket execution status
 * POST /api/v1/cli/tech-stack/          — register detected tech stack
 * POST /api/v1/cli/request-input/       — ask user a question (returns answer)
 * POST /api/v1/cli/ticket-chat/         — receive chat message for ticket agent
 */

import { Hono } from "hono";
import { db } from "../../config/db.ts";
import { projectTickets, projectTodoLists, ticketLogs } from "../../db/schema/tickets.ts";
import { sandboxes } from "../../db/schema/sandbox.ts";
import { projects } from "../../db/schema/projects.ts";
import { profiles } from "../../db/schema/users.ts";
import { instantApps } from "../../db/schema/instant.ts";
import { eq, and } from "drizzle-orm";
import { emit } from "../../events/bus.ts";
import { parseJsonlEvents, extractSessionId, isStreamComplete } from "../../services/claude-cli.ts";
import { addLog, attachLogOutput, formatToolUse } from "../../services/ticket-logs.ts";
import { describePiTool, describePiLine, noteBuildActivity } from "../../services/pi-cli.ts";
import { broadcastInstantStatus } from "../../services/instant-app.ts";

export const cliRouter = new Hono<{ Variables: { cliUserId: string } }>();

// The still-growing Pi label per ticket, held between POST batches so a message
// streamed across several POSTs is logged ONCE (flushed when a different label
// arrives or the run signals done) instead of once per batch.
const _piPending = new Map<string, string>();

// tool_use.id → the command log row it created, held between POST batches so a
// tool_result arriving in a LATER batch can be folded into its command's row
// (`${ticketId}:${toolUseId}` → logId). Bounded: entries are deleted on match.
const _toolUseLog = new Map<string, string>();

// ── Auth middleware ───────────────────────────────────────────────────

cliRouter.use("*", async (c, next) => {
  const apiKey = c.req.header("X-CLI-API-Key");
  if (!apiKey) {
    return c.json({ error: "Missing X-CLI-API-Key header" }, 401);
  }

  // Look up the profile that owns this key
  const [profile] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.cliApiKey, apiKey))
    .limit(1);

  if (!profile) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Scope every request to the key's owner so handlers can enforce that the
  // body-supplied ticket_id/app_id actually belongs to this user (prevents IDOR:
  // a valid key must not be able to read/mutate another user's tickets by id).
  c.set("cliUserId", profile.userId);

  await next();
});

// Ownership guard: resolve ticket → project → owner and confirm it matches the
// authenticated CLI user. Returns false for both "not found" and "not yours" so
// we never leak the existence of another user's ticket.
async function ticketOwnedBy(ticketId: string, userId: string): Promise<boolean> {
  if (!ticketId || !userId) return false;
  const [row] = await db
    .select({ ownerId: projects.ownerId })
    .from(projectTickets)
    .innerJoin(projects, eq(projectTickets.projectId, projects.id))
    .where(eq(projectTickets.id, ticketId))
    .limit(1);
  return !!row && row.ownerId === userId;
}

// ── POST /api/v1/cli/tasks/create/ ────────────────────────────────────

cliRouter.post("/tasks/create", async (c) => {
  const body = await c.req.json<{
    ticket_id: string;
    tasks: Array<{
      description: string;
      status?: string;
    }>;
  }>();

  const { ticket_id, tasks } = body;
  if (!ticket_id || !Array.isArray(tasks) || tasks.length === 0) {
    return c.json({ error: "ticket_id and tasks array required" }, 400);
  }
  if (!(await ticketOwnedBy(ticket_id, c.get("cliUserId")))) {
    return c.json({ error: "Ticket not found" }, 404);
  }

  // Get max existing order
  const existingTasks = await db
    .select({ order: projectTodoLists.order })
    .from(projectTodoLists)
    .where(eq(projectTodoLists.ticketId, ticket_id));

  let nextOrder = existingTasks.length > 0
    ? Math.max(...existingTasks.map((t) => t.order)) + 1
    : 0;

  const created: Array<{ id: string; description: string }> = [];
  for (const task of tasks) {
    if (!task.description?.trim()) continue;
    const [row] = await db
      .insert(projectTodoLists)
      .values({
        ticketId: ticket_id,
        description: task.description.trim(),
        status: task.status ?? "pending",
        order: nextOrder++,
      })
      .returning();
    if (row) created.push({ id: row.id, description: row.description });
  }

  // Broadcast task update event
  emit({ type: "ticket.tasks_updated", ticketId: ticket_id, taskIds: created.map((t) => t.id) });

  return c.json({ created }, 201);
});

// ── POST /api/v1/cli/tasks/bulk/ ──────────────────────────────────────

cliRouter.post("/tasks/bulk", async (c) => {
  const body = await c.req.json<{
    ticket_id: string;
    tasks: Array<{
      id: string;
      status: string;
      explanation?: string;
    }>;
  }>();

  const { ticket_id, tasks } = body;
  if (!ticket_id || !Array.isArray(tasks)) {
    return c.json({ error: "ticket_id and tasks required" }, 400);
  }
  if (!(await ticketOwnedBy(ticket_id, c.get("cliUserId")))) {
    return c.json({ error: "Ticket not found" }, 404);
  }

  const updated: string[] = [];
  for (const task of tasks) {
    if (!task.id || !task.status) continue;

    await db
      .update(projectTodoLists)
      .set({
        status: task.status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectTodoLists.id, task.id),
          eq(projectTodoLists.ticketId, ticket_id)
        )
      );

    updated.push(task.id);
  }

  // Broadcast task update event
  emit({ type: "ticket.tasks_updated", ticketId: ticket_id, taskIds: updated });

  return c.json({ updated });
});

// ── POST /api/v1/cli/status/ ──────────────────────────────────────────

cliRouter.post("/status", async (c) => {
  const body = await c.req.json<{
    ticket_id: string;
    status: string;   // in_progress | complete | failed
    message?: string;
  }>();

  const { ticket_id, status, message } = body;
  if (!ticket_id || !status) {
    return c.json({ error: "ticket_id and status required" }, 400);
  }
  if (!(await ticketOwnedBy(ticket_id, c.get("cliUserId")))) {
    return c.json({ error: "Ticket not found" }, 404);
  }

  // Map CLI status to ticket status
  const ticketStatus =
    status === "complete" ? "done" :
    status === "failed" ? "failed" :
    "in_progress";

  await db
    .update(projectTickets)
    .set({
      status: ticketStatus,
      queueStatus: status === "in_progress" ? "executing" : "none",
      updatedAt: new Date(),
    })
    .where(eq(projectTickets.id, ticket_id));

  // Log status message
  if (message) {
    await db.insert(ticketLogs).values({
      ticketId: ticket_id,
      logType: "command",
      command: `Status: ${status}`,
      explanation: message,
    });
  }

  emit({
    type: "ticket.status_changed",
    ticketId: ticket_id,
    status: ticketStatus,
    message,
  });

  return c.json({ ok: true });
});

// ── POST /api/v1/cli/tech-stack/ ─────────────────────────────────────

cliRouter.post("/tech-stack", async (c) => {
  const body = await c.req.json<{
    ticket_id: string;
    language?: string;
    framework?: string;
    package_manager?: string;
    start_command?: string;
    build_command?: string;
    port?: number;
  }>();

  const { ticket_id, ...stackFields } = body;
  if (!ticket_id) {
    return c.json({ error: "ticket_id required" }, 400);
  }
  if (!(await ticketOwnedBy(ticket_id, c.get("cliUserId")))) {
    return c.json({ error: "Ticket not found" }, 404);
  }

  // Get the ticket to find its sandbox
  const [ticket] = await db
    .select()
    .from(projectTickets)
    .where(eq(projectTickets.id, ticket_id))
    .limit(1);

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  // Update sandbox tech stack
  const techStack = {
    language: stackFields.language,
    framework: stackFields.framework,
    packageManager: stackFields.package_manager,
    startCommand: stackFields.start_command,
    buildCommand: stackFields.build_command,
    port: stackFields.port,
  };

  await db
    .update(sandboxes)
    .set({ techStack, updatedAt: new Date() })
    .where(eq(sandboxes.ticketId, ticket_id));

  // Also save the stack identifier to the project for future executions
  if (stackFields.framework || stackFields.language) {
    const stackLabel = stackFields.framework || stackFields.language || "";
    await db
      .update(projects)
      .set({ stack: stackLabel, updatedAt: new Date() })
      .where(eq(projects.id, ticket.projectId));
  }

  return c.json({ ok: true });
});

// ── POST /api/v1/cli/request-input/ ──────────────────────────────────

/**
 * The CLI blocks here waiting for the user to respond.
 * We emit a WS event to the user and long-poll for the answer.
 * Timeout: 5 minutes.
 */
cliRouter.post("/request-input", async (c) => {
  const body = await c.req.json<{
    ticket_id: string;
    question: string;
    options?: string[];
  }>();

  const { ticket_id, question, options } = body;
  if (!ticket_id || !question) {
    return c.json({ error: "ticket_id and question required" }, 400);
  }
  if (!(await ticketOwnedBy(ticket_id, c.get("cliUserId")))) {
    return c.json({ error: "Ticket not found" }, 404);
  }

  // Look up ticket owner for WS broadcast
  const [inputTicket] = await db.select({ projectId: projectTickets.projectId })
    .from(projectTickets).where(eq(projectTickets.id, ticket_id)).limit(1);
  const [inputProject] = await db.select({ ownerId: projects.ownerId })
    .from(projects).where(eq(projects.id, inputTicket!.projectId)).limit(1);
  const inputOwnerId = inputProject?.ownerId;

  // Emit WS event so the UI can show the question to the user
  emit({
    type: "ticket.input_requested",
    ticketId: ticket_id,
    question,
    options,
  });

  // Log as "question" type (broadcasts via WS automatically through addLog)
  await addLog(ticket_id, question, "question", inputOwnerId);

  // Emit needs_attention for orchestrator consumption
  emit({
    type: "ticket.needs_attention",
    ticketId: ticket_id,
    reason: "input_requested",
    question,
  });

  // Long-poll for answer stored via the ticket-chat endpoint
  // Max wait: 5 minutes (300s)
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const [ticket] = await db
      .select({ inputResponse: projectTickets.notes })
      .from(projectTickets)
      .where(eq(projectTickets.id, ticket_id))
      .limit(1);

    // Check if user responded (we'll store the answer in a special field)
    // For now use a simple marker pattern in notes — TODO: dedicated field
    const notes = ticket?.inputResponse ?? "";
    const marker = `INPUT_RESPONSE:${ticket_id}:`;
    const idx = notes.lastIndexOf(marker);
    if (idx !== -1) {
      const answer = notes.slice(idx + marker.length).split("\n")[0];
      // Clear the marker
      await db
        .update(projectTickets)
        .set({ notes: notes.slice(0, idx).trim(), updatedAt: new Date() })
        .where(eq(projectTickets.id, ticket_id));
      return c.json({ answer });
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  return c.json({ answer: "timeout — no response" }, 408);
});

// ── POST /api/v1/cli/ticket-chat/ ────────────────────────────────────

/**
 * Called when a user/orchestrator sends a message to the ticket agent.
 * Stores the message as a log entry and triggers executeTicketChat().
 */
cliRouter.post("/ticket-chat", async (c) => {
  const body = await c.req.json<{
    ticket_id: string;
    message: string;
    sender?: string; // "user" | "orchestrator"
  }>();

  const { ticket_id, message, sender = "user" } = body;
  if (!ticket_id || !message) {
    return c.json({ error: "ticket_id and message required" }, 400);
  }
  if (!(await ticketOwnedBy(ticket_id, c.get("cliUserId")))) {
    return c.json({ error: "Ticket not found" }, 404);
  }

  await db.insert(ticketLogs).values({
    ticketId: ticket_id,
    logType: "user_message",
    command: message,
    explanation: `Message from ${sender}`,
  });

  // Trigger the chat executor (fire-and-forget)
  emit({ type: "ticket.chat_message", ticketId: ticket_id, message, sender });

  return c.json({ ok: true });
});

// ── POST /api/v1/cli/output/ ──────────────────────────────────────────

/**
 * Receives pushed JSONL output chunks from the VM forwarder loop.
 * Decodes base64 data, parses JSONL events, logs to DB, broadcasts via WS.
 * When done=true, emits ticket.execution_finished event.
 */
cliRouter.post("/output", async (c) => {
  let body: { ticket_id: string; data: string; done?: boolean; exit_code?: number };
  try {
    body = await c.req.json();
  } catch (err) {
    console.error("[cli/output] JSON parse error:", (err as Error).message);
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { ticket_id, data, done, exit_code } = body;
  if (!ticket_id || (data == null && !done)) {
    return c.json({ error: "ticket_id and data required" }, 400);
  }
  if (!(await ticketOwnedBy(ticket_id, c.get("cliUserId")))) {
    return c.json({ error: "Ticket not found" }, 404);
  }

  // Proof-of-life: the VM just delivered build output, so it's alive AND producing
  // work — streamPiToCompletion uses this so a flaky poll exec never fails a live build.
  noteBuildActivity(ticket_id);

  // Look up ticket owner (userId) for WS broadcasting
  const [ticket] = await db
    .select({ id: projectTickets.id, projectId: projectTickets.projectId })
    .from(projectTickets)
    .where(eq(projectTickets.id, ticket_id))
    .limit(1);

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, ticket.projectId))
    .limit(1);

  const ownerId = project?.ownerId;

  // Decode base64 chunk
  let rawText: string;
  try {
    rawText = data ? Buffer.from(data, "base64").toString("utf-8") : "";
  } catch {
    return c.json({ error: "Invalid base64 data" }, 400);
  }

  // Parse JSONL events. This endpoint receives BOTH Claude CLI JSONL (Claude Code
  // path) AND Pi JSONL (DeepSeek/Pi ticket builds) — the two formats differ, so we
  // try Claude parsing first and fall back to a Pi-aware per-line parser. `logged`
  // tracks whether anything was surfaced so the fallback only runs when needed.
  const events = parseJsonlEvents(rawText);
  let logged = 0;

  if (events.length > 0) {
    // Extract session ID if present — save to sandbox
    const sessionId = extractSessionId(events);
    if (sessionId) {
      await db
        .update(sandboxes)
        .set({ cliSessionId: sessionId, updatedAt: new Date() })
        .where(eq(sandboxes.ticketId, ticket_id));
    }

    // Log each event to DB + WS
    for (const ev of events) {
      try {
        const msg = (ev as any).message;
        const content = Array.isArray(msg?.content) ? msg.content : [];

        if (ev.type === "assistant") {
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              await addLog(ticket_id, block.text, "ai_response", ownerId); logged++;
            } else if (block.type === "tool_use" && block.name) {
              const toolMsg = formatToolUse(block.name, block.input ?? {});
              const logId = await addLog(ticket_id, toolMsg, "command", ownerId); logged++;
              // Remember which row this tool_use created so its tool_result (below,
              // possibly in a later POST) folds into THIS row instead of a new one.
              if (block.id && logId) _toolUseLog.set(ticket_id + ":" + block.id, logId);
            }
          }
        } else if (ev.type === "user") {
          for (const block of content) {
            if (block.type === "tool_result") {
              // content can be a string or array of content blocks
              const text = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((b: any) => b.text ?? "").join("\n")
                  : "";
              // Fold the output into its command's row (paired by tool_use_id) —
              // one collapsible command→output entry, no second disconnected line.
              const key = ticket_id + ":" + (block.tool_use_id ?? "");
              const cmdLogId = block.tool_use_id ? _toolUseLog.get(key) : undefined;
              if (cmdLogId) {
                await attachLogOutput(cmdLogId, text, ticket_id, ownerId); logged++;
                _toolUseLog.delete(key);
              } else if (text.length > 50) {
                // No correlation (missing id) → fall back to a standalone row.
                await addLog(ticket_id, text.slice(0, 500), "command", ownerId); logged++;
              }
            }
          }
        } else if (ev.type === "result") {
          // Skip logging result text — same content already logged from the
          // final assistant message. Only log if it's an error subtype.
        } else if (ev.type === "error") {
          const errMsg = (ev as { type: "error"; error: string }).error;
          await addLog(ticket_id, `CLI error: ${errMsg}`, "cli_error", ownerId); logged++;
        }
      } catch (err) {
        console.error(`[cli/output] Error processing event type=${ev.type}:`, err);
      }
    }
  }

  // Pi format (or anything the Claude parser didn't surface): parse each line with
  // the Pi-aware describer so DeepSeek/Pi ticket builds stream real output.
  if (logged === 0 && rawText.trim()) {
    // Pi's --mode json streams each tool call AND each reasoning line token by
    // token, so one action arrives as a run of GROWING-PREFIX labels — "Running
    // grep", "Running grep -", "Running grep -A20"…, or "Reading /", "Reading
    // /data", "Reading /data/project"…, or the same assistant sentence growing a
    // word at a time. Exact-dedup misses these (each label differs). Collapse:
    // emit a label only when the NEXT one does NOT extend it (i.e. it's final),
    // then also drop exact repeats across POST batches (via _lastPiLabel).
    const labels: string[] = [];
    for (const line of rawText.split("\n")) {
      try { const l = describePiLine(line); if (l) labels.push(l); } catch { /* skip a bad line */ }
    }
    const norm = (s: string) => s.replace(/…+$/, "").trimEnd();
    // 1) Within-batch: collapse a growing-prefix run to its final (longest) label.
    const collapsed: string[] = [];
    for (let i = 0; i < labels.length; i++) {
      const cur = labels[i]!;
      const next = labels[i + 1];
      if (next && norm(next).startsWith(norm(cur))) continue; // superseded by the next chunk
      collapsed.push(cur);
    }
    // 2) ACROSS batches: the same streamed message (esp. a long assistant summary)
    // arrives split over several POSTs, so within-batch collapse can't catch it.
    // Hold the growing label as "pending" and only emit it when a DIFFERENT label
    // arrives (or on `done`) — so one message logs once, not once per POST.
    let pending = _piPending.get(ticket_id) ?? "";
    for (const cur of collapsed) {
      if (pending && (norm(cur).startsWith(norm(pending)) || norm(pending).startsWith(norm(cur)))) {
        if (norm(cur).length >= norm(pending).length) pending = cur; // same stream → keep longest
        continue;
      }
      if (pending) { await addLog(ticket_id, pending, "command", ownerId); logged++; }
      pending = cur;
    }
    if (done && pending) { await addLog(ticket_id, pending, "command", ownerId); logged++; pending = ""; }
    if (pending) _piPending.set(ticket_id, pending); else _piPending.delete(ticket_id);
    // Truly opaque non-JSON output (stderr) — surface it rather than drop it.
    if (labels.length === 0) {
      const plain = rawText.trim();
      if (plain && !plain.startsWith("{")) await addLog(ticket_id, plain.slice(0, 1000), "cli_error", ownerId);
    }
  }

  // If VM signals completion, emit the event
  if (done) {
    emit({
      type: "ticket.execution_finished",
      ticketId: ticket_id,
      status: exit_code === 0 ? "complete" : "failed",
      exitCode: exit_code,
      projectId: ticket?.projectId,
    });
  }

  return c.json({ ok: true });
});

// ── POST /api/v1/cli/instant-progress ─────────────────────────────────
// Live build-activity stream from the in-VM Pi forwarder. The forwarder parses Pi's
// --mode json output and POSTs compact tool-call ops here in real time; we turn each
// into a human label and broadcast it to the user's Instant build log.
// Body: { app_id, ops: [{ n: toolName, p: path|null, c: command|null }] }
cliRouter.post("/instant-progress", async (c) => {
  // The auth middleware already verified the X-CLI-API-Key; resolve the owning user.
  const apiKey = c.req.header("X-CLI-API-Key")!;
  const [profile] = await db
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.cliApiKey, apiKey))
    .limit(1);
  if (!profile) return c.json({ error: "Invalid API key" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    app_id?: string;
    ops?: Array<{ n?: string; p?: string | null; c?: string | null }>;
  };
  const appId = body.app_id;
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (!appId || ops.length === 0) return c.json({ ok: true });

  const [app] = await db
    .select({
      appId: instantApps.appId,
      name: instantApps.name,
      conversationId: instantApps.conversationId,
      userId: instantApps.userId,
    })
    .from(instantApps)
    .where(eq(instantApps.appId, appId))
    .limit(1);
  if (!app || app.userId !== profile.userId) return c.json({ error: "app not found" }, 404);

  for (const op of ops) {
    const message = describePiTool(String(op.n ?? ""), { path: op.p ?? undefined, command: op.c ?? undefined });
    void broadcastInstantStatus({
      userId: app.userId,
      conversationId: app.conversationId,
      appId: app.appId,
      appName: app.name,
      status: "building",
      message,
    });
  }
  return c.json({ ok: true });
});
