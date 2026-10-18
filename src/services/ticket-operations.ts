import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { db } from '../config/db.ts';
import { ticketLogs, projectTickets } from '../db/schema/tickets.ts';
import { projects } from '../db/schema/projects.ts';
import { messages, conversations } from '../db/schema/chat.ts';
import { eq, and, sql, desc } from 'drizzle-orm';
import {getChatAccess} from './chat-access.ts';
import { getProjectAccess } from '../auth/project-access.ts';
import { broadcastToUser } from '../ws/connection-manager.ts';

export type OperationStatus = 'queued' | 'running' | 'needs_input' | 'failed' | 'completed';
export interface TicketOperation {
 id:string;ticketId:string;projectId:string;publicProjectId:string;conversationId:string;userId:string;
 status:OperationStatus;requestHash?:string;detail:string;updatedAt:string;waitingForInput?:boolean;lastAnswerTurnId?:string;selectedBranch?:string|null;publication?:{branch:string;anchor:string;sha:string};
}
const context = new AsyncLocalStorage<string>();
export function operationId(ticketId:string,conversationId:string,turnId:string,message:string) {
 return 'ticket-operation:'+createHash('sha256').update(JSON.stringify([ticketId,conversationId,turnId,message])).digest('hex');
}
export async function authorizeTicketOperation(ticketId:string,projectId:string,userId:string,conversationId:string) {
 const [ticket]=await db.select().from(projectTickets).where(and(eq(projectTickets.id,ticketId),eq(projectTickets.projectId,projectId)));
 const [project]=await db.select().from(projects).where(eq(projects.id,projectId));
 const [conversation]=await db.select().from(conversations).where(eq(conversations.id,conversationId));
 if(!ticket || !project || !conversation || ![project.id,project.projectId].includes(conversation.projectId || '')) throw Error('Ticket and conversation must belong to this project.');
 if(!(await getChatAccess(conversationId,userId)).canWrite)throw Error('You cannot continue this conversation.');
 const access=await getProjectAccess(project.projectId,userId);
 if(!access?.permissions.canChat || !access.permissions.canEditFiles || !access.permissions.canManageTickets) throw Error('Chat, edit and ticket permissions are required.');
 return {ticket,project};
}
export async function readTicketOperation(id:string):Promise<TicketOperation|null> {
 const [row]=await db.select().from(ticketLogs).where(and(eq(ticketLogs.id,id),eq(ticketLogs.logType,'chat_operation')));
 return row?.output ? JSON.parse(row.output) : null;
}
export async function createTicketOperation(input:{ticketId:string;projectId:string;conversationId:string;userId:string;turnId:string;message:string}) {
 const {project}=await authorizeTicketOperation(input.ticketId,input.projectId,input.userId,input.conversationId);
 const requestHash=createHash('sha256').update(input.message.trim()).digest('hex');
 const recent=await db.select().from(ticketLogs).where(and(eq(ticketLogs.ticketId,input.ticketId),eq(ticketLogs.logType,'chat_operation'))).orderBy(desc(ticketLogs.createdAt));
 for(const row of recent) {
  const existing=JSON.parse(row.output||'{}') as TicketOperation;
  if(existing.conversationId!==input.conversationId)continue;
  if(['queued','running'].includes(existing.status) && existing.requestHash===requestHash)return {operation:existing,created:false};
  if(existing.lastAnswerTurnId===input.turnId)return {operation:existing,created:false};
  if(existing.status==='needs_input' && existing.waitingForInput) {
   const answered={...existing,status:'running' as const,waitingForInput:false,lastAnswerTurnId:input.turnId,detail:'Your answer was delivered to the waiting ticket agent.',updatedAt:new Date().toISOString()};
   const marker='\nINPUT_RESPONSE:'+input.ticketId+':'+input.message;
   const claim=(tx:typeof db)=>tx.update(ticketLogs).set({output:JSON.stringify(answered)}).where(and(eq(ticketLogs.id,existing.id),eq(ticketLogs.output,row.output!))).returning({id:ticketLogs.id});
   const answer=(tx:typeof db)=>tx.update(projectTickets).set({notes:sql`coalesce(${projectTickets.notes}, '') || ${marker}`,updatedAt:new Date()}).where(eq(projectTickets.id,input.ticketId));
   if(process.env.DATABASE_DRIVER==='postgresql') {
    await db.transaction(async tx=>{
      if(!(await claim(tx as any)).length)throw Error('The pending question changed; check its status before replying again.');
      await answer(tx as any);
    });
   }else{
    db.transaction(tx=>{
      if(!claim(tx as any).get())throw Error('The pending question changed; check its status before replying again.');
      answer(tx as any).run();
    });
   }
   return {operation:answered,created:false};
  }
 }
 const id=operationId(input.ticketId,input.conversationId,input.turnId,input.message);
 const {getPreviewState}=await import('./dev-preview.ts');
 const preview=await getPreviewState(input.projectId).catch(()=>null);
 const operation:TicketOperation={id,ticketId:input.ticketId,projectId:input.projectId,publicProjectId:project.projectId,conversationId:input.conversationId,userId:input.userId,selectedBranch:preview?.branch,requestHash,status:'queued',detail:'Repair or question queued for the ticket agent.',updatedAt:new Date().toISOString()};
 const inserted=await db.insert(ticketLogs).values({id,ticketId:input.ticketId,logType:'chat_operation',command:'Chat follow-up',output:JSON.stringify(operation)}).onConflictDoNothing().returning({id:ticketLogs.id});
 return {operation:(await readTicketOperation(id))!,created:inserted.length>0};
}
export async function updateTicketOperation(status:OperationStatus,detail:string,id=context.getStore()) {
 if(!id)return;
 const operation=await readTicketOperation(id);if(!operation)return;
 operation.status=status;if(status==='failed'||status==='completed')operation.waitingForInput=false;operation.detail=detail;operation.updatedAt=new Date().toISOString();
 await db.update(ticketLogs).set({output:JSON.stringify(operation)}).where(eq(ticketLogs.id,id));
 if(status==='running'||status==='queued')return;
 // A deterministic message ID makes redelivery safe; retain operation-owned origin.
 const messageId=id+':'+status+':'+createHash('sha256').update(detail).digest('hex').slice(0,12);
 const rows=await db.insert(messages).values({id:messageId,conversationId:operation.conversationId,role:'assistant',userRole:'operation_status',content:detail}).onConflictDoNothing().returning({id:messages.id});
 if(rows.length)broadcastToUser(operation.userId,{type:'message',sender:'assistant',message:detail,conversation_id:operation.conversationId,project_id:operation.publicProjectId,build_status:true,operation_id:id});
}
export async function withTicketOperation(id:string|undefined,run:()=>Promise<void>) {
 if(!id)return run();
 return context.run(id,async()=>{
  const op=await readTicketOperation(id);if(!op || op.status!=='queued')return;
  const claimed={...op,status:'running' as const,detail:'Ticket agent is working.',updatedAt:new Date().toISOString()};
  const rows=await db.update(ticketLogs).set({output:JSON.stringify(claimed)}).where(and(eq(ticketLogs.id,id),eq(ticketLogs.output,JSON.stringify(op)))).returning({id:ticketLogs.id});
  if(!rows.length)return;
  try {
   await run();
   const finished=await readTicketOperation(id);
   if(finished?.publication) await finishPublishedOperation(finished);
   if((await readTicketOperation(id))?.status==='running' || (await readTicketOperation(id))?.waitingForInput)await updateTicketOperation('failed','The ticket turn ended without a verified outcome. Saved work is retained; inspect the ticket before retrying.');
  } catch(e) {await updateTicketOperation('failed',`Ticket follow-up failed: ${(e as Error).message}`);throw e;}
 });
}

