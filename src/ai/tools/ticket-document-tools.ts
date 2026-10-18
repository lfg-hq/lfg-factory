import {tool, zodSchema} from 'ai';
import {z} from 'zod';

type Context = {projectId:string;publicProjectId:string;userId:string};
type Request = {ticketId:string;documentIds:string[];sourceDocumentId?:string};
type Dependencies = {
 access: (publicId:string,userId:string)=>Promise<{project:{id:string};permissions:{canChat:boolean;canManageTickets:boolean}}|null>;
 link: (projectId:string,request:Request)=>Promise<unknown>;
};

/** Add requirements to existing tickets without touching their implementation or build state. */
export function linkTicketDocumentsTool(context:Context, dependencies?:Dependencies) {
 return tool({
  description:'Attach relevant saved requirements documents to an EXISTING ticket, including completed tickets, without deleting/recreating it or restarting a build. First read the ticket and document contents to establish relevance; do this on the user’s behalf. Links are additive and idempotent. Optionally select the primary source document. Preserve code, branch, status, acceptance criteria and existing links. This does not audit implementation or approve a design. Updated context is used on the next build or ticket follow-up, not an already-running agent session.',
  inputSchema:zodSchema(z.object({
   ticketId:z.string(),
   documentIds:z.array(z.string().uuid()).min(1).max(40).describe('Relevant requirements documents read from this project; never guessed IDs or every document indiscriminately.'),
   sourceDocumentId:z.string().uuid().optional().describe('Primary requirements document, if it should be set or corrected. Must be included in documentIds.'),
  })),
  execute:async(request:Request)=>{
   const deps=dependencies??{
    access:(await import('../../auth/project-access.ts')).getProjectAccess,
    link:(await import('../../services/ticket-document-links.ts')).linkTicketDocuments,
   };
   const access=await deps.access(context.publicProjectId,context.userId);
   if(!access || access.project.id!==context.projectId || !access.permissions.canChat || !access.permissions.canManageTickets)return {error:'Project chat and ticket-management permissions are required.'};
   if(request.sourceDocumentId && !request.documentIds.includes(request.sourceDocumentId))return {error:'Include the primary source in documentIds.'};
   return deps.link(context.projectId,request);
  },
 });
}
