/**
 * Two-way sync between an LFG project and one Jira/Linear board. Manual: it runs when
 * someone presses "Sync now", never on a timer.
 *
 * THE MERGE RULE, which is the whole design:
 *
 *   A side "changed" iff its updatedAt is newer than the pair's lastSyncedAt. That one
 *   comparison replaces a change log, and it's why every pair carries its own timestamp
 *   rather than the link carrying one for everybody.
 *
 *     remote changed only → pull it
 *     local changed only  → push it
 *     both changed        → the BOARD wins product fields (title, description, priority)
 *                           and LFG wins the status.
 *
 * That split isn't a coin toss. The board is where people write what the work IS, and
 * LFG is where the delivery state actually happens — a build finishing is a fact, not an
 * opinion, and overwriting it with a stale column would lie about the work. Both-changed
 * pairs are counted and reported, so a "conflict: 3" tells you to go look.
 *
 * Nothing is ever deleted on either side. An issue that disappears from the board leaves
 * its LFG ticket alone, and vice versa — a sync that can delete your work is a sync
 * nobody can trust.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { projects } from "../../db/schema/projects.ts";
import { projectTickets, ticketStages } from "../../db/schema/tickets.ts";
import { boardConnections, boardLinks, ticketBoardLinks } from "../../db/schema/boards.ts";
import { nextTicketKey } from "../../utils/ticket-keys.ts";
import { clientFor, getConnection } from "./connections.ts";
import type { BoardClient, BoardProvider, RemoteIssue, RemoteStatus } from "./types.ts";
import { guessCategory, providerLabel } from "./types.ts";

export type BoardLink = typeof boardLinks.$inferSelect;
type Stage = typeof ticketStages.$inferSelect;
type Ticket = typeof projectTickets.$inferSelect;

export interface StatusMap {
  toRemote: Record<string, string>;
  toLocal: Record<string, string>;
}

export interface SyncSummary {
  pulledNew: number;      // issues that became LFG tickets
  pulledUpdated: number;  // LFG tickets updated from the board
  pushedNew: number;      // LFG tickets that became issues
  pushedUpdated: number;  // issues updated from LFG
  conflicts: number;      // both sides changed; resolved by the rule above
  unchanged: number;
  errors: string[];
  at: Date;
}

export function emptySummary(): SyncSummary {
  return { pulledNew: 0, pulledUpdated: 0, pushedNew: 0, pushedUpdated: 0, conflicts: 0, unchanged: 0, errors: [], at: new Date() };
}

export function summarize(s: SyncSummary): string {
  const bits: string[] = [];
  if (s.pulledNew) bits.push(`${s.pulledNew} imported`);
  if (s.pulledUpdated) bits.push(`${s.pulledUpdated} updated from the board`);
  if (s.pushedNew) bits.push(`${s.pushedNew} created on the board`);
  if (s.pushedUpdated) bits.push(`${s.pushedUpdated} pushed`);
  if (s.conflicts) bits.push(`${s.conflicts} changed on both sides`);
  if (!bits.length) bits.push("everything already in sync");
  if (s.errors.length) bits.push(`${s.errors.length} error(s)`);
  return bits.join(", ");
}

/** Which LFG stage a board category belongs in, by the stage names this app ships with. */
const CATEGORY_TO_STAGE: Record<string, string[]> = {
  backlog: ["Backlog"],
  todo: ["Todo", "Backlog"],
  in_progress: ["In Progress"],
  review: ["In Review"],
  done: ["Done"],
  cancelled: ["Archive", "Done"],
};

/**
 * Pair stages with remote statuses on a fresh link: exact name first, then category.
 * A guess, made visible in the UI so it can be corrected — silently dropping tickets in
 * the wrong column is worse than an obvious wrong guess.
 */