export async function publishTicketOperation(branch:string,anchor:string,sha:string,detail:string) {
 const id=context.getStore();if(!id)return;
 const op=await readTicketOperation(id);if(!op)return;
 op.publication={branch,anchor,sha};op.detail=detail;op.updatedAt=new Date().toISOString();
 await db.update(ticketLogs).set({output:JSON.stringify(op)}).where(eq(ticketLogs.id,id));
}
async function finishPublishedOperation(op:TicketOperation) {
 const {getPreviewState,restartPreview}=await import('./dev-preview.ts');
 const state=await getPreviewState(op.projectId).catch(()=>null);
 const selected=state?.branch || '(default)';
 const publication=op.publication!;
 let detail=`Ticket changes published: ${publication.branch} (${publication.sha.slice(0,12)}), merged into ${publication.anchor}.`;
 if(state?.previewStatus==='running' && selected===op.selectedBranch && [publication.branch,publication.anchor].includes(selected)) {
  const result=await restartPreview(op.projectId,{userId:op.userId,branch:selected,expectedBranch:selected,conversationId:op.conversationId}).catch(e=>({error:(e as Error).message}));
  detail+='error' in result ? ` Preview refresh did not complete: ${result.error}` : ` Preview updated: ${result.previewUrl}. Availability passed; the refreshed preview's full user workflow has not been independently verified.`;
 } else detail+=' The selected Preview was left unchanged. Select the published branch when you want to preview this change.';
 await updateTicketOperation('completed',detail,op.id);
}
export async function recoverTicketOperations(before=Date.now()) {
 const rows=await db.select().from(ticketLogs).where(eq(ticketLogs.logType,'chat_operation'));
 for(const row of rows) {
  let op:TicketOperation;try{op=JSON.parse(row.output || '{}');}catch{continue;}
  if(Date.parse(op.updatedAt)<before && (op.status==='queued'||op.status==='running'||op.waitingForInput))await updateTicketOperation('failed','The server restarted before this operation recorded a final outcome. Saved ticket work is retained. Check the ticket before resuming; the operation was not replayed automatically.',op.id);
 }
}

export async function noteTicketOperationInput(ticketId:string,question:string,options:string[]=[]) {
 const rows=await db.select().from(ticketLogs).where(and(eq(ticketLogs.ticketId,ticketId),eq(ticketLogs.logType,'chat_operation')));
 for(const row of rows){const op=JSON.parse(row.output||'{}') as TicketOperation;if(op.status!=='running')continue;
  op.waitingForInput=true;
  await db.update(ticketLogs).set({output:JSON.stringify(op)}).where(eq(ticketLogs.id,op.id));
  await updateTicketOperation('needs_input',question+(options.length?'\n\n'+options.map(o=>'- '+o).join('\n'):''),op.id);
 }
}
