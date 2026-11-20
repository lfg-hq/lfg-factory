import { db } from '../config/db.ts';
import { epics } from '../db/schema/epics.ts';
import { eq, and, inArray } from 'drizzle-orm';
import { linkDocsToEpic } from './epics.ts';

/** A feature's own delivery docs. Only these follow the conversation's epic without being
 * told to; a case study, overview or research note written in the same chat stays a
 * project doc unless the agent links it on purpose. */
const FEATURE_DOC_TYPES = new Set(['prd', 'tech_analysis', 'implementation', 'spec', 'design', 'design_language']);
export function isFeatureDocType(fileType: unknown): boolean {
  return typeof fileType === 'string' && FEATURE_DOC_TYPES.has(fileType.trim().toLowerCase());
}

/** Only infer a saved epic when the conversation has one unambiguous active feature. */
export async function conversationEpic(projectId: string, conversationId: string): Promise<string | undefined> {
  const rows = await db.select({id:epics.id}).from(epics).where(and(
    eq(epics.projectId,projectId), eq(epics.conversationId,conversationId),
    inArray(epics.status,['draft','building','in_review']),
  ));
  return rows.length === 1 ? rows[0]!.id : undefined;
}
export { linkDocsToEpic };

// Store pending associations across chat turns; never sweep unrelated project docs.
import { toolCallHistory } from '../db/schema/documents.ts';
export async function rememberPendingDocument(projectId: string, conversationId: string, fileId: string) {
  await db.insert(toolCallHistory).values({projectId,conversationId,toolName:'pendingEpicDocument',
    toolInput:{fileId},generatedContent:'',contentType:'epic_context'});
}
export async function linkPendingDocuments(projectId: string, conversationId: string, epicId: string, userId: string) {
  const rows = await db.select().from(toolCallHistory).where(and(eq(toolCallHistory.projectId,projectId),
    eq(toolCallHistory.conversationId,conversationId),eq(toolCallHistory.toolName,'pendingEpicDocument')));
  const fileIds = rows.map(row => (row.toolInput as {fileId?:string})?.fileId).filter((id):id is string => !!id);
  if (!fileIds.length) return;
  await linkDocsToEpic(epicId,fileIds,userId);
  await db.delete(toolCallHistory).where(inArray(toolCallHistory.id,rows.map(row => row.id)));
}
