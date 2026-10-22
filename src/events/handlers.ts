import { getBuildOrigin, setBuildOrigin, reportBuildStatus } from "../services/build-reporting.ts";
/**
 * Orchestrator Event Handlers
 *
 * Subscribes to ticket lifecycle events and reacts:
 * - Logs activities to the project timeline
 * - Advances build runs when a ticket in one finishes (single tickets build alone)
 */

import { bus } from "./bus.ts";
import { db } from "../config/db.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { eq } from "drizzle-orm";
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
        ? "Build finished, ready for review." : "Build didn’t finish. Ask me here what went wrong, or open the ticket’s Actions tab for the full log.");

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
    // the preview. A ticket queued on its own builds only itself: the old project-wide
    // "next open ticket" reflex rebuilt unrelated tickets nobody asked for.
    const { onTicketFinished } = await import("../services/build-queue.ts");
    await onTicketFinished(ticketId, status === "complete" ? "complete" : "failed")
      .catch((e) => { console.warn("[handlers] build-run advance failed:", (e as Error).message); return true; });
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
