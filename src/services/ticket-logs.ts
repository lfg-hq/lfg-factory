/**
 * Shared ticket logging utilities.
 *
 * Extracted from ticket-executor.ts so both the executor worker and the
 * CLI callback API can insert logs + broadcast to the frontend via WS.
 */

import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { ticketLogs } from "../db/schema/tickets.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";

/**
 * Insert a log row for a ticket and broadcast it to the owner via WebSocket.
 */
export async function addLog(
  ticketId: string,
  message: string,
  logType: "command" | "ai_response" | "user_message" | "cli_error" | "question",
  userId?: string,
  metadata?: Record<string, unknown>,
  extra?: { output?: string; explanation?: string; exitCode?: number }
): Promise<string | undefined> {
  const [inserted] = await db.insert(ticketLogs).values({
    ticketId,
    logType,
    command: message.slice(0, 2000),
    ...(extra?.output != null ? { output: extra.output.slice(0, 8000) } : {}),
    ...(extra?.explanation != null ? { explanation: extra.explanation } : {}),
    ...(extra?.exitCode != null ? { exitCode: extra.exitCode } : {}),
  }).returning();

  if (userId) {
    broadcastToUser(userId, {
      type: "ticket_log",
      ticketId,
      log: {
        id: inserted?.id,
        type: logType,
        message: message.slice(0, 2000),
        output: extra?.output?.slice(0, 8000),
        createdAt: inserted?.createdAt ?? new Date().toISOString(),
        ...metadata,
      },
    });
  }
  return inserted?.id;
}

/**
 * Attach captured output to an EXISTING command log row (the agent's tool_result
 * paired to its tool_use by id) and push a live update so the UI folds the output
 * into the command's row instead of showing a second, disconnected "output" line.
 */
export async function attachLogOutput(
  logId: string,
  output: string,
  ticketId?: string,
  userId?: string,
) {
  const out = output.slice(0, 8000);
  await db.update(ticketLogs).set({ output: out }).where(eq(ticketLogs.id, logId));
  if (userId && ticketId) {
    broadcastToUser(userId, { type: "ticket_log_output", ticketId, logId, output: out });
  }
}

/**
 * Format a tool_use block for log display, matching Django's approach.
 */
export function formatToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `$ ${(input.command as string) ?? ""}`.slice(0, 500);
    case "Read":
      return `📄 Read: ${input.file_path ?? ""}`;
    case "Write":
      return `✏️ Write: ${input.file_path ?? ""}`;
    case "Edit":
      return `✏️ Edit: ${input.file_path ?? ""}`;
    case "Grep":
    case "Glob":
      return `🔍 ${name}: ${input.pattern ?? ""}`;
    case "TodoWrite":
      return `📋 TodoWrite: updating tasks`;
    default:
      return `🔧 ${name}`;
  }
}
