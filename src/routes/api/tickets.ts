import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { projects } from "../../db/schema/projects.ts";
import { ticketStages, projectTickets, ticketLogs, projectTodoLists, ticketMergeHistory, ticketAddenda } from "../../db/schema/tickets.ts";
import { like, or } from "drizzle-orm";
import { githubTokens } from "../../db/schema/users.ts";
import { sandboxes } from "../../db/schema/sandbox.ts";
import { conversations } from "../../db/schema/chat.ts";
import { instantApps } from "../../db/schema/instant.ts";
import { eq, and, asc, desc, max, notExists } from "drizzle-orm";
import { getProjectAccess, requirePermission } from "../../auth/project-access.ts";
import { nextTicketKey } from "../../utils/ticket-keys.ts";
import { notify } from "../../services/notify.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const ticketsApi = new Hono<AuthEnv>();
ticketsApi.use("*", requireAuth);

// ── GET /api/projects/:projectId/tickets ────────────────────────────
ticketsApi.get("/:projectId/tickets", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const rows = await db
    .select()
    .from(projectTickets)
    .where(eq(projectTickets.projectId, project.id))
    .orderBy(asc(projectTickets.createdAt));

  return c.json({ tickets: rows });
});

// ── POST /api/projects/:projectId/tickets ────────────────────────────
ticketsApi.post("/:projectId/tickets", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const body = await c.req.json<{
    name: string;
    description: string;
    priority?: string;
    stageId?: string;
    complexity?: string;
    assigneeId?: string | null;
  }>();

  if (!body.name || !body.description) {
    return c.json({ error: "name and description are required" }, 400);
  }

  // Default to Backlog stage if none provided
  let stageId = body.stageId ?? null;
  if (!stageId) {
    const [backlog] = await db
      .select({ id: ticketStages.id })
      .from(ticketStages)
      .where(and(eq(ticketStages.projectId, project.id), eq(ticketStages.name, "Backlog")))
      .limit(1);
    stageId = backlog?.id ?? null;
  }

  const ticketKey = await nextTicketKey(project.id, project.name);

  const [ticket] = await db
    .insert(projectTickets)
    .values({
      projectId: project.id,
      ticketKey,
      name: body.name,
      description: body.description,
      priority: body.priority ?? "Medium",
      stageId,
      complexity: body.complexity ?? "medium",
      assigneeId: body.assigneeId || null,
    })
    .returning();

  // Notify the assignee (if someone other than the creator).
  if (ticket && body.assigneeId) {
    await notify({
      userId: body.assigneeId,
      actorId: user.id,
      projectId: project.projectId,
      type: "assigned",
      targetType: "ticket",
      targetId: ticket.id,
      message: `${user.name || "Someone"} assigned you a ticket: "${ticket.name}"`,
      link: `/projects/${project.projectId}/tickets`,
    });
  }

  return c.json({ ticket }, 201);
});

// ── GET /api/projects/:projectId/tickets/:ticketId ───────────────────
ticketsApi.get("/:projectId/tickets/:ticketId", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [ticket] = await db
    .select()
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId!), eq(projectTickets.projectId, project.id)));

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  const logs = await db
    .select()
    .from(ticketLogs)
    .where(eq(ticketLogs.ticketId, ticket.id))
    .orderBy(desc(ticketLogs.createdAt))
    .limit(50);

  return c.json({ ticket, logs });
});

