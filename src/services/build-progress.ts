/**
 * Live build progress for the chat card: one row per ticket with a plain-language
 * stage and the latest meaningful update, derived from the ticket row and its logs.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projectTickets, ticketLogs } from "../db/schema/tickets.ts";
import { isChatTurnActive } from "./ticket-chat-turn.ts";

export type BuildStage = "waiting" | "queued" | "building" | "committed" | "checking" | "testing" | "repairing" | "changing" | "ready" | "failed" | "stopped";
export const STAGE_LABELS: Record<BuildStage, string> = {
  waiting: "Waiting", queued: "Queued", building: "Building", committed: "Code committed",
  checking: "Starting the app", testing: "Testing in the browser", repairing: "Fixing an issue", changing: "Making changes",
  ready: "Ready for review", failed: "Needs attention", stopped: "Stopped",
};
const ACTIVE = new Set<BuildStage>(["queued", "building", "committed", "checking", "testing", "repairing", "changing"]);

type LogLine = { text: string; type: string | null };
const clean = (text: string) => text.replace(/^\[(Validation|Feature testing)\]\s*/, "").replace(/\*\*/g, "")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`/g, "").replace(/\s+/g, " ").trim();
// Tool chatter ("Reading…", "Editing…") is not news for a reader skimming progress.
const CHATTER = /^(Running|Reading|Editing|Writing|Creating|Successfully|Checking an HTTP|Browser:|Inspecting|Command failed|Committing changes|>|\$|\(no output\)|\d+$)/i;

/** Latest stage evidenced by the logs while the ticket is running, newest first. */
function runningStage(logs: LogLine[]): BuildStage {
  for (const { text: raw } of logs) {
    const text = clean(raw);
    if (/^Repairing (runtime checks|test setup)|^Feature testing: Repairing/i.test(text)) return "repairing";
    if (/^Feature testing|^\[Feature testing\]/i.test(raw) || /^Browser: |Live browser/i.test(text)) return "testing";
    if (/^\[Validation\]/.test(raw) || /^(Running the saved ticket|Validation scope|App readiness|Preview readiness)/i.test(text)) return "checking";
    if (/^Build saved:/i.test(text)) return "committed";
    if (/^(Isolated build|Starting Pi build|Starting (ticket )?build|Building ticket)/i.test(text)) return "building";
  }
  return "building";
}

// Agent narration reads as prose; command output (grep hits, paths, URLs, JSON) does not.
function isProse(text: string): boolean {
  if (text.length < 25 || CHATTER.test(text) || /^[{\[/]/.test(text) || text.startsWith("Validation check:")) return false;
  if (/[\w.-]+\.\w+:\d+|https?:\/\/|\|/.test(text) || (text.match(/\//g) ?? []).length > 2) return false;
  const words = text.split(" ").filter((word) => /[a-z]{2,}/i.test(word));
  return words.length >= 5 && (text.match(/[a-z ]/gi) ?? []).length / text.length > 0.75;
}
const NARRATION = new Set(["agent_progress", "ai_response"]);

/** One readable sentence about what is happening now, or null. Agent notes win over command output. */
export function latestUpdate(logs: LogLine[]): string | null {
  const recent = logs.slice(0, 25);
  const pick = recent.find((log) => NARRATION.has(log.type ?? "") && isProse(clean(log.text))) ?? recent.find((log) => isProse(clean(log.text)));
  if (!pick) return null;
  const text = clean(pick.text);
  const sentence = text.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? text;
  return sentence.length > 160 ? sentence.slice(0, 157) + "…" : sentence;
}

export function ticketStage(ticket: { status: string; queueStatus: string }, logs: LogLine[]): BuildStage {
  if (ticket.queueStatus === "queued") return "queued";
  if (ticket.queueStatus === "executing" || ticket.queueStatus === "stopping") return runningStage(logs);
  if (["review", "done", "merged", "archived"].includes(ticket.status)) return "ready";
  if (["failed", "blocked"].includes(ticket.status)) return "failed";
  if (ticket.status === "stopped") return "stopped";
  return "waiting";
}

export async function buildProgress(projectId: string, ticketIds: string[]) {
  const ids = [...new Set(ticketIds)].slice(0, 20);
  if (!ids.length) return { active: false, tickets: [] };
  const rows = await db.select({
    id: projectTickets.id, key: projectTickets.ticketKey, name: projectTickets.name, status: projectTickets.status,
    queueStatus: projectTickets.queueStatus, sha: projectTickets.githubCommitSha, branch: projectTickets.githubBranch,
  }).from(projectTickets).where(and(eq(projectTickets.projectId, projectId), inArray(projectTickets.id, ids)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const tickets = await Promise.all(ids.filter((id) => byId.has(id)).map(async (id) => {
    const t = byId.get(id)!;
    const logs = (await db.select({ text: ticketLogs.command, type: ticketLogs.logType }).from(ticketLogs)
      .where(eq(ticketLogs.ticketId, id)).orderBy(desc(ticketLogs.createdAt), desc(ticketLogs.id)).limit(40))
      .map((l) => ({ text: l.text ?? "", type: l.type }));
    let stage = ticketStage(t, logs);
    // A ticket-chat repair runs outside the build queue; show it as active work.
    if (!ACTIVE.has(stage) && isChatTurnActive(id)) stage = "changing";
    return {
      id, key: t.key, name: t.name, stage, label: STAGE_LABELS[stage], active: ACTIVE.has(stage),
      update: stage === "waiting" ? null : latestUpdate(logs), sha: t.sha ? t.sha.slice(0, 7) : null, branch: t.branch,
    };
  }));
  return { active: tickets.some((t) => t.active), tickets };
}
