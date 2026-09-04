/**
 * Build runs: "build them all" as a DURABLE, dependency-aware queue.
 *
 * The old chain was a single reflex — when a ticket finished, look up "the next
 * open ticket in this project" and queue it. Three things were wrong with that:
 * it was project-wide (an unrelated ticket from months ago could be picked up
 * mid-epic), it ignored dependencies entirely, and it lived only in the moment —
 * there was no record of what the user actually asked for, so a restart, a crash
 * or a deploy in the middle of a five-ticket epic left nothing to resume from.
 *
 * A run is a row in `agent_run`; its items are `ticket_execution` rows and their
 * edges are `ticket_execution_dependency`. Every transition appends an
 * `agent_event`. All of it is in the database, so:
 *   - a restart resumes exactly where it stopped (see resumeBuildRuns),
 *   - the state is inspectable ("what is this project building, and why?"),
 *   - the finishing move is part of the plan, not an afterthought: when the last
 *     item lands, the run starts the preview for the epic's branch and posts the
 *     URL back into the conversation that asked for the build.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../config/db.ts";
import { agentRuns, ticketExecutions, ticketExecutionDependencies, agentEvents } from "../db/schema/orchestrator.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { projects } from "../db/schema/projects.ts";
import { messages } from "../db/schema/chat.ts";
import { emit } from "../events/bus.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { getEpic } from "./epics.ts";

/** run_type marker so these rows are distinguishable from other agent runs. */
const RUN_TYPE = "ticket_build_chain";
/** execution_type for a ticket build item. */
const EXEC_TYPE = "code_implementation";

export type AfterBuild = "preview" | "none";

interface RunPlan {
  epicId?: string | null;
  afterBuild: AfterBuild;
  /** Ticket keys in order, purely so the plan reads sensibly in the database. */
  order?: string[];
}

// ── Creating a run ────────────────────────────────────────────────────

/**
 * Queue a set of tickets as one run and start the first item.
 *
 * `ticketIds` is taken as the dependency order (the order the agent scheduled
 * them in): each item depends on the one before it. That's deliberately simple —
 * it matches how the product agent actually reasons ("1, 2, 3, 4, 5") and it
 * degrades safely, since a stricter graph could only ever run MORE in parallel
 * and this box builds one ticket at a time anyway.
 */
export async function createBuildRun(opts: {
  projectId: string;
  userId: string;
  conversationId: string | null;
  ticketIds: string[];
  epicId?: string | null;
  afterBuild?: AfterBuild;
  triggerMessage?: string;
}): Promise<{ runId: string; queued: number; firstTicketId: string | null }> {
  const ids = [...new Set(opts.ticketIds.filter(Boolean))];
  if (!ids.length) return { runId: "", queued: 0, firstTicketId: null };

  // Keep the caller's order, but only for tickets that really exist here.
  const rows = await db
    .select({ id: projectTickets.id, key: projectTickets.ticketKey, name: projectTickets.name, epicId: projectTickets.epicId })
    .from(projectTickets)
    .where(and(eq(projectTickets.projectId, opts.projectId), inArray(projectTickets.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.filter((id) => byId.has(id));
  if (!ordered.length) return { runId: "", queued: 0, firstTicketId: null };

  const epicId = opts.epicId ?? byId.get(ordered[0]!)?.epicId ?? null;
  const plan: RunPlan = {
    epicId,
    afterBuild: opts.afterBuild ?? "preview",
    order: ordered.map((id) => byId.get(id)?.key ?? id.slice(0, 8)),
  };

  const [run] = await db.insert(agentRuns).values({
    conversationId: opts.conversationId ?? "",
    projectId: opts.projectId,
    userId: opts.userId,
    triggerMessage: opts.triggerMessage ?? "Build the queued tickets",
    runType: RUN_TYPE,
    status: "running",
    plan,
  }).returning();
  if (!run) return { runId: "", queued: 0, firstTicketId: null };

  // Items in order, each depending on its predecessor.
  let prevExecId: string | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const t = byId.get(ordered[i]!)!;
    const [exec] = await db.insert(ticketExecutions).values({
      agentRunId: run.id,
      ticketId: t.id,
      title: `${t.key ?? ""} ${t.name}`.trim(),
      description: `Build ticket ${t.key ?? t.id}`,
      executionType: EXEC_TYPE,
      status: "pending",
      sequenceNumber: i,
    }).returning();
    if (!exec) continue;
    if (prevExecId) {
      await db.insert(ticketExecutionDependencies).values({ executionId: exec.id, dependsOnId: prevExecId }).catch(() => {});
    }
    prevExecId = exec.id;
  }

  await logRunEvent(run.id, null, "run_created", { ticketCount: ordered.length, epicId, afterBuild: plan.afterBuild });
  const started = await dispatchNext(run.id);
  return { runId: run.id, queued: ordered.length, firstTicketId: started };
}

// ── Advancing ─────────────────────────────────────────────────────────

/**
 * A ticket finished. If it belongs to a live run, record the outcome and start
 * the next item whose dependencies are satisfied.
 *
 * Returns true when this ticket was part of a run — the caller then leaves the
 * legacy project-wide auto-queue alone, so the two can't both dispatch.
 */
export async function onTicketFinished(ticketId: string, status: "complete" | "failed"): Promise<boolean> {
  const item = await liveItemForTicket(ticketId);
  if (!item) return false;

  await db.update(ticketExecutions)
    .set({ status: status === "complete" ? "done" : "failed", completedAt: new Date() })
    .where(eq(ticketExecutions.id, item.id));
  await logRunEvent(item.agentRunId, item.id, status === "complete" ? "ticket_completed" : "ticket_failed", { ticketId });

  // The user retried the ticket that had paused this run, and it worked — un-block
  // the run so the tickets waiting behind it carry on without anyone asking twice.
  if (status === "complete") {
    const [run] = await db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, item.agentRunId)).limit(1);
    if (run?.status === "blocked") {
      await db.update(agentRuns).set({ status: "running", updatedAt: new Date() }).where(eq(agentRuns.id, item.agentRunId));
      await logRunEvent(item.agentRunId, item.id, "run_unblocked", { ticketId });
      await announce(item.agentRunId, `▶️ **${item.title || "That ticket"} passed on retry — resuming the chain.**`);
    }
  }

  if (status === "failed") {
    // Stop the chain: everything after this depends on it. Say so, rather than
    // marching on and failing four more tickets for the same reason.
    await db.update(agentRuns).set({ status: "blocked", updatedAt: new Date() }).where(eq(agentRuns.id, item.agentRunId));
    await logRunEvent(item.agentRunId, item.id, "run_blocked", { ticketId }, true);
    const remaining = await pendingItems(item.agentRunId);
    await announce(item.agentRunId,
      `⛔ **Build chain paused** — ${item.title || "a ticket"} failed.\n\n` +
      `${remaining.length} ticket${remaining.length === 1 ? "" : "s"} still queued behind it. ` +
      `Open the ticket's Actions tab for the failure, then retry it — the chain picks up from there.`);
    return true;
  }

  await dispatchNext(item.agentRunId);
  return true;
}

