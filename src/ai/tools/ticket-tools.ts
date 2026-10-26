import { setBuildOrigin, reportBuildStatus } from "../../services/build-reporting.ts";
import { associateUsageTicket } from "../../services/token-usage.ts";
import { tool, zodSchema } from "ai";
import { z } from "zod";
import { db } from "../../config/db.ts";
import {
  projectTickets,
  ticketStages,
  ticketLogs,
  ticketAddenda,
  projectTodoLists,
  projectTicketAttachments,
} from "../../db/schema/tickets.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { readApprovedDesigns, approvedDesignReferences } from "../../services/approved-designs.ts";
import { projects } from "../../db/schema/projects.ts";
import { chatFiles } from "../../db/schema/chat.ts";
import { eq, and, inArray } from "drizzle-orm";
import { nextTicketKey } from "../../utils/ticket-keys.ts";
import { createEpic, getEpic } from "../../services/epics.ts";
import {
  emitTicketCreated,
  emitTicketUpdated,
  emitTicketStatusChanged,
  emitTicketQueued,
  emitTicketCommented,
} from "../../events/emitters.ts";

let _wsBroadcast: ((userId: string, data: object) => void) | null = null;
export function setTicketWsBroadcast(fn: (userId: string, data: object) => void) {
  _wsBroadcast = fn;
}

