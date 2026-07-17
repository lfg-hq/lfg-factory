/**
 * Notifications — powers the dashboard inbox (assigned tickets, @mentions,
 * comments). Writes a row and pushes it live to the recipient over WebSocket.
 */
import { db } from "../config/db.ts";
import { notifications } from "../db/schema/notifications.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";

export interface NotifyRef {
  type: "document" | "ticket";
  id: string;
  name: string;
}

export interface NotifyParams {
  userId: string; // recipient
  actorId?: string | null; // who triggered it
  projectId?: string | null; // public projectId
  type: string; // assigned | mentioned | comment | comment_reply | comment_resolved
  targetType: string; // ticket | document
  targetId: string;
  message: string;
  link?: string | null;
  refs?: NotifyRef[] | null; // clickable referenced docs/tickets
}

export async function notify(p: NotifyParams) {
  // Never notify someone about their own action.
  if (p.actorId && p.userId === p.actorId) return null;
  const [row] = await db
    .insert(notifications)
    .values({
      userId: p.userId,
      actorId: p.actorId ?? null,
      projectId: p.projectId ?? null,
      type: p.type,
      targetType: p.targetType,
      targetId: p.targetId,
      message: p.message,
      link: p.link ?? null,
      refs: p.refs && p.refs.length ? JSON.stringify(p.refs) : null,
    })
    .returning();
  try {
    broadcastToUser(p.userId, { type: "notification", notification: row });
  } catch {
    /* WS best-effort */
  }
  return row ?? null;
}
