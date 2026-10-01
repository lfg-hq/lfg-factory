import {createHash} from 'node:crypto';
import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { db } from '../../config/db.ts';
import { eq, and, asc } from 'drizzle-orm';
import { projects } from '../../db/schema/projects.ts';
import { projectTickets, ticketStages } from '../../db/schema/tickets.ts';
import { getProjectAccess } from '../../auth/project-access.ts';
import { getEpic, listEpicDocs } from '../../services/epics.ts';
import { createBuildRun, getActiveRun, resumeBlockedRun, cancelBlockedRun } from '../../services/build-queue.ts';
import { nextTicketKey } from '../../utils/ticket-keys.ts';

// One server dispatches the queue. Coalesce overlapping tool calls before any rows
// are created; the durable active-run check handles repeats after dispatch/restart.
const pending = new Map<string, {epicId:string; userId:string; promise:Promise<unknown>}>();
export function buildEpicTool(context: {projectId: string; userId: string; conversationId: string}) {
  return tool({
    description: 'Build an epic ONLY after the user explicitly approves building its documented requirements. Supply the complete approved requirements as self-contained implementation milestones, with acceptance criteria and source document ids. The entire plan becomes ONE build ticket; milestones are its internal checklist, not separate builds. On retry, omit steps: existing work is reused and an interrupted build resumes. No code is built during requirements planning.',
    inputSchema: zodSchema(z.object({
      epicId: z.string(),
      approvedByUser: z.literal(true).describe('True only when the user explicitly said to build this epic; document generation is not approval.'),
      replaceBlockedRunId: z.string().optional().describe('Exact blocking run ID returned by this tool. Set only when the user explicitly asks to abandon/replace that old blocked build and build this epic instead. Never use for a running build.'),
      steps: z.array(z.object({
        name: z.string().min(1), description: z.string().min(20).describe('Self-contained Markdown implementation instructions, UI requirements, edge cases and document references.'),
        acceptanceCriteria: z.array(z.string()).min(2),
        sourceDocumentId: z.string(),
        priority: z.enum(['High','Medium','Low']).default('Medium'),
        complexity: z.enum(['simple','medium','complex']).default('medium'),
      })).min(1).max(40).optional(),
    })),
    execute: async ({epicId, approvedByUser, steps, replaceBlockedRunId}, options) => {
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
        if (active?.epicId === epicId) {
          if (active.status === 'blocked' && !await resumeBlockedRun(project.id)) return {error:'Build state changed. Check its current status before retrying.',status:'not_started'};
          return {epicId, name:epic.name, status:active.status === 'blocked' ? 'resuming' : 'building', runId:active.runId};
        }
        if (active && (active.status !== 'blocked' || replaceBlockedRunId !== active.runId)) {
          return {error:active.status === 'blocked'
            ? 'Another feature build is paused after a failure. Nothing was queued for this epic. Ask the user in this chat whether to replace that blocked build, then call buildEpic with replaceBlockedRunId and the approved plan.'
            : 'Another feature is actively building. Nothing was queued for this epic. Wait for it to finish; do not claim this request will start automatically.',
            status:'not_started',queued:false,blockingRun:{runId:active.runId,epicId:active.epicId,status:active.status},canReplace:active.status==='blocked'};
        }
        if (replaceBlockedRunId && !active) return {error:'The blocking run has changed or ended. Retry without replacement after checking status.',status:'not_started'};
        const docs = await listEpicDocs(epicId);
        if (!docs.some(d => d.fileType === 'prd')) return {error:'Write and review the epic PRD before building.'};
        let rows = await db.select().from(projectTickets).where(and(eq(projectTickets.projectId,project.id),eq(projectTickets.epicId,epicId))).orderBy(asc(projectTickets.executionOrder),asc(projectTickets.createdAt));
        if (rows.some(t=>["queued","executing","stopping"].includes(t.queueStatus))) return {epicId,name:epic.name,status:"building",note:"Existing feature work is still running. Wait for it to finish before starting another build."};
        if (!rows.length && (!steps?.length || steps.some(s=>!docs.some(d=>d.id===s.sourceDocumentId)))) return {error:'Provide an implementation plan whose steps reference documents belonging to this epic.',status:'not_started'};
        if (!rows.length && !docs.some(d=>['tech_analysis','implementation'].includes(d.fileType))) return {error:'Review and attach the technical analysis before building the complete feature.',status:'not_started'};
        if (active && !await cancelBlockedRun(project.id, active.runId)) return {error:'The previous build state changed; it was not replaced. Check status before retrying.',status:'not_started'};
        if (!rows.length) {
          if (!steps?.length) return {error:'Provide an implementation plan for the approved requirements.'};
          const docIds = new Set(docs.map(d=>d.id));
          if (steps.some(s=>!docIds.has(s.sourceDocumentId))) return {error:'Every implementation step must reference a document belonging to this epic.'};
          const stages = await db.select().from(ticketStages).where(eq(ticketStages.projectId,project.id));
          const stage = stages.find(s=>s.name === 'Backlog') || stages[0];
          const plan = singleEpicTicketPlan(epic, steps, docs);
          // Stable identity prevents duplicate tickets after a restart or a lost response.
          const values = [{id:singleEpicTicketId(epicId),projectId:project.id,epicId,conversationId:context.conversationId,
            ticketKey:await nextTicketKey(project.id,project.name),...plan,
            executionOrder:0,stageId:stage?.id ?? null}];
          await db.insert(projectTickets).values(values).onConflictDoNothing({target:projectTickets.id});
          rows = await db.select().from(projectTickets).where(and(eq(projectTickets.projectId,project.id),eq(projectTickets.epicId,epicId))).orderBy(asc(projectTickets.executionOrder),asc(projectTickets.createdAt));
        }
        // Legacy epics remain on their original workflow; new builds never convert their history.
        const remaining = rows.filter(t=>!['review','done','archived'].includes(t.status));
        if (!remaining.length) return {epicId,name:epic.name,status:'ready_for_review',previewUrl:epic.previewUrl};
        const result = await createBuildRun({projectId:project.id,userId:context.userId,conversationId:context.conversationId,epicId,ticketIds:remaining.map(t=>t.id),afterBuild:'preview',epicBuild:true,triggerMessage:'Build approved feature: '+epic.name});
        if (!result.runId) return {error:'The feature could not be queued. Please retry.'};
        return {epicId,name:epic.name,status:'building',runId:result.runId,note:rows.length===1 && (rows[0]!.details as any)?.epicBuildMode==='single-ticket' ? 'The complete feature is building in one ticket. Follow its implementation checklist and preview here.' : 'This existing epic retains its original ticket plan and saved work; it has not been converted. A preview will be provided when ready.'};
      };
      const promise = execute(); pending.set(context.projectId,{epicId,userId:context.userId,promise});
      try { return await promise; } finally {pending.delete(context.projectId);}
    },
  });
}

