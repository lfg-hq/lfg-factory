import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projects } from "../db/schema/projects.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { tokenUsageRuns } from "../db/schema/tokens.ts";
import { currentUsage, withUsage } from "../ai/usage-context.ts";
import { collectCliUsage } from "./usage-cli.ts";

export async function withTicketUsage<T>(ticketId: string, actorId: string | undefined, operation: string, run: () => Promise<T>): Promise<T> {
  // The Claude path can delegate to Pi; retain the same attempt in that case.
  if (currentUsage()?.ticketId === ticketId && currentUsage()?.operation === operation) return run();
  const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  if (!ticket) throw new Error("Ticket not found");
  const [project] = await db.select().from(projects).where(eq(projects.id, ticket.projectId)).limit(1);
  if (!project) throw new Error("Project not found");
  const context = { userId: actorId ?? ticket.assigneeId ?? project.ownerId, projectId: project.id,
    ticketId, operation, runId: crypto.randomUUID(), cliOutputs: [], documentIds: new Set(ticket.sourceDocumentId ? [ticket.sourceDocumentId] : []) };
  await db.insert(tokenUsageRuns).values({ id: context.runId, userId: context.userId, projectId: context.projectId, ticketId, operation });
  return withUsage(context, async () => {
    try { return await run(); }
    finally { await collectCliUsage(); }
  });
}
