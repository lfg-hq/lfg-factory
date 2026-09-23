import { getBuildOrigin, setBuildOrigin, reportBuildStatus } from "../services/build-reporting.ts";
/**
 * Orchestrator Event Handlers
 *
 * Subscribes to ticket lifecycle events and reacts:
 * - Logs activities to the project timeline
 * - Auto-queues the next ticket after completion
 */

import { bus, emit } from "./bus.ts";
import { db } from "../config/db.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { projects } from "../db/schema/projects.ts";
import { eq, and, asc, inArray } from "drizzle-orm";
import { logActivity } from "../services/activity-log.ts";
import { ACTIVITY_TYPES } from "../db/schema/activities.ts";

// ── Resolve projectId from ticketId (for events that lack it) ─────────

async function resolveProjectId(ticketId: string): Promise<string | null> {
  const [ticket] = await db
    .select({ projectId: projectTickets.projectId })
    .from(projectTickets)
    .where(eq(projectTickets.id, ticketId))
    .limit(1);
  return ticket?.projectId ?? null;
}

async function getTicketName(ticketId: string): Promise<string> {
  const [ticket] = await db
    .select({ name: projectTickets.name })
    .from(projectTickets)
    .where(eq(projectTickets.id, ticketId))
    .limit(1);
  return ticket?.name ?? ticketId.slice(0, 8);
}

/** ticketId:status → when we last handled it, so a duplicate finish can't
 *  advance the build queue twice. */
const recentFinishes = new Map<string, number>();

// ── Auto-queue next ticket ──────────────────────────────────────────

