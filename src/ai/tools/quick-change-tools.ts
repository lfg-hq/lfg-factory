import {tool,zodSchema} from 'ai';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {db} from '../../config/db.ts';
import {projects} from '../../db/schema/projects.ts';
import {projectTickets} from '../../db/schema/tickets.ts';
import {eq} from 'drizzle-orm';
import {getProjectAccess} from '../../auth/project-access.ts';
import {createEpic} from '../../services/epics.ts';
import {createBuildRun,getActiveRun} from '../../services/build-queue.ts';
import {nextTicketKey} from '../../utils/ticket-keys.ts';
const pending=new Map<string,Promise<unknown>>();
export function quickChangeTool(context:{projectId:string;userId:string;conversationId:string;turnId:string}) {
 return tool({description:'Build one explicitly requested small new change to an existing repository without requiring PRD/technical documents. Provide self-contained scope and testable acceptance criteria. Reuse sendTicketMessage for repairs to an existing ticket; use the feature workflow (requirements, technical analysis, tickets) for a new substantial feature.',
 inputSchema:zodSchema(z.object({approvedByUser:z.literal(true),name:z.string().min(1).max(150),description:z.string().min(20).max(12000),acceptanceCriteria:z.array(z.string().min(1)).min(2).max(8)})),
 execute:async(args)=>{
  if(!args.approvedByUser)return {error:'An explicit request to implement this change is required.'};
  const key=context.projectId+':'+context.conversationId+':'+context.turnId;
  if(pending.has(key))return pending.get(key)!;
  const work=async()=>{
   const [project]=await db.select().from(projects).where(eq(projects.id,context.projectId));
   if(!project)return {error:"Project not found"};
   const access=await getProjectAccess(project.projectId,context.userId);
   if(!access?.permissions.canChat||!access.permissions.canEditFiles||!access.permissions.canManageTickets)return {error:'Project chat, edit and ticket permissions are required.'};
   if(!project.repoUrl && !project.repoName)return {error:'Quick changes require an existing repository; use the new-project build workflow.'};
   const raw=createHash('sha256').update(key).digest('hex');
   const id=raw.slice(0,8)+'-'+raw.slice(8,12)+'-4'+raw.slice(13,16)+'-a'+raw.slice(17,20)+'-'+raw.slice(20,32);
   let [ticket]=await db.select().from(projectTickets).where(eq(projectTickets.id,id));
   const active=await getActiveRun(project.id);
   if(active?.items.some(item=>item.ticketId===id))return {status:active.status,runId:active.runId,ticketId:id,note:'This change is already tracked by the existing build.'};
   if(active)return {status:'not_started',runId:active.runId,detail:'A project build is already active. Check that build before starting another.'};
   if(!ticket){
    const epic=await createEpic({projectId:project.id,name:args.name,createdById:context.userId,conversationId:context.conversationId});
    [ticket]=await db.insert(projectTickets).values({id,projectId:project.id,epicId:epic.id,conversationId:context.conversationId,ticketKey:await nextTicketKey(project.id,project.name),name:args.name,description:args.description,acceptanceCriteria:args.acceptanceCriteria,complexity:'simple',details:{workflow:'quick-change'}}).onConflictDoNothing().returning();
    if(!ticket)[ticket]=await db.select().from(projectTickets).where(eq(projectTickets.id,id));
   }
   if(!ticket)throw Error('Quick-change ticket could not be created');
   if(['review','done'].includes(ticket.status))return {ticketId:id,status:ticket.status,note:'This change already completed; use sendTicketMessage for a follow-up.'};
   const run=await createBuildRun({projectId:project.id,userId:context.userId,conversationId:context.conversationId,epicId:ticket.epicId,ticketIds:[id],afterBuild:'preview',triggerMessage:args.description});
   return {...run,ticketId:id,ticketKey:ticket.ticketKey,status:'queued'};
  };
  const promise=work();pending.set(key,promise);try{return await promise;}finally{pending.delete(key);}
 }});
}