/**
 * Start the next item whose dependencies are all done. When there is none left,
 * the run is complete and its finishing move runs.
 */
async function dispatchNext(runId: string): Promise<string | null> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!run || (run.status !== "running" && run.status !== "planning")) return null;

  // Anything already in flight → nothing to do; we build one ticket at a time.
  const inFlight = await db.select({ id: ticketExecutions.id })
    .from(ticketExecutions)
    .where(and(eq(ticketExecutions.agentRunId, runId), inArray(ticketExecutions.status, ["queued", "running"])))
    .limit(1);
  if (inFlight.length) return null;

  const pending = await pendingItems(runId);
  if (!pending.length) {
    await finishRun(runId);
    return null;
  }

  const doneIds = new Set(
    (await db.select({ id: ticketExecutions.id })
      .from(ticketExecutions)
      .where(and(eq(ticketExecutions.agentRunId, runId), eq(ticketExecutions.status, "done")))).map((r) => r.id),
  );

  for (const item of pending) {
    const deps = await db.select({ dependsOnId: ticketExecutionDependencies.dependsOnId })
      .from(ticketExecutionDependencies)
      .where(eq(ticketExecutionDependencies.executionId, item.id));
    if (deps.some((d) => !doneIds.has(d.dependsOnId))) continue; // still blocked

    if (!item.ticketId) continue;
    await db.update(ticketExecutions).set({ status: "queued", startedAt: new Date() }).where(eq(ticketExecutions.id, item.id));
    await db.update(projectTickets)
      .set({ queueStatus: "queued", queuedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectTickets.id, item.ticketId));
    await logRunEvent(runId, item.id, "ticket_queued", { ticketId: item.ticketId });
    emit({ type: "ticket.queued", ticketId: item.ticketId, projectId: run.projectId });
    return item.ticketId;
  }
  return null; // everything left is blocked behind a failure
}

