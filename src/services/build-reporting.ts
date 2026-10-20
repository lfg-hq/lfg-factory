/** Build origin belongs to the current operation, never to ticket creation.
 * Keep a durable routing record so workers can report after a restart.
 */
import { db } from '../config/db.ts';
import { ticketLogs, projectTickets } from '../db/schema/tickets.ts';
import { projects } from '../db/schema/projects.ts';
import { messages } from '../db/schema/chat.ts';
import { eq } from 'drizzle-orm';
import { notify } from './notify.ts';
import { broadcastToUser } from '../ws/connection-manager.ts';

export interface BuildOrigin { conversationId: string | null; userId: string | null; inRun?: boolean }
const originId = (ticketId: string) => `build-origin:${ticketId}`;
/** `inRun`: the ticket is part of a build run, whose card and announcements report it. */
export async function setBuildOrigin(ticketId: string, conversationId: string | null, userId: string | null = null, inRun = false) {
  const output = JSON.stringify({ conversationId, userId, ...(inRun ? { inRun: true } : {}) });
  await db.insert(ticketLogs).values({ id: originId(ticketId), ticketId, logType: 'execution_origin',
    command: conversationId ? 'Build requested from chat' : 'Build requested outside chat', output,
  }).onConflictDoUpdate({ target: ticketLogs.id, set: { output, command: conversationId ? "Build requested from chat" : "Build requested outside chat", createdAt: new Date() } });
}
export async function getBuildOrigin(ticketId: string): Promise<BuildOrigin> {
  const [row] = await db.select({ output: ticketLogs.output }).from(ticketLogs).where(eq(ticketLogs.id, originId(ticketId))).limit(1);
  try { const value = JSON.parse(row?.output || '{}'); return {
    conversationId: typeof value.conversationId === 'string' && value.conversationId ? value.conversationId : null,
    userId: typeof value.userId === 'string' ? value.userId : null,
    ...(value.inRun ? { inRun: true } : {}),
  }; } catch { return { conversationId: null, userId: null }; }
}

async function deliverBuildStatus(ticketId: string, status: string, detail: string) {
  const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  if (!ticket) return;
  const [project] = await db.select().from(projects).where(eq(projects.id, ticket.projectId)).limit(1);
  if (!project) return;
  const origin = await getBuildOrigin(ticketId);
  const userId = origin.userId || project.ownerId;
  const content = `${ticket.ticketKey ? ticket.ticketKey + ' — ' : ''}${ticket.name}: ${detail}`;
  await notify({ userId, projectId: project.projectId, type: `build_${status}`, targetType: 'ticket', targetId: ticketId,
    message: content, link: `/projects/${project.projectId}/tickets?ticket=${encodeURIComponent(ticketId)}`,
  }).catch(error => console.error('[build-reporting] Notification failed:', error));
  // The chat's live build card shows queued/started; run tickets are reported by the run.
  if (!origin.conversationId || origin.inRun || status === 'queued' || status === 'started') return;
  await db.insert(messages).values({ conversationId: origin.conversationId, role: 'assistant', userRole:'operation_status', content });
  broadcastToUser(userId, { type: 'message', sender: 'assistant', message: content,
    conversation_id: origin.conversationId, project_id: project.projectId, build_status: true });
}

// Reporting must never prevent execution or queue advancement.
export async function reportBuildStatus(ticketId: string, status: string, detail: string) {
  try { await deliverBuildStatus(ticketId, status, detail); }
  catch (error) { console.error('[build-reporting] Could not report status:', error); }
}