export const createTickets = tool({
  description: "Create one or more development tickets. Only call when the user explicitly asks to build/create tickets. If the user attached an image/screenshot this turn (its imageId is given alongside the vision description), and a ticket is ABOUT that image (a bug/design shown in it), pass that imageId in the ticket's `attachmentImageIds` so the screenshot is attached to the ticket for the coding agent to see.",
  inputSchema: zodSchema(z.object({
    projectId: z.string(),
    userId: z.string().describe("User ID for real-time ticket streaming"),
    epicId: z.string().optional().describe(
      "The epic (delivery unit) these tickets belong to — from startEpic. ALWAYS pass this. " +
      "It decides which branch the tickets are cut from and merged into, keeps the whole " +
      "feature reviewable as one unit, and stops unapproved work leaking into the next " +
      "feature. If you didn't open an epic, pass `epicName` instead and one is created."
    ),
    epicName: z.string().optional().describe(
      "Fallback when no epicId: the feature name to open an epic under, e.g. 'Billing rework'."
    ),
    conversationId: z.string().optional().describe(
      "The conversation these tickets were created in — use the conversationId given to you. " +
      "It's what makes the ticket list's 'This Chat Only' filter work, so always pass it."
    ),
    tickets: z.array(z.object({
      name: z.string().describe("Ticket title"),
      description: z.string().describe(
        "Formatted Markdown (NOT a plain paragraph). Use headings and bullet lists: " +
        "## Problem (what is wrong or missing today, in plain words: what someone does, what happens, what should happen; " +
        "for a feature, who needs it and what they can't do yet; one line of key evidence at most), " +
        "## Goal (what will be true when done, 1-2 sentences), " +
        "## Implementation Notes (stack, data model, API routes, edge cases), " +
        "## UI / UX (screens, states, design references), ## Out of Scope. " +
        "Use `inline code` for identifiers, endpoints, and hex values. " +
        "CRITICAL: this ticket is handed to a SEPARATE coding agent that receives this ticket and linked saved documents " +
        "as context (it does NOT see this conversation). So make it SELF-CONTAINED: name the exact " +
        "files/modules/components to touch (with paths), the precise change, relevant existing " +
        "patterns/functions to reuse, data shapes, and any gotchas — enough that the agent can " +
        "implement it correctly without asking questions or re-discovering the codebase."
      ),
      acceptanceCriteria: z.array(z.string()).min(2).describe("2-4 specific, testable acceptance criteria — never empty"),
      priority: z.enum(["High", "Medium", "Low"]).default("Medium"),
      complexity: z.enum(["simple", "medium", "complex"]).default("medium"),
      stageId: z.string().optional(),
      sourceDocumentId: z.string().optional(),
      approvedDesignDocumentIds: z.array(z.string().uuid()).max(20).optional().describe("Preview IDs explicitly accepted by the user. Include all relevant screens; never drafts. Independent copies are referenced in the ticket."),
      notes: z.string().optional(),
      dependsOn: z.array(z.string()).optional().describe(
        "Tickets that must be built before this one: exact names of tickets in this same batch, or keys of " +
        "existing tickets (e.g. 'REC-2'). Leave empty when it can be built in parallel with the others. " +
        "Saved so the ticket map shows what depends on what."
      ),
      attachmentImageIds: z.array(z.string()).optional().describe(
        "Image/file ids of attachments the user provided THIS turn to attach to this ticket. " +
        "Use ONLY ids surfaced in the message as (imageId: <id>). Include when the ticket is about a " +
        "screenshot/image the user shared, so the coding agent gets the actual image."
      ),
    })),
  })),
  execute: async ({ projectId, userId, epicId, epicName, conversationId, tickets }, options) => {
    const approvedDesigns = await readApprovedDesigns(projectId, tickets.flatMap((t) => t.approvedDesignDocumentIds ?? []));
    // Fetch all stages for this project so we can validate stageId
    const allStages = await db.select().from(ticketStages)
      .where(eq(ticketStages.projectId, projectId));
    const stageIds = new Set(allStages.map((s) => s.id));
    const backlog = allStages.find((s) => s.name === "Backlog") ?? allStages[0];

    // Get project name for ticket key generation
    const [proj] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId));
    const projectName = proj?.name ?? "PRJ";

    // Every batch of tickets belongs to exactly one epic. If the model didn't open
    // one, open it here rather than letting these tickets fall back to the shared
    // `lfg-agent` anchor — that fallback is the leak epics exist to close.
    let resolvedEpicId: string | null = null;
    if (epicId) {
      const existing = await getEpic(epicId);
      if (existing) resolvedEpicId = existing.id;
    }
    if (!resolvedEpicId) {
      const name = epicName?.trim() || tickets[0]?.name?.trim() || "Untitled feature";
      try {
        const epic = await createEpic({ projectId, name, createdById: userId, conversationId: conversationId ?? null });
        resolvedEpicId = epic.id;
        console.log(`[createTickets] opened epic ${epic.epicKey} "${name}" on ${epic.branch}`);
      } catch (e) {
        console.warn(`[createTickets] could not open an epic:`, (e as Error).message?.slice(0, 200));
      }
    }

    const created: { id: string; ticketKey: string | null; name: string }[] = [];

    // Insert tickets one at a time and broadcast each immediately
    for (const t of tickets) {
      // Validate stageId — if it's not a real UUID stage, fall back to Backlog
      const resolvedStageId = (t.stageId && stageIds.has(t.stageId)) ? t.stageId : (backlog?.id ?? null);

      const ticketKey = await nextTicketKey(projectId, projectName);

      // Copy accepted screens so future draft refreshes do not change this ticket.
      const accepted = [...new Set(t.approvedDesignDocumentIds ?? [])].map((id) => approvedDesigns.find((design) => design.id === id)!);
      const snapshots = [];
      for (const design of accepted) {
        const id = crypto.randomUUID();
        const [snapshot] = await db.insert(projectFiles).values({
          id, projectId, epicId: "", fileType: "page_preview",
          name: `${design.name} — accepted ${ticketKey} (${id})`,
          content: design.content, s3Key: null,
        }).returning();
        snapshots.push({ id: snapshot!.id, name: design.name });
      }
      const description = t.description + approvedDesignReferences(snapshots);
      const [row] = await db.insert(projectTickets).values({
        projectId,
        epicId: resolvedEpicId,
        ticketKey,
        name: t.name,
        description,
        acceptanceCriteria: t.acceptanceCriteria,
        priority: t.priority,
        complexity: t.complexity,
        stageId: resolvedStageId,
        sourceDocumentId: t.sourceDocumentId ?? null,
        // Which chat produced this ticket. Without it the ticket list's
        // "This Chat Only" filter matches nothing, because the column stays null.
        conversationId: conversationId ?? null,
        notes: t.notes ?? "",
      }).returning();
      if (row) await associateUsageTicket(row.id, options.toolCallId);

      // Attach any images the user shared this turn (referenced by id) to the ticket, so
      // the coding agent — and the ticket view — get the actual screenshot, not just prose.
      const attachIds = [...new Set((t.attachmentImageIds || []).filter(Boolean))];
      if (attachIds.length) {
        const files = await db.select().from(chatFiles).where(inArray(chatFiles.id, attachIds)).catch(() => []);
        if (files.length) {
          await db.insert(projectTicketAttachments).values(files.map((f) => ({
            ticketId: row!.id,
            filePath: `/api/files/${f.id}`, // servable URL (the chat file endpoint)
            originalFilename: f.originalFilename ?? "attachment",
            fileType: f.fileType ?? "",
            fileSize: f.fileSize ?? 0,
          }))).catch((e) => console.warn("[createTickets] attach failed:", (e as Error).message?.slice(0, 120)));
        }
      }

      emitTicketCreated({ projectId, ticketId: row!.id, ticketName: row!.name, priority: row!.priority, stageId: row!.stageId });

      // Stream ticket to client as it's created
      if (_wsBroadcast) {
        _wsBroadcast(userId, {
          type: "ai_chunk",
          is_notification: true,
          notification_type: "ticket_stream",
          ticket: {
            id: row!.id,
            name: row!.name,
            description,
            priority: t.priority,
            complexity: t.complexity,
            stage: backlog?.name ?? "Backlog",
          },
        });
      }

      created.push({ id: row!.id, ticketKey: row!.ticketKey, name: row!.name });
    }

    // Dependencies name tickets in this batch (by name) or existing ones (by key/id).
    const batchByName = new Map(created.map((c) => [c.name.trim().toLowerCase(), c.id]));
    for (const [index, t] of tickets.entries()) {
      if (!t.dependsOn?.length || !created[index]) continue;
      const ids = await resolveTicketRefs(projectId, t.dependsOn, batchByName);
      if (ids.length) await db.update(projectTickets).set({ dependencies: ids.filter((id) => id !== created[index]!.id), updatedAt: new Date() }).where(eq(projectTickets.id, created[index]!.id));
    }

    return { created: created.length, tickets: created, epicId: resolvedEpicId, name: resolvedEpicId ? (await getEpic(resolvedEpicId))?.name || "Created tickets" : "Created tickets" };
  },
});

