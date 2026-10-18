/**
 * After a build run finishes (or pauses on a failure), the chat agent takes one turn
 * in the conversation that started it. It reads what the tickets actually did and
 * explains the result and how to test it in the preview. The run's own short
 * announcement stays the reliable fallback, so this turn is best-effort.
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
    ? "Read the built tickets' results (getTicketDetails, getRecentActivities). Then tell the user what was built, give step-by-step instructions for testing it in the preview, and list anything unverified or still open. Do not start builds or change tickets."
    : "Read the failed ticket's details and logs (getTicketDetails). Explain in plain language what failed and why, and recommend the fix. Ask before retrying or changing anything.");
  return lines.join("\n");
}

export async function runBuildSummaryTurn(opts: { conversationId: string; userId: string; message: string }): Promise<void> {
  // A live turn already owns this chat; the announcement covers it.
  if (findBackgroundTurn(opts.userId, opts.conversationId)) return;
  const [conv] = await db.select({ projectId: conversations.projectId }).from(conversations)
    .where(eq(conversations.id, opts.conversationId)).limit(1);
  if (!conv) return;

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
  const timer = setTimeout(() => abortController.abort(), TURN_TIMEOUT_MS);
  try {
    await handleStream({
      ws, userId: opts.userId, userMessage: opts.message, userRole: BUILD_EVENT_ROLE,
      conversationId: opts.conversationId, projectId: conv.projectId ?? undefined, abortController,
    });
  } finally {
    clearTimeout(timer);
  }
  if (text.trim()) broadcastToUser(opts.userId, {
    type: "message", sender: "assistant", message: text, build_status: true,
    conversation_id: opts.conversationId, project_id: conv.projectId ?? undefined,
  });
}