// ── PATCH /api/projects/:projectId/tickets/:ticketId ─────────────────
ticketsApi.patch("/:projectId/tickets/:ticketId", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [existing] = await db
    .select({ id: projectTickets.id })
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId!), eq(projectTickets.projectId, project.id)));

  if (!existing) return c.json({ error: "Ticket not found" }, 404);

  const body = await c.req.json<Partial<{
    name: string;
    description: string;
    status: string;
    priority: string;
    stageId: string | null;
    complexity: string;
    queueStatus: string;
    notes: string;
    assigneeId: string | null;
  }>>();

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updateData.name = body.name;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.status !== undefined) updateData.status = body.status;
  if (body.priority !== undefined) updateData.priority = body.priority;
  if ("stageId" in body) updateData.stageId = body.stageId;
  if (body.complexity !== undefined) updateData.complexity = body.complexity;
  if (body.queueStatus !== undefined) updateData.queueStatus = body.queueStatus;
  if (body.notes !== undefined) updateData.notes = body.notes;
  if ("assigneeId" in body) updateData.assigneeId = body.assigneeId || null;

  const [updated] = await db
    .update(projectTickets)
    .set(updateData)
    .where(eq(projectTickets.id, existing.id))
    .returning();

  // Notify on (re)assignment to a different person.
  if ("assigneeId" in body && body.assigneeId) {
    await notify({
      userId: body.assigneeId,
      actorId: user.id,
      projectId: project.projectId,
      type: "assigned",
      targetType: "ticket",
      targetId: existing.id,
      message: `${user.name || "Someone"} assigned you a ticket: "${updated?.name ?? ""}"`,
      link: `/projects/${project.projectId}/tickets`,
    });
  }

  return c.json({ ticket: updated });
});

// ── DELETE /api/projects/:projectId/tickets/:ticketId ────────────────
ticketsApi.delete("/:projectId/tickets/:ticketId", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [existing] = await db
    .select({ id: projectTickets.id })
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId!), eq(projectTickets.projectId, project.id)));

  if (!existing) return c.json({ error: "Ticket not found" }, 404);

  await db.delete(projectTickets).where(eq(projectTickets.id, existing.id));
  return c.json({ success: true });
});

// ── GET /api/projects/:projectId/stages ──────────────────────────────
ticketsApi.get("/:projectId/stages", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const rows = await db
    .select()
    .from(ticketStages)
    .where(eq(ticketStages.projectId, project.id))
    .orderBy(asc(ticketStages.order));

  return c.json({ stages: rows });
});

// ── PATCH /api/projects/:projectId/tickets/:ticketId/stage ────────────
ticketsApi.patch("/:projectId/tickets/:ticketId/stage", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [existing] = await db
    .select({ id: projectTickets.id })
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId!), eq(projectTickets.projectId, project.id)));

  if (!existing) return c.json({ error: "Ticket not found" }, 404);

  const { stageId } = await c.req.json<{ stageId: string | null }>();

  const [updated] = await db
    .update(projectTickets)
    .set({ stageId: stageId ?? null, updatedAt: new Date() })
    .where(eq(projectTickets.id, existing.id))
    .returning();

  return c.json({ ticket: updated });
});

// ── GET /api/projects/:projectId/conversations/ ──────────────────────
ticketsApi.get("/:projectId/conversations", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json([], 200);
  const project = access.project;

  // Exclude conversations that belong to instant apps
  const convRows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.projectId, project.projectId),
        notExists(
          db.select({ id: instantApps.id }).from(instantApps)
            .where(eq(instantApps.conversationId, conversations.id))
        )
      )
    )
    .orderBy(desc(conversations.updatedAt));

  return c.json(
    convRows.map((c) => ({
      id: c.id,
      title: c.title ?? "Untitled",
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    }))
  );
});

// Trailing slash variant
ticketsApi.get("/:projectId/conversations/", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json([], 200);
  const project = access.project;

  // Exclude conversations that belong to instant apps
  const convRows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.projectId, project.projectId),
        notExists(
          db.select({ id: instantApps.id }).from(instantApps)
            .where(eq(instantApps.conversationId, conversations.id))
        )
      )
    )
    .orderBy(desc(conversations.updatedAt));

  return c.json(
    convRows.map((c) => ({
      id: c.id,
      title: c.title ?? "Untitled",
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    }))
  );
});

// ── GET /:projectId/tickets/:ticketId/logs ──────────────────────────
// Returns ticket execution logs (command + ai_response + user_message)

