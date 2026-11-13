/**
 * When work the chat agent started reaches an outcome, the agent takes one turn in the
 * conversation that started it: a build run finishing or pausing, a single ticket's
 * build or retry ending, or a change request sent to a ticket completing or failing.
 * It reads what actually happened, explains it, and re-checks a fix it was waiting on.
 * The short status message each of these already posts stays the reliable fallback, so
 * this turn is best-effort. Events for a chat that is busy wait for it; they used to be dropped.
 * CHAT_BUILD_EVENT_TURNS=0 turns the automatic turns off (status messages remain).
 */
import type { ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { conversations } from "../db/schema/chat.ts";
import type { WsData } from "../ws/types.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { findBackgroundTurn } from "../ws/background-turns.ts";

/** Stored on the triggering user row so history can hide it; the agent still sees it. */
export const BUILD_EVENT_ROLE = "build_event";
/** Live-call transcript and recap prompts handed to the agent by the meeting agent; hidden the same way. */
export const MEETING_CONTEXT_ROLE = "meeting_context";
/** User-row roles the agent reads but chat history does not show. */
export const HIDDEN_USER_ROLES: readonly string[] = [BUILD_EVENT_ROLE, MEETING_CONTEXT_ROLE];

const TURN_TIMEOUT_MS = 5 * 60_000;

export function buildEventMessage(event: { kind: "complete" | "paused"; tickets: string[]; previewUrl?: string | null; branch?: string | null; detail?: string }): string {
  const lines = [
    `[Automated build event: not a message from the user, and not approval for new work]`,
    event.kind === "complete" ? "The build run finished." : "The build run paused because a ticket failed.",
    `Tickets: ${event.tickets.join(", ") || "none recorded"}`,
  ];
  if (event.previewUrl) lines.push(`Preview: ${event.previewUrl}${event.branch ? ` (branch ${event.branch})` : ""}`);
  if (event.detail) lines.push(event.detail);
  lines.push(event.kind === "complete"
    ? "Read the built tickets' results (getTicketDetails, getRecentActivities). Then tell the user what was built, name each ticket's branch and latest commit, give step-by-step instructions for testing it in the preview, and list anything unverified or still open. Update your plan if you keep one. Do not start builds or change tickets."
    : "Read the failed ticket's details and logs (getTicketDetails). Explain in plain language what failed and why, say where the work so far is saved (branch), and recommend the fix. Ask before retrying or changing anything.");
  return lines.join("\n");
}

/** One ticket's build, retry or change request reached an outcome outside a build run. */
export function ticketEventMessage(event: { kind: "built" | "failed" | "change_done" | "change_failed"; ticket: string; ticketId: string; detail: string }): string {
  const what = { built: "A ticket build finished.", failed: "A ticket build failed.",
    change_done: "A change request sent to a ticket's agent finished.", change_failed: "A change request sent to a ticket's agent did not finish." }[event.kind];
  const ok = event.kind === "built" || event.kind === "change_done";
  return [
    `[Automated build event: not a message from the user, and not approval for new work]`,
    what,
    `Ticket: ${event.ticket} (id ${event.ticketId})`,
    `Reported outcome: ${event.detail.replace(/\s+/g, " ").slice(0, 1500)}`,
    ok
      ? "Check what was actually done (getTicketDetails). If this was a fix for a problem found earlier in this conversation, re-run the check that found it against the preview (runInPreview, getPreviewDiagnostics) once the preview shows this change, and say plainly whether it is fixed, still failing, or could not be checked and why. Otherwise say in a few lines what changed and how to try it. Update your plan if you keep one. Read-only checks only: do not start builds, send new change requests or edit tickets in this turn; if more work is needed, recommend it and ask."
      : "Read the ticket's details and logs (getTicketDetails). Explain in plain language what failed and why, say what is saved, and recommend the fix. Update your plan if you keep one. Ask before retrying or changing anything.",
  ].join("\n");
}

const WAIT_FOR_IDLE_MS = 20 * 60_000;
const queues = new Map<string, Promise<void>>();

/**
 * Queue an automatic turn for a conversation. Turns for one conversation run one at a
 * time, each waiting for any live turn (the user's, or an earlier event's) to finish.
 */
export function runBuildSummaryTurn(opts: { conversationId: string; userId: string; message: string }): Promise<void> {
  if (process.env.CHAT_BUILD_EVENT_TURNS === "0") return Promise.resolve();
  return runQueuedChatTurn({ ...opts, userRole: BUILD_EVENT_ROLE }).then((text) => announceAgentMessage(opts, text));
}

/** Show a reply from a browserless turn in the owner's open tabs. */
export async function announceAgentMessage(opts: { conversationId: string; userId: string }, text: string): Promise<void> {
  if (!text.trim()) return;
  const [conv] = await db.select({ projectId: conversations.projectId }).from(conversations)
    .where(eq(conversations.id, opts.conversationId)).limit(1);
  broadcastToUser(opts.userId, {
    type: "message", sender: "assistant", message: text, build_status: true,
    conversation_id: opts.conversationId, project_id: conv?.projectId ?? undefined,
  });
}

export interface QueuedChatTurn {
  conversationId: string; userId: string; message: string;
  /** Stored on the message row; a hidden role keeps it out of chat history. Omit for a visible message. */
  userRole?: string;
  files?: Array<{ id?: string; name?: string; type?: string; size?: number }>;
  timeoutMs?: number;
}

/**
 * Run one agent turn in a conversation without a browser, and return what the agent said.
 * Turns for one conversation run one at a time, each waiting for any live turn to finish.
 * Returns "" when the chat stayed busy too long or the conversation is gone.
 */
export function runQueuedChatTurn(opts: QueuedChatTurn): Promise<string> {
  const previous = queues.get(opts.conversationId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => runWhenIdle(opts));
  const settled = next.then(() => {}, () => {});
  queues.set(opts.conversationId, settled);
  void settled.finally(() => { if (queues.get(opts.conversationId) === settled) queues.delete(opts.conversationId); });
  return next;
}

/** Fire-and-forget form for reporters, which must never fail or wait on the chat agent. */
export function notifyChatAgent(opts: { conversationId: string | null | undefined; userId: string | null | undefined; message: string }): void {
  if (!opts.conversationId || !opts.userId) return;
  runBuildSummaryTurn({ conversationId: opts.conversationId, userId: opts.userId, message: opts.message })
    .catch((error) => console.error("[build-event] Chat agent turn failed:", (error as Error).message));
}

async function runWhenIdle(opts: QueuedChatTurn): Promise<string> {
  const deadline = Date.now() + WAIT_FOR_IDLE_MS;
  while (findBackgroundTurn(opts.userId, opts.conversationId)) {
    if (Date.now() > deadline) { console.warn("[build-event] Chat stayed busy; event left to its status message:", opts.conversationId); return ""; }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const [conv] = await db.select({ projectId: conversations.projectId }).from(conversations)
    .where(eq(conversations.id, opts.conversationId)).limit(1);
  if (!conv) return "";

  const { handleStream } = await import("../ai/stream-handler.ts");
  let text = "";
  const ws = {
    send(raw: string) {
      try {
        const m = JSON.parse(raw);
        if (m.type === "ai_chunk" && !m.is_notification && m.chunk) text += m.chunk;
      } catch { /* not JSON */ }
      return raw.length;
    },
    data: {} as WsData,
    readyState: 1,
  } as unknown as ServerWebSocket<WsData>;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), opts.timeoutMs ?? TURN_TIMEOUT_MS);
  try {
    await handleStream({
      ws, userId: opts.userId, userMessage: opts.message, userRole: opts.userRole, files: opts.files,
      conversationId: opts.conversationId, projectId: conv.projectId ?? undefined, abortController,
    });
  } finally {
    clearTimeout(timer);
  }
  return text;
}