export function autoMapStatuses(stages: Stage[], statuses: RemoteStatus[]): StatusMap {
  // Match names by letters and digits alone, so "To Do" and "Todo" — the same column
  // spelled two ways — are recognised as the same thing instead of falling through to a
  // category guess.
  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const toRemote: Record<string, string> = {};
  const toLocal: Record<string, string> = {};
  if (!statuses.length) return { toRemote, toLocal };

  const byName = new Map(statuses.map((s) => [norm(s.name), s]));
  const catOf = (s: RemoteStatus) => s.category ?? guessCategory(s.name);
  const byCategory = new Map<string, RemoteStatus>();
  for (const s of statuses) {
    const c = catOf(s);
    if (c && !byCategory.has(c)) byCategory.set(c, s);
  }

  // Boards don't all have the same columns: plenty of Jira projects run To Do / In
  // Progress / Done with no Backlog and no review column. Without a fallback the
  // Backlog stage mapped to NOTHING, and "not mapped" means those tickets silently
  // never reach the board — so degrade to the nearest column that does exist.
  const NEAREST: Record<string, string[]> = {
    backlog: ["backlog", "todo", "in_progress"],
    todo: ["todo", "backlog", "in_progress"],
    in_progress: ["in_progress", "todo", "review"],
    review: ["review", "in_progress", "done"],
    done: ["done", "review", "in_progress"],
    cancelled: ["cancelled", "done", "backlog"],
  };
  const nearestStatus = (cat: string): RemoteStatus | undefined => {
    for (const c of NEAREST[cat] ?? [cat]) {
      const hit = byCategory.get(c);
      if (hit) return hit;
    }
    return undefined;
  };

  for (const stage of stages) {
    const cat = stage.isCompleted ? "done" : guessCategory(stage.name);
    const picked = byName.get(norm(stage.name)) ?? nearestStatus(cat ?? "todo");
    if (picked) toRemote[stage.id] = picked.id;
  }

  // Reverse direction is resolved on its own terms, not as a mirror of the forward map:
  // when two stages point at one column, the column should come back to the stage that
  // MEANS the same thing ("To Do" → Todo), not to whichever stage was listed first.
  const stageByName = new Map(stages.map((st) => [norm(st.name), st]));
  for (const s of statuses) {
    const exact = stageByName.get(norm(s.name));
    if (exact) { toLocal[s.id] = exact.id; continue; }
    const cat = catOf(s) ?? "todo";
    // Walk the PREFERENCES in order — scanning stages instead sent "To Do" to Backlog
    // purely because Backlog sorts first on the board.
    const names = CATEGORY_TO_STAGE[cat] ?? [];
    let byCatName: Stage | undefined;
    for (const n of names) {
      const hit = stages.find((st) => norm(st.name) === norm(n));
      if (hit) { byCatName = hit; break; }
    }
    if (byCatName) { toLocal[s.id] = byCatName.id; continue; }
    // Nothing named right → any stage that points here, else the default stage.
    const claimer = stages.find((st) => toRemote[st.id] === s.id);
    const fallback = claimer ?? stages.find((st) => st.isDefault) ?? stages[0];
    if (fallback) toLocal[s.id] = fallback.id;
  }
  return { toRemote, toLocal };
}

export function readStatusMap(link: BoardLink): StatusMap {
  const raw = (link.statusMap ?? {}) as Partial<StatusMap>;
  return { toRemote: raw.toRemote ?? {}, toLocal: raw.toLocal ?? {} };
}

/** The board a project is bound to (at most one per provider), with its connection. */
export async function getProjectLink(projectId: string, provider?: BoardProvider) {
  const rows = await db.select().from(boardLinks).where(
    provider
      ? and(eq(boardLinks.projectId, projectId), eq(boardLinks.provider, provider))
      : eq(boardLinks.projectId, projectId)
  );
  return rows[0] ?? null;
}

export async function listProjectLinks(projectId: string): Promise<BoardLink[]> {
  return db.select().from(boardLinks).where(eq(boardLinks.projectId, projectId));
}