ticketsApi.get("/:projectId/tickets/:ticketId/logs", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  const project = access.project;

  // Most-recent 500 (desc + limit), then flip back to chronological order. Using
  // ASC+limit returned the OLDEST 500, so on a chatty ticket the user's latest
  // message + latest activity fell off the end and never rendered.
  const logs = await db
    .select()
    .from(ticketLogs)
    .where(eq(ticketLogs.ticketId, ticketId))
    .orderBy(desc(ticketLogs.createdAt))
    .limit(500);

  return c.json(logs.reverse().map((l) => ({
    id: l.id,
    type: l.logType,
    message: l.command,
    explanation: l.explanation,
    createdAt: l.createdAt,
  })));
});

// ── GET /:projectId/tickets/:ticketId/tasks ─────────────────────────

ticketsApi.get("/:projectId/tickets/:ticketId/tasks", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  const project = access.project;

  const tasks = await db
    .select()
    .from(projectTodoLists)
    .where(eq(projectTodoLists.ticketId, ticketId))
    .orderBy(projectTodoLists.order);

  return c.json(tasks);
});

// ── POST /:projectId/tickets/:ticketId/tasks ────────────────────────
// Create task(s) for a ticket

ticketsApi.post("/:projectId/tickets/:ticketId/tasks", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [ticket] = await db
    .select({ id: projectTickets.id })
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId), eq(projectTickets.projectId, project.id)));

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  const body = await c.req.json<{
    tasks: Array<{ description: string; order?: number }>;
  }>();

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return c.json({ error: "tasks array is required" }, 400);
  }

  // Get max existing order
  const [maxRow] = await db
    .select({ maxOrder: max(projectTodoLists.order) })
    .from(projectTodoLists)
    .where(eq(projectTodoLists.ticketId, ticketId));

  let nextOrder = (maxRow?.maxOrder ?? -1) + 1;

  const created = [];
  for (const task of body.tasks) {
    if (!task.description?.trim()) continue;
    const order = task.order ?? nextOrder++;
    const [row] = await db
      .insert(projectTodoLists)
      .values({
        ticketId,
        description: task.description.trim(),
        status: "pending",
        order,
      })
      .returning();
    if (row) created.push({ id: row.id, description: row.description, status: row.status, order: row.order });
  }

  // Emit event
  const { emit } = await import("../../events/bus.ts");
  emit({ type: "ticket.tasks_updated", ticketId, taskIds: created.map((t) => t.id) });

  return c.json({ created }, 201);
});

// ── PATCH /:projectId/tickets/:ticketId/tasks/:taskId ───────────────

ticketsApi.patch("/:projectId/tickets/:ticketId/tasks/:taskId", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId, taskId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  // Verify ticket belongs to project
  const [ticket] = await db
    .select({ id: projectTickets.id })
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId), eq(projectTickets.projectId, project.id)));

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  const [existing] = await db
    .select({ id: projectTodoLists.id })
    .from(projectTodoLists)
    .where(and(eq(projectTodoLists.id, taskId), eq(projectTodoLists.ticketId, ticketId)));

  if (!existing) return c.json({ error: "Task not found" }, 404);

  const body = await c.req.json<Partial<{ description: string; status: string; order: number }>>();
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (body.description !== undefined) updateData.description = body.description;
  if (body.status !== undefined) updateData.status = body.status;
  if (body.order !== undefined) updateData.order = body.order;

  const [updated] = await db
    .update(projectTodoLists)
    .set(updateData)
    .where(eq(projectTodoLists.id, taskId))
    .returning();

  return c.json({ task: updated });
});

// ── DELETE /:projectId/tickets/:ticketId/tasks/:taskId ──────────────

ticketsApi.delete("/:projectId/tickets/:ticketId/tasks/:taskId", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId, taskId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [ticket] = await db
    .select({ id: projectTickets.id })
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId), eq(projectTickets.projectId, project.id)));

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  const [existing] = await db
    .select({ id: projectTodoLists.id })
    .from(projectTodoLists)
    .where(and(eq(projectTodoLists.id, taskId), eq(projectTodoLists.ticketId, ticketId)));

  if (!existing) return c.json({ error: "Task not found" }, 404);

  await db.delete(projectTodoLists).where(eq(projectTodoLists.id, taskId));
  return c.json({ success: true });
});

