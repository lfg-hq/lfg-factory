import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { db } from '../../config/db.ts';
import { eq, and, asc } from 'drizzle-orm';
import { projects } from '../../db/schema/projects.ts';
import { projectTickets, ticketStages } from '../../db/schema/tickets.ts';
import { getProjectAccess } from '../../auth/project-access.ts';
import { getEpic, listEpicDocs } from '../../services/epics.ts';
import { createBuildRun, getActiveRun, resumeBlockedRun } from '../../services/build-queue.ts';
import { nextTicketKey } from '../../utils/ticket-keys.ts';

// One server dispatches the queue. Coalesce overlapping tool calls before any rows
// are created; the durable active-run check handles repeats after dispatch/restart.
const pending = new Map<string, {epicId:string; userId:string; promise:Promise<unknown>}>();
export function buildEpicTool(context: {projectId: string; userId: string; conversationId: string}) {
  return tool({
    description: 'Build an epic ONLY after the user explicitly approves building its documented requirements. Supply self-contained implementation steps in dependency order, with acceptance criteria and source document ids. These are private implementation details, never present them as tickets in chat. On retry, omit steps: existing work is reused and an interrupted build resumes. No code is built during requirements planning.',
    inputSchema: zodSchema(z.object({
      epicId: z.string(),
      approvedByUser: z.literal(true).describe('True only when the user explicitly said to build this epic; document generation is not approval.'),
      steps: z.array(z.object({
        name: z.string().min(1), description: z.string().min(20).describe('Self-contained Markdown implementation instructions, UI requirements, edge cases and document references.'),
        acceptanceCriteria: z.array(z.string()).min(2),
        sourceDocumentId: z.string(),
        priority: z.enum(['High','Medium','Low']).default('Medium'),
        complexity: z.enum(['simple','medium','complex']).default('medium'),
      })).min(1).max(40).optional(),
    })),
    execute: async ({epicId, approvedByUser, steps}, options) => {
      if (!approvedByUser) return {error:'Build approval is required.'};
      const preparing = pending.get(context.projectId);
      if (preparing) return preparing.epicId === epicId && preparing.userId === context.userId
        ? preparing.promise : {error:"Another feature build request is being prepared. Please retry shortly."};
      const execute = async () => {
        const [project] = await db.select().from(projects).where(eq(projects.id,context.projectId)).limit(1);
        if (!project?.epicBuildsEnabled) return {error:'Epic builds are disabled in this project.'};
        const access = await getProjectAccess(project.projectId, context.userId);
        if (!access || !access.permissions.canManageTickets || !access.permissions.canChat) return {error:'You do not have permission to build this project.'};
        const epic = await getEpic(epicId);
        if (!epic || epic.projectId !== project.id) return {error:'Epic not found in this project.'};
        if (['merged','rejected'].includes(epic.status)) return {error:'Start a new epic for changes to this completed or rejected feature.'};
        const active = await getActiveRun(project.id);
        if (active) {
          if (active.epicId !== epicId) return {error:'Another feature is building. Finish or stop that build first.'};
          if (active.status === 'blocked') await resumeBlockedRun(project.id);
          return {epicId, name:epic.name, status:active.status === 'blocked' ? 'resuming' : 'building', runId:active.runId};
        }
        const docs = await listEpicDocs(epicId);
        if (!docs.some(d => d.fileType === 'prd')) return {error:'Write and review the epic PRD before building.'};
        let rows = await db.select().from(projectTickets).where(and(eq(projectTickets.projectId,project.id),eq(projectTickets.epicId,epicId))).orderBy(asc(projectTickets.executionOrder),asc(projectTickets.createdAt));
        if (rows.some(t=>["queued","executing","stopping"].includes(t.queueStatus))) return {epicId,name:epic.name,status:"building",note:"Existing feature work is still running. Wait for it to finish before starting another build."};
        if (!rows.length) {
          if (!steps?.length) return {error:'Provide an implementation plan for the approved requirements.'};
          const docIds = new Set(docs.map(d=>d.id));
          if (steps.some(s=>!docIds.has(s.sourceDocumentId))) return {error:'Every implementation step must reference a document belonging to this epic.'};
          const stages = await db.select().from(ticketStages).where(eq(ticketStages.projectId,project.id));
          const stage = stages.find(s=>s.name === 'Backlog') || stages[0];
          const values = [];
          for (const [index,step] of steps.entries()) {
            values.push({id:crypto.randomUUID(),projectId:project.id,epicId,conversationId:context.conversationId,
              ticketKey:await nextTicketKey(project.id,project.name),name:step.name,description:step.description,
              acceptanceCriteria:step.acceptanceCriteria,sourceDocumentId:step.sourceDocumentId,
              priority:step.priority,complexity:step.complexity,executionOrder:index,stageId:stage?.id ?? null});
          }
          // One insert is atomic: a failed write cannot leave a half-created plan.
          await db.insert(projectTickets).values(values);
          rows = await db.select().from(projectTickets).where(and(eq(projectTickets.projectId,project.id),eq(projectTickets.epicId,epicId))).orderBy(asc(projectTickets.executionOrder),asc(projectTickets.createdAt));
        }
        const remaining = rows.filter(t=>!['review','done','archived'].includes(t.status));
        if (!remaining.length) return {epicId,name:epic.name,status:'ready_for_review',previewUrl:epic.previewUrl};
        const result = await createBuildRun({projectId:project.id,userId:context.userId,conversationId:context.conversationId,epicId,ticketIds:remaining.map(t=>t.id),afterBuild:'preview',epicBuild:true,triggerMessage:'Build approved feature: '+epic.name});
        if (!result.runId) return {error:'The feature could not be queued. Please retry.'};
        return {epicId,name:epic.name,status:'building',runId:result.runId,note:'The feature is building. A preview will be provided when ready.'};
      };
      const promise = execute(); pending.set(context.projectId,{epicId,userId:context.userId,promise});
      try { return await promise; } finally {pending.delete(context.projectId);}
    },
  });
}

export const EPIC_BUILD_PROMPT = `
## Epic build workflow — enabled for this project
This replaces the default ticket-oriented delivery workflow for this chat.
1. Understand the feature, check epic overlap, and start one epic. Create its PRD and the technical/design documentation that the feature needs. Always attach those docs to that epic. Show the requirements and ask for explicit build approval before execution.
2. When the user approves building, call buildEpic with that epic id and an ordered, self-contained implementation plan grounded in the epic's documents. The tool manages internal work and sequential execution. Do not call ticket creation or ticket execution tools.
3. Speak only about the feature, its requirements, build progress, issues and preview. Do not list implementation tickets, ticket keys, counts, or direct the user to Tickets in chat. Internal tools and historical ticket messages are implementation context only. Do not claim execution happened unless buildEpic succeeded.
4. Use getEpicStatus to inspect progress. If a build pauses, explain the feature-level issue and offer to resume with buildEpic after the user asks. Do not report preview readiness unless an actual preview URL was returned.
5. Existing documents or a request to draft a PRD are not authorization to build. Reuse the correct epic for follow-ups; do not create duplicate epics or work on retries.
`;
