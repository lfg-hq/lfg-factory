/**
 * "Skip checks": the user stops a slow or stuck check run and lets the build continue
 * with the code already committed. The request is stored on the ticket (durable across
 * processes, like Stop) and watched by the run that is checking it. Turning checks off
 * in project or ticket settings mid-run is treated the same way.
 */
import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projectTickets } from "../db/schema/tickets.ts";

const local = new Set<string>();

export async function requestSkipChecks(ticketId: string): Promise<void> {
  local.add(ticketId);
  const [row] = await db.select({ details: projectTickets.details }).from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  const details = (row?.details && typeof row.details === "object" ? row.details : {}) as Record<string, unknown>;
  await db.update(projectTickets).set({ details: { ...details, skipChecksAt: new Date().toISOString() }, updatedAt: new Date() })
    .where(eq(projectTickets.id, ticketId));
}

/** Watches for a skip requested after `since`; `skipped()` stays synchronous for check loops. */
export function watchSkipChecks(ticketId: string, since = Date.now(), intervalMs = 3000) {
  let skipped = false;
  local.delete(ticketId);
  const poll = async () => {
    if (skipped) return;
    if (local.has(ticketId)) { skipped = true; return; }
    const [row] = await db.select({ details: projectTickets.details, projectId: projectTickets.projectId }).from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1).catch(() => []);
    const at = Date.parse(String((row?.details as Record<string, unknown> | null)?.skipChecksAt ?? ""));
    if (Number.isFinite(at) && at >= since) { skipped = true; return; }
    // Turning checks off (project or ticket) while they run counts as a skip: the
    // setting is read once at the start, so without this a run kept going regardless.
    if (row?.projectId) {
      const { loadBuildStageSettings } = await import("./build-stage-settings.ts");
      const settings = await loadBuildStageSettings(row.projectId, ticketId).catch(() => null);
      if (settings && settings.validationEnabled === false && settings.featureTestingEnabled === false) skipped = true;
    }
  };
  const timer = setInterval(() => { void poll(); }, intervalMs);
  return {
    skipped: () => skipped || local.has(ticketId),
    stop: () => { clearInterval(timer); local.delete(ticketId); },
  };
}