// ── POST /:projectId/tickets/:ticketId/chat ─────────────────────────
// User sends a chat message to the ticket agent

ticketsApi.post("/:projectId/tickets/:ticketId/chat", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  const project = access.project;

  const body = await c.req.json<{ message: string }>();
  if (!body.message?.trim()) return c.json({ error: "message required" }, 400);

  // Check if the agent is waiting for input (latest log is a "question")
  const [latestLog] = await db.select({ logType: ticketLogs.logType })
    .from(ticketLogs)
    .where(eq(ticketLogs.ticketId, ticketId!))
    .orderBy(desc(ticketLogs.createdAt))
    .limit(1);

  // Log user message
  await db.insert(ticketLogs).values({
    ticketId,
    logType: "user_message",
    command: body.message,
  });

  if (latestLog?.logType === "question") {
    // Agent is waiting for input — write INPUT_RESPONSE marker to notes
    // so the /request-input/ long-poll picks it up
    const marker = `INPUT_RESPONSE:${ticketId}:${body.message}`;
    const [ticket] = await db.select({ notes: projectTickets.notes })
      .from(projectTickets).where(eq(projectTickets.id, ticketId!)).limit(1);
    await db.update(projectTickets).set({
      notes: (ticket?.notes ?? "") + "\n" + marker,
      updatedAt: new Date(),
    }).where(eq(projectTickets.id, ticketId!));
  } else {
    // Normal chat — dispatch to executor for new/resumed CLI session
    const { bus } = await import("../../events/bus.ts");
    bus.emit({ type: "ticket.chat_message", payload: { ticketId, message: body.message, sender: "user" } });
  }

  return c.json({ ok: true });
});

// ── POST /:projectId/tickets/:ticketId/chat/upload ──────────────────
// Upload a file for the ticket agent. FAST + reliable: store to S3 once (not a
// slow chunked base64 stream over dozens of VM round-trips), return a render URL
// for the chat, and — if the ticket has a live sandbox — pull it into the VM at
// /data/uploads/<name> with a SINGLE curl so the agent can read it.
ticketsApi.post("/:projectId/tickets/:ticketId/chat/upload", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);

  const body = await c.req.parseBody();
  const file = body["file"] as File | undefined;
  if (!file) return c.json({ error: "No file provided" }, 400);
  if (file.size > 25 * 1024 * 1024) return c.json({ error: "File too large (max 25 MB)." }, 400);

  const { isS3Enabled, buildS3Key, uploadBinary, getPresignedGetUrl, guessContentType } = await import("../../services/s3.ts");
  if (!isS3Enabled) return c.json({ error: "File storage (S3) isn't configured." }, 503);

  const safeName = (file.name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 80) || "file";
  const contentType = file.type || guessContentType(file.name);
  const isImage = /^image\//.test(contentType);
  const buf = Buffer.from(await file.arrayBuffer());

  // 1) Store to S3 (one call) + a durable presigned URL for rendering / VM pull.
  let url = "";
  try {
    const key = buildS3Key(projectId, "ticket-uploads", `${crypto.randomUUID().slice(0, 8)}-${safeName}`);
    await uploadBinary(key, buf, contentType);
    url = await getPresignedGetUrl(key, 7 * 24 * 3600);
  } catch (e) {
    return c.json({ error: `Upload failed: ${(e as Error).message}` }, 500);
  }

  // 2) If a live sandbox exists, pull the file in with ONE curl (fast, no chunking).
  let vmPath: string | null = null;
  const [sb] = await db.select({ ws: sandboxes.magsWorkspaceId })
    .from(sandboxes).where(eq(sandboxes.ticketId, ticketId!)).limit(1);
  if (sb?.ws) {
    const destPath = `/data/uploads/${crypto.randomUUID().slice(0, 8)}-${safeName}`;
    try {
      const { execOnWorkspace } = await import("../../services/mags.ts");
      const r = await execOnWorkspace(sb.ws, `mkdir -p /data/uploads && curl -fsSL -o '${destPath}' "${url}" && echo GOT $(wc -c < '${destPath}')`, { timeout: 60_000 });
      if (/GOT/.test(r.output)) vmPath = destPath;
    } catch { /* sandbox unreachable — still return the S3 url for rendering */ }
  }

  return c.json({ url, path: vmPath, name: file.name, isImage, inSandbox: !!vmPath });
});

