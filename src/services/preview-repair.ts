/**
 * Preview → ticket → preview hand-off.
 *
 * Preview recovery may only repair the runtime recipe; an application defect (a
 * migration that can't replay, schema code running out of band) needs a source
 * change, which only a ticket may make. When the preview driver diagnoses one, it
 * lands here: a repair ticket is built on the branch's epic with `afterBuild:
 * 'preview'`, so the build queue reruns the preview once the fix merges.
 *
 * Guards: one open repair per epic, and at most MAX_ATTEMPTS repairs per epic in a
 * day; past that a person decides, so the two agents can't hand a failure back and
 * forth forever.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projects } from "../db/schema/projects.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { epics } from "../db/schema/epics.ts";
import { messages } from "../db/schema/chat.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { createEpic, listUnapprovedEpics } from "./epics.ts";
import { createBuildRun, getActiveRun } from "./build-queue.ts";
import { nextTicketKey } from "../utils/ticket-keys.ts";
import type { SourceRepair } from "./dev-preview.ts";

export const PREVIEW_REPAIR_WORKFLOW = "preview-repair";
const DEFAULT_BRANCH_EPIC = "Preview setup repairs";
const MAX_ATTEMPTS = 2;
const WINDOW_MS = 24 * 60 * 60_000;
const FINISHED = new Set(["review", "done", "failed"]);
const inFlight = new Set<string>();

type Epic = typeof epics.$inferSelect;

export async function requestPreviewRepair(o: {
  projectId: string; userId: string; conversationId: string | null;
  /** The branch the preview was running; "" is the repository default. */
  branch: string; error: string; sourceRepair: SourceRepair;
}): Promise<{ ticketId: string } | null> {
  if (inFlight.has(o.projectId)) return null;
  inFlight.add(o.projectId);
  try {
    const [project] = await db.select().from(projects).where(eq(projects.id, o.projectId));
    if (!project?.repoUrl && !project?.repoName) return null;
    const say = (content: string, conversationId = o.conversationId) => post(o.userId, project.projectId, conversationId, content);

    const epic = await repairEpic(o.projectId, o.userId, o.conversationId, o.branch);
    if (!epic) {
      await say(`⚠️ **The preview needs a code fix** — ${o.sourceRepair.summary}\n\nI couldn't find the epic that owns \`${o.branch}\`, so no repair ticket was started. Ask me to make this change and I'll build it.`);
      return null;
    }
    const conversationId = o.conversationId ?? epic.conversationId ?? null;

    const repairs = (await db.select().from(projectTickets).where(and(eq(projectTickets.projectId, o.projectId), eq(projectTickets.epicId, epic.id))))
      .filter(t => (t.details as { workflow?: string } | null)?.workflow === PREVIEW_REPAIR_WORKFLOW);
    const decision = repairDecision(repairs, Date.now());
    if (decision.kind === "open") return null;
    if (decision.kind === "limit") {
      const recent = decision.recent;
      await say(`⏸️ **Automatic preview repair stopped** — ${recent.length} repair tickets (${recent.map(t => t.ticketKey).join(", ")}) haven't got the preview running, so I won't open another on my own.\n\nStill failing: ${clip(o.error, 400)}\n\nTell me how you'd like to proceed, or retry from the **Preview** tab.`, conversationId);
      return null;
    }
    const active = await getActiveRun(o.projectId);
    if (active) {
      // That build already ends in a preview rerun; a repair queued behind it would race it.
      await say(`⚠️ **The preview needs a code fix** — ${o.sourceRepair.summary}\n\nA build is already running, so I'll leave it to finish first. If the preview still fails afterwards, I'll open a repair ticket.`, conversationId);
      return null;
    }

    const branchLabel = o.branch || "the default branch";
    const description = [
      "## Problem",
      `The preview of \`${branchLabel}\` cannot start without an application change. Preview setup may only repair its runtime recipe, so it handed this over.`,
      "",
      o.sourceRepair.summary,
      "",
      "## Evidence",
      "```",
      clip(o.error, 3000),
      "```",
      "",
      "## Implementation Notes",
      ...(o.sourceRepair.files.length ? o.sourceRepair.files.map(f => `- \`${f}\``) : ["- Locate the failing code from the evidence above."]),
      "- The fix must work on BOTH a fresh database and the existing development database (which already holds data).",
      "",
      "## Out of Scope",
      "- Forging or editing migration history records, disabling migrations, or dropping/resetting databases.",
      "- Unrelated changes; the preview reruns automatically when this merges.",
    ].join("\n");
    const acceptanceCriteria = [...o.sourceRepair.acceptanceCriteria, `The preview of \`${branchLabel}\` starts with its saved setup steps after this merges.`];

    const [ticket] = await db.insert(projectTickets).values({
      projectId: o.projectId, epicId: epic.id, conversationId,
      ticketKey: await nextTicketKey(o.projectId, project.name),
      name: `Fix preview: ${clip(o.sourceRepair.summary.split(/[.\n]/)[0] || "setup failure", 120)}`,
      description, acceptanceCriteria, complexity: "simple", priority: "High",
      details: { workflow: PREVIEW_REPAIR_WORKFLOW, previewBranch: o.branch || "(default)" },
    }).returning();
    if (!ticket) return null;

    await createBuildRun({
      projectId: o.projectId, userId: o.userId, conversationId, epicId: epic.id,
      ticketIds: [ticket.id], afterBuild: "preview", triggerMessage: `Repair preview: ${o.sourceRepair.summary}`,
    });
    const rerunNote = o.branch && o.branch === epic.branch
      ? `the preview of \`${epic.branch}\` reruns`
      : `the preview reruns on \`${epic.branch}\` (where the fix lands; it reaches \`${o.branch || "the default branch"}\` when the epic is approved)`;
    await say(`🔧 **The preview needs a code fix, so I've started ${ticket.ticketKey}.**\n\n${o.sourceRepair.summary}\n\nWhen it's built and merged, ${rerunNote} automatically.`, conversationId);
    return { ticketId: ticket.id };
  } finally {
    inFlight.delete(o.projectId);
  }
}

