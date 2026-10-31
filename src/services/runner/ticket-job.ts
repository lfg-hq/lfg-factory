/**
 * Turn a ticket into a Claude Code job for the requester's own computer.
 *
 * The job only describes the work (repo, branch, prompt). The runner clones with
 * the person's own Git credentials and runs their own `claude` login, so neither a
 * Git token nor a Claude credential ever leaves the server or the laptop.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { projects } from "../../db/schema/projects.ts";
import { resolveTicketAnchor } from "../epics.ts";
import { ticketBranchName } from "../../utils/ticket-branch.ts";
import { addLog } from "../ticket-logs.ts";
import { enqueueJob, userHasConnectedRunner } from "./hub.ts";
import { RUNNER_PROTOCOL_VERSION, type ClaudeTaskPayload } from "./protocol.ts";

export class RunnerJobError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

export function buildRunnerPrompt(ticket: {
  ticketKey: string | null; name: string; description: string;
  acceptanceCriteria?: unknown; notes?: string | null;
}, extraNotes?: string): string {
  const criteria = Array.isArray(ticket.acceptanceCriteria) ? ticket.acceptanceCriteria.map(String).filter(Boolean) : [];
  const notes = [ticket.notes?.trim(), extraNotes?.trim()].filter(Boolean).join("\n\n");
  return [
    `You are implementing ticket ${ticket.ticketKey ?? ""} "${ticket.name}" in this repository.`.replace("  ", " "),
    "",
    "## Ticket",
    ticket.description.trim() || "(no description)",
    "",
    "## Acceptance criteria",
    criteria.length ? criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") : "Not specified.",
    ...(notes ? ["", "## Notes", notes] : []),
    "",
    "## How to work",
    "- Read the code before changing it and follow the repository's existing conventions.",
    "- Make the smallest complete change that satisfies the ticket. Add or update tests where the project has them, and run them.",
    "- Do not commit, push or switch branches. LFG Desktop commits and pushes your changes when you finish.",
    "- End with a short summary of what you changed and anything left undone.",
  ].join("\n");
}

export async function startTicketOnRunner(input: { projectId: string; ticketId: string; actorId: string; notes?: string }) {
  const [ticket] = await db.select().from(projectTickets)
    .where(and(eq(projectTickets.id, input.ticketId), eq(projectTickets.projectId, input.projectId))).limit(1);
  if (!ticket) throw new RunnerJobError("Ticket not found", 404);
  if (/^(queued|executing|stopping)$/.test(ticket.queueStatus)) throw new RunnerJobError("This ticket already has an active operation.", 409);
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) throw new RunnerJobError("Project not found", 404);
  if (!project.repoUrl) throw new RunnerJobError("Connect a Git repository to this project before running it on your computer.");

  const anchor = await resolveTicketAnchor(ticket);
  const branch = ticket.githubBranch || ticketBranchName(ticket);
  const payload: ClaudeTaskPayload = {
    protocol: RUNNER_PROTOCOL_VERSION,
    projectName: project.name,
    ticketKey: ticket.ticketKey,
    ticketTitle: ticket.name,
    repoUrl: project.repoUrl,
    branch,
    startFrom: [...new Set([anchor.anchorBranch, anchor.baseBranch, "main", "master"])],
    prompt: buildRunnerPrompt(ticket, input.notes),
    commitMessage: `${ticket.ticketKey ? `${ticket.ticketKey}: ` : ""}${ticket.name}`.slice(0, 200),
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    maxTurns: 80,
  };

  // "executing" from the start: "queued" would let the cloud worker pick it up after a restart.
  const claimed = await db.update(projectTickets)
    .set({ status: "in_progress", queueStatus: "executing", updatedAt: new Date() })
    .where(and(eq(projectTickets.id, ticket.id), eq(projectTickets.queueStatus, ticket.queueStatus)))
    .returning({ id: projectTickets.id });
  if (!claimed.length) throw new RunnerJobError("Another operation claimed this ticket.", 409);

  if (!userHasConnectedRunner(input.actorId)) {
    await addLog(ticket.id, "Waiting for your computer. Open LFG Desktop and this build starts there.", "agent_progress", project.ownerId);
  }
  return enqueueJob({ userId: input.actorId, projectId: project.id, ticketId: ticket.id, payload });
}