/** The run drained — mark it complete and run the finishing move. */
async function finishRun(runId: string): Promise<void> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!run) return;
  await db.update(agentRuns).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(agentRuns.id, runId));
  await logRunEvent(runId, null, "run_completed", {});

  const plan = (run.plan ?? {}) as RunPlan;
  const built = await db.select({ title: ticketExecutions.title })
    .from(ticketExecutions)
    .where(and(eq(ticketExecutions.agentRunId, runId), eq(ticketExecutions.status, "done")))
    .orderBy(asc(ticketExecutions.sequenceNumber));
  const list = built.map((b) => `- ${b.title}`).join("\n");

  if (plan.afterBuild !== "preview") {
    await announce(runId, `✅ **All ${built.length} ticket${built.length === 1 ? "" : "s"} built.**\n\n${list}`);
    return;
  }

  // Finishing move: run the epic's branch and hand back a URL to test it on.
  const epic = plan.epicId ? await getEpic(plan.epicId).catch(() => null) : null;
  const branch = epic?.branch;
  if (!branch) {
    await announce(runId, `✅ **All ${built.length} ticket${built.length === 1 ? "" : "s"} built.**\n\n${list}\n\nOpen the **Preview** tab to run the branch.`);
    return;
  }

  await announce(runId, `✅ **All ${built.length} ticket${built.length === 1 ? "" : "s"} built.**\n\n${list}\n\n🚀 Starting the preview for \`${branch}\` — I'll post the URL here when it's up.`);
  await logRunEvent(runId, null, "preview_starting", { branch });

  try {
    const { restartPreview } = await import("./dev-preview.ts");
    const res = await restartPreview(run.projectId, {
      userId: run.userId,
      branch,
      conversationId: run.conversationId || null,
    });
    if ("error" in res) {
      await logRunEvent(runId, null, "preview_failed", { branch, error: res.error }, true);
      await announce(runId, `⚠️ The build finished, but the preview didn't start: ${res.error}\n\nYou can retry it from the **Preview** tab.`);
      return;
    }
    await logRunEvent(runId, null, "preview_ready", { branch, url: res.previewUrl });
    await announce(runId,
      `🔗 **${epic?.name ?? "The epic"} is live on \`${branch}\`**\n\n${res.previewUrl}\n\n` +
      `That's all ${built.length} ticket${built.length === 1 ? "" : "s"} running together — try it and tell me what to change.`);
  } catch (err) {
    await logRunEvent(runId, null, "preview_failed", { branch, error: String(err) }, true);
    await announce(runId, `⚠️ The build finished, but starting the preview threw: ${(err as Error).message?.slice(0, 200)}`);
  }
}

// ── Resume after a restart / deploy ───────────────────────────────────

/**
 * Pick up every unfinished run. Called once at worker start.
 *
 * A deploy can land mid-build, and the executor's own boot sweep resets tickets
 * that were `executing` back to `none` — which used to mean the work simply
 * stopped, silently, forever. Here we reconcile each item against the ticket's
 * real state (it may well have finished while we were down) and then dispatch,
 * so a run that was three tickets in continues from the fourth.
 */
export async function resumeBuildRuns(): Promise<void> {
  const runs = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.runType, RUN_TYPE), inArray(agentRuns.status, ["running", "planning"])))
    .catch(() => []);
  if (!runs.length) return;
  console.log(`[build-queue] resuming ${runs.length} unfinished build run(s)`);

  for (const run of runs) {
    try {
      const items = await db.select().from(ticketExecutions)
        .where(and(eq(ticketExecutions.agentRunId, run.id), inArray(ticketExecutions.status, ["queued", "running"])));

      for (const item of items) {
        if (!item.ticketId) continue;
        const [t] = await db.select({
          status: projectTickets.status,
          sha: projectTickets.githubCommitSha,
          queueStatus: projectTickets.queueStatus,
        }).from(projectTickets).where(eq(projectTickets.id, item.ticketId)).limit(1);
        if (!t) {
          await db.update(ticketExecutions).set({ status: "done", completedAt: new Date() }).where(eq(ticketExecutions.id, item.id));
          continue;
        }
        // Finished while we were down (In Review / Done, or pushed) → count it.
        if (t.status === "review" || t.status === "done" || (t.status !== "failed" && t.sha)) {
          await db.update(ticketExecutions).set({ status: "done", completedAt: new Date() }).where(eq(ticketExecutions.id, item.id));
          await logRunEvent(run.id, item.id, "ticket_completed", { ticketId: item.ticketId, viaResume: true });
        } else if (t.status === "failed") {
          await db.update(ticketExecutions).set({ status: "failed", completedAt: new Date() }).where(eq(ticketExecutions.id, item.id));
          await logRunEvent(run.id, item.id, "ticket_failed", { ticketId: item.ticketId, viaResume: true });
          await db.update(agentRuns).set({ status: "blocked", updatedAt: new Date() }).where(eq(agentRuns.id, run.id));
        } else if (t.queueStatus === "queued" || t.queueStatus === "executing") {
          // Already in the executor's pipeline — either it is genuinely building right
          // now, or the worker's own boot sweep re-queued it. Leave it alone: handing it
          // back here would dispatch the SAME ticket a second time.
          await db.update(ticketExecutions).set({ status: "queued" }).where(eq(ticketExecutions.id, item.id));
        } else {
          // Was mid-flight when the process died and nothing else picked it up: hand it
          // back to the queue.
          await db.update(ticketExecutions).set({ status: "pending", startedAt: null }).where(eq(ticketExecutions.id, item.id));
          await logRunEvent(run.id, item.id, "ticket_requeued_after_restart", { ticketId: item.ticketId });
        }
      }

      const [fresh] = await db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, run.id)).limit(1);
      if (fresh?.status === "running" || fresh?.status === "planning") await dispatchNext(run.id);
    } catch (err) {
      console.warn(`[build-queue] resume failed for run ${run.id}:`, (err as Error).message);
    }
  }
}

