import type { FollowupQueue } from './followup-queue.ts';
import { BackgroundTurn, findConnectionTurn, findBackgroundTurn, detachBackgroundSocket } from './background-turns.ts';
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
import { restartPreview, getPreviewState } from "../services/dev-preview.ts";
import { getProjectAccess } from "../auth/project-access.ts";

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.WS_HEARTBEAT_MS || "20000", 10);

// Heartbeat timers, one PER SOCKET.
//
// These used to be keyed `${userId}:${sessionId}` — and sessionId is the AUTH
// session id, which every tab in a browser shares. So with two tabs open, the
// second connection's timer overwrote the first's entry, and then closing EITHER
// tab cleared whichever timer the key currently held — usually the OTHER tab's,
// the one still working. That tab stopped receiving heartbeats, its client-side
// connection monitor concluded the socket was dead after 120s, and force-closed
// it. Turns now survive these socket closures. A reply would simply stop
// mid-sentence because a DIFFERENT tab had been closed.
const syncedSockets = new WeakSet<ServerWebSocket<WsData>>();
const heartbeatTimers = new WeakMap<ServerWebSocket<WsData>, ReturnType<typeof setInterval>>();

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
  if (ws.data.conversationId && !findBackgroundTurn(conn.userId, ws.data.conversationId)) {
    sendHistory(ws, ws.data.conversationId).catch((err) => {
      console.warn("[ws] Failed to send chat history:", err);
    });
  }

  // Start heartbeat — owned by THIS socket, so another tab closing can't stop it.
  const timer = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "heartbeat" }));
    } catch {
      clearInterval(timer);
      heartbeatTimers.delete(ws);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimers.set(ws, timer);
}

export function onClose(ws: ServerWebSocket<WsData>): void {
  // Stop THIS socket's heartbeat (never another tab's).
  const timer = heartbeatTimers.get(ws);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(ws);
  }

  detachBackgroundSocket(ws);

  unregisterConnection(ws);
}