// ── POST /:projectId/tickets/:ticketId/queue ────────────────────────
// Queue a ticket for execution

ticketsApi.post("/:projectId/tickets/:ticketId/queue", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  const project = access.project;

  const body = await c.req.json<{ notes?: string }>().catch(() => ({} as { notes?: string }));

  const [ticket] = await db
    .select()
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId), eq(projectTickets.projectId, project.id)))
    .limit(1);

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  await db
    .update(projectTickets)
    .set({ queueStatus: "queued", queuedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectTickets.id, ticketId));

  const { bus } = await import("../../events/bus.ts");
  bus.emit({ type: "ticket.queued", payload: { ticketId, projectId: project.id, notes: body.notes } });

  return c.json({ ok: true });
});

// ── GET /:projectId/tickets/:ticketId/sandbox ───────────────────────
// Get sandbox info (preview URL, status, branch)

ticketsApi.get("/:projectId/tickets/:ticketId/sandbox", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  const project = access.project;

  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticketId), eq(sandboxes.workspaceType, "ticket")))
    .limit(1);

  if (!sandbox) return c.json(null);

  return c.json({
    id: sandbox.id,
    status: sandbox.status,
    previewUrl: sandbox.previewUrl,
    previewPort: sandbox.previewPort,
    currentBranch: sandbox.currentBranch,
    techStack: sandbox.techStack,
    cliSessionId: sandbox.cliSessionId ? "active" : null,
  });
});

// ── POST /:projectId/tickets/:ticketId/preview ──────────────────────
// Start/restart dev server

ticketsApi.post("/:projectId/tickets/:ticketId/preview", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  const project = access.project;

  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticketId), eq(sandboxes.workspaceType, "ticket")))
    .limit(1);

  if (!sandbox) return c.json({ error: "No sandbox found for this ticket" }, 404);

  const body = await c.req.json<{ action?: string }>().catch(() => ({} as { action?: string }));
  const action = body.action ?? "start";

  const { startDevServer, restartDevServer, stopDevServer } = await import("../../services/preview.ts");

  try {
    if (action === "stop") {
      await stopDevServer(sandbox.id);
      return c.json({ ok: true });
    }
    const result = action === "restart"
      ? await restartDevServer(sandbox.id)
      : await startDevServer(sandbox.id);
    return c.json(result);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── POST /:projectId/tickets/:ticketId/stop ─────────────────────────
// Stop a running ticket build mid-execution (kills the in-VM Claude/Pi agent).
ticketsApi.post("/:projectId/tickets/:ticketId/stop", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  const { requestTicketStop } = await import("../../workers/ticket-executor.ts");
  await requestTicketStop(ticketId!, access.project.id);
  return c.json({ ok: true });
});

// ── POST /:projectId/tickets/:ticketId/demo ─────────────────────────
// (Re)generate the auto-demo recording for this ticket and surface it in Preview.
ticketsApi.post("/:projectId/tickets/:ticketId/demo", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  const project = access.project;

  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticketId!), eq(sandboxes.workspaceType, "ticket")))
    .limit(1);
  if (!sandbox?.magsWorkspaceId) return c.json({ error: "No sandbox for this ticket — build it first." }, 400);

  const { generateTicketDemo } = await import("../../services/ticket-demo.ts");
  // Fire-and-forget: the client listens for the `ticket_demo` ws event and reloads
  // the recording when it's ready.
  void generateTicketDemo(ticketId!, { ownerId: project.ownerId, projectId: project.id });
  return c.json({ ok: true, status: "running" });
});

