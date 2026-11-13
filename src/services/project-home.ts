/**
 * The project Home dashboard as data: what needs the viewer, what is being built
 * right now, and where each epic stands. Everything here is derived from rows the
 * app already keeps (tickets, epics, ticket logs, build runs, notifications), so
 * the page can never show a status the rest of the app disagrees with.
 */
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../config/db.ts";
import { epics } from "../db/schema/epics.ts";
import { projectTickets, ticketLogs } from "../db/schema/tickets.ts";
import { agentRuns, ticketExecutions } from "../db/schema/orchestrator.ts";
import { notifications } from "../db/schema/notifications.ts";
import { projectFiles } from "../db/schema/documents.ts";
import { users } from "../db/schema/users.ts";
import { STAGE_LABELS, latestUpdate, ticketStage, type BuildStage } from "./build-progress.ts";
import { decodeQuestionMeta, isChatTurnActive } from "./ticket-chat-turn.ts";

export type TicketState = "ready" | "building" | "queued" | "failed" | "waiting" | "open";
export type QueueKind = "epic_review" | "epic_merge" | "ticket_review" | "question" | "mention" | "failed";
export type QueueGroup = "review" | "question" | "problem";

export type QueueItem = {
  id: string;
  kind: QueueKind;
  group: QueueGroup;
  title: string;
  detail: string;
  at: string | null;
  action: string;
  targetId: string;
  link?: string | null;
  body?: string;
  options?: string[];
  waiting?: { id: string; key: string | null; name: string }[];
};

type TicketRow = {
  id: string; name: string; ticketKey: string | null; status: string; queueStatus: string;
  epicId: string | null; executionOrder: number; updatedAt: Date; githubPrUrl: string | null;
};

const READY = new Set(["review", "done", "merged", "archived"]);
const RUNNING = new Set(["executing", "running", "stopping"]);
const ACTIVE_STAGES = new Set<BuildStage>(["building", "committed", "checking", "testing", "repairing", "changing"]);
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const label = (t: { ticketKey: string | null; name: string }) => (t.ticketKey ? `${t.ticketKey} ${t.name}` : t.name);

/** One word for where a ticket is, shared by the progress bars and the lists. */
export function ticketState(t: { status: string; queueStatus: string }, waitingIds?: Set<string>, id?: string): TicketState {
  if (t.queueStatus === "queued") return "queued";
  if (RUNNING.has(t.queueStatus) || t.status === "in_progress") return "building";
  if (READY.has(t.status)) return "ready";
  if (t.status === "failed" || t.status === "blocked") return "failed";
  if (id && waitingIds?.has(id)) return "waiting";
  return "open";
}

/** An epic is ready for its owner once every ticket in it is built. */
export function epicReviewState(epic: { status: string }, states: TicketState[]): "review" | "merge" | null {
  if (epic.status === "approved") return "merge";
  if (epic.status === "merged" || epic.status === "rejected") return null;
  if (epic.status === "in_review") return "review";
  return states.length > 0 && states.every((s) => s === "ready") ? "review" : null;
}