/** Bind a project to a remote board and pre-fill the status mapping. */
export async function linkBoard(opts: {
  projectId: string;
  userId: string;
  provider: BoardProvider;
  remoteId: string;
  remoteKey?: string | null;
  remoteName?: string | null;
  remoteUrl?: string | null;
  issueTypeId?: string | null;
  issueTypeName?: string | null;
}): Promise<BoardLink> {
  const conn = await getConnection(opts.userId, opts.provider);
  if (!conn) throw new Error(`${providerLabel(opts.provider)} isn't connected — connect it in Settings → Integrations first.`);
  const client = await clientFor(conn);

  const [stages, statuses] = await Promise.all([
    db.select().from(ticketStages).where(eq(ticketStages.projectId, opts.projectId)).orderBy(ticketStages.order),
    client.listStatuses(opts.remoteId),
  ]);
  const statusMap = autoMapStatuses(stages, statuses);

  const existing = await getProjectLink(opts.projectId, opts.provider);
  const values = {
    projectId: opts.projectId,
    connectionId: conn.id,
    provider: opts.provider,
    remoteId: opts.remoteId,
    remoteKey: opts.remoteKey ?? null,
    remoteName: opts.remoteName ?? null,
    remoteUrl: opts.remoteUrl ?? null,
    issueTypeId: opts.issueTypeId ?? null,
    issueTypeName: opts.issueTypeName ?? null,
    statusMap,
    syncEnabled: true,
    updatedAt: new Date(),
  };
  if (existing) {
    const [row] = await db.update(boardLinks).set(values).where(eq(boardLinks.id, existing.id)).returning();
    return row!;
  }
  const [row] = await db.insert(boardLinks).values(values).returning();
  return row!;
}

/** Unbind a project. Pairings go with it; no ticket or issue is touched. */
export async function unlinkBoard(projectId: string, provider: BoardProvider): Promise<void> {
  const link = await getProjectLink(projectId, provider);
  if (!link) return;
  await db.delete(ticketBoardLinks).where(eq(ticketBoardLinks.linkId, link.id));
  await db.delete(boardLinks).where(eq(boardLinks.id, link.id));
}

export async function setStatusMap(linkId: string, map: StatusMap): Promise<void> {
  await db.update(boardLinks).set({ statusMap: map, updatedAt: new Date() }).where(eq(boardLinks.id, linkId));
}

const ms = (d: Date | string | null | undefined): number => (d ? new Date(d as string).getTime() : 0);