export const getPendingTickets = tool({
  description: "Get all unfinished tickets for a project, grouped by stage.",
  inputSchema: zodSchema(z.object({
    projectId: z.string(),
    stageFilter: z.array(z.string()).optional(),
  })),
  execute: async ({ projectId, stageFilter }) => {
    const [stages, tickets] = await Promise.all([
      db.select().from(ticketStages).where(eq(ticketStages.projectId, projectId)).orderBy(ticketStages.order),
      db.select().from(projectTickets).where(eq(projectTickets.projectId, projectId)),
    ]);
    const filteredStages = stageFilter ? stages.filter((s) => stageFilter.includes(s.name)) : stages;
    return filteredStages.map((stage) => ({
      stageId: stage.id,
      stageName: stage.name,
      tickets: tickets.filter((t) => t.stageId === stage.id).map((t) => ({ id: t.id, ticketKey: t.ticketKey, name: t.name, priority: t.priority, complexity: t.complexity, status: t.status })),
    }));
  },
});

export const getTicketDetails = tool({
  description: "Get full details of a specific ticket including description, acceptance criteria, and logs.",
  inputSchema: zodSchema(z.object({ ticketId: z.string() })),
  execute: async ({ ticketId }, options) => {
    const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId));
    if (!ticket) return { found: false as const };
    await associateUsageTicket(ticket.id, options.toolCallId);
    const [logs, todos] = await Promise.all([
      db.select().from(ticketLogs).where(eq(ticketLogs.ticketId, ticketId)).orderBy(ticketLogs.createdAt),
      db.select().from(projectTodoLists).where(eq(projectTodoLists.ticketId, ticketId)).orderBy(projectTodoLists.order),
    ]);
    return {
      found: true as const,
      ticket,
      logs: logs.map((l) => ({ logType: l.logType, command: l.command, output: l.output, exitCode: l.exitCode, createdAt: l.createdAt })),
      todos: todos.map((t) => ({ id: t.id, description: t.description, status: t.status })),
    };
  },
});