// ── GET /:projectId/tickets/:ticketId/server-logs ────────────────────
// Poll live dev server logs from the VM
ticketsApi.get("/:projectId/tickets/:ticketId/server-logs", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Not found" }, 404);
  const project = access.project;

  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticketId), eq(sandboxes.workspaceType, "ticket")))
    .limit(1);

  if (!sandbox) return c.json({ lines: [], newOffset: 0 });

  const offset = Number(c.req.query("offset") ?? 0);
  const { getDevServerLogs } = await import("../../services/preview.ts");

  try {
    const result = await getDevServerLogs(sandbox.id, offset);
    return c.json(result);
  } catch (err) {
    return c.json({ lines: [], newOffset: offset, error: String(err) });
  }
});

// ── GET /:projectId/tickets/:ticketId/git/diff?base=main ────────────
// Diff the ticket's feature branch vs a base branch (for the Git-tab viewer).
ticketsApi.get("/:projectId/tickets/:ticketId/git/diff", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const base = c.req.query("base") || "main";
  const { getTicketDiff } = await import("../../services/dev-preview.ts");
  return c.json(await getTicketDiff(access.project.id, ticketId, base));
});

// ── POST /:projectId/tickets/:ticketId/git/create-pr ────────────────
// Create a GitHub PR for the ticket's feature branch

ticketsApi.post("/:projectId/tickets/:ticketId/git/create-pr", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [ticket] = await db
    .select()
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId), eq(projectTickets.projectId, project.id)));

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);
  if (!ticket.githubBranch) return c.json({ error: "No branch found for this ticket" }, 400);

  // Get GitHub token
  const [ghToken] = await db
    .select()
    .from(githubTokens)
    .where(eq(githubTokens.userId, user.id))
    .limit(1);

  if (!ghToken?.accessToken) return c.json({ error: "GitHub not connected" }, 400);

  // Extract owner/repo from project stack
  const repoUrl = getProjectRepo(project);
  if (!repoUrl) return c.json({ error: "No GitHub repo configured for this project" }, 400);

  const [, repoOwner, repoName] = repoUrl;

  const { createPullRequest } = await import("../../services/git.ts");

  try {
    const { prNumber, prUrl } = await createPullRequest({
      repoOwner: repoOwner!,
      repoName: repoName!,
      featureBranch: ticket.githubBranch,
      targetBranch: "lfg-agent",
      title: `feat: ${ticket.name}`,
      body: `Automated PR for ticket: ${ticket.name}`,
      githubToken: ghToken.accessToken,
    });

    await db
      .update(projectTickets)
      .set({
        githubPrUrl: prUrl,
        githubPrNumber: prNumber,
        githubMergeStatus: "pr_open",
        updatedAt: new Date(),
      })
      .where(eq(projectTickets.id, ticketId));

    return c.json({ prNumber, prUrl });
  } catch (err) {
    return c.json({ error: `PR creation failed: ${err}` }, 500);
  }
});

// ── POST /:projectId/tickets/:ticketId/git/merge ────────────────────
// Merge the ticket's open PR

ticketsApi.post("/:projectId/tickets/:ticketId/git/merge", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [ticket] = await db
    .select()
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId), eq(projectTickets.projectId, project.id)));

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);
  if (!ticket.githubPrNumber) return c.json({ error: "No PR found for this ticket" }, 400);

  // Get GitHub token
  const [ghToken] = await db
    .select()
    .from(githubTokens)
    .where(eq(githubTokens.userId, user.id))
    .limit(1);

  if (!ghToken?.accessToken) return c.json({ error: "GitHub not connected" }, 400);

  // Extract owner/repo
  const repoUrl = getProjectRepo(project);
  if (!repoUrl) return c.json({ error: "No GitHub repo configured" }, 400);

  const [, repoOwner, repoName] = repoUrl;

  const { mergePullRequest } = await import("../../services/git.ts");

  try {
    const { mergeCommitSha } = await mergePullRequest({
      repoOwner: repoOwner!,
      repoName: repoName!,
      prNumber: ticket.githubPrNumber,
      githubToken: ghToken.accessToken,
    });

    await db
      .update(projectTickets)
      .set({
        githubMergeStatus: "merged",
        githubMergeCommitSha: mergeCommitSha,
        updatedAt: new Date(),
      })
      .where(eq(projectTickets.id, ticketId));

    // Record merge history
    await db.insert(ticketMergeHistory).values({
      ticketId,
      action: "merged",
      mergeCommitSha,
      performedById: user.id,
      commitMessage: `feat: ${ticket.name}`,
    });

    return c.json({ mergeCommitSha });
  } catch (err) {
    await db
      .update(projectTickets)
      .set({ githubMergeStatus: "failed", updatedAt: new Date() })
      .where(eq(projectTickets.id, ticketId));

    return c.json({ error: `Merge failed: ${err}` }, 500);
  }
});