/** Run the sync for one project+provider. */
export async function syncBoard(projectId: string, provider: BoardProvider): Promise<SyncSummary> {
  const summary = emptySummary();
  const link = await getProjectLink(projectId, provider);
  if (!link) throw new Error(`This project isn't linked to a ${providerLabel(provider)} board.`);
  if (!link.syncEnabled) throw new Error("Sync is paused for this board.");

  const [conn] = await db.select().from(boardConnections).where(eq(boardConnections.id, link.connectionId)).limit(1);
  if (!conn) throw new Error(`The ${providerLabel(provider)} connection behind this link is gone — reconnect it in Settings → Integrations.`);
  const client = await clientFor(conn);

  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const stages = await db.select().from(ticketStages).where(eq(ticketStages.projectId, projectId)).orderBy(ticketStages.order);
  const defaultStage = stages.find((s) => s.isDefault) ?? stages[0] ?? null;
  const map = readStatusMap(link);

  const tickets = await db.select().from(projectTickets).where(eq(projectTickets.projectId, projectId));
  const pairs = await db.select().from(ticketBoardLinks).where(eq(ticketBoardLinks.linkId, link.id));
  const pairByTicket = new Map(pairs.map((p) => [p.ticketId, p]));
  const pairByRemote = new Map(pairs.map((p) => [p.remoteId, p]));
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  let remote: RemoteIssue[] = [];
  try {
    remote = await client.listIssues(link.remoteId, { limit: 200 });
  } catch (e) {
    throw new Error(`Couldn't read the ${providerLabel(provider)} board: ${(e as Error).message}`);
  }

  const now = new Date();

  // ── Remote → LFG ────────────────────────────────────────────────────────────
  for (const issue of remote) {
    const pair = pairByRemote.get(issue.id);

    if (!pair) {
      // An issue we've never seen becomes a ticket.
      try {
        const stageId = map.toLocal[issue.statusId] ?? defaultStage?.id ?? null;
        const key = await nextTicketKey(projectId, project?.name ?? "Project").catch(() => null);
        const [created] = await db.insert(projectTickets).values({
          projectId,
          ticketKey: key,
          name: issue.title || issue.key,
          description: issue.description || "",
          priority: issue.priority ?? "Medium",
          status: "open",
          stageId,
        }).returning();
        if (created) {
          await db.insert(ticketBoardLinks).values({
            ticketId: created.id,
            linkId: link.id,
            provider,
            remoteId: issue.id,
            remoteKey: issue.key,
            remoteUrl: issue.url,
            remoteStatusId: issue.statusId,
            remoteStatusName: issue.statusName,
            remoteUpdatedAt: issue.updatedAt,
            lastSyncedAt: now,
          });
          summary.pulledNew++;
        }
      } catch (e) {
        summary.errors.push(`Import ${issue.key}: ${(e as Error).message}`);
      }
      continue;
    }

    const ticket = ticketById.get(pair.ticketId);
    if (!ticket) continue; // ticket deleted locally; leave the issue alone

    const since = ms(pair.lastSyncedAt);
    const remoteChanged = ms(issue.updatedAt) > since;
    const localChanged = ms(ticket.updatedAt) > since;

    try {
      if (remoteChanged && !localChanged) {
        await pullInto(ticket, issue, map, defaultStage?.id ?? null);
        summary.pulledUpdated++;
      } else if (localChanged && !remoteChanged) {
        await pushFrom(client, link, ticket, issue, map);
        summary.pushedUpdated++;
      } else if (remoteChanged && localChanged) {
        // Board wins the product fields; LFG wins the status. One round-trip each way.
        await pullInto(ticket, issue, map, defaultStage?.id ?? null, { statusFromRemote: false });
        await pushFrom(client, link, ticket, issue, map, { onlyStatus: true });
        summary.conflicts++;
      } else {
        summary.unchanged++;
      }
      const fresh = await client.getIssue(link.remoteId, issue.id).catch(() => null);
      await db.update(ticketBoardLinks).set({
        remoteKey: fresh?.key ?? issue.key,
        remoteUrl: fresh?.url ?? issue.url,
        remoteStatusId: fresh?.statusId ?? issue.statusId,
        remoteStatusName: fresh?.statusName ?? issue.statusName,
        remoteUpdatedAt: fresh?.updatedAt ?? issue.updatedAt,
        lastSyncedAt: new Date(),
        syncError: null,
        updatedAt: new Date(),
      }).where(eq(ticketBoardLinks.id, pair.id));
    } catch (e) {
      const msg = (e as Error).message;
      summary.errors.push(`${issue.key}: ${msg}`);
      await db.update(ticketBoardLinks).set({ syncError: msg.slice(0, 400), updatedAt: new Date() })
        .where(eq(ticketBoardLinks.id, pair.id)).catch(() => {});
    }
  }

  // ── LFG → remote (tickets that have no issue yet) ────────────────────────────
  for (const ticket of tickets) {
    if (pairByTicket.has(ticket.id)) continue;
    try {
      const statusId = ticket.stageId ? map.toRemote[ticket.stageId] ?? null : null;
      const issue = await client.createIssue(link.remoteId, {
        title: ticket.name,
        description: describeForBoard(ticket),
        statusId,
        priority: ticket.priority ?? null,
      }, { issueTypeId: link.issueTypeId });
      await db.insert(ticketBoardLinks).values({
        ticketId: ticket.id,
        linkId: link.id,
        provider,
        remoteId: issue.id,
        remoteKey: issue.key,
        remoteUrl: issue.url,
        remoteStatusId: issue.statusId,
        remoteStatusName: issue.statusName,
        remoteUpdatedAt: issue.updatedAt,
        lastSyncedAt: new Date(),
      });
      summary.pushedNew++;
    } catch (e) {
      summary.errors.push(`Create ${ticket.ticketKey ?? ticket.name}: ${(e as Error).message}`);
    }
  }

  await db.update(boardLinks).set({
    lastSyncedAt: new Date(),
    lastSyncSummary: summarize(summary),
    updatedAt: new Date(),
  }).where(eq(boardLinks.id, link.id));

  return summary;
}