export const updateTicket = tool({
  description: "Update the status or stage of a ticket.",
  inputSchema: zodSchema(z.object({
    ticketId: z.string(),
    status: z.enum(["open", "in_progress", "review", "done", "failed", "blocked", "archived"]).optional(),
    stageId: z.string().optional(),
    priority: z.enum(["High", "Medium", "Low"]).optional(),
  })),
  execute: async ({ ticketId, status, stageId, priority }) => {
    const [before] = await db.select({ status: projectTickets.status, projectId: projectTickets.projectId }).from(projectTickets).where(eq(projectTickets.id, ticketId));
    const u: Record<string, unknown> = { updatedAt: new Date() };
    if (status) u.status = status;
    if (stageId) u.stageId = stageId;
    if (priority) u.priority = priority;
    await db.update(projectTickets).set(u).where(eq(projectTickets.id, ticketId));
    const projectId = before?.projectId ?? "";
    if (status && before?.status !== status) {
      emitTicketStatusChanged({ ticketId, projectId, oldStatus: before?.status, newStatus: status });
    }
    if (stageId || priority) {
      emitTicketUpdated({ ticketId, projectId, changes: u });
    }
    return { success: true };
  },
});

/** Ticket ids for references given as batch names, ticket keys (REC-2) or ids, within one project. */
async function resolveTicketRefs(projectId: string, refs: string[], batchByName: Map<string, string>): Promise<string[]> {
  const rows = await db.select({ id: projectTickets.id, key: projectTickets.ticketKey, name: projectTickets.name }).from(projectTickets).where(eq(projectTickets.projectId, projectId));
  const ids = refs.map((ref) => {
    const r = ref.trim(), lower = r.toLowerCase();
    return batchByName.get(lower) ?? rows.find((t) => t.id === r || t.key?.toLowerCase() === lower || t.name.trim().toLowerCase() === lower)?.id;
  }).filter((id): id is string => !!id);
  return [...new Set(ids)];
}

export const updateTicketDetails = tool({
  description: "Update the description, acceptance criteria, or other details of a ticket.",
  inputSchema: zodSchema(z.object({
    ticketId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
    complexity: z.enum(["simple", "medium", "complex"]).optional(),
    notes: z.string().optional(),
    dependsOn: z.array(z.string()).optional().describe("Replace this ticket's prerequisites: ticket keys (e.g. 'REC-2') or ids. Pass [] to clear."),
  })),
  execute: async ({ ticketId, name, description, acceptanceCriteria, complexity, notes, dependsOn }, options) => {
    const u: Record<string, unknown> = { updatedAt: new Date() };
    if (dependsOn) {
      const [own] = await db.select({ projectId: projectTickets.projectId }).from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
      if (own) u.dependencies = (await resolveTicketRefs(own.projectId, dependsOn, new Map())).filter((id) => id !== ticketId);
    }
    if (name) u.name = name;
    if (description) u.description = description;
    if (acceptanceCriteria) u.acceptanceCriteria = acceptanceCriteria;
    if (complexity) u.complexity = complexity;
    if (notes != null) u.notes = notes;
    const changed = await db.update(projectTickets).set(u).where(eq(projectTickets.id, ticketId)).returning({ id: projectTickets.id });
    if (changed[0]) await associateUsageTicket(changed[0].id, options.toolCallId);
    return { success: changed.length > 0 };
  },
});