export async function projectHome(project: { id: string; projectId: string }, userId: string) {
  const [ticketRows, epicRows, blockedRuns, unread, docs] = await Promise.all([
    db.select({
      id: projectTickets.id, name: projectTickets.name, ticketKey: projectTickets.ticketKey, status: projectTickets.status,
      queueStatus: projectTickets.queueStatus, epicId: projectTickets.epicId, executionOrder: projectTickets.executionOrder,
      updatedAt: projectTickets.updatedAt, githubPrUrl: projectTickets.githubPrUrl,
    }).from(projectTickets).where(eq(projectTickets.projectId, project.id))
      .orderBy(asc(projectTickets.executionOrder), asc(projectTickets.createdAt)) as Promise<TicketRow[]>,
    db.select({
      id: epics.id, name: epics.name, epicKey: epics.epicKey, status: epics.status, goal: epics.goal,
      previewUrl: epics.previewUrl, conversationId: epics.conversationId, createdAt: epics.createdAt, updatedAt: epics.updatedAt,
    }).from(epics).where(eq(epics.projectId, project.id)).orderBy(desc(epics.createdAt), desc(epics.id)),
    db.select({ id: agentRuns.id }).from(agentRuns)
      .where(and(eq(agentRuns.projectId, project.id), eq(agentRuns.status, "blocked"))),
    db.select({
      id: notifications.id, type: notifications.type, message: notifications.message, link: notifications.link,
      createdAt: notifications.createdAt, actorName: users.name,
    }).from(notifications).leftJoin(users, eq(notifications.actorId, users.id))
      .where(and(eq(notifications.userId, userId), eq(notifications.projectId, project.projectId), isNull(notifications.readAt)))
      .orderBy(desc(notifications.createdAt)).limit(30),
    db.select({ id: projectFiles.id, name: projectFiles.name, updatedAt: projectFiles.updatedAt }).from(projectFiles)
      .where(eq(projectFiles.projectId, project.id)).orderBy(desc(projectFiles.updatedAt)).limit(4),
  ]);

  const byId = new Map(ticketRows.map((t) => [t.id, t]));

  // Tickets a paused build run is holding back, keyed by the ticket that stopped it.
  const waitingIds = new Set<string>();
  const waitingBehind = new Map<string, TicketRow[]>();
  if (blockedRuns.length) {
    const items = await db.select({ runId: ticketExecutions.agentRunId, ticketId: ticketExecutions.ticketId, status: ticketExecutions.status })
      .from(ticketExecutions).where(inArray(ticketExecutions.agentRunId, blockedRuns.map((r) => r.id)))
      .orderBy(asc(ticketExecutions.sequenceNumber));
    for (const run of blockedRuns) {
      const mine = items.filter((i) => i.runId === run.id && i.ticketId && byId.has(i.ticketId));
      const failed = mine.find((i) => i.status === "failed");
      const pending = mine.filter((i) => i.status === "pending").map((i) => byId.get(i.ticketId!)!);
      pending.forEach((t) => waitingIds.add(t.id));
      if (failed && pending.length) waitingBehind.set(failed.ticketId!, pending);
    }
  }

  const stateOf = (t: TicketRow) => ticketState(t, waitingIds, t.id);
  const queue: QueueItem[] = [];

  // ── Reviews ─────────────────────────────────────────────────────────
  const epicCards = epicRows.map((epic) => {
    const tickets = ticketRows.filter((t) => t.epicId === epic.id);
    const states = tickets.map(stateOf);
    return { epic, tickets, states, review: epicReviewState(epic, states) };
  });
  for (const { epic, tickets, review } of epicCards) {
    if (!review) continue;
    const key = epic.epicKey ? `Epic ${epic.epicKey}` : "Epic";
    queue.push(review === "merge"
      ? { id: `epic:${epic.id}`, kind: "epic_merge", group: "review", title: `${epic.name} is approved and ready to merge`,
          detail: `${key} · ${plural(tickets.length, "ticket")} · not on main yet`, at: iso(epic.updatedAt), action: "Merge", targetId: epic.id }
      : { id: `epic:${epic.id}`, kind: "epic_review", group: "review", title: `${epic.name} is ready to review`,
          detail: `${key} · ${plural(tickets.length, "ticket")} built${epic.previewUrl ? " · preview is live" : ""}`,
          at: iso(epic.updatedAt), action: "Review", targetId: epic.id });
  }
  for (const t of ticketRows) {
    if (t.epicId || t.status !== "review") continue;
    queue.push({ id: `ticket:${t.id}`, kind: "ticket_review", group: "review", title: `${t.name} is ready to review`,
      detail: `${t.ticketKey ?? "Ticket"} · built${t.githubPrUrl ? " · pull request open" : ""}`, at: iso(t.updatedAt),
      action: "Review code", targetId: t.id });
  }

  // ── Questions from a ticket's agent ─────────────────────────────────
  // A question is still open only while it is the last thing said on the ticket.
  const ticketIds = ticketRows.map((t) => t.id);
  if (ticketIds.length) {
    const asked = await db.select({ id: ticketLogs.id, ticketId: ticketLogs.ticketId, text: ticketLogs.command,
      explanation: ticketLogs.explanation, createdAt: ticketLogs.createdAt })
      .from(ticketLogs).where(and(inArray(ticketLogs.ticketId, ticketIds), eq(ticketLogs.logType, "question")))
      .orderBy(desc(ticketLogs.createdAt), desc(ticketLogs.id)).limit(40);
    const newest = new Map<string, (typeof asked)[number]>();
    for (const q of asked) if (!newest.has(q.ticketId)) newest.set(q.ticketId, q);
    await Promise.all([...newest.values()].slice(0, 12).map(async (q) => {
      const [last] = await db.select({ id: ticketLogs.id }).from(ticketLogs)
        .where(and(eq(ticketLogs.ticketId, q.ticketId), ne(ticketLogs.logType, "execution_origin")))
        .orderBy(desc(ticketLogs.createdAt), desc(ticketLogs.id)).limit(1);
      const t = byId.get(q.ticketId)!;
      if (last?.id !== q.id || RUNNING.has(t.queueStatus) || isChatTurnActive(t.id)) return;
      const meta = decodeQuestionMeta(q.explanation);
      queue.push({ id: `question:${q.id}`, kind: "question", group: "question",
        title: meta.blocking ? `The agent needs a decision on ${t.ticketKey ?? t.name}` : `The agent asked about ${t.ticketKey ?? t.name}`,
        detail: (q.text ?? "").replace(/\s+/g, " ").trim().slice(0, 180), at: iso(q.createdAt), action: "Answer",
        targetId: t.id, body: (q.text ?? "").trim().slice(0, 1500), options: meta.options });
    }));
  }

  // ── Mentions, assignments and review requests from people ───────────
  for (const n of unread) {
    if (/^build_/.test(n.type)) continue;
    const text = (n.message ?? "").split(" — re: ")[0]!.replace(/\s+/g, " ").trim();
    queue.push({ id: `mention:${n.id}`, kind: "mention", group: "question",
      title: n.actorName ? `${n.actorName}: ${text}`.slice(0, 140) : text.slice(0, 140),
      detail: n.type === "assigned" ? "Assigned to you" : n.type === "review_requested" ? "Review requested" : n.type === "mentioned" ? "Mentioned you" : "Comment",
      at: iso(n.createdAt), action: "Open", targetId: n.id, link: n.link });
  }

  // ── Problems ────────────────────────────────────────────────────────
  const failed = ticketRows.filter((t) => stateOf(t) === "failed");
  const active = ticketRows.filter((t) => ["building", "queued"].includes(stateOf(t)));
  const logsFor = async (ids: string[]) => new Map(await Promise.all(ids.map(async (id) => {
    const rows = await db.select({ text: ticketLogs.command, type: ticketLogs.logType }).from(ticketLogs)
      .where(eq(ticketLogs.ticketId, id)).orderBy(desc(ticketLogs.createdAt), desc(ticketLogs.id)).limit(40);
    return [id, rows.map((l) => ({ text: l.text ?? "", type: l.type }))] as const;
  })));
  const logs = await logsFor([...failed.slice(0, 8), ...active.slice(0, 8)].map((t) => t.id));
  const epicName = (id: string | null) => epicRows.find((e) => e.id === id)?.name ?? null;

  for (const t of failed.slice(0, 8)) {
    const waiting = waitingBehind.get(t.id) ?? [];
    // Build notes often open with a status emoji; the row already carries the icon.
    const why = latestUpdate(logs.get(t.id) ?? [])?.replace(/^[^\p{L}\p{N}]+/u, "") ?? null;
    queue.push({ id: `failed:${t.id}`, kind: "failed", group: "problem",
      title: `${t.ticketKey ?? t.name} ${t.status === "blocked" ? "is blocked" : "failed"}${t.ticketKey ? `: ${t.name}` : ""}`,
      detail: [epicName(t.epicId), waiting.length ? `${plural(waiting.length, "ticket")} waiting behind it` : null, why].filter(Boolean).join(" · "),
      at: iso(t.updatedAt), action: "View issue", targetId: t.id,
      waiting: waiting.map((w) => ({ id: w.id, key: w.ticketKey, name: w.name })) });
  }

  const groupOrder: Record<QueueGroup, number> = { problem: 0, question: 1, review: 2 };
  queue.sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || (b.at ?? "").localeCompare(a.at ?? ""));

  // ── In progress ─────────────────────────────────────────────────────
  const inProgress = active.slice(0, 8).map((t) => {
    const lines = logs.get(t.id) ?? [];
    let stage = ticketStage(t, lines);
    if (!ACTIVE_STAGES.has(stage) && stage !== "queued" && (t.status === "in_progress" || isChatTurnActive(t.id))) stage = "building";
    return { id: t.id, key: t.ticketKey, name: t.name, epic: epicName(t.epicId), stage, label: STAGE_LABELS[stage],
      active: stage !== "queued", update: stage === "queued" ? null : latestUpdate(lines), at: iso(t.updatedAt) };
  }).sort((a, b) => Number(b.active) - Number(a.active));
  const waiting = [...waitingIds].map((id) => byId.get(id)!).slice(0, 6).map((t) => ({ id: t.id, key: t.ticketKey, name: t.name, epic: epicName(t.epicId) }));

  const withPreview = epicCards.filter((c) => c.epic.previewUrl && c.epic.status !== "rejected")
    .sort((a, b) => +new Date(b.epic.updatedAt) - +new Date(a.epic.updatedAt))[0];

  return {
    queue,
    inProgress,
    waiting,
    stats: {
      needsYou: queue.length,
      building: inProgress.filter((t) => t.active).length,
      queued: inProgress.filter((t) => !t.active).length,
      waiting: waitingIds.size,
      ready: ticketRows.filter((t) => stateOf(t) === "ready").length,
      total: ticketRows.length,
    },
    epics: epicCards.filter((c) => c.epic.status !== "rejected").slice(0, 6).map(({ epic, tickets, states, review }) => ({
      id: epic.id, name: epic.name, epicKey: epic.epicKey, status: epic.status, previewUrl: epic.previewUrl,
      states, total: tickets.length, review,
    })),
    preview: withPreview ? { epicId: withPreview.epic.id, name: withPreview.epic.name, url: withPreview.epic.previewUrl, at: iso(withPreview.epic.updatedAt) } : null,
    docs: docs.map((d) => ({ id: d.id, name: d.name, at: iso(d.updatedAt) })),
    hasWork: ticketRows.length > 0 || epicRows.length > 0,
  };
}
