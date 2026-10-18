import {db} from '../config/db.ts';
import {projectTickets} from '../db/schema/tickets.ts';
import {projectFiles} from '../db/schema/documents.ts';
import {and,eq,inArray,isNull} from 'drizzle-orm';
import {emitTicketUpdated} from '../events/emitters.ts';

import {mergeTicketDocumentIds} from './ticket-context-documents.ts';
export async function linkTicketDocuments(projectId:string,request:{ticketId:string;documentIds:string[];sourceDocumentId?:string}) {
 const ids=[...new Set(request.documentIds)];
 const result=await (async()=>{
  const [ticket]=await db.select().from(projectTickets).where(and(eq(projectTickets.id,request.ticketId),eq(projectTickets.projectId,projectId)));
  if(!ticket)return {error:'Ticket not found in this project.'};
  const docs=await db.select().from(projectFiles).where(and(eq(projectFiles.projectId,projectId),eq(projectFiles.isActive,true),inArray(projectFiles.id,ids)));
  if(docs.length!==ids.length)return {error:'Every document must be active and belong to this project. No links were changed.'};
  if(docs.some(doc=>['page_preview','design_baseline'].includes(doc.fileType)))return {error:'Use the design approval workflow for previews. This tool attaches requirements documents.'};
  if(request.sourceDocumentId && !ids.includes(request.sourceDocumentId))return {error:'Include the primary source in documentIds.'};
  // Optimistic guard prevents clobbering a concurrent ticket edit.
  const changed=await db.update(projectTickets).set({
   details:mergeTicketDocumentIds(ticket.details,ids),
   ...(request.sourceDocumentId ? {sourceDocumentId:request.sourceDocumentId}:{}),updatedAt:new Date(),
  }).where(and(eq(projectTickets.id,ticket.id),eq(projectTickets.projectId,projectId),ticket.details==null ? isNull(projectTickets.details) : eq(projectTickets.details,ticket.details),ticket.sourceDocumentId==null ? isNull(projectTickets.sourceDocumentId) : eq(projectTickets.sourceDocumentId,ticket.sourceDocumentId))).returning({id:projectTickets.id});
  if(!changed.length)return {error:'The ticket changed while linking documents. Read it again and retry; no links were changed.'};
  return {success:true,ticketId:ticket.id,ticketKey:ticket.ticketKey,documentIds:(mergeTicketDocumentIds(ticket.details,ids).sourceDocumentIds as string[]),sourceDocumentId:request.sourceDocumentId??ticket.sourceDocumentId,note:'Documents attached. Existing work and status are preserved. The next build or ticket follow-up will receive this context; existing code has not been audited.'};
 })();
 if('success' in result)emitTicketUpdated({ticketId:request.ticketId,projectId,changes:{documentIds:result.documentIds,sourceDocumentId:result.sourceDocumentId}});
 return result;
}