export const updateAllTickets = tool({
  description: "Batch-update status or stage for multiple tickets.",
  inputSchema: zodSchema(z.object({
    updates: z.array(z.object({
      ticketId: z.string(),
      status: z.enum(["open", "in_progress", "review", "done", "failed", "blocked", "archived"]).optional(),
      stageId: z.string().optional(),
    })),
  })),
  execute: async ({ updates }) => {
    await Promise.all(updates.map(({ ticketId, status, stageId }) => {
      const u: Record<string, unknown> = { updatedAt: new Date() };
      if (status) u.status = status;
      if (stageId) u.stageId = stageId;
      return db.update(projectTickets).set(u).where(eq(projectTickets.id, ticketId));
    }));
    return { updated: updates.length };
  },
});

export const getNextTicket = tool({
  description: "Get the next open ticket to work on.",
  inputSchema: zodSchema(z.object({ projectId: z.string() })),
  execute: async ({ projectId }) => {
    const [next] = await db.select().from(projectTickets).where(and(eq(projectTickets.projectId, projectId), eq(projectTickets.status, "open"))).orderBy(projectTickets.executionOrder, projectTickets.createdAt).limit(1);
    if (!next) return { found: false as const };
    return { found: true as const, ticket: { id: next.id, ticketKey: next.ticketKey, name: next.name, description: next.description } };
  },
});

export const scheduleTickets = tool({
  description: "Provide a prioritized execution order for tickets.",
  inputSchema: zodSchema(z.object({
    projectId: z.string(),
    schedule: z.array(z.object({
      ticketId: z.string(),
      order: z.number(),
      rationale: z.string().optional(),
    })),
  })),
  execute: async ({ projectId: _projectId, schedule }) => {
    await Promise.all(schedule.map(({ ticketId, order, rationale }) =>
      db.update(projectTickets).set({
        executionOrder: order,
        notes: rationale ? `[Order: ${order}] ${rationale}` : `[Order: ${order}]`,
        updatedAt: new Date(),
      }).where(eq(projectTickets.id, ticketId))
    ));
    return { scheduled: schedule.length };
  },
});

export const retryTicket = tool({
  description: "Retry a failed ticket. Automatically resume integration when its code is already pushed; otherwise queue implementation. Use build only when implementation must be repeated, or merge to retry only integration.",
  inputSchema: zodSchema(z.object({
    ticketId: z.string(),
    conversationId: z.string().optional(),
    userId: z.string().optional(),
    reason: z.string().optional(),
    mode: z.enum(['auto', 'merge', 'build']).optional(),
  })),
  execute: async ({ ticketId, reason, conversationId, userId, mode }) => {
    const [row] = await db.select({ projectId: projectTickets.projectId, queueStatus: projectTickets.queueStatus, githubMergeStatus: projectTickets.githubMergeStatus, githubCommitSha: projectTickets.githubCommitSha }).from(projectTickets).where(eq(projectTickets.id, ticketId));
    if (!row) throw new Error("Ticket not found");
    if (/^(queued|executing|stopping)$/.test(row.queueStatus)) throw new Error("This ticket already has an active operation.");
    const { ticketRetryMode } = await import('../../services/ticket-retry-mode.ts');
    if (ticketRetryMode(row, mode) === 'merge') {
      const { startTicketMergeRetry } = await import('../../workers/ticket-executor.ts');
      await startTicketMergeRetry(ticketId, userId, conversationId);
      return { success: true, ticketId, note: 'Merge retry started from the published ticket branch. Implementation is not being repeated.' };
    }
    const claimed = await db.update(projectTickets).set({ status: "open", queueStatus: "queued", queuedAt: new Date(), updatedAt: new Date() }).where(and(eq(projectTickets.id, ticketId), eq(projectTickets.queueStatus, row.queueStatus))).returning({id:projectTickets.id});
    if (!claimed.length) throw new Error("Another operation claimed this ticket.");
    await setBuildOrigin(ticketId, conversationId ?? null, userId ?? null);
    if (reason) {
      await db.insert(ticketLogs).values({ ticketId, logType: "agent_action", command: `Retry: ${reason}`, explanation: reason });
    }
    await reportBuildStatus(ticketId, "queued", "Build queued.");
    // Emit queued event to trigger execution
    const { emit } = await import("../../events/bus.ts");
    emit({ type: "ticket.queued", ticketId, projectId: row?.projectId ?? "" });
    return { success: true, ticketId, note: "Ticket queued for execution" };
  },
});

