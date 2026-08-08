import type { ServerWebSocket } from "bun";
import type { WsData, WSIncoming, WsConnection } from "./types.ts";
import {
  registerConnection,
  unregisterConnection,
  getConnection,
  send,
} from "./connection-manager.ts";
import { handleStream } from "../ai/stream-handler.ts";
import { db } from "../config/db.ts";
import { messages, conversations } from "../db/schema/chat.ts";
import { eq, asc, desc } from "drizzle-orm";
import { runPreviewChat, restartPreview, getPreviewState } from "../services/dev-preview.ts";
import { getProjectAccess } from "../auth/project-access.ts";

const HEARTBEAT_INTERVAL_MS = 20_000;

// Active heartbeat timers by userId+sessionId
const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

export function onOpen(ws: ServerWebSocket<WsData>): void {
  const conn: WsConnection = {
    ws,
    userId: ws.data.userId,
    conversationId: ws.data.conversationId,
    projectId: ws.data.projectId,
    isStreaming: false,
    stopRequested: false,
  };

  registerConnection(conn);

  // Send chat history if conversation_id was provided in the WS URL
  console.log("[ws] onOpen - conversationId:", ws.data.conversationId, "userId:", ws.data.userId);
  if (ws.data.conversationId) {
    sendHistory(ws, ws.data.conversationId).catch((err) => {
      console.warn("[ws] Failed to send chat history:", err);
    });
  }

  // Start heartbeat
  const key = `${ws.data.userId}:${ws.data.sessionId}`;
  const timer = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "heartbeat" }));
    } catch {
      clearInterval(timer);
      heartbeatTimers.delete(key);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimers.set(key, timer);
}

export function onClose(ws: ServerWebSocket<WsData>): void {
  // Stop heartbeat
  const key = `${ws.data.userId}:${ws.data.sessionId}`;
  const timer = heartbeatTimers.get(key);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(key);
  }

  // Abort any in-flight generation
  const conn = getConnection(ws);
  if (conn?.abortController) {
    conn.abortController.abort();
  }

  unregisterConnection(ws);
}

export async function onMessage(ws: ServerWebSocket<WsData>, rawData: string | Buffer): Promise<void> {
  const conn = getConnection(ws);
  if (!conn) return;

  let msg: WSIncoming;
  try {
    msg = JSON.parse(rawData.toString()) as WSIncoming;
  } catch {
    send(ws, { type: "error", message: "Invalid JSON" });
    return;
  }

  if (msg.type === "heartbeat_ack") return;

  if (msg.type === "sync_state") {
    send(ws, {
      type: "sync_state_response",
      is_streaming: conn.isStreaming,
      conversation_id: conn.conversationId,
    });
    return;
  }

  if (msg.type === "stop_generation") {
    conn.stopRequested = true;
    conn.abortController?.abort();
    send(ws, { type: "stop_confirmed" });
    return;
  }

  if (msg.type === "message") {
    const { message, conversation_id, project_id, turbo_mode, instant_mode, user_role, file, file_data, files } = msg;
    const mentionedTickets = (msg as { mentioned_tickets?: Array<{ id: string; key?: string; name?: string; branch?: string }> }).mentioned_tickets;
    // Multiple attachments: prefer the `files` array; fall back to the single file_data/file.
    const resolvedFiles = (files && files.length ? files : ([file_data ?? file].filter(Boolean) as NonNullable<typeof file_data>[]));
    const resolvedFile = resolvedFiles[0];
    const normalizedMessage = message?.trim()
      ? message
      : resolvedFiles.length
        ? (resolvedFiles.length === 1
            ? `[Shared a file: ${resolvedFiles[0]!.name}]`
            : `[Shared ${resolvedFiles.length} files: ${resolvedFiles.map((f) => f!.name).join(", ")}]`)
        : "";

    if (!normalizedMessage.trim()) {
      send(ws, { type: "error", message: "Message cannot be empty" });
      return;
    }

    if (conn.isStreaming) {
      // Silently drop a duplicate send while we're already streaming.
      // Showing a "response is already being generated" toast is more
      // annoying than helpful — the user can see the assistant is mid-
      // reply, and a stray duplicate (e.g. from auto-resend or a fast
      // double-click) just gets ignored.
      console.log("[chat-handler] ignoring send while already streaming");
      return;
    }

    // Update conversation context — history is loaded by the client via REST API,
    // so we never send chat_history here (it would wipe the user's just-sent message).
    if (conversation_id) {
      conn.conversationId = conversation_id;
    }

    conn.projectId = project_id;
    conn.isStreaming = true;
    conn.stopRequested = false;
    conn.abortController = new AbortController();

    try {
      // "@preview …" → route to the interactive Preview agent (full control of the
      // project's live sandbox) instead of the normal chat model.
      if (/^\s*@preview\b/i.test(normalizedMessage) && conn.projectId) {
        await handlePreviewChat(ws, conn, normalizedMessage);
      } else {
        // @ticket:… referenced → switch the Preview to the FIRST ticket's branch,
        // but ONLY if a preview is already LIVE and on a DIFFERENT branch. Asking a
        // QUESTION about the ticket you're already previewing must NOT rebuild it
        // (and a question shouldn't boot a preview from scratch). Fire-and-forget.
        if (mentionedTickets?.length && conn.projectId) {
          const first = mentionedTickets[0];
          getProjectAccess(conn.projectId, conn.userId).then(async (access) => {
            if (!access || !first?.id) return;
            const target = first.branch || `feature/ticket-${first.id}`;
            const st = await getPreviewState(access.project.id).catch(() => null);
            const isLive = st && (st.previewStatus === "running" || st.previewStatus === "starting");
            const alreadyOn = st && st.branch && (st.branch === target);
            if (isLive && !alreadyOn) {
              restartPreview(access.project.id, { userId: conn.userId, ticketId: first.id, conversationId: conn.conversationId ?? null })
                .catch((e) => console.warn("[chat-handler] @ticket branch switch failed:", (e as Error).message));
            }
          }).catch(() => {});
        }
        const result = await handleStream({
          ws,
          userId: conn.userId,
          userMessage: normalizedMessage,
          conversationId: conn.conversationId,
          projectId: conn.projectId,
          turboMode: turbo_mode,
          instantMode: instant_mode,
          userRole: user_role,
          file: resolvedFile,
          files: resolvedFiles,
          mentionedTickets,
          abortController: conn.abortController,
        });

        // Update connection with resolved conversationId
        conn.conversationId = result.conversationId;
      }
    } finally {
      conn.isStreaming = false;
      conn.abortController = undefined;
    }
  }
}

