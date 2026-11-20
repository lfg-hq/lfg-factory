/**
 * Review gates the agent cannot skip.
 *
 * A new feature moves docs → tickets → build, and the person reviews each step before
 * the next one starts. The prompt says so, but a model that reads "build an SDR demo"
 * as permission for everything wrote the docs, created the tickets and started the
 * build in one turn. These checks hold the line in code: work made in the current turn
 * (after the person's latest message) cannot be carried to the next step in that same
 * turn. The person has to see it and reply first.
 */
import { and, desc, eq, gt, inArray, isNull, notInArray, or } from "drizzle-orm";
import { db } from "../config/db.ts";
import { messages } from "../db/schema/chat.ts";
import { projectFiles } from "../db/schema/documents.ts";
import { projectTickets } from "../db/schema/tickets.ts";

/** Rows on the user side that the person did not write (build events, meeting context, status). */
const AUTOMATED_USER_ROLES = ["build_event", "meeting_context", "operation_status"];
/** The docs a person reviews before a feature is broken into tickets. */
const REVIEW_DOC_TYPES = ["prd", "tech_analysis"];

/** When the person last wrote in this conversation; null when unknown. */
export async function lastPersonMessageAt(conversationId: string | null | undefined): Promise<Date | null> {
  if (!conversationId) return null;
  const [row] = await db.select({ at: messages.createdAt }).from(messages)
    .where(and(
      eq(messages.conversationId, conversationId),
      eq(messages.role, "user"),
      or(isNull(messages.userRole), notInArray(messages.userRole, AUTOMATED_USER_ROLES)),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.at ?? null;
}

/** Refusal text when tickets would be created in the same turn as the docs they come from. */
export async function ticketsBeforeDocReview(projectId: string, conversationId: string | null | undefined): Promise<string | null> {
  const since = await lastPersonMessageAt(conversationId);
  if (!since) return null;
  const docs = await db.select({ name: projectFiles.name }).from(projectFiles)
    .where(and(
      eq(projectFiles.projectId, projectId),
      inArray(projectFiles.fileType, REVIEW_DOC_TYPES),
      gt(projectFiles.createdAt, since),
    ))
    .limit(3);
  if (!docs.length) return null;
  return `Not created: ${docs.map(d => `"${d.name}"`).join(", ")} ${docs.length === 1 ? "was" : "were"} written in this turn, ` +
    "and the user has not reviewed them yet. Stop here: point the user to the docs, summarise what they cover in a few lines, " +
    "and ask them to review and confirm before you propose and create tickets.";
}

/** Refusal text when tickets would be built in the same turn they were created. */
export async function buildBeforeTicketReview(
  ticketIds: string[],
  conversationId: string | null | undefined,
  opts: { allowSingleFix?: boolean } = {},
): Promise<string | null> {
  const since = await lastPersonMessageAt(conversationId);
  if (!since || !ticketIds.length) return null;
  const fresh = await db.select({ id: projectTickets.id, epicId: projectTickets.epicId, key: projectTickets.ticketKey }).from(projectTickets)
    .where(and(inArray(projectTickets.id, ticketIds), gt(projectTickets.createdAt, since)));
  if (!fresh.length) return null;
  if (opts.allowSingleFix && fresh.length === 1) {
    // A single fix ticket may be queued in the turn it was filed, unless it is part of
    // a feature's ticket set made in this same turn.
    const epicId = fresh[0]!.epicId;
    const siblings = epicId
      ? await db.select({ id: projectTickets.id }).from(projectTickets)
          .where(and(eq(projectTickets.epicId, epicId), gt(projectTickets.createdAt, since))).limit(2)
      : [];
    if (siblings.length < 2) return null;
  }
  const keys = fresh.map(t => t.key).filter(Boolean).join(", ");
  return `Not started: ${keys || "these tickets"} ${fresh.length === 1 ? "was" : "were"} created in this turn, and the user has not reviewed ${fresh.length === 1 ? "it" : "them"} yet. ` +
    "Stop here: list the tickets (what each delivers, in order) and ask whether to start the build. Build only after the user says so.";
}