export const sendTicketMessage = tool({
  description: "Send a change request or question to a ticket's coding agent. A change request is saved on the ticket (pending until a build or follow-up publishes it), so it survives failures and rebuilds. If a Claude session is active, it resumes that session with the message. Otherwise it starts a new session with context.",
  inputSchema: zodSchema(z.object({
    ticketId: z.string(),
    conversationId: z.string().optional().describe("Current conversation ID supplied in your context; associates activity with this chat."),
    message: z.string().describe("The instruction or question to send to the ticket agent"),
    kind: z.enum(["change","question"]).optional().describe("'change' (default): a code change. It is saved on the ticket as a pending change request and carried into every build and follow-up until one publishes it. 'question': only asks the ticket agent something."),
  })),
  execute: async (args: {ticketId:string;message:string;kind?:'change'|'question';conversationId?:string;projectId?:string;userId?:string;turnId?:string}) => {
    const {ticketId,message,conversationId,projectId,userId,turnId}=args;
    if(!conversationId || !projectId || !userId || !turnId)return {error:'Server-owned conversation, project, actor and turn context are required.'};
    const {createTicketOperation}=await import('../../services/ticket-operations.ts');
    const {operation,created}=await createTicketOperation({ticketId,message,conversationId,projectId,userId,turnId});
    if(created){
      // Durable record: a failed or interrupted turn must not lose the request.
      if((args.kind ?? 'change')==='change') await db.insert(ticketAddenda).values({ticketId,createdById:userId,description:message,status:'pending'});
      await db.insert(ticketLogs).values({ticketId,logType:'agent_action',command:message});
      emitTicketCommented({ticketId,projectId,message,logType:'agent_action'});
      const {bus}=await import('../../events/bus.ts');
      bus.emit({type:'ticket.chat_message',payload:{ticketId,message,sender:'orchestrator',actorId:userId,operationId:operation.id}});
    }
    return {success:true,ticketId,operationId:operation.id,status:operation.status,detail:operation.detail};
  },
});

/**
 * "Build them all" — the multi-ticket path. queueTicketExecution starts ONE ticket
 * and forgets it; this records the whole set as a durable run, so the chain keeps
 * its dependency order, stays inside the epic, survives a restart or a deploy, and
 * ends by starting the preview and posting the URL back here.
 */
export const startBuildRun = tool({
  description:
    "Build MULTIPLE tickets in order as one tracked run. Use this whenever the user asks to build more than one ticket ('build them', 'build all', 'build the epic') — NOT queueTicketExecution in a loop. " +
    "Pass ticketIds in dependency order (the order you scheduled them in); each ticket starts only after the previous one succeeds. " +
    "The run survives server restarts, and when the last ticket lands it starts the preview for the epic's branch and posts the URL into this conversation. " +
    "Tell the user you have queued N tickets and that you will post the preview link when they are all built.",
  inputSchema: zodSchema(z.object({
    projectId: z.string(),
    userId: z.string().describe("User ID — the run belongs to them"),
    conversationId: z.string().optional().describe("This conversation, so the run can report back into it"),
    ticketIds: z.array(z.string()).min(1).describe("Ticket ids IN DEPENDENCY ORDER (first one builds first)"),
    epicId: z.string().optional().describe("The epic these belong to — used to pick the branch to preview at the end"),
    afterBuild: z.enum(["preview", "none"]).optional().describe(
      "What to do when every ticket is built. 'preview' (default) starts the epic branch and returns a URL the user can test on; 'none' just reports completion."),
  })),
  execute: async ({ projectId, userId, conversationId, ticketIds, epicId, afterBuild }) => {
    const { createBuildRun } = await import("../../services/build-queue.ts");
    const res = await createBuildRun({
      projectId, userId,
      conversationId: conversationId ?? null,
      ticketIds, epicId: epicId ?? null,
      afterBuild: afterBuild ?? "preview",
      triggerMessage: "Build the queued tickets",
    });
    if (!res.runId) return { success: false, error: "None of those ticket ids exist in this project." };
    return {
      success: true,
      runId: res.runId,
      ticketIds,
      queued: res.queued,
      building: res.firstTicketId,
      afterBuild: afterBuild ?? "preview",
      note: `${res.queued} ticket(s) queued in order. The chain advances automatically as each completes and survives restarts.` +
        ((afterBuild ?? "preview") === "preview" ? " The preview URL will be posted here when they are all built." : ""),
    };
  },
});