export const EPIC_BUILD_PROMPT = `
## Epic build workflow — enabled for this project
This replaces the default ticket-oriented delivery workflow for this chat.
1. Understand the feature, check epic overlap, and start one epic. Preserve every explicit user requirement. Before writing technical documentation, brainstorm material implementation choices WITH the user in this chat: explain the viable approaches in plain language, their hosting/runtime needs, operating cost, maintenance and user-experience tradeoffs. For example, a renderer might use an installed binary in the app container, a separate worker/container, a library (which may itself require that binary), or a hosted service. These are examples, not mandatory choices. Ground options in inspected repository evidence; do not invent library limitations, available image versions, or compatibility claims. Recommend an approach and ask the user to choose or explicitly delegate the choice. STOP and wait when a material decision is unresolved. A product-scope answer is not approval of a technical architecture.
   Only then create the PRD and technical/design documentation needed, following the document confirmation rules. Never interpret "continue" or approval for a different epic as approval to remove a requested feature. If a requested capability is expensive or missing, explain that and ask before deferring it. Record unresolved decisions as open, never as "alternative rejected". Always attach docs to the correct epic.
   The PRD must include "What we will build, in plain language" and "What the user will experience": explain the input-to-result journey, screens, controls, defaults, waiting/progress, success, error/retry, and how previous results remain accessible. The Technical Analysis must include "How we will build it, in plain language" and a decision record distinguishing user-approved choices from assumptions. Explain where each part runs and how data moves without requiring the reader to understand code.
   Before asking for build approval, reconcile user decisions, PRD, Technical Analysis and the proposed internal plan. Resolve conflicting limits, audio behavior, retention/access, defaults, dependencies and acceptance criteria. A generic build approval must not silently settle previously undisclosed scope or architecture changes. Show the final scope and ask for explicit build approval before execution.
2. When the user approves building, call buildEpic with that epic id and an ordered, self-contained implementation plan grounded in the epic's documents. Each internal milestone must have a clear outcome, documented source requirements, explicit prerequisites, and measurable acceptance criteria. Do not require later routes or UI in an infrastructure-only step; avoid vague checks such as "playable size". Preserve end-to-end checks for the integrated feature. The tool creates ONE build ticket covering the entire approved feature and runs the existing ticket builder. Steps are internal milestones within that ticket, not separate tickets or builds. Include all end-to-end acceptance criteria; the agent owns implementation order and verifies the complete feature. Do not call ticket creation or ticket execution tools.
3. Speak only about the feature, its requirements, build progress, issues and preview. Use the implementation checklist within the single build ticket to explain progress. Ready for review means verification passed, not that the user approved the feature. Existing epics with multiple tickets keep their historical workflow; never silently consolidate, delete, or replace their saved work. Keep the user in chat; ticket details open in the left panel. Internal tools and historical ticket messages are implementation context only. Do not claim execution happened unless buildEpic succeeded.
4. A buildEpic error or status not_started means NOTHING was queued. Never claim the plan is running, scheduled, or will automatically start. If blockingRun.status is blocked, explain that it is paused, not running. Offer to replace it HERE IN CHAT, preserving its documents and work. If the user explicitly asks to abandon/replace the old attempt and build this epic, use its exact runId as replaceBlockedRunId with the new plan. Do not send them to a board to cancel it. Never replace an actively running build. Use getEpicStatus to inspect progress. If a build pauses, explain the feature-level issue and offer to resume with buildEpic after the user asks. Do not report preview readiness unless an actual preview URL was returned.
5. Existing documents or a request to draft a PRD are not authorization to build. Reuse the correct epic for follow-ups; do not create duplicate epics or work on retries.
`;

