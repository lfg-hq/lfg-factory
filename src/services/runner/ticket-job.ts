/**
 * Turn a ticket into a Claude Code job for the requester's own computer.
 *
 * The job only describes the work (repo, branch, prompt). The runner clones with
 * the person's own Git credentials and runs their own `claude` login, so neither a
 * Git token nor a Claude credential ever leaves the server or the laptop.
 */

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { runnerJobs } from "../../db/schema/runners.ts";
import { db } from "../../config/db.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { projects } from "../../db/schema/projects.ts";
import { resolveTicketAnchor } from "../epics.ts";
import { ticketBranchName } from "../../utils/ticket-branch.ts";
import { addLog } from "../ticket-logs.ts";
import { enqueueJob, userHasConnectedRunner } from "./hub.ts";
import { LOCAL_AGENT_EFFORTS, localAiSettings } from "./opt-in.ts";
import { RUNNER_PROTOCOL_VERSION, type AgentEffort, type AgentKind, type ClaudeTaskPayload } from "./protocol.ts";

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
    "- Make the smallest complete change that satisfies the ticket. Add or update tests where the project has them.",
    "- While you work, run only the tests for what you changed (one file or a name filter). Run the full test suite, typecheck, lint and build once, at the end. A full run takes minutes, so don't repeat it after small fixes: rerun just the failing tests, then finish.",
    "- If dependencies are already installed (node_modules exists), don't reinstall them; install only when you change the package files or something is missing.",
    "- Edit files with your edit tools rather than writing scripts that rewrite them.",
    "- Other tickets may be building on this computer at the same time, each in its own folder. Don't rely on fixed ports or shared database names: give anything you start or create for tests a name or port of its own.",
    "- Do not commit, push or switch branches. LFG Desktop commits and pushes your changes when you finish.",
    "- End with a short summary of what you changed and anything left undone, then one JSON block reporting the checks you ran at the end (LFG shows them on the ticket), and nothing after it:",
    "```json",
    '{"checks": [{"name": "Tests", "command": "<what you ran>", "status": "passed" | "failed" | "preexisting", "detail": "<e.g. 143 of 148 passed>"}], "howToRun": "<the exact commands that ran the checks on this computer, with any PATH, env or database setup they needed>"}',
    "```",
    "  Use \"preexisting\" only for a check that fails the same way without your change (you checked). List tests, typecheck, lint and build, whichever the project has.",
  ].join("\n");
}

export function buildFollowUpPrompt(ticket: { ticketKey: string | null; name: string }, message: string): string {
  return [
    `Follow-up on ticket ${ticket.ticketKey ?? ""} "${ticket.name}". Earlier work on it is already on this branch.`.replace("  ", " "),
    "",
    "## Request",
    message.trim(),
    "",
    "## How to work",
    "- If this is a question, answer it; change code only when it asks for a change.",
    "- Do not commit, push or switch branches. LFG Desktop commits and pushes your changes when you finish.",
    "- End with a short summary of what you did.",
  ].join("\n");
}

/**
 * How hard the agent thinks, by the ticket's complexity. Most of a build's time is the
 * model reasoning, so a simple ticket runs one level below the person's choice (low when
 * they chose none), and a complex one gets high when they chose none. A follow-up, or an
 * agent without effort levels, keeps the person's choice.
 */
export function buildEffort(agent: AgentKind, chosen: AgentEffort | null, complexity: string | null | undefined): AgentEffort | null {
  const levels = LOCAL_AGENT_EFFORTS[agent];
  if (!levels.length || !complexity) return chosen;
  if (complexity === "simple") {
    if (!chosen) return levels.includes("low") ? "low" : null;
    return levels[Math.max(0, levels.indexOf(chosen) - 1)] ?? chosen;
  }
  if (complexity === "complex" && !chosen) return levels.includes("high") ? "high" : null;
  return chosen;
}

export async function startTicketOnRunner(input: {
  projectId: string; ticketId: string; actorId: string; notes?: string;
  /** A ticket-chat follow-up instead of a build: continues the agent's earlier session. */
  followUp?: string;
  /** Called from the build queue, where the ticket is already marked "queued". */
  fromQueue?: boolean;
  /** The ticket's own agent choice; otherwise the person's chosen agent. */
  agent?: AgentKind;
}) {
  const [ticket] = await db.select().from(projectTickets)
    .where(and(eq(projectTickets.id, input.ticketId), eq(projectTickets.projectId, input.projectId))).limit(1);
  if (!ticket) throw new RunnerJobError("Ticket not found", 404);
  const busy = input.fromQueue ? /^(executing|stopping)$/ : /^(queued|executing|stopping)$/;
  if (busy.test(ticket.queueStatus)) throw new RunnerJobError("This ticket already has an active operation.", 409);
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) throw new RunnerJobError("Project not found", 404);
  if (!project.repoUrl) throw new RunnerJobError("Connect a Git repository to this project before running it on your computer.");

  const settings = await localAiSettings(input.actorId);
  const agent = input.agent ?? settings.agent;
  // The person's model/effort belong to their chosen agent; another agent uses its own default.
  const model = agent === settings.agent ? settings.model : null;
  const effort = buildEffort(agent, agent === settings.agent ? settings.effort : null, input.followUp ? null : ticket.complexity);
  // A follow-up continues the same agent's latest session on this ticket, if there is one.
  const [previous] = input.followUp
    ? await db.select({ session: runnerJobs.agentSession }).from(runnerJobs)
        .where(and(eq(runnerJobs.ticketId, ticket.id), eq(runnerJobs.userId, input.actorId), eq(runnerJobs.agent, agent), isNotNull(runnerJobs.agentSession)))
        .orderBy(desc(runnerJobs.createdAt)).limit(1)
    : [];
  const anchor = await resolveTicketAnchor(ticket);
  const branch = ticket.githubBranch || ticketBranchName(ticket);
  const payload: ClaudeTaskPayload = {
    protocol: RUNNER_PROTOCOL_VERSION,
    projectName: project.name,
    ticketKey: ticket.ticketKey,
    ticketTitle: ticket.name,
    repoUrl: project.repoUrl,
    branch,
    // Like a cloud build, the ticket lands on its epic branch so the next ticket builds on it.
    ...(anchor.anchorBranch && anchor.anchorBranch !== branch ? { mergeInto: anchor.anchorBranch } : {}),
    startFrom: [...new Set([anchor.anchorBranch, anchor.baseBranch, "main", "master"])],
    prompt: input.followUp ? buildFollowUpPrompt(ticket, input.followUp) : buildRunnerPrompt(ticket, input.notes),
    commitMessage: `${ticket.ticketKey ? `${ticket.ticketKey}: ` : ""}${ticket.name}`.slice(0, 200),
    agent,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(previous?.session ? { sessionId: previous.session } : {}),
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    // A build implements, tests and checks a whole ticket; 80 steps ran out before it
    // could finish (error_max_turns), losing the work. Follow-ups are smaller.
    maxTurns: input.followUp ? 80 : 200,
    ...(input.followUp ? {} : { build: true }),
    // Then a recorded walkthrough of the acceptance criteria (Claude Code drives the browser).
    ...(!input.followUp && agent === "claude" ? { walkthrough: true } : {}),
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