/**
 * Route a "@preview …" chat message to the interactive Preview agent, which has
 * full shell control of the project's LIVE sandbox. Detailed command output
 * streams into the Preview tab log; a concise summary comes back inline in chat.
 * Ends with an is_final ai_chunk so the chat input re-enables like a normal reply.
 */
async function handlePreviewChat(ws: ServerWebSocket<WsData>, conn: WsConnection, rawMessage: string): Promise<void> {
  const userId = conn.userId;
  const publicProjectId = conn.projectId as string;
  const conversationId = conn.conversationId ?? null;
  const instruction = rawMessage.replace(/^\s*@preview\b[:\s]*/i, "").trim();

  // Persist the user's message (normal chat persists it server-side too).
  if (conversationId) {
    await db.insert(messages).values({ conversationId, role: "user", content: rawMessage }).catch(() => {});
  }

  const finish = async (content: string) => {
    if (conversationId) await db.insert(messages).values({ conversationId, role: "assistant", content }).catch(() => {});
    // is_final ai_chunk → renders the bubble AND re-enables the chat input.
    send(ws, { type: "ai_chunk", chunk: content, is_final: true, conversation_id: conversationId, provider: "preview-agent" });
  };

  if (!instruction) {
    await finish("🔧 **Preview agent** — tell me what to do, e.g. `@preview restart the app`, `@preview why is postgres failing?`, or `@preview tail the last 50 lines of the app log`.");
    return;
  }

  const access = await getProjectAccess(publicProjectId, userId).catch(() => null);
  if (!access) { await finish("I couldn't find this project to work on its preview."); return; }

  try {
    const { reply, status } = await runPreviewChat({
      projectId: access.project.id,
      publicProjectId,
      userId,
      conversationId,
      instruction,
      abortSignal: conn.abortController?.signal,
    });
    // Colour-coded status banner: green = ok, red = error, yellow = stuck.
    const badge = status === "ok" ? "🟢 **Preview agent — done**" : status === "error" ? "🔴 **Preview agent — failed**" : "🟡 **Preview agent — needs attention**";
    await finish(`${badge}\n\n${reply}`);
  } catch (e) {
    await finish(`🔴 **Preview agent — failed**\n\n${(e as Error).message?.slice(0, 300) || "unknown error"}`);
  }
}

async function sendHistory(ws: ServerWebSocket<WsData>, conversationId: string): Promise<void> {
  console.log("[ws] sendHistory called for conversation:", conversationId);
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(100);

  console.log("[ws] sendHistory found", rows.length, "messages");
  send(ws, {
    type: "chat_history",
    messages: rows.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      createdAt: m.createdAt,
    })),
  });
}