export function singleEpicTicketId(epicId:string):string {
  const hex=createHash('sha256').update('epic-build-ticket:'+epicId).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function singleEpicTicketPlan(epic:{name:string;goal?:string|null},steps:Array<{name:string;description:string;acceptanceCriteria:string[];sourceDocumentId:string;priority:string;complexity:string}>,docs:Array<{id:string;name?:string;fileType:string}>) {
 const acceptanceCriteria=[...new Set(steps.flatMap(s=>s.acceptanceCriteria))];
 return {
  name:epic.name,
  description:[`## Approved feature\n${epic.name}\n${epic.goal || ''}`,
   'Build this complete feature in one ticket and the existing sandbox. The milestones below are an implementation checklist, not separate tickets. Preserve saved work on resume. Verify the integrated feature against every acceptance criterion before reporting it ready for review.',
   '## Documents\n'+docs.map(d=>`- ${d.name || d.fileType} (document ID: ${d.id})`).join('\n'),
   ...steps.map((s,i)=>`## ${i+1}. ${s.name}\n${s.description}\n\nSource document: ${s.sourceDocumentId}\n\nAcceptance criteria:\n${s.acceptanceCriteria.map(c=>'- '+c).join('\n')}`),
   '## Completion\nRun the complete feature end to end, verify all acceptance criteria, and report what passed and any remaining limitations. Keep implementation progress in the ticket Tasks checklist. Ready for review is separate from user approval.'
  ].join('\n\n'),
  acceptanceCriteria,sourceDocumentId:docs.find(d=>d.fileType==='prd')!.id,
  priority:steps.some(s=>s.priority==='High')?'High':'Medium',complexity:'complex',
  details:{epicBuildMode:'single-ticket',sourceDocumentIds:docs.map(d=>d.id),implementationPlan:steps.map(s=>s.name)},
 };
}
