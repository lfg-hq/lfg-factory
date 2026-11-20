/**
 * After a ticket in an epic is built and merged into the epic's branch, restart the
 * preview on that branch so the person can click straight in and test.
 *
 * Build runs already do this when the whole run finishes (build-queue finishRun), so
 * this covers single-ticket builds and retries, which used to leave the preview running
 * the old code. Where it runs follows the project's "Preview on" setting (cloud or the
 * person's computer through LFG Desktop) via resolvePreviewWhere.
 */
import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { projects } from "../db/schema/projects.ts";
import { messages } from "../db/schema/chat.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { getEpic } from "./epics.ts";
import { getBuildOrigin } from "./build-reporting.ts";

export interface EpicPreviewTarget {
  ticketId: string;
  projectId: string;
  publicProjectId: string;
  userId: string;
  conversationId: string | null;
  branch: string;
  epicLabel: string;
}

/** The epic branch to preview after this ticket's build, or null when there is none. */
export async function epicPreviewTarget(ticketId: string): Promise<EpicPreviewTarget | null> {
  const [ticket] = await db.select({
    projectId: projectTickets.projectId, epicId: projectTickets.epicId, mergeStatus: projectTickets.githubMergeStatus,
  }).from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  if (!ticket?.epicId) return null;
  // Only when the work actually landed on the epic branch; otherwise the preview would
  // restart on code that doesn't include this ticket.
  if (ticket.mergeStatus !== "merged" && ticket.mergeStatus !== "merged_with_conflicts") return null;
  const epic = await getEpic(ticket.epicId).catch(() => undefined);
  if (!epic?.branch) return null;
  const origin = await getBuildOrigin(ticketId);
  // A build run previews once, when the whole run is done.
  if (origin.inRun) return null;
  const [project] = await db.select({ id: projects.id, projectId: projects.projectId, ownerId: projects.ownerId, repoUrl: projects.repoUrl })
    .from(projects).where(eq(projects.id, ticket.projectId)).limit(1);
  if (!project?.repoUrl) return null;
  const userId = origin.userId || project.ownerId;
  if (!userId) return null;
  return {
    ticketId, projectId: project.id, publicProjectId: project.projectId ?? project.id, userId,
    conversationId: origin.conversationId, branch: epic.branch,
    epicLabel: `${epic.epicKey ? epic.epicKey + " — " : ""}${epic.name}`,
  };
}

// One refresh per project at a time; a build that lands meanwhile asks for one more.
const inFlight = new Map<string, EpicPreviewTarget | null>();

export function refreshEpicPreview(target: EpicPreviewTarget): void {
  if (inFlight.has(target.projectId)) { inFlight.set(target.projectId, target); return; }
  inFlight.set(target.projectId, null);
  void (async () => {
    let next: EpicPreviewTarget | null = target;
    while (next) {
      await runOnce(next).catch((e) => console.warn("[epic-auto-preview] failed:", (e as Error).message));
      next = inFlight.get(target.projectId) ?? null;
      inFlight.set(target.projectId, null);
    }
    inFlight.delete(target.projectId);
  })();
}

async function runOnce(t: EpicPreviewTarget): Promise<void> {
  const local = await import("./runner/preview-job.ts");
  const where = await local.resolvePreviewWhere(t.userId, { projectId: t.projectId });
  const res = where.where === "computer"
    ? await local.startLocalPreview({ projectId: t.projectId, userId: t.userId, refresh: true, ...(await local.resolvePreviewBranch(t.projectId, { branch: t.branch })) })
        .then((job) => local.waitForLocalPreview(job.id, 15 * 60_000))
    : await (await import("./dev-preview.ts")).restartPreview(t.projectId, { userId: t.userId, branch: t.branch, conversationId: t.conversationId });
  const place = where.where === "computer" ? "on your computer" : "in the cloud";
  await say(t, "error" in res
    ? `The preview of \`${t.branch}\` didn't start ${place}: ${res.error}\n\nYou can try again with **Restart** in the Preview tab.`
    : `**${t.epicLabel}** is ready to test ${place}, with the latest build: ${res.previewUrl}`);
}

/** A short status line in the chat that started the build. No agent turn. */
async function say(t: EpicPreviewTarget, content: string): Promise<void> {
  if (!t.conversationId) return;
  await db.insert(messages).values({ conversationId: t.conversationId, role: "assistant", userRole: "operation_status", content });
  broadcastToUser(t.userId, { type: "message", sender: "assistant", message: content,
    conversation_id: t.conversationId, project_id: t.publicProjectId, build_status: true });
}