/** Where a build run is up to — which ticket is building, what's left, what failed. */
export const getBuildRunStatus = tool({
  description:
    "Check the progress of the current multi-ticket build run for a project: which ticket is building now, which are done, and whether the chain is blocked by a failure. Use this when the user asks 'how is the build going' or 'what's left'.",
  inputSchema: zodSchema(z.object({ projectId: z.string() })),
  execute: async ({ projectId }) => {
    const { getActiveRun } = await import("../../services/build-queue.ts");
    const run = await getActiveRun(projectId);
    if (!run) return { active: false, note: "No build run is in progress for this project." };
    return {
      active: true,
      status: run.status,
      afterBuild: run.afterBuild,
      items: run.items,
      note: run.status === "blocked"
        ? "The chain is paused on a failed ticket — retry it and the rest will continue."
        : "The chain advances on its own as each ticket completes.",
    };
  },
});

export const queueTicketExecution = tool({
  description: "Mark a ticket as queued for background execution by the coding agent.",
  inputSchema: zodSchema(z.object({
    ticketId: z.string(),
    conversationId: z.string().optional(),
    userId: z.string().optional(),
    notes: z.string().optional(),
  })),
  execute: async ({ ticketId, notes, conversationId, userId }) => {
    const [row] = await db.select({ projectId: projectTickets.projectId, queueStatus: projectTickets.queueStatus }).from(projectTickets).where(eq(projectTickets.id, ticketId));
    if (!row) throw new Error("Ticket not found");
    if (/^(queued|executing|stopping)$/.test(row.queueStatus)) throw new Error("This ticket already has an active operation.");
    const claimed = await db.update(projectTickets).set({ queueStatus: "queued", queuedAt: new Date(), notes: notes ?? undefined, updatedAt: new Date() }).where(and(eq(projectTickets.id, ticketId), eq(projectTickets.queueStatus, row.queueStatus))).returning({id:projectTickets.id});
    if (!claimed.length) throw new Error("Another operation claimed this ticket.");
    await setBuildOrigin(ticketId, conversationId ?? null, userId ?? null);
    await db.insert(ticketLogs).values({ ticketId, logType: "user_message", command: notes ? `Queued: ${notes}` : "Queued for execution" });
    await reportBuildStatus(ticketId, "queued", "Build queued.");
    emitTicketQueued({ ticketId, projectId: row?.projectId ?? "", notes });
    return { success: true, ticketId };
  },
});

export const getTicketOperationStatus = tool({
 description:'Read the durable status and result of a ticket follow-up dispatched from this conversation.',
 inputSchema:zodSchema(z.object({operationId:z.string()})),
 execute:async(args:{operationId:string;projectId?:string;userId?:string;conversationId?:string})=>{
  const {readTicketOperation,authorizeTicketOperation}=await import('../../services/ticket-operations.ts');
  const op=await readTicketOperation(args.operationId);
  if(!op || !args.projectId || !args.userId || args.conversationId!==op.conversationId)return {error:'Operation is not available in this conversation.'};
  await authorizeTicketOperation(op.ticketId,args.projectId,args.userId,args.conversationId);
  return op;
 }
});