async function autoQueueNextTicket(projectId: string, completedTicketId: string): Promise<void> {
  // Find the next open ticket that isn't already queued or executing
  const [nextTicket] = await db
    .select({ id: projectTickets.id, name: projectTickets.name })
    .from(projectTickets)
    .where(
      and(
        eq(projectTickets.projectId, projectId),
        eq(projectTickets.status, "open"),
        eq(projectTickets.queueStatus, "none")
      )
    )
    .orderBy(asc(projectTickets.executionOrder), asc(projectTickets.createdAt))
    .limit(1);

  if (!nextTicket) {
    // No more open tickets — check if any failed
    const [project] = await db
      .select({ ownerId: projects.ownerId, name: projects.name, publicProjectId: projects.projectId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) return;

    // Count failed tickets for this project
    const failedTickets = await db
      .select({ id: projectTickets.id, name: projectTickets.name })
      .from(projectTickets)
      .where(
        and(
          eq(projectTickets.projectId, projectId),
          eq(projectTickets.status, "failed")
        )
      );

    const failedCount = failedTickets.length;

    if (failedCount > 0) {
      const failedNames = failedTickets.map((t) => t.name).join(", ");
      await logActivity({
        projectId,
        actorType: "system",
        activityType: ACTIVITY_TYPES.BATCH_COMPLETE,
        title: "Build chain finished with errors",
        description: `${failedCount} ticket(s) failed: ${failedNames}`,
        metadata: { failedCount, failedTicketIds: failedTickets.map((t) => t.id) },
      });

      await reportBuildStatus(completedTicketId, "attention", `Build chain finished with ${failedCount} failed ticket(s).`);
    } else {
      await logActivity({
        projectId,
        actorType: "system",
        activityType: ACTIVITY_TYPES.BATCH_COMPLETE,
        title: "All tickets built successfully",
        description: `All queued tickets for ${project.name} have been built.`,
      });

      await reportBuildStatus(completedTicketId, "complete", "Build chain finished.");
    }
    return;
  }

  // Mark as queued
  await db
    .update(projectTickets)
    .set({ queueStatus: "queued", updatedAt: new Date() })
    .where(eq(projectTickets.id, nextTicket.id));

  // Log the auto-queue activity
  await logActivity({
    projectId,
    ticketId: nextTicket.id,
    actorType: "system",
    activityType: ACTIVITY_TYPES.ORCHESTRATOR_QUEUED_NEXT,
    title: `Auto-queued: ${nextTicket.name}`,
    description: `Automatically queued after completion of previous ticket.`,
    metadata: { previousTicketId: completedTicketId },
  });

  const origin = await getBuildOrigin(completedTicketId);
  await setBuildOrigin(nextTicket.id, origin.conversationId, origin.userId);
  await reportBuildStatus(nextTicket.id, "queued", "Build queued.");
  // Emit ticket.queued to trigger the executor
  emit({ type: "ticket.queued", ticketId: nextTicket.id, projectId });
}

// ── Register all handlers ───────────────────────────────────────────

export function registerEventHandlers(): void {
  // ticket.queued → log activity
  bus.on("ticket.queued", async (event) => {
    const { ticketId, projectId } = event.payload;
    const name = await getTicketName(ticketId);
    await logActivity({
      projectId,
      ticketId,
      actorType: "system",
      activityType: ACTIVITY_TYPES.TICKET_QUEUED,
      title: `Ticket queued: ${name}`,
    });
  });

  // ticket.execution_started → log activity
  bus.on("ticket.execution_started", async (event) => {
    const { ticketId } = event.payload;
    await reportBuildStatus(ticketId, "started", "Build started.");
    recentFinishes.delete(`${ticketId}:complete`);
    recentFinishes.delete(`${ticketId}:failed`);
    const projectId = event.payload.projectId ?? await resolveProjectId(ticketId);
    if (!projectId) return;
    const name = await getTicketName(ticketId);
    await logActivity({
      projectId,
      ticketId,
      actorType: "system",
      activityType: ACTIVITY_TYPES.TICKET_STARTED,
      title: `Build started: ${name}`,
    });
  });

  // ticket.execution_finished → log + auto-queue
  bus.on("ticket.execution_finished", async (event) => {
    const { ticketId, status, durationMs, exitCode } = event.payload;
    // One finish per ticket. Some paths can emit twice (the CLI forwarder's done=true
    // AND markTicketFailed), and a double would advance the queue twice — two tickets
    // building at once, out of dependency order.
    const dedupeKey = `${ticketId}:${status}`;
    const last = recentFinishes.get(dedupeKey);
    if (last && Date.now() - last < 60_000) {
      console.log(`[handlers] duplicate execution_finished for ${ticketId} (${status}) — ignoring`);
      return;
    }
    recentFinishes.set(dedupeKey, Date.now());
    for (const [k, t] of recentFinishes) if (Date.now() - t > 300_000) recentFinishes.delete(k);
    const projectId = event.payload.projectId ?? await resolveProjectId(ticketId);
    if (!projectId) return;
    const name = await getTicketName(ticketId);

    await reportBuildStatus(ticketId, exitCode === 130 ? "stopped" : status,
      exitCode === 130 ? "Build stopped." : status === "complete"
        ? "Build finished, ready for review." : "Build failed. Open the ticket’s Actions log for details and retry.");

    if (status === "complete") {
      const durationStr = durationMs ? ` in ${Math.round(durationMs / 1000)}s` : "";
      await logActivity({
        projectId,
        ticketId,
        actorType: "system",
        activityType: ACTIVITY_TYPES.TICKET_COMPLETED,
        title: `Completed: ${name}`,
        description: `Ticket implementation finished successfully${durationStr}.`,
        metadata: { durationMs, exitCode },
      });
    } else {
      await logActivity({
        projectId,
        ticketId,
        actorType: "system",
        activityType: ACTIVITY_TYPES.TICKET_FAILED,
        title: `Failed: ${name}`,
        description: `Execution failed with exit code ${exitCode ?? "unknown"}.`,
        metadata: { exitCode, durationMs },
      });
    }

    // A ticket that belongs to a BUILD RUN is advanced by that run — it knows the
    // dependency order, stays inside the epic, survives a restart, and finishes with
    // the preview. Only when a ticket isn't part of a run do we fall back to the old
    // project-wide "next open ticket" reflex.
    const { onTicketFinished } = await import("../services/build-queue.ts");
    const handledByRun = await onTicketFinished(ticketId, status === "complete" ? "complete" : "failed")
      .catch((e) => { console.warn("[handlers] build-run advance failed:", (e as Error).message); return true; });
    if (!handledByRun) await autoQueueNextTicket(projectId, ticketId);
  });

  // ticket.needs_attention → log activity
  bus.on("ticket.needs_attention", async (event) => {
    const { ticketId, reason, question } = event.payload;
    const projectId = await resolveProjectId(ticketId);
    if (!projectId) return;
    const name = await getTicketName(ticketId);
    await reportBuildStatus(ticketId, "attention", question || reason);
    await logActivity({
      projectId,
      ticketId,
      actorType: "system",
      activityType: ACTIVITY_TYPES.TICKET_STUCK,
      title: `Needs attention: ${name}`,
      description: question ?? reason,
      metadata: { reason },
    });
  });

  console.log("[event-handlers] Orchestrator event handlers registered");
}
