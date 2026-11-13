/**
 * Whiteboard API: boards of a project, saving what people draw, fetching what others drew,
 * and the chat with the agent that draws on the board.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess, type ProjectAccess } from "../../auth/project-access.ts";
import {
  BoardError, applyOps, changesSince, clearMessages, createBoard, deleteBoard, getBoard, listBoards, listMessages, readElements, renameBoard, type Board,
} from "../../services/whiteboards/store.ts";
import { runBoardAgent, type AgentEvent } from "../../services/whiteboards/agent.ts";
import { providerErrorMessage } from "../../ai/provider-error.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const whiteboardsApi = new Hono<AuthEnv>();
whiteboardsApi.use("*", requireAuth);
whiteboardsApi.use("*", bodyLimit({ maxSize: 6 * 1024 * 1024 }));

export const canDraw = (access: ProjectAccess) => access.role === "owner" || access.permissions.canEditFiles;
export const canAsk = (access: ProjectAccess) => access.role === "owner" || access.permissions.canChat;

/** The board and the caller's access to its project, or null when they may not see it. */
async function open(boardId: string, userId: string): Promise<{ board: Board; access: ProjectAccess } | null> {
  const board = await getBoard(boardId);
  if (!board) return null;
  const access = await getProjectAccess(board.projectId, userId);
  return access ? { board, access } : null;
}

whiteboardsApi.get("/", async (c) => {
  const projectId = c.req.query("projectId") ?? "";
  const access = await getProjectAccess(projectId, c.get("user").id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  return c.json({ boards: await listBoards(access.project.projectId), canEdit: canDraw(access) });
});

whiteboardsApi.post("/", async (c) => {
  const body = await c.req.json<{ projectId?: string; title?: string }>().catch(() => ({}) as Record<string, never>);
  const access = await getProjectAccess(String(body.projectId ?? ""), c.get("user").id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (!canDraw(access)) return c.json({ error: "You can view boards in this project, but not create them." }, 403);
  const board = await createBoard(c.get("user").id, access.project.projectId, body.title);
  return c.json({ board: { id: board.id, title: board.title } });
});

whiteboardsApi.get("/:id", async (c) => {
  const found = await open(c.req.param("id"), c.get("user").id);
  if (!found) return c.json({ error: "Board not found" }, 404);
  const since = c.req.query("since");
  if (since != null) return c.json({ title: found.board.title, ...changesSince(found.board, Number(since) || 0) });
  return c.json({
    board: { id: found.board.id, title: found.board.title, version: found.board.version },
    elements: readElements(found.board),
    messages: (await listMessages(found.board.id)).map((m) => ({ role: m.role, content: m.content })),
    canEdit: canDraw(found.access), canChat: canAsk(found.access),
  });
});

whiteboardsApi.patch("/:id", async (c) => {
  const found = await open(c.req.param("id"), c.get("user").id);
  if (!found) return c.json({ error: "Board not found" }, 404);
  if (!canDraw(found.access)) return c.json({ error: "You can't edit this board." }, 403);
  const body = await c.req.json<{ title?: string }>().catch(() => ({}) as Record<string, never>);
  return c.json({ title: await renameBoard(found.board.id, String(body.title ?? "")) });
});

whiteboardsApi.delete("/:id", async (c) => {
  const found = await open(c.req.param("id"), c.get("user").id);
  if (!found) return c.json({ error: "Board not found" }, 404);
  if (!canDraw(found.access)) return c.json({ error: "You can't delete this board." }, 403);
  await deleteBoard(found.board.id);
  return c.json({ ok: true });
});

// Save what changed: the elements this browser added or edited, and the ids it removed.
whiteboardsApi.post("/:id/ops", async (c) => {
  const found = await open(c.req.param("id"), c.get("user").id);
  if (!found) return c.json({ error: "Board not found" }, 404);
  if (!canDraw(found.access)) return c.json({ error: "You can't edit this board." }, 403);
  const body = await c.req.json<{ upserts?: unknown[]; deletes?: unknown[] }>().catch(() => ({}) as Record<string, never>);
  try {
    const result = await applyOps(found.board.id, body);
    return c.json({ version: result.version });
  } catch (error) {
    if (error instanceof BoardError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

whiteboardsApi.delete("/:id/messages", async (c) => {
  const found = await open(c.req.param("id"), c.get("user").id);
  if (!found) return c.json({ error: "Board not found" }, 404);
  if (!canAsk(found.access)) return c.json({ error: "You can't use the agent in this project." }, 403);
  await clearMessages(found.board.id);
  return c.json({ ok: true });
});

// Ask the agent. The answer streams back as one JSON event per line: text as it is written,
// and board changes as they are made, so the board fills in while the agent works.
const busy = new Set<string>();
whiteboardsApi.post("/:id/chat", async (c) => {
  const user = c.get("user");
  const found = await open(c.req.param("id"), user.id);
  if (!found) return c.json({ error: "Board not found" }, 404);
  if (!canAsk(found.access) || !canDraw(found.access)) return c.json({ error: "You can't use the agent on this board." }, 403);
  const body = await c.req.json<{ message?: string; selection?: unknown[]; viewport?: { x: number; y: number; w: number; h: number } }>().catch(() => ({}) as Record<string, never>);
  const message = String(body.message ?? "").trim().slice(0, 8000);
  if (!message) return c.json({ error: "Type what you'd like LFG to do." }, 400);
  const boardId = found.board.id;
  if (busy.has(boardId)) return c.json({ error: "LFG is still working on this board. Give it a moment." }, 409);
  busy.add(boardId);

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const view = body.viewport;
  const viewport = view && [view.x, view.y, view.w, view.h].every((n) => typeof n === "number" && Number.isFinite(n)) ? view : undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: AgentEvent) => { if (open) try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { open = false; } };
      try {
        await runBoardAgent({
          board: found.board, userId: user.id, userName: user.name, message, viewport, emit, signal: abort.signal,
          selection: (Array.isArray(body.selection) ? body.selection : []).filter((id): id is string => typeof id === "string").slice(0, 200),
        });
      } catch (error) {
        if (!abort.signal.aborted) {
          console.error("[whiteboard] agent failed:", (error as Error).message);
          const reason = (error as Error).message || "";
          emit({ type: "error", message: /API key|LLM access|subscription/i.test(reason) ? reason : providerErrorMessage(error, null) });
        }
      } finally {
        busy.delete(boardId);
        open = false;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() { abort.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
});

export default whiteboardsApi;
