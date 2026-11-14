/**
 * Whiteboard API: boards of a project, saving what people draw, fetching what others drew,
 * and the chat with the agent that draws on the board.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess, type ProjectAccess } from "../../auth/project-access.ts";
import {
  BoardError, applyOps, boardByShareToken, changesSince, clearMessages, createBoard, deleteBoard, getBoard, listBoards, listMessages, readElements, renameBoard, setShare, shareModeOf, type Board,
} from "../../services/whiteboards/store.ts";
import { runBoardAgent, type AgentEvent } from "../../services/whiteboards/agent.ts";
import { broadcast, closeGuests, type PeerInfo } from "../../services/whiteboards/live.ts";
import { availableChatModels } from "../../services/available-models.ts";
import { db } from "../../config/db.ts";
import { modelSelections } from "../../db/schema/chat.ts";
import { eq } from "drizzle-orm";
import { providerErrorMessage } from "../../ai/provider-error.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const whiteboardsApi = new Hono<AuthEnv>();
whiteboardsApi.use("*", requireAuth);
whiteboardsApi.use("*", bodyLimit({ maxSize: 6 * 1024 * 1024 }));

export const canDraw = (access: ProjectAccess) => access.role === "owner" || access.permissions.canEditFiles;
/** Opening a board to people outside the project is an invitation, so it needs the right to invite. */
export const canShare = (access: ProjectAccess) => access.role === "owner" || (canDraw(access) && access.permissions.canInviteMembers);
export const canAsk = (access: ProjectAccess) => access.role === "owner" || access.permissions.canChat;

/** The board and the caller's access to its project, or null when they may not see it. */
async function open(boardId: string, userId: string): Promise<{ board: Board; access: ProjectAccess } | null> {
  const board = await getBoard(boardId);
  if (!board) return null;
  const access = await getProjectAccess(board.projectId, userId);
  return access ? { board, access } : null;
}

/** Who is asking to join a board's live connection, and what they may do there. Null when they may not join. */
export async function authorizeBoardSocket(query: URLSearchParams, user: { id: string; name: string } | null): Promise<PeerInfo | null> {
  const token = query.get("token");
  if (token) {
    const board = await boardByShareToken(token);
    if (!board) return null;
    return { boardId: board.id, name: user?.name || query.get("name") || "Guest", canEdit: shareModeOf(board) === "edit", guest: true };
  }
  if (!user) return null;
  const found = await open(query.get("board") ?? "", user.id);
  return found ? { boardId: found.board.id, name: user.name, canEdit: canDraw(found.access), guest: false } : null;
}

/** The live connection a request came from (sent by the browser), so that browser is not told about its own change. */
const originOf = (c: { req: { header(name: string): string | undefined } }) => c.req.header("X-Board-Client")?.slice(0, 16) || null;

/** The models this person can chat with here, and the one they have picked (shared with the main chat). */
async function chatModels(userId: string, projectId: string) {
  const models = await availableChatModels(userId, projectId).catch(() => []);
  const [selection] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId)).limit(1);
  const usable = models.filter((m) => m.available);
  const selected = usable.find((m) => m.key === selection?.selectedModel)?.key ?? null;
  return { models: usable.map((m) => ({ key: m.key, label: m.label, provider: m.providerLabel })), model: selected };
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
    ...(canAsk(found.access) && canDraw(found.access) ? await chatModels(c.get("user").id, found.board.projectId) : { models: [], model: null }),
    // The link is a credential: only people who may hand it out are shown it.
    share: canShare(found.access) ? { mode: shareModeOf(found.board), token: shareModeOf(found.board) ? found.board.shareToken : null } : null,
  });
});

whiteboardsApi.patch("/:id", async (c) => {
  const found = await open(c.req.param("id"), c.get("user").id);
  if (!found) return c.json({ error: "Board not found" }, 404);
  if (!canDraw(found.access)) return c.json({ error: "You can't edit this board." }, 403);
  const body = await c.req.json<{ title?: string }>().catch(() => ({}) as Record<string, never>);
  const title = await renameBoard(found.board.id, String(body.title ?? ""));
  broadcast(found.board.id, { t: "title", title }, originOf(c));
  return c.json({ title });
});

// Turn the board's public link on (to view or to edit) or off.
whiteboardsApi.put("/:id/share", async (c) => {
  const found = await open(c.req.param("id"), c.get("user").id);
  if (!found) return c.json({ error: "Board not found" }, 404);
  if (!canShare(found.access)) return c.json({ error: "Only people who can invite others to this project can share a board by link." }, 403);
  const body = await c.req.json<{ mode?: string | null }>().catch(() => ({}) as Record<string, never>);
  const mode = body.mode === "view" || body.mode === "edit" ? body.mode : null;
  const share = await setShare(found.board.id, mode);
  // Whoever is on the board through the link loads it again, and finds what the link now allows.
  if (shareModeOf(found.board) !== mode) closeGuests(found.board.id);
  return c.json(share);
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
    const result = await applyOps(found.board.id, body, { origin: originOf(c) });
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
        const origin = originOf(c);
        const reply = await runBoardAgent({
          board: found.board, userId: user.id, userName: user.name, message, viewport, emit, signal: abort.signal, origin,
          selection: (Array.isArray(body.selection) ? body.selection : []).filter((id): id is string => typeof id === "string").slice(0, 200),
        });
        // Project members with the board open see the exchange too (guests never see the agent conversation).
        broadcast(boardId, { t: "chat", name: user.name, message, reply }, origin, { membersOnly: true });
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

/**
 * What someone holding a board's link can do, with no account: read the board, and, when the
 * link allows editing, save changes to it. The link's secret is the only credential, so nothing
 * here reveals the project, its members or the conversation with the agent, and the agent
 * (which spends the project's model credit) is not available.
 */
export const sharedBoardsApi = new Hono();
sharedBoardsApi.use("*", bodyLimit({ maxSize: 6 * 1024 * 1024 }));

sharedBoardsApi.get("/:token", async (c) => {
  const board = await boardByShareToken(c.req.param("token"));
  if (!board) return c.json({ error: "This link is not available." }, 404);
  const since = c.req.query("since");
  if (since != null) return c.json({ title: board.title, ...changesSince(board, Number(since) || 0) });
  return c.json({
    board: { id: board.id, title: board.title, version: board.version }, elements: readElements(board),
    messages: [], canEdit: shareModeOf(board) === "edit", canChat: false, share: null,
  });
});

sharedBoardsApi.post("/:token/ops", async (c) => {
  const board = await boardByShareToken(c.req.param("token"));
  if (!board) return c.json({ error: "This link is not available." }, 404);
  if (shareModeOf(board) !== "edit") return c.json({ error: "This link only lets you view the board." }, 403);
  const body = await c.req.json<{ upserts?: unknown[]; deletes?: unknown[] }>().catch(() => ({}) as Record<string, never>);
  try {
    return c.json({ version: (await applyOps(board.id, body, { origin: originOf(c) })).version });
  } catch (error) {
    if (error instanceof BoardError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

export default whiteboardsApi;