// ── POST /:projectId/tickets/:ticketId/git/push ─────────────────────
// Manually commit + push the sandbox code to GitHub

ticketsApi.post("/:projectId/tickets/:ticketId/git/push", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [ticket] = await db
    .select()
    .from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId), eq(projectTickets.projectId, project.id)));

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  // Get GitHub token
  const [ghToken] = await db
    .select()
    .from(githubTokens)
    .where(eq(githubTokens.userId, user.id))
    .limit(1);

  if (!ghToken?.accessToken) return c.json({ error: "GitHub not connected. Connect GitHub in Settings." }, 400);

  // Extract owner/repo
  const repoUrl = getProjectRepo(project);
  if (!repoUrl) return c.json({ error: "No GitHub repo configured for this project" }, 400);

  const [, repoOwner, repoName] = repoUrl;

  // Find sandbox
  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticketId), eq(sandboxes.workspaceType, "ticket")))
    .limit(1);

  if (!sandbox?.magsWorkspaceId) {
    return c.json({ error: "No active sandbox. Build the ticket first." }, 400);
  }

  const { commitAndPush, createPullRequest } = await import("../../services/git.ts");

  const featureBranch = ticket.githubBranch ?? `feature/ticket-${ticketId}`;

  try {
    const { sha } = await commitAndPush({
      workspaceId: sandbox.magsWorkspaceId,
      projectDir: "/data/project",
      commitMessage: `update: ${ticket.name}`,
      featureBranch,
      repoUrl: `https://github.com/${repoOwner}/${repoName}.git`,
      githubToken: ghToken.accessToken,
    });

    await db
      .update(projectTickets)
      .set({
        githubBranch: featureBranch,
        githubCommitSha: sha,
        updatedAt: new Date(),
      })
      .where(eq(projectTickets.id, ticketId));

    // Merge feature branch → lfg-agent (direct push)
    let mergeStatus = ticket.githubMergeStatus;
    try {
      const { mergeToLfgAgent } = await import("../../services/git.ts");
      const { sha: mergeSha } = await mergeToLfgAgent({
        workspaceId: sandbox.magsWorkspaceId,
        projectDir: "/data/project",
        featureBranch,
        repoUrl: `https://github.com/${repoOwner}/${repoName}.git`,
        githubToken: ghToken.accessToken,
      });
      mergeStatus = "merged";
      await db
        .update(projectTickets)
        .set({ githubMergeStatus: "merged", updatedAt: new Date() })
        .where(eq(projectTickets.id, ticketId));
    } catch (mergeErr) {
      console.warn(`[tickets] Merge to lfg-agent failed during push:`, mergeErr);
    }

    return c.json({ sha, branch: featureBranch, mergeStatus });
  } catch (err) {
    return c.json({ error: `Push failed: ${err}` }, 500);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract repo owner/name from project fields, falling back to parsing stack text.
 * Returns a regex match array [full, owner, name] or null.
 */
function getProjectRepo(project: { repoOwner?: string | null; repoName?: string | null; repoUrl?: string | null; stack?: string | null }) {
  if (project.repoOwner && project.repoName) {
    return [`https://github.com/${project.repoOwner}/${project.repoName}`, project.repoOwner, project.repoName];
  }
  const url = project.repoUrl ?? project.stack ?? "";
  return url.match(/https?:\/\/github\.com\/([^/]+)\/([^/.]+)/);
}

// ── GET /:projectId/ticket-mentions?q= ── @ticket autocomplete ──────
// Search tickets by key/name for the chat @ticket picker. NOTE the distinct path
// ("ticket-mentions", not "tickets/mentions") so it can't be shadowed by the
// earlier GET /:projectId/tickets/:ticketId route (which would match ":ticketId"
// = "mentions" and 404).
ticketsApi.get("/:projectId/ticket-mentions", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const q = (c.req.query("q") || "").trim();

  const rows = await db
    .select({ id: projectTickets.id, key: projectTickets.ticketKey, name: projectTickets.name, status: projectTickets.status, branch: projectTickets.githubBranch })
    .from(projectTickets)
    .where(and(
      eq(projectTickets.projectId, access.project.id),
      q ? or(like(projectTickets.ticketKey, `%${q}%`), like(projectTickets.name, `%${q}%`)) : undefined,
    ))
    .orderBy(desc(projectTickets.updatedAt))
    .limit(20);

  return c.json({
    tickets: rows.map((r) => ({
      id: r.id,
      ticketKey: r.key || "",
      name: r.name,
      status: r.status,
      branch: r.branch || `feature/ticket-${r.id}`,
      label: `${r.key ? r.key + " — " : ""}${r.name}`.slice(0, 70),
    })),
  });
});