/** Board → ticket. `statusFromRemote: false` keeps LFG's status (the conflict case). */
async function pullInto(
  ticket: Ticket,
  issue: RemoteIssue,
  map: StatusMap,
  fallbackStageId: string | null,
  opts?: { statusFromRemote?: boolean }
): Promise<void> {
  const patch: Partial<Ticket> = {
    name: issue.title || ticket.name,
    description: issue.description || ticket.description,
    priority: issue.priority ?? ticket.priority,
    updatedAt: new Date(),
  };
  if (opts?.statusFromRemote !== false) {
    patch.stageId = map.toLocal[issue.statusId] ?? ticket.stageId ?? fallbackStageId;
  }
  await db.update(projectTickets).set(patch).where(eq(projectTickets.id, ticket.id));
}

/** Ticket → board. `onlyStatus` is the conflict case, where the board keeps its text. */
async function pushFrom(
  client: BoardClient,
  link: BoardLink,
  ticket: Ticket,
  issue: RemoteIssue,
  map: StatusMap,
  opts?: { onlyStatus?: boolean }
): Promise<void> {
  const statusId = ticket.stageId ? map.toRemote[ticket.stageId] ?? null : null;
  // Don't ask for a transition we're already sitting on — on Jira that's a pointless
  // round-trip that can also fail on a workflow with no self-loop.
  const wantsStatus = statusId && statusId !== issue.statusId ? statusId : null;
  if (opts?.onlyStatus) {
    if (wantsStatus) await client.updateIssue(link.remoteId, issue.id, { statusId: wantsStatus });
    return;
  }
  await client.updateIssue(link.remoteId, issue.id, {
    title: ticket.name,
    description: describeForBoard(ticket),
    statusId: wantsStatus,
    priority: ticket.priority ?? null,
  });
}

/**
 * What the board should show for an LFG ticket: the description, plus the delivery facts
 * the board can't know (branch, PR, merge state). Kept in a marked block so a person
 * editing the description on Jira doesn't fight with us over it.
 */
export function describeForBoard(ticket: Ticket): string {
  const lines: string[] = [String(ticket.description ?? "").trim()];
  const facts: string[] = [];
  if (ticket.ticketKey) facts.push(`LFG ticket: ${ticket.ticketKey}`);
  if (ticket.githubBranch) facts.push(`Branch: ${ticket.githubBranch}`);
  if (ticket.githubPrUrl) facts.push(`PR: ${ticket.githubPrUrl}`);
  if (ticket.githubMergeStatus) facts.push(`Merge: ${ticket.githubMergeStatus}`);
  if (facts.length) lines.push(`— synced from LFG —\n${facts.join("\n")}`);
  return lines.filter(Boolean).join("\n\n");
}

/** Pairings for a set of tickets, so the board can render a link per ticket. */
export async function pairsForTickets(ticketIds: string[]) {
  if (!ticketIds.length) return [];
  return db.select().from(ticketBoardLinks).where(inArray(ticketBoardLinks.ticketId, ticketIds));
}