/** Whether another repair may start, given this epic's earlier repair tickets. */
export function repairDecision<T extends { status: string; createdAt: Date | null }>(repairs: T[], now: number):
  { kind: "open" } | { kind: "limit"; recent: T[] } | { kind: "start" } {
  // Already being repaired — this failure is the reason it was opened, or a rerun before it lands.
  if (repairs.some(t => !FINISHED.has(t.status))) return { kind: "open" };
  const recent = repairs.filter(t => t.createdAt && now - +new Date(t.createdAt) < WINDOW_MS);
  return recent.length >= MAX_ATTEMPTS ? { kind: "limit", recent } : { kind: "start" };
}

/** The epic a repair for `branch` belongs to: its own epic, a ticket branch's epic, or one for the default branch. */
async function repairEpic(projectId: string, userId: string, conversationId: string | null, branch: string): Promise<Epic | null> {
  const open = await listUnapprovedEpics(projectId);
  if (!branch) {
    return open.find(e => e.name === DEFAULT_BRANCH_EPIC)
      ?? await createEpic({ projectId, name: DEFAULT_BRANCH_EPIC, goal: "Application fixes the preview needs to start.", createdById: userId, conversationId });
  }
  const own = open.find(e => e.branch === branch);
  if (own) return own;
  const [ticket] = await db.select({ epicId: projectTickets.epicId }).from(projectTickets)
    .where(and(eq(projectTickets.projectId, projectId), eq(projectTickets.githubBranch, branch))).limit(1);
  return open.find(e => e.id === ticket?.epicId) ?? null;
}

async function post(userId: string, publicProjectId: string | null | undefined, conversationId: string | null, content: string): Promise<void> {
  if (!conversationId) return;
  await db.insert(messages).values({ conversationId, role: "assistant", content }).catch(() => {});
  broadcastToUser(userId, { type: "message", sender: "assistant", message: content, conversation_id: conversationId, project_id: publicProjectId ?? undefined, build_status: true });
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