// ── Reading ───────────────────────────────────────────────────────────

/** The live run covering this project, with its items — for the agent to inspect. */
export async function getActiveRun(projectId: string): Promise<{
  runId: string; status: string; epicId: string | null; afterBuild: AfterBuild;
  items: { ticketId: string | null; title: string; status: string; sequence: number }[];
} | null> {
  const [run] = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.projectId, projectId), eq(agentRuns.runType, RUN_TYPE), inArray(agentRuns.status, ["running", "planning", "blocked"])))
    .orderBy(desc(agentRuns.createdAt)).limit(1);
  if (!run) return null;
  const items = await db.select().from(ticketExecutions)
    .where(eq(ticketExecutions.agentRunId, run.id))
    .orderBy(asc(ticketExecutions.sequenceNumber));
  const plan = (run.plan ?? {}) as RunPlan;
  return {
    runId: run.id, status: run.status, epicId: plan.epicId ?? null, afterBuild: plan.afterBuild ?? "preview",
    items: items.map((i) => ({ ticketId: i.ticketId, title: i.title, status: i.status, sequence: i.sequenceNumber })),
  };
}

/** Un-block a run after the user retries the failed ticket. */
export async function resumeBlockedRun(projectId: string): Promise<boolean> {
  const active = await getActiveRun(projectId);
  if (!active || active.status !== "blocked") return false;
  await db.update(agentRuns).set({ status: "running", updatedAt: new Date() }).where(eq(agentRuns.id, active.runId));
  // The failed item goes back in the queue; its dependents follow.
  await db.update(ticketExecutions).set({ status: "pending", completedAt: null })
    .where(and(eq(ticketExecutions.agentRunId, active.runId), eq(ticketExecutions.status, "failed")));
  await dispatchNext(active.runId);
  return true;
}

// ── Internals ─────────────────────────────────────────────────────────

async function liveItemForTicket(ticketId: string) {
  const [row] = await db
    .select({
      id: ticketExecutions.id, agentRunId: ticketExecutions.agentRunId,
      title: ticketExecutions.title, status: ticketExecutions.status,
    })
    .from(ticketExecutions)
    .innerJoin(agentRuns, eq(agentRuns.id, ticketExecutions.agentRunId))
    .where(and(
      eq(ticketExecutions.ticketId, ticketId),
      // "failed" is included so a RETRY of the ticket that paused the run is
      // recognised as this run's item rather than falling through to the legacy
      // project-wide chain. "done" is not: a duplicate finish must match nothing.
      inArray(ticketExecutions.status, ["queued", "running", "pending", "failed"]),
      eq(agentRuns.runType, RUN_TYPE),
      inArray(agentRuns.status, ["running", "planning", "blocked"]),
    ))
    .orderBy(desc(ticketExecutions.createdAt))
    .limit(1);
  return row ?? null;
}

async function pendingItems(runId: string) {
  return db.select().from(ticketExecutions)
    .where(and(eq(ticketExecutions.agentRunId, runId), eq(ticketExecutions.status, "pending")))
    .orderBy(asc(ticketExecutions.sequenceNumber));
}

async function logRunEvent(
  runId: string,
  executionId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
  requiresUserAction = false,
): Promise<void> {
  await db.insert(agentEvents).values({
    agentRunId: runId, ticketExecutionId: executionId, eventType, payload, requiresUserAction,
  }).catch(() => {});
}

/** Post a message from the run into the conversation that started it. */
async function announce(runId: string, content: string): Promise<void> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!run) return;
  const [proj] = await db.select({ pub: projects.projectId }).from(projects).where(eq(projects.id, run.projectId)).limit(1);
  if (run.conversationId) {
    await db.insert(messages).values({ conversationId: run.conversationId, role: "assistant", content }).catch(() => {});
  }
  broadcastToUser(run.userId, {
    type: "message", sender: "assistant", message: content,
    conversation_id: run.conversationId || undefined, project_id: proj?.pub,
  });
}
