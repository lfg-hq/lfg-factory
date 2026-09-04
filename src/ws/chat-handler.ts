import type { ServerWebSocket } from "bun";
import type { WsData, WSIncoming, WsConnection } from "./types.ts";
import {
  registerConnection,
  unregisterConnection,
  getConnection,
  send,
} from "./connection-manager.ts";
import { handleStream, describeAttachedImages } from "../ai/stream-handler.ts";
import { db } from "../config/db.ts";
import { messages, conversations } from "../db/schema/chat.ts";
import { eq, asc, desc } from "drizzle-orm";
import { runPreviewChat, restartPreview, getPreviewState } from "../services/dev-preview.ts";
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
// it — which aborts the in-flight turn server-side. A reply would simply stop
// mid-sentence because a DIFFERENT tab had been closed.
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
  if (ws.data.conversationId) {
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

  // Abort any in-flight generation. Tag WHY first: a turn cut off because the
  // laptop slept must not be saved as though the assistant had finished.
  const conn = getConnection(ws);
  if (conn?.abortController) {
    conn.endReason = "disconnect";
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
    conn.endReason = "stopped";
    conn.abortController?.abort();
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
    // @preview is an interactive shell agent doing real work (build/scan/fix). It's more
    // forgiving on idle, and — crucially — when the watchdog DOES fire, we don't spam a
    // generic "stopped responding" toast: aborting makes runPreviewChat emit a graceful,
    // RESUMABLE summary ("here's where I got to — reply 'continue'"), which is the message
    // the user should see instead of a bare kill.
    const isPreviewCmd = /^\s*@preview\b/i.test(normalizedMessage) && !!conn.projectId;
    const idleMs = parseInt(process.env.CHAT_STREAM_IDLE_TIMEOUT_MIN || process.env.CHAT_STREAM_TIMEOUT_MIN || "4", 10) * 60_000
      * (isPreviewCmd ? 2 : 1);
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
      // For @preview the aborted run produces its OWN graceful "paused — reply continue"
      // message; a second generic error toast would just be noise, so skip it there.
      if (!isPreviewCmd) send(ws, { type: "error", message: "The assistant stopped responding — please try again." });
      clearInterval(watchdog);
    }, 15_000);

    try {
      // "@preview …" → route to the interactive Preview agent (full control of the
      // project's live sandbox) instead of the normal chat model.
      if (/^\s*@preview\b/i.test(normalizedMessage) && conn.projectId) {
        await handlePreviewChat(ws, conn, normalizedMessage, resolvedFiles, bumpActivity);
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
          isVoice,
          abortController: conn.abortController,
          abortReason: () => conn.endReason,
          onActivity: bumpActivity,
        });

        // Update connection with resolved conversationId
        conn.conversationId = result.conversationId;
      }
    } finally {
      clearInterval(watchdog);
      if (!watchdogFired) conn.isStreaming = false;
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
async function handlePreviewChat(ws: ServerWebSocket<WsData>, conn: WsConnection, rawMessage: string, files?: Array<{ id?: string; name?: string; type?: string; size?: number }>, onActivity?: () => void): Promise<void> {
  const userId = conn.userId;
  const publicProjectId = conn.projectId as string;
  const conversationId = conn.conversationId ?? null;
  let instruction = rawMessage.replace(/^\s*@preview\b[:\s]*/i, "").trim();

  // The preview agent is a text/shell agent — it can't view images. Run the Gemini vision
  // pre-pass over any screenshot the user attached and inject the description, so "@preview
  // fix this error" + a screenshot of the error actually gives the agent the error text.
  const imageFiles = (files || []).filter((f) => f.id && (f.type || "").startsWith("image/"));
  if (imageFiles.length) {
    const desc = await describeAttachedImages(imageFiles).catch(() => "");
    if (desc) instruction = `${instruction}\n\n${desc}`.trim();
  }

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
      onActivity,
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
