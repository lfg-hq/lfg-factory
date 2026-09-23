/** Build origin belongs to the current operation, never to ticket creation.
 * Keep a durable routing record so workers can report after a restart.
 */
import { db } from '../config/db.ts';
import { ticketLogs, projectTickets } from '../db/schema/tickets.ts';
import { projects } from '../db/schema/projects.ts';
import { epics } from '../db/schema/epics.ts';
import { messages } from '../db/schema/chat.ts';
import { eq } from 'drizzle-orm';
import { notify } from './notify.ts';
import { broadcastToUser } from '../ws/connection-manager.ts';

export interface BuildOrigin { conversationId: string | null; userId: string | null; epicBuild?: boolean }
const originId = (ticketId: string) => `build-origin:${ticketId}`;
export async function setBuildOrigin(ticketId: string, conversationId: string | null, userId: string | null = null, epicBuild = false) {
  const output = JSON.stringify({ conversationId, userId, ...(epicBuild ? {epicBuild:true} : {}) });
  await db.insert(ticketLogs).values({ id: originId(ticketId), ticketId, logType: 'execution_origin',
    command: conversationId ? 'Build requested from chat' : 'Build requested outside chat', output,
  }).onConflictDoUpdate({ target: ticketLogs.id, set: { output, command: conversationId ? "Build requested from chat" : "Build requested outside chat", createdAt: new Date() } });
}
export async function getBuildOrigin(ticketId: string): Promise<BuildOrigin> {
  const [row] = await db.select({ output: ticketLogs.output }).from(ticketLogs).where(eq(ticketLogs.id, originId(ticketId))).limit(1);
  try { const value = JSON.parse(row?.output || '{}'); return {
    conversationId: typeof value.conversationId === 'string' && value.conversationId ? value.conversationId : null,
    userId: typeof value.userId === 'string' ? value.userId : null,
    ...(value.epicBuild ? {epicBuild:true} : {}),
  }; } catch { return { conversationId: null, userId: null }; }
}

async function deliverBuildStatus(ticketId: string, status: string, detail: string) {
  const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  if (!ticket) return;
  const [project] = await db.select().from(projects).where(eq(projects.id, ticket.projectId)).limit(1);
  if (!project) return;
  const origin = await getBuildOrigin(ticketId);
  const userId = origin.userId || project.ownerId;
  if (origin.epicBuild && ticket.epicId) {
    const [epic] = await db.select().from(epics).where(eq(epics.id,ticket.epicId)).limit(1);
    const label = ['failed','stopped','attention'].includes(status) ? 'Needs attention' : status === 'complete' ? 'Build progress updated' : 'Building';
    broadcastToUser(userId, { type:'epic_build_update', project_id:project.projectId, epic_id:ticket.epicId });
    if (['failed','stopped','attention'].includes(status)) await notify({userId, projectId:project.projectId, type:'build_'+status,targetType:'epic',targetId:ticket.epicId,message:(epic?.name || 'Feature')+': '+label,link:'/projects/'+project.projectId+'/epics?epic='+encodeURIComponent(ticket.epicId)});
    return;
  }
  const content = `${ticket.ticketKey ? ticket.ticketKey + ' — ' : ''}${ticket.name}: ${detail}`;
  await notify({ userId, projectId: project.projectId, type: `build_${status}`, targetType: 'ticket', targetId: ticketId,
    message: content, link: `/projects/${project.projectId}/tickets?ticket=${encodeURIComponent(ticketId)}`,
  }).catch(error => console.error('[build-reporting] Notification failed:', error));
  if (!origin.conversationId || origin.epicBuild) return;
  await db.insert(messages).values({ conversationId: origin.conversationId, role: 'assistant', content });
  broadcastToUser(userId, { type: 'message', sender: 'assistant', message: content,
    conversation_id: origin.conversationId, project_id: project.projectId, build_status: true });
}

// Reporting must never prevent execution or queue advancement.
export async function reportBuildStatus(ticketId: string, status: string, detail: string) {
  try { await deliverBuildStatus(ticketId, status, detail); }
  catch (error) { console.error('[build-reporting] Could not report status:', error); }
}