// ── Ticket Addenda (follow-up change requests) ──────────────────────
// Resolve + authorize the ticket for an addendum request; returns null on failure.
async function addendumTicket(c: any): Promise<{ id: string } | null> {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();
  const access = await getProjectAccess(projectId, user.id);
  if (!access) return null;
  const [t] = await db.select({ id: projectTickets.id }).from(projectTickets)
    .where(and(eq(projectTickets.id, ticketId), eq(projectTickets.projectId, access.project.id))).limit(1);
  return t ?? null;
}

ticketsApi.get("/:projectId/tickets/:ticketId/addenda", async (c) => {
  const t = await addendumTicket(c);
  if (!t) return c.json({ error: "Not found" }, 404);
  const addenda = await db.select().from(ticketAddenda)
    .where(eq(ticketAddenda.ticketId, t.id)).orderBy(desc(ticketAddenda.createdAt));
  return c.json({ addenda });
});

ticketsApi.post("/:projectId/tickets/:ticketId/addenda", async (c) => {
  const user = c.get("user");
  const t = await addendumTicket(c);
  if (!t) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ description?: string }>().catch(() => ({} as { description?: string }));
  if (!body.description?.trim()) return c.json({ error: "description is required" }, 400);
  const [addendum] = await db.insert(ticketAddenda).values({
    ticketId: t.id, createdById: user.id, description: body.description.trim(), status: "pending",
  }).returning();
  return c.json({ addendum }, 201);
});

ticketsApi.patch("/:projectId/tickets/:ticketId/addenda/:addendumId", async (c) => {
  const t = await addendumTicket(c);
  if (!t) return c.json({ error: "Not found" }, 404);
  const { addendumId } = c.req.param();
  const body = await c.req.json<{ status?: string; description?: string }>().catch(() => ({} as { status?: string; description?: string }));
  const [updated] = await db.update(ticketAddenda).set({
    status: body.status ?? undefined,
    description: body.description?.trim() || undefined,
    resolvedAt: body.status === "resolved" ? new Date() : (body.status === "pending" ? null : undefined),
  }).where(and(eq(ticketAddenda.id, addendumId!), eq(ticketAddenda.ticketId, t.id))).returning();
  if (!updated) return c.json({ error: "Addendum not found" }, 404);
  return c.json({ addendum: updated });
});

ticketsApi.delete("/:projectId/tickets/:ticketId/addenda/:addendumId", async (c) => {
  const t = await addendumTicket(c);
  if (!t) return c.json({ error: "Not found" }, 404);
  const { addendumId } = c.req.param();
  await db.delete(ticketAddenda).where(and(eq(ticketAddenda.id, addendumId!), eq(ticketAddenda.ticketId, t.id)));
  return c.json({ ok: true });
});

export default ticketsApi;