export async function onMessage(ws: ServerWebSocket<WsData>, rawData: string | Buffer, continuation?: {conn:WsConnection;queue:FollowupQueue;subscribers:Set<ServerWebSocket<WsData>>}): Promise<void> {
  const conn = continuation?.conn ?? getConnection(ws);
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
    const turn = findBackgroundTurn(conn.userId, conn.conversationId);
    if (conn.conversationId && !syncedSockets.has(ws) && (!turn || !turn.subscribers.has(ws))) {
      syncedSockets.add(ws);
      let rows = await db.select().from(messages).where(eq(messages.conversationId, conn.conversationId!)).orderBy(asc(messages.createdAt));
      const active = findBackgroundTurn(conn.userId, conn.conversationId);
      if (!active) rows = await db.select().from(messages).where(eq(messages.conversationId, conn.conversationId!)).orderBy(asc(messages.createdAt));
      if (active?.subscribers.has(ws) || !getConnection(ws)) return;
      send(ws, { type: "background_resume", messages: rows.filter(m => !active || m.id !== active.assistantMessageId).map(m => ({ ...m, page_previews: m.pagePreviews ?? null, activity_trail: m.activityTrail, end_reason: m.endReason, is_partial: m.isPartial })), events: active?.events.map(e => JSON.parse(e)) ?? [] });
      active?.subscribers.add(ws);
    }
    send(ws, { type: "chat_queue", items: turn?.followups.snapshot() ?? [] });
    send(ws, {
      type: "sync_state_response",
      is_streaming: !!findBackgroundTurn(conn.userId, conn.conversationId),
      conversation_id: conn.conversationId,
    });
    return;
  }

  if (msg.type === "queue_remove" || msg.type === "queue_steer") {
    const active=findBackgroundTurn(conn.userId,conn.conversationId) ?? findConnectionTurn(conn);
    if(!active)return;
    if(msg.type==='queue_remove')active.followups.remove(msg.id);
    else if(active.followups.steer(msg.id)) {
      active.owner.stopRequested=true;
      active.owner.endReason='stopped';
      active.owner.abortController?.abort();
    }
    send(active.transport,{type:'chat_queue',items:active.followups.snapshot()});
    return;
  }

  if (msg.type === "stop_generation") {
    const owner = findBackgroundTurn(conn.userId, conn.conversationId)?.owner ?? conn;
    owner.stopRequested = true;
    owner.endReason = "stopped";
    owner.abortController?.abort();
    send(ws, { type: "stop_confirmed" });
    return;
  }

  if (msg.type === "message") {
    const { message, conversation_id, project_id, turbo_mode, instant_mode, user_role, file, file_data, files } = msg;
    // Dictated messages are marked so the transcript can show a mic after a reload.
    const isVoice = !!(msg as { is_voice?: boolean }).is_voice;
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

    const active = findBackgroundTurn(conn.userId, conversation_id || conn.conversationId) ?? findConnectionTurn(conn);
    if (active || conn.isStreaming) {
      if (!active) { send(ws,{type:'error',message:'The current response is still stopping. Please retry your message.'}); return; }
      if (msg.client_message_id && msg.client_message_id === active.clientMessageId) return;
      try {
        active.followups.add({...msg, message:normalizedMessage});
        active.subscribers.add(ws);
        send(active.transport,{type:'chat_queue',items:active.followups.snapshot()});
      } catch(e) { send(ws,{type:'message_rejected',reason:(e as Error).message,message:msg.display_message ?? msg.message,files:resolvedFiles}); }
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
    conn.endReason = undefined;
    const turn = new BackgroundTurn(conn, continuation?.queue);
    if(continuation) for(const subscriber of continuation.subscribers) turn.subscribers.add(subscriber);
    turn.clientMessageId = msg.client_message_id;
    const output = turn.transport;
    send(output,{type:'chat_queue',items:turn.followups.snapshot()});
    send(output,{type:'message_started',message:msg.display_message ?? normalizedMessage,files:resolvedFiles,render_on_start:!!msg.render_on_start,client_message_id:msg.client_message_id});

    // Watchdog: if the model stream HANGS (provider stops responding with no output),
    // handleStream never returns → the finally never runs → isStreaming stays true →
    // every subsequent message is silently dropped and the client's "Thinking…" hangs
    // forever. Abort it and tell the client so it can recover.
    //
    // IDLE, not fixed-wall-clock: a long-but-ACTIVE agentic run (e.g. mapping a whole
    // feature = many codebase queries) legitimately runs past a few minutes while
    // streaming tool calls the whole time. A fixed timer killed those mid-work. So we
    // fire only after CHAT_STREAM_IDLE_TIMEOUT_MIN with NO output — onActivity (passed to
    // handleStream) bumps lastActivity on every stream event.
    const idleMs = parseInt(process.env.CHAT_STREAM_IDLE_TIMEOUT_MIN || process.env.CHAT_STREAM_TIMEOUT_MIN || "4", 10) * 60_000;
    let watchdogFired = false;
    let lastActivity = Date.now();
    const bumpActivity = () => { lastActivity = Date.now(); };
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity < idleMs) return; // still producing output — let it run
      watchdogFired = true;
      conn.endReason = "timeout";
      console.warn(`[chat-handler] stream watchdog fired — no output for ${Math.round(idleMs / 1000)}s, aborting a hung generation`);
      try { conn.abortController?.abort(); } catch { /* best-effort */ }
      // Reset the guard immediately so a hung provider can't wedge the connection even if
      // the abort doesn't unblock the underlying socket.
      conn.isStreaming = false;
      send(output, { type: "error", message: "The assistant stopped responding — please try again." });
      clearInterval(watchdog);
    }, 15_000);

    try {
      // Legacy @preview requests use the same ticket-aware orchestrator and attachments.
      {
        // Ticket mentions supply context only. Preview selection is an explicit action.
        const result = await handleStream({
          ws: output,
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
          isVoice,
          abortController: conn.abortController,
          abortReason: () => conn.endReason,
          onActivity: bumpActivity,
          onAssistantMessageId: id => { turn.assistantMessageId = id; },
        });

        // Update connection with resolved conversationId
        conn.conversationId = result.conversationId;
      }
    } finally {
      const subscribers = new Set(turn.subscribers);
      turn.finish();
      clearInterval(watchdog);
      if (!watchdogFired) conn.isStreaming = false;
      conn.abortController = undefined;
      const next = turn.followups.next();
      if(next) {
        // Carry the queue and live subscribers into the next turn, even if the
        // original socket closed. Never overlap tool execution with the prior turn.
        await onMessage(ws,JSON.stringify({...next.request,conversation_id:conn.conversationId}),{conn,queue:turn.followups,subscribers});
      }
    }
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
      activity_trail: m.activityTrail ?? null,
      page_previews: m.pagePreviews ?? null,
      end_reason: m.endReason ?? null,
      is_partial: m.isPartial ?? false,
    })),
  });
}
