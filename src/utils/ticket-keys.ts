import { db } from "../config/db.ts";
import { projects } from "../db/schema/projects.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { eq, isNull, asc, sql } from "drizzle-orm";

/**
 * Derive a 3-letter uppercase prefix from a project name.
 * Takes the first 3 alphanumeric characters, uppercased.
 * Falls back to "PRJ" if the name has fewer than 3 usable chars.
 */
export function derivePrefix(projectName: string): string {
  const chars = projectName.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (chars.length >= 3) return chars.slice(0, 3);
  return (chars + "PRJ").slice(0, 3);
}

/**
 * Atomically generate the next ticket key for a project.
 * Increments project.ticketCounter and returns e.g. "PRO-1", "PRO-2".
 */
export async function nextTicketKey(projectId: string, projectName: string): Promise<string> {
  const prefix = derivePrefix(projectName);

  // Atomically increment and return the new counter
  const [updated] = await db
    .update(projects)
    .set({ ticketCounter: sql`${projects.ticketCounter} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ ticketCounter: projects.ticketCounter });

  const num = updated?.ticketCounter ?? 1;
  return `${prefix}-${num}`;
}

/**
 * Backfill ticketKey for any existing tickets that don't have one.
 * Safe to run multiple times — only touches tickets where ticketKey IS NULL.
 */
export async function backfillTicketKeys(): Promise<number> {
  const orphans = await db
    .select({
      id: projectTickets.id,
      projectId: projectTickets.projectId,
    })
    .from(projectTickets)
    .where(isNull(projectTickets.ticketKey))
    .orderBy(asc(projectTickets.createdAt));

  if (orphans.length === 0) return 0;

  // Group by project
  const byProject = new Map<string, string[]>();
  for (const t of orphans) {
    if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
    byProject.get(t.projectId)!.push(t.id);
  }

  let count = 0;
  for (const [projectId, ticketIds] of byProject) {
    const [proj] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId));
    const projectName = proj?.name ?? "PRJ";

    for (const ticketId of ticketIds) {
      const key = await nextTicketKey(projectId, projectName);
      await db
        .update(projectTickets)
        .set({ ticketKey: key })
        .where(eq(projectTickets.id, ticketId));
      count++;
    }
  }

  console.log(`[ticket-keys] Backfilled ${count} tickets across ${byProject.size} projects`);
  return count;
}
