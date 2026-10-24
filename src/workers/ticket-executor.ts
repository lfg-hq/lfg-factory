import { withTicketOperation, updateTicketOperation, publishTicketOperation } from '../services/ticket-operations.ts';
import { selectTicketContextDocuments, ticketDocumentInstructions } from "../services/ticket-context-documents.ts";
import {emptyRepoBootstrap} from '../services/empty-repo-bootstrap.ts';
import { openTicketWorkspace, latestTicketWorkspace } from '../services/ticket-workspace.ts';
import { markTicketSandboxBusy, retireTicketSandbox, sweepIdleTicketSandboxes, ticketJournalInstruction, workJournalBlock } from '../services/ticket-sandbox-retire.ts';
import { setBuildOrigin, reportBuildStatus } from "../services/build-reporting.ts";
import { ticketStopVerificationScript, confirmTicketStopped } from "../services/ticket-stop-verification.ts";
import { ValidationFailure } from "../services/validation-contract.ts";
import { failureSummary } from "../services/preview-plan.ts";
import { createTicketSandbox } from "../services/ticket-sandbox-clone.ts";
import { recoverSandboxStorage, destroyWorkspaceAfterStop } from "../services/sandbox-storage-recovery.ts";
import { runGitSetup, refreshOriginCommand } from "../services/build-preflight.ts";
import { TICKET_RUNTIME_INSTRUCTION } from "../services/ticket-runtime.ts";
import { watchSkipChecks } from "../services/check-skip.ts";
import { checkLogType, shortSummary, recentWorkSummary } from "../services/build-progress.ts";
import { withTicketUsage } from "../services/usage-run.ts";
import { ENGINEERING_CONTRACT } from '../ai/prompts/engineering-contract.ts';
import { currentUsage } from "../ai/usage-context.ts";
/**
 * Ticket Executor Worker
 *
 * Subscribes to `ticket.queued` events and runs the full execution flow
 * (matching Django's execute_ticket_with_claude_cli):
 *
 * Step 1: Load ticket + project + user data
 * Step 2: Find or create Mags sandbox (probe existing, fallback to fresh)
 * Step 3: Setup git repo, checkout feature branch
 * Step 4: Verify Claude auth (credentials from DB)
 * Step 5: Build prompt with project context + LFG API integration
 * Step 6: Start Claude CLI via runner script (nohup, root)
 * Step 7: Wait for completion (VM pushes output to /api/v1/cli/output/)
 * Step 8: On completion: commit, push, update ticket status
 *
 * Also handles ticket.chat_message events for session-resume chat.
 */

import { db } from "../config/db.ts";
import { projectTickets, projectTodoLists, ticketStages, ticketLogs, ticketAddenda, projectTicketAttachments } from "../db/schema/tickets.ts";
import { projects, projectEnvironmentVariables } from "../db/schema/projects.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { profiles, githubTokens, applicationState, llmApiKeys } from "../db/schema/users.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { decrypt } from "../ai/tools/env-tools.ts";
import { bus, emit } from "../events/bus.ts";
import {
  newWorkspaceV2,
  execOnWorkspace,
  deleteWorkspace,
  stopWorkspace,
  setNoSleep,
} from "../services/mags.ts";
import {
  startClaudeCli,
  startClaudeCliChat,
  preflightCheck,
  saveCredentialsFromVm,
  markClaudeDisconnected,
} from "../services/claude-cli.ts";
import {
  commitAndPush,
  mergeToAnchor,
  createGitHubRepo,
  initAndPushRepo,
} from "../services/git.ts";
import { resolveGitActor, NO_SHARED_GIT_MESSAGE } from "../services/git-access.ts";
import { resolveLlmGrants, NO_LLM_ACCESS_MESSAGE } from "../services/llm-access.ts";
import {
  buildBuilderPrompt,
  buildTicketChatPrompt,
  TICKET_FOLLOWUP_TASKS,
  TICKET_FOLLOWUP_SCOPE,
} from "../ai/prompts/builder.ts";
import { buildApiBuilderPrompt } from "../ai/prompts/builder-api.ts";
import { shellQuote } from '../services/preview-plan.ts';
import { createBuilderTools } from "../ai/tools/builder-tools.ts";
import { getModel, getProviderName, getProviderModel, DEFAULT_MODEL_KEY, type ProviderName } from "../ai/provider.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { resolveRepoAuth, extractRepoUrl, type RepoAuth } from "../services/repo-auth.ts";
import {
  resolveTicketAnchor,
  markEpicBuilding,
  maybeSubmitEpicForReview,
  recordEpicFilesTouched,
} from "../services/epics.ts";

/**
 * Remove a ticket's git worktree from the shared preview sandbox and drop its
 * sandbox row. Called ONLY when the ticket is approved and moved to Done — the
 * worktree is kept alive through In-Review so the user can preview/test the branch.
 */
export async function cleanupTicketWorktree(ticketId: string): Promise<void> {
  const rows = await db.select().from(sandboxes).where(eq(sandboxes.ticketId, ticketId));
  const keep: string[] = []; // rows we deliberately leave in place
  for (const sb of rows) {
    if (!sb.magsWorkspaceId) continue;
    const isPreview = sb.magsWorkspaceId.startsWith("pv-");
    if (sb.workspaceType === "ticket-worktree" && isPreview) {
      // A worktree lives inside the always-on preview VM — remove the worktree,
      // never the VM. EXCEPT when the preview is currently serving this branch from
      // that very directory: deleting it would pull the files out from under a
      // running app someone is looking at. Leave it; it's evicted later when a lane
      // needs the space (evictFinishedWorktrees).
      const [t] = await db.select({ branch: projectTickets.githubBranch, projectId: projectTickets.projectId })
        .from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
      const liveBranch = t?.projectId ? await livecastPreviewBranch(t.projectId) : null;
      if (t?.branch && liveBranch && t.branch === liveBranch) {
        console.log(`[ticket-executor] Keeping worktree for ${ticketId} — the preview is serving ${liveBranch}`);
        keep.push(sb.id);
        continue;
      }
      const dir = ticketWorktreeDirName(ticketId);
      await execOnWorkspace(sb.magsWorkspaceId, `cd ${WORKING_DIR}/project 2>/dev/null && git worktree remove --force ${WORKING_DIR}/${dir} 2>/dev/null; rm -rf ${WORKING_DIR}/${dir} 2>/dev/null; git worktree prune 2>/dev/null; echo cleaned`, { timeout: 60_000 }).catch(() => {});
    } else if (!isPreview) {
      // A DEDICATED isolated VM (ticket-chat / ticket build) — destroy it so the
      // warm chat sandbox doesn't linger after the ticket is done.
      await deleteWorkspace(sb.magsWorkspaceId).catch(() => {});
    }
  }
  if (keep.length) {
    for (const sb of rows) {
      if (!keep.includes(sb.id)) await db.delete(sandboxes).where(eq(sandboxes.id, sb.id)).catch(() => {});
    }
    return;
  }
  await db.delete(sandboxes).where(eq(sandboxes.ticketId, ticketId)).catch(() => {});
}

/**
 * The model to build tickets with. Precedence: an explicit builder model (if the
 * user set one in Settings) → the user's SELECTED CHAT model → the global default.
 * This is why a DeepSeek chat user's tickets build with DeepSeek, not a hardcoded
 * Claude. (The old hardcoded "claude_4.5_sonnet" fallback ignored the chat pick
 * AND was a dead key.)
 */
import { resolveBuildLlm, resolveBuilderModelKey, resolveBuilderAuthMode } from "../services/build-llm-access.ts";
import { startPiCli, streamPiToCompletion, isPiSupportedProvider, extractPiProgress, piProviderUsesSharedConfig } from "../services/pi-cli.ts";
import { getOpenAICodexAccessToken, hasOpenAICodexCredentials } from "../services/openai-codex-auth.ts";

/** Pi's final "here's what I did" summary from its output tail (or ""). */
function piWorkSummary(tail: string | undefined): string {
  const s = extractPiProgress(tail || "", 1200) || "";
  return s.replace(/^Agent:\s*/, "").trim();
}

/** Concrete failure detail for the banner when the agent itself is unhelpful ("did not
 *  complete"): the most recent error log, else the last meaningful line the agent
 *  printed. Kept short + single-line. Best-effort → "" on any failure. */
async function lastErrorSnippet(ticketId: string, tail?: string): Promise<string> {
  try {
    const [errLog] = await db
      .select({ m: ticketLogs.command })
      .from(ticketLogs)
      .where(and(eq(ticketLogs.ticketId, ticketId), eq(ticketLogs.logType, "cli_error")))
      .orderBy(desc(ticketLogs.createdAt))
      .limit(1);
    let snip = (errLog?.m ?? "").trim();
    if (!snip && tail) {
      const lines = tail.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("{") && !l.startsWith("["));
      snip = lines.length ? lines[lines.length - 1]! : "";
    }
    snip = snip.replace(/\s+/g, " ").trim();
    return snip.length > 240 ? snip.slice(0, 237) + "…" : snip;
  } catch {
    return "";
  }
}
import { getBuildProfile, detectProjectType } from "../services/instant-profiles.ts";
import { generateText, stepCountIs } from "ai";
import { resolveUserModel } from "../services/app-profile.ts";
import { addLog } from "../services/ticket-logs.ts";
import {
  isChatTurnActive,
  runChatTurn,
  resolveTurnOutcome,
  encodeQuestionMeta,
  TICKET_CHAT_MODE_CONTRACT,
} from "../services/ticket-chat-turn.ts";
import {
  tryAcquireLane,
  acquireLaneWaiting,
  releaseLane,
  noteLanePid,
  laneOf,
  activeLanes,
  scopedStopScript,
  freeDiskGb,
  laneMinFreeGb,
  topDiskConsumers,
  planWorktreeEviction,
} from "../services/shared-lanes.ts";
import { runTicketQa } from "../services/qa-agent.ts";
import { matchKnowledgeForPrompt } from "../ai/knowledge/matcher.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { logActivity } from "../services/activity-log.ts";
import { ACTIVITY_TYPES } from "../db/schema/activities.ts";
import { eq, and, asc, desc, inArray, ne } from "drizzle-orm";

/** Find a stage by name for a project and move the ticket to it. */
async function moveTicketToStage(ticketId: string, projectId: string, stageName: string): Promise<string | null> {
  const [stage] = await db
    .select({ id: ticketStages.id })
    .from(ticketStages)
    .where(and(eq(ticketStages.projectId, projectId), eq(ticketStages.name, stageName)))
    .limit(1);
  if (stage) {
    await db.update(projectTickets).set({ stageId: stage.id, updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
  }
  return stage?.id ?? null;
}

const CALLBACK_BASE_URL = process.env.APP_URL ?? "http://localhost:3000";

/**
 * Seed 3–7 implementation subtasks up-front so the Tasks tab is populated the
 * instant a build starts — regardless of whether the (often weaker) build agent
 * remembers to call the optional createTasks tool, and regardless of whether the
 * build later fails. The agent's own createTasks is idempotent (dedupes by
 * description), so it reuses these instead of duplicating.
 *
 * Best-effort: any failure here is swallowed so it never blocks a build.
 */
async function seedTasksIfEmpty(
  ticket: { id: string; name: string; description: string | null; acceptanceCriteria?: unknown; details?: unknown },
  ownerId: string,
): Promise<void> {
  try {
    const acceptanceCriteria: string[] = Array.isArray(ticket.acceptanceCriteria)
      ? ticket.acceptanceCriteria.filter((c): c is string => typeof c === "string")
      : [];
    const existing = await db
      .select({ id: projectTodoLists.id })
      .from(projectTodoLists)
      .where(eq(projectTodoLists.ticketId, ticket.id));
    if (existing.length > 0) return; // agent/user already created tasks

    let descriptions: string[] = [];

    // Primary: ask the user's model to decompose the ticket. Use plain text +
    // JSON parse (not generateObject) so weak models (Kimi/DeepSeek/GLM) that
    // reject structured-output negotiation still work.
    try {
      if(!descriptions.length){
      const { model } = await resolveUserModel(ownerId);
      const ac = acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const prompt =
        "Break this software ticket into 3 to 7 concrete implementation steps a developer would follow, in order.\n\n" +
        "Ticket: " + ticket.name + "\n\n" +
        "Description:\n" + (ticket.description ?? "(none)") + "\n\n" +
        (ac ? "Acceptance criteria:\n" + ac + "\n\n" : "") +
        "Reply with ONLY a JSON array of short step strings, e.g. [\"Add the X model\", \"Wire the Y endpoint\"]. No prose, no code fences.";
      const { text } = await generateText({ model, prompt });
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(parsed)) {
          descriptions = parsed
            .map((x) => (typeof x === "string" ? x : typeof x?.description === "string" ? x.description : ""))
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 7);
        }
      }
      }
    } catch (err) {
      console.warn(`[ticket-executor] task seeding via model failed for ${ticket.id}:`, err);
    }

    // Fallback: one task per acceptance criterion.
    if (descriptions.length === 0) {
      descriptions = acceptanceCriteria.map((c) => c.trim()).filter(Boolean).slice(0, 7);
    }
    if (descriptions.length === 0) return; // nothing to seed — leave it to the agent

    const rows = await db
      .insert(projectTodoLists)
      .values(descriptions.map((description, i) => ({ ticketId: ticket.id, description, status: "pending", order: i })))
      .returning({ id: projectTodoLists.id });
    emit({ type: "ticket.tasks_updated", ticketId: ticket.id, taskIds: rows.map((r) => r.id) });
    console.log(`[ticket-executor] Seeded ${rows.length} subtasks for ticket ${ticket.id}`);
  } catch (err) {
    console.warn(`[ticket-executor] seedTasksIfEmpty failed for ${ticket.id}:`, err);
  }
}

/**
 * Mark the FIRST subtask in_progress when a build starts (so the Tasks tab shows
 * motion even on the Pi path, which doesn't self-report per step). No-op if a task
 * is already in_progress/done, or there are no tasks. Best-effort.
 */
async function markBuildTasksStarted(ticketId: string): Promise<void> {
  try {
    const rows = await db
      .select({ id: projectTodoLists.id, status: projectTodoLists.status })
      .from(projectTodoLists)
      .where(eq(projectTodoLists.ticketId, ticketId))
      .orderBy(projectTodoLists.order);
    if (!rows.length) return;
    if (rows.some((r) => r.status === "in_progress" || r.status === "success")) return;
    const first = rows.find((r) => r.status === "pending") ?? rows[0]!;
    await db.update(projectTodoLists).set({ status: "in_progress" }).where(eq(projectTodoLists.id, first.id));
    emit({ type: "ticket.tasks_updated", ticketId, taskIds: [first.id] });
  } catch (err) {
    console.warn(`[ticket-executor] markBuildTasksStarted failed for ${ticketId}:`, err);
  }
}

/**
 * On a SUCCESSFUL build, flip every not-yet-done subtask to done. Coarse (all at
 * once at the end) but truthful — the ticket's acceptance criteria were met. On
 * failure we DON'T call this, so the tab shows how far it got. Best-effort.
 */
async function markBuildTasksComplete(ticketId: string): Promise<void> {
  try {
    const rows = await db
      .select({ id: projectTodoLists.id })
      .from(projectTodoLists)
      .where(and(eq(projectTodoLists.ticketId, ticketId), ne(projectTodoLists.status, "success")));
    if (!rows.length) return;
    await db
      .update(projectTodoLists)
      .set({ status: "success" })
      .where(and(eq(projectTodoLists.ticketId, ticketId), ne(projectTodoLists.status, "success")));
    emit({ type: "ticket.tasks_updated", ticketId, taskIds: rows.map((r) => r.id) });
  } catch (err) {
    console.warn(`[ticket-executor] markBuildTasksComplete failed for ${ticketId}:`, err);
  }
}

/**
 * Persist Pi's run artifacts to S3 BEFORE the VM is reaped — the raw JSONL stream
 * (all runs concatenated, since resumes create new files) + the exact composite prompt.
 * Keyed by ticket so the download endpoints can serve them long after the sandbox is
 * gone (Pi's /data/.pi files are auto-cleaned ~30min after a run). Best-effort.
 */
async function backupPiArtifacts(ticketId: string, workspaceId: string | null | undefined): Promise<void> {
  if (!workspaceId) return;
  try {
    const { uploadBinary, uploadFile } = await import("../services/s3.ts");
    const outRes = await execOnWorkspace(
      workspaceId,
      `fs=$(ls -tr /data/.pi/pi_output_*.jsonl 2>/dev/null); if [ -n "$fs" ]; then cat $fs | gzip -c | base64 | tr -d '\\n'; else echo NONE; fi`,
      { timeout: 120_000 },
    ).catch(() => ({ output: "" } as { output: string }));
    const out = (outRes.output || "").trim();
    if (out && out !== "NONE") {
      await uploadBinary(`pi-artifacts/${ticketId}/output.jsonl.gz`, Buffer.from(out, "base64"), "application/gzip");
    }
    const pRes = await execOnWorkspace(
      workspaceId,
      `f=$(ls -t /data/.pi/pi_prompt_*.txt 2>/dev/null | head -1); if [ -n "$f" ]; then cat "$f"; else echo NONE; fi`,
      { timeout: 30_000 },
    ).catch(() => ({ output: "" } as { output: string }));
    const prompt = pRes.output || "";
    if (prompt.trim() && prompt.trim() !== "NONE") {
      await uploadFile(`pi-artifacts/${ticketId}/prompt.txt`, prompt);
    }
    console.log(`[ticket-executor] backed up Pi artifacts for ${ticketId} to S3`);
  } catch (err) {
    console.warn(`[ticket-executor] backupPiArtifacts failed for ${ticketId}:`, (err as Error).message?.slice(0, 120));
  }
}

/** Kill any lingering Pi process in the VM before a resume (frees a thrashing VM's
 *  RAM so the relaunch has room). Best-effort, busybox-safe. */
async function killPiInVm(workspaceId: string, backgroundPid?: string): Promise<void> {
  const kill = backgroundPid
    ? `pkill -9 -P ${backgroundPid} 2>/dev/null; kill -9 ${backgroundPid} 2>/dev/null; pkill -9 -f pi-coding-agent 2>/dev/null; pkill -9 -f 'mode json' 2>/dev/null; true`
    : `pkill -9 -f pi-coding-agent 2>/dev/null; pkill -9 -f 'mode json' 2>/dev/null; pkill -9 -f 'pi -p' 2>/dev/null; true`;
  await execOnWorkspace(workspaceId, kill, { timeout: 20_000 }).catch(() => {});
}

// How many times a build that stalled/lost-contact/OOM'd (but did real work) is
// auto-resumed from the persisted repo before we give up and ask the user.
const MAX_BUILD_RESUMES = 2;

// Absolute SAFETY ceiling on a single build run — NOT the real stop signal. The real,
// progress-based decision lives in streamPiToCompletion: it kills a NON-progressing build
// via stall detection (~7.5 min of the same action with nothing running) and a LOOPING one
// via the tool-call budget (runaway). So a build that keeps making varied progress should
// be allowed to run long; this ceiling just backstops a truly runaway process. 30 min was
// too low (it guillotined legitimately-long, still-working builds). Configurable.
const BUILD_TIMEOUT_MS = parseInt(process.env.TICKET_BUILD_TIMEOUT_MIN || "60", 10) * 60_000;

/**
 * The working tree is the SOURCE OF TRUTH for "did the agent do work" — not the log
 * heuristic (didWork) or the reportStatus signal, which weak agents (Kimi/Pi) routinely
 * skip, causing a real, edited build to be thrown away as "no changes were made". Returns
 * true if there are uncommitted SOURCE changes, ignoring runtime junk (DBs, logs).
 */
async function gitWorkingTreeHasChanges(workspaceId: string, projectDirName: string): Promise<boolean> {
  try {
    const r = await execOnWorkspace(
      workspaceId,
      `cd ${WORKING_DIR}/${projectDirName} 2>/dev/null && git config --global --add safe.directory '*' 2>/dev/null; git status --porcelain 2>/dev/null | grep -viE '\\.(db|sqlite|sqlite3|log)(-wal|-shm|-journal)?$|(^|/)(data/app\\.db|dev\\.log|build\\.log)$' | head -5`,
      { timeout: 30_000 },
    );
    return !!(r.output || "").trim();
  } catch {
    return false;
  }
}
// A "lost contact / poll timeout" is INFRA, not a build failure — the VM restores and
// the work is safe on /data, so we retry it far more generously than a real cut-short.
// It's self-limiting anyway: if the VM is genuinely gone, the relaunch itself fails fast.
const MAX_INFRA_RESUMES = 6;

// Ticket build VMs are persistent + noSync + no_sleep. no_sleep is pinned ON while
// actively working (so Mags can't idle-sleep a live build → "lost contact") and
// turned OFF at build/chat end so the VM idle-sleeps to save cost; the next request
// wakes it and resumes from the persisted /data. NEVER toggle the always-on preview
// VM ("pv-…"), which is keepAlive by design.
async function wakeTicketVm(workspaceId: string | null | undefined): Promise<void> {
  if (!workspaceId || workspaceId.startsWith("pv-")) return;
  await markTicketSandboxBusy(workspaceId);
  await setNoSleep(workspaceId, true).catch((e) => console.warn(`[ticket-executor] pin-awake (no_sleep=true) failed for ${workspaceId}:`, (e as Error).message));
}
// End of a turn: save the agent's work journal and retire the VM (deleted after a
// grace period once its work is on GitHub or checkpointed; see ticket-sandbox-retire).
async function sleepTicketVm(workspaceId: string | null | undefined, ticketId?: string, kind = "Turn"): Promise<void> {
  if (!workspaceId) return;
  const ids = ticketId ? [ticketId] : (await db.select({ t: sandboxes.ticketId }).from(sandboxes).where(eq(sandboxes.magsWorkspaceId, workspaceId))).map(r => r.t).filter((t): t is string => !!t);
  for (const id of new Set(ids)) await retireTicketSandbox(id, workspaceId, kind).catch(error => console.error("[ticket-executor] retire failed", workspaceId, error));
}

// API-mode ticket builds run the Pi in-sandbox coding agent (model-agnostic,
// same as instant mode) by default. Set TICKET_BUILDER=agent to force the
// legacy in-process generateText loop instead.
const USE_PI_TICKET_BUILDER = (process.env.TICKET_BUILDER ?? "pi") !== "agent";

/** Focused, self-contained prompt for the Pi coding agent building a ticket. */
/** If the project has an always-on preview sandbox that's actually reachable,
 *  return its workspace id (env-<projectId>) so tickets can reuse it via a git
 *  worktree — same env (DBs, cached toolchain) as the preview, own branch. */
async function resolvePreviewSandbox(internalProjectId: string): Promise<string | null> {
  try {
    const [env] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, internalProjectId));
    if (!env?.workspaceId) return null;
    const probe = await execOnWorkspace(env.workspaceId, 'test -d /data/project/.git && echo REPO_OK || echo NO_REPO', { timeout: 60_000 }).catch(() => ({ output: "" } as any));
    return (probe.output || "").includes("REPO_OK") ? env.workspaceId : null;
  } catch { return null; }
}

// ── Shared-preview-VM placement (opt-in; default builds never come here) ─────
//
// Everything below is reached ONLY when a project is set to "Shared preview VM"
// (ticketBuildIsolation = "shared"). The default "Fresh sandbox (isolated)" path
// resolves `shared: false` on the first line and behaves exactly as it always has.

export const SHARED_MODE = "shared";

/** The worktree directory name a ticket gets inside the shared preview VM. This is
 *  the SAME dir the preview serves the branch from (dev-preview's ticketWorktreeDir),
 *  which is what makes "build here, then just restart the server" work. */
export function ticketWorktreeDirName(ticketId: string): string {
  return `wt-ticket-${ticketId.slice(0, 12)}`;
}

type BuildPlacement =
  | { shared: true; workspaceId: string; dir: string; credKey: string; exclusiveConfig: boolean }
  | { shared: false };

/** Is this project on shared mode, and is its preview VM actually usable right now? */
async function resolveBuildPlacement(
  ticketId: string,
  project: { id: string; ownerId: string; ticketBuildIsolation?: string },
): Promise<BuildPlacement> {
  if ((project.ticketBuildIsolation ?? "isolated") !== SHARED_MODE) return { shared: false };
  const workspaceId = await resolvePreviewSandbox(project.id);
  // No reachable preview VM (never set up, or wiped) → fall back to the isolated
  // path rather than failing the build. The user sees which one ran in the log.
  if (!workspaceId) return { shared: false };

  const modelKey = await resolveBuilderModelKey(project.ownerId, project.id);
  const provider = getProviderName(modelKey) ?? "";
  const [keys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, project.ownerId)).limit(1);
  const providerKey = ({
    anthropic: keys?.anthropicApiKey, openai: keys?.openaiApiKey, google: keys?.googleApiKey,
    kimi: keys?.kimiApiKey, deepseek: keys?.deepseekApiKey, glm: keys?.glmApiKey,
  } as Record<string, string | null | undefined>)[provider];
  // Fingerprint, never the key itself: lanes may only overlap when the credential
  // that lands in the VM's shared Pi config is identical.
  const credKey = `${provider}|${getProviderModel(modelKey) ?? modelKey}|${(providerKey ?? "sub").slice(-6)}`;
  return {
    shared: true,
    workspaceId,
    dir: ticketWorktreeDirName(ticketId),
    credKey,
    exclusiveConfig: piProviderUsesSharedConfig(provider),
  };
}

/**
 * Reclaim /data space in the shared preview VM by removing ticket worktrees.
 *
 * A worktree is a CACHE, not the work: everything in it is either pushed to the
 * remote or still in the tree of a running build. Removing a pushed one costs a
 * `git worktree add` and a dependency install on the next build (the caches on
 * /data survive), and costs nothing at all if the ticket is never touched again.
 *
 * Two tiers, gentlest first, stopping the moment we're above `targetGb`:
 *   1. tickets that are DONE — nobody is coming back to these;
 *   2. tickets whose work is SAFELY ON THE REMOTE (a pushed commit), oldest first.
 *      This is the tier that matters on a real board, where a dozen tickets sit in
 *      In Review for weeks and tier 1 alone would free nothing.
 *
 * Never touched: an active lane's worktree, the one the preview is serving right
 * now, and anything whose work was never pushed (a build whose push failed — its
 * only copy is that directory).
 */
async function reclaimWorktreeSpace(
  workspaceId: string,
  projectId: string,
  opts: { keepTicketId?: string; targetGb: number; includePushed: boolean },
): Promise<{ freed: string[]; freeGb: number | null }> {
  const freed: string[] = [];
  let freeGb = await freeDiskGb(workspaceId);
  if (freeGb !== null && freeGb >= opts.targetGb) return { freed, freeGb };

  const rows = await db
    .select({
      id: sandboxes.id,
      ticketId: sandboxes.ticketId,
      key: projectTickets.ticketKey,
      status: projectTickets.status,
      branch: projectTickets.githubBranch,
      sha: projectTickets.githubCommitSha,
      touched: projectTickets.updatedAt,
    })
    .from(sandboxes)
    .innerJoin(projectTickets, eq(projectTickets.id, sandboxes.ticketId))
    .where(and(eq(sandboxes.magsWorkspaceId, workspaceId), eq(sandboxes.workspaceType, "ticket-worktree")))
    .catch(() => []);

  const live = await livecastPreviewBranch(projectId);
  const byTicket = new Map(rows.filter((r) => r.ticketId).map((r) => [r.ticketId!, r]));
  const plan = planWorktreeEviction(
    rows.filter((r) => !!r.ticketId).map((r) => ({
      ticketId: r.ticketId!, status: r.status, branch: r.branch, sha: r.sha, touched: r.touched,
    })),
    { keepTicketId: opts.keepTicketId, liveBranch: live, includePushed: opts.includePushed },
  );

  for (const c of plan) {
    if (freeGb !== null && freeGb >= opts.targetGb) break;
    const r = byTicket.get(c.ticketId)!;
    const dir = ticketWorktreeDirName(r.ticketId!);
    await execOnWorkspace(workspaceId,
      `cd ${WORKING_DIR}/project 2>/dev/null && git worktree remove --force ${WORKING_DIR}/${dir} 2>/dev/null; rm -rf ${WORKING_DIR}/${dir} 2>/dev/null; git worktree prune 2>/dev/null; echo evicted`,
      { timeout: 120_000 }).catch(() => {});
    await db.delete(sandboxes).where(eq(sandboxes.id, r.id)).catch(() => {});
    freed.push(r.key ?? dir);
    console.log(`[ticket-executor] Reclaimed worktree ${dir} (${r.status}) in ${workspaceId}`);
    freeGb = await freeDiskGb(workspaceId);
  }
  return { freed, freeGb };
}

/** Keep the box comfortable after a build, so the NEXT one isn't refused for space.
 *  Only touches finished tickets — the cheap tier, no rebuild cost anyone will feel. */
function reclaimOpportunistically(workspaceId: string, projectId: string, keepTicketId: string): void {
  void reclaimWorktreeSpace(workspaceId, projectId, {
    keepTicketId,
    targetGb: laneMinFreeGb() + 2, // aim above the refusal line, not at it
    includePushed: false,
  }).catch(() => {});
}

/** The branch the project's preview is serving right now (null when idle). */
async function livecastPreviewBranch(projectId: string): Promise<string | null> {
  try {
    const [env] = await db
      .select({ b: projectEnvironments.previewBranch, s: projectEnvironments.previewStatus })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.projectId, projectId))
      .limit(1);
    return env && env.s !== "idle" && env.s !== "stopped" ? env.b ?? null : null;
  } catch { return null; }
}

/** Tickets already told "waiting for a slot", so a retry doesn't repeat itself. */
const laneWaitNotified = new Set<string>();

/** Re-dispatch the oldest still-queued ticket for a project after a lane frees. */
async function dispatchNextQueued(projectId: string, exceptTicketId: string): Promise<void> {
  try {
    const rows = await db
      .select({ id: projectTickets.id })
      .from(projectTickets)
      .where(and(eq(projectTickets.projectId, projectId), eq(projectTickets.queueStatus, "queued")))
      .orderBy(asc(projectTickets.executionOrder), asc(projectTickets.queuedAt))
      .limit(4);
    const next = rows.find((r) => r.id !== exceptTicketId && !executingTickets.has(r.id));
    if (next) emit({ type: "ticket.queued", ticketId: next.id, projectId });
  } catch (e) {
    console.warn("[ticket-executor] dispatchNextQueued failed:", (e as Error).message);
  }
}

/**
 * Hand a failed merge to the coding agent in the sandbox. Everything it needs that only
 * the executor knows — the authenticated remote and the owner whose model drives the CLI
 * — is gathered here. Conflicts and non-conflict git failures take the same path: from
 * the agent's side both are just "get this merge through".
 */
async function tryAgentMerge(o: {
  ticketId: string; ownerId: string; actorId?: string; workspaceId: string; projectDir: string;
  featureBranch: string; targetBranch: string; files?: string[];
  authUrl: string; projectId: string; error?: string;
}): Promise<{ merged: boolean; sha?: string; summary: string } | null> {
  if (o.error?.includes("ValidationFailure")) return { merged: false, summary: o.error };
  try {
    const { mergeWithAgent } = await import("../services/merge-resolver.ts");
    return await mergeWithAgent({
      projectId: o.projectId,
      userId: o.actorId ?? o.ownerId,
      workspaceId: o.workspaceId,
      projectDir: o.projectDir,
      featureBranch: o.featureBranch,
      targetBranch: o.targetBranch,
      authUrl: o.authUrl,
      error: o.error,
      conflictFiles: o.files,
      onLog: (line) => { addLog(o.ticketId, line, "command", o.ownerId).catch(() => {}); },
    });
  } catch (e) {
    console.warn("[ticket-executor] agent merge failed:", e);
    return null;
  }
}

/** Pull the project's build/run commands from the preview setup manifest (if it
 *  was ever set up), so tickets are told exactly how to build + run the app. */
async function loadRunInfo(internalProjectId: string): Promise<{ installCmd?: string; buildCmd?: string; runCmd?: string; port?: number } | null> {
  try {
    const [env] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, internalProjectId));
    if (!env?.setupManifest) return null;
    const m = JSON.parse(env.setupManifest) as { installCmd?: string; buildCmd?: string; runCmd?: string; port?: number };
    return { installCmd: m.installCmd, buildCmd: m.buildCmd, runCmd: m.runCmd, port: m.port };
  } catch { return null; }
}

/**
 * A prompt block with the ticket's PENDING addenda (new change requests) + a short
 * history of what was already done — so a (re)build iterates instead of restarting.
 * Returns the block text and the pending addendum ids (to mark resolved after a
 * successful build).
 */
async function ticketAddendaContext(ticketId: string): Promise<{ block: string; pendingIds: string[] }> {
  const pending = await db.select({ id: ticketAddenda.id, description: ticketAddenda.description })
    .from(ticketAddenda)
    .where(and(eq(ticketAddenda.ticketId, ticketId), eq(ticketAddenda.status, "pending")))
    .orderBy(asc(ticketAddenda.createdAt));
  const done = await db.select({ m: ticketLogs.command, at: ticketLogs.createdAt })
    .from(ticketLogs)
    .where(and(eq(ticketLogs.ticketId, ticketId), eq(ticketLogs.logType, "ai_response")))
    .orderBy(desc(ticketLogs.createdAt)).limit(4);
  let block = "";
  if (pending.length) {
    block += `\n## Addenda — NEW changes requested since the last build (address ALL of these)\n${pending.map((a, i) => `${i + 1}. ${a.description}`).join("\n")}\n`;
  }
  if (done.length) {
    block += `\n## Already done on this ticket (build on it — do NOT redo)\n${done.reverse().map((d) => `- ${(d.m ?? "").replace(/\s+/g, " ").slice(0, 240)}`).join("\n")}\n`;
  }
  return { block, pendingIds: pending.map((p) => p.id) };
}

/** Pending addenda a follow-up turn was given, so it resolves exactly those once it publishes. */
const chatTurnAddenda = new Map<string, string[]>();

/** Mark a ticket's pending addenda resolved after a successful (re)build. */
async function resolveTicketAddenda(ticketId: string, pendingIds: string[]): Promise<void> {
  if (!pendingIds.length) return;
  await db.update(ticketAddenda)
    .set({ status: "resolved", buildIncludedAt: new Date(), buildTicketId: ticketId, resolvedAt: new Date() })
    .where(and(eq(ticketAddenda.ticketId, ticketId), inArray(ticketAddenda.id, pendingIds)))
    .catch(() => {});
}

/** The project's mandatory directives (app_profile) as a prompt block, or "". */
async function directivesBlock(projectId: string, branch = "default", followup = false): Promise<string> {
  let out = "";
  try {
    const { loadAppProfile } = await import("../services/app-profile.ts");
    const profiles = await Promise.all([...new Set([branch,"default"])].map(b=>loadAppProfile(projectId,b)));
    const d = [...new Set(profiles.flatMap(p=>p?.profile.directives ?? []))];
    if (d.length) {
      out += `\n## ${followup ? 'Project constraints for the affected code — preserve these while making the requested change; report unrelated existing violations separately' : 'MANDATORY DIRECTIVES — always enforce (fixing a violation is part of the task)'}\n${d.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n`;
    }
  } catch { /* profile is optional */ }
  try {
    // The same instructions the chat agent gets — one place to say "always do X here",
    // honoured by whoever is doing the work.
    const [row] = await db.select({ ci: projects.customInstructions }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const ci = (row?.ci ?? "").trim();
    if (ci) out += `\n## PROJECT INSTRUCTIONS (from this project's settings)\n${ci}\n`;
  } catch { /* instructions are optional */ }
  return out;
}

function ticketDocumentIds(details:unknown):string[] {
  const ids=(details as {sourceDocumentIds?:unknown}|null)?.sourceDocumentIds;
  return Array.isArray(ids) ? ids.filter((id):id is string=>typeof id==='string') : [];
}

/** Copy the saved requirements into every builder's checkout, not just UUIDs in prose. */
async function materializeTicketDocs(args: {
  projectId: string; workspaceId: string; projectDir: string; text: string;
  epicId?: string | null; sourceDocumentId?: string | null; sourceDocumentIds?: string[];
}): Promise<Array<{ name: string; fileType: string; path: string }>> {
  const { projectFiles } = await import("../db/schema/documents.ts");
  const { epicDocuments } = await import("../db/schema/epic-documents.ts");
  const { getContent } = await import("../services/s3.ts");
  const rows = await db.select().from(projectFiles).where(eq(projectFiles.projectId, args.projectId));
  const links = args.epicId ? await db.select({fileId:epicDocuments.fileId}).from(epicDocuments).where(eq(epicDocuments.epicId,args.epicId)) : [];
  const selected = selectTicketContextDocuments(rows, {...args,linkedIds:links.map(row=>row.fileId)});
  const out: Array<{ name: string; fileType: string; path: string }> = [];
  const quote = (value:string) => "'" + value.replace(/'/g, "'\\''") + "'";
  for (const f of selected) {
    const content = await getContent(f.s3Key, f.content);
    if (!content?.trim() || content.length > 400_000) throw new Error(`Cannot prepare build context: document "${f.name}" is empty, unreadable or exceeds 400,000 characters.`);
    const ext = f.fileType === "page_preview" ? "html" : "md";
    const path = `${args.projectDir}/.lfg/context/${f.id}.${ext}`;
    const b64 = Buffer.from(content).toString("base64");
    const script = `mkdir -p ${quote(args.projectDir+'/.lfg/context')} && echo ${b64} | base64 -d > ${quote(path)}`;
    const r = await execOnWorkspace(args.workspaceId, `echo ${Buffer.from(script).toString("base64")} | base64 -d | sh`, {timeout:60_000});
    if (r.exitCode !== 0) throw new Error(`Could not copy build context document "${f.name}" into the workspace.`);
    out.push({name:f.name,fileType:f.fileType,path});
  }
  const indexPath = `${args.projectDir}/.lfg/context/README.md`;
  const indexContent = ticketDocumentInstructions(out);
  const indexScript = `mkdir -p ${quote(args.projectDir+'/.lfg/context')} && echo ${Buffer.from(indexContent).toString("base64")} | base64 -d > ${quote(indexPath)}`;
  const written = await execOnWorkspace(args.workspaceId, `echo ${Buffer.from(indexScript).toString("base64")} | base64 -d | sh`, {timeout:60_000});
  if (written.exitCode !== 0) throw new Error("Could not write the build document context index.");
  return out;
}

function buildPiTicketPrompt(args: {
  ticket: { name: string; description: string | null; notes?: string | null; acceptanceCriteria?: string[] | null };
  techStack?: { language?: string; framework?: string; packageManager?: string; port?: number } | null;
  projectDir: string;
  /** True when the project is already scaffolded (boilerplate or server-side scaffold). */
  prescaffolded?: boolean;
  /** How to build/run this project (from the preview setup manifest, if any). */
  runInfo?: { installCmd?: string; buildCmd?: string; runCmd?: string; port?: number } | null;
  /** Project mandatory directives (app_profile) — must always be enforced. */
  directives?: string;
  /** Pending addenda + "already done" history block (see ticketAddendaContext). */
  addenda?: string;
  /** Screenshots/images the user attached to this ticket, as absolute fetchable URLs. */
  attachments?: Array<{ url: string; name?: string }>;
  /** Project documents the ticket references, written into the sandbox. */
  designRefs?: Array<{ name: string; fileType: string; path: string }>;
}): string {
  const t = args.ticket;
  const ac = (t.acceptanceCriteria ?? []).map((c, i) => `${i + 1}. ${c}`).join("\n") || "Not specified.";
  const attBlock = (args.attachments && args.attachments.length)
    ? `\n## Attached screenshots\nThe user attached ${args.attachments.length} image(s) to this ticket — the description above reflects them. If you can view images, fetch them:\n` +
      args.attachments.map((a) => `- ${a.name || "image"}: ${a.url}`).join("\n") + "\n"
    : "";
  const refBlock = ticketDocumentInstructions(args.designRefs ?? []);
  const port = args.runInfo?.port ?? args.techStack?.port ?? 8080;
  const runBlock = args.runInfo && (args.runInfo.installCmd || args.runInfo.buildCmd || args.runInfo.runCmd)
    ? `\n## How to build & run this project\n` +
      [args.runInfo.installCmd && `- Install: \`${args.runInfo.installCmd}\``,
       args.runInfo.buildCmd && `- Build: \`${args.runInfo.buildCmd}\``,
       args.runInfo.runCmd && `- Run: \`${args.runInfo.runCmd}\` (must serve on 0.0.0.0:${port})`].filter(Boolean).join("\n") +
      `\nUse these exact commands to verify your change builds and runs before finishing.\n`
    : "";
  // Scaffolding is done deterministically server-side (or by the boilerplate
  // rootfs). Never ask the agent to run create-next-app — that's what makes
  // weak agents loop.
  const setup = args.prescaffolded
    ? `The app is ALREADY scaffolded at ${args.projectDir} (Next.js + TypeScript + Tailwind + shadcn/ui, dependencies installed). DO NOT run create-next-app, npm init, or shadcn init — just implement the ticket in the existing tree.`
    : `Work directly in the existing repository at ${args.projectDir}; reuse its existing stack and files. Do NOT scaffold a new project.`;
  const stack = args.techStack
    ? `Language: ${args.techStack.language ?? "?"}, Framework: ${args.techStack.framework ?? "?"}, Package manager: ${args.techStack.packageManager ?? "?"}, Dev port: ${port}`
    : "Use the stack already present in the project.";
  return `You are a senior software engineer implementing a ticket.
${ENGINEERING_CONTRACT}

## Project setup
${setup}

## Ticket
${t.name}

## Description
${t.description ?? ""}
${t.notes ? `\n## Notes\n${t.notes}` : ""}

## Acceptance Criteria
${ac}
${attBlock}
## Tech stack
${stack}
${refBlock}${runBlock}${args.addenda ?? ""}${args.directives ?? ""}
## Sandbox environment
- This is an **Alpine Linux** sandbox. Install system packages with **\`apk add\`** ONLY — apt/apt-get/yum/dnf/brew do NOT exist here. You are root; do NOT use \`sudo\`.
- **ALL work must live on \`/data\`** (an ~8GB volume). The root filesystem \`/\` is tiny (~2.9GB) and fills up fast. The project is at **\`/data/project\`**. Every toolchain cache/download is ALREADY redirected to /data for you (GOPATH/GOMODCACHE/GOCACHE + Go toolchain downloads, pip/uv/cargo/npm caches, XDG caches, TMPDIR). Do NOT install into \`/root\` or \`/tmp\`, and do NOT point any cache/install/toolchain dir back at the root fs — if you need a new cache/output dir, put it under \`/data\`. If a build ever reports "no space left on device", it's because something wrote to \`/\`; move it under \`/data\`.
- **\`grep\` here is BusyBox, not GNU** — it does NOT support \`--include\`, \`--exclude\`, or \`-P\` (PCRE). Use \`grep -rn PATTERN <dir>\` and filter by extension with a pipe (e.g. \`grep -rln PATTERN internal | grep '\\.go$'\`). Do NOT retry \`--include\`/\`-P\` — they will always fail; switch syntax on the first error.

## Instructions
- Explore the project first; reuse existing patterns, dependencies, and files.
- **Trust the ticket + PRD as the source of truth for facts.** For DOCUMENTATION / marketing / copy / content tickets especially: the ticket already states which features exist, their limits, prices, etc. — do NOT audit the whole codebase to re-verify every claim (that wastes most of the run). At most do a couple of TARGETED checks only where the ticket is ambiguous or self-contradictory. Spend your effort writing/implementing, not exhaustively grepping to confirm things the ticket already told you.
- Implement the ticket end to end so every acceptance criterion is met.${args.addenda ? "\n- If Addenda are listed above, they are the PRIMARY task this run — address every one, building on what was already done." : ""}${args.directives ? "\n- The MANDATORY DIRECTIVES above are non-negotiable — verify your change satisfies every one before finishing." : ""}
- Make the app runnable: bind the dev server to 0.0.0.0 on port ${port}.
- Run the implementation and repair actual failures in this sandbox before committing. Do not commit or push; the server saves all changes together after runtime checks pass. Never commit credentials or generated files.
- Before finishing, make sure the project builds/compiles.
${TICKET_RUNTIME_INSTRUCTION}`;
}

/**
 * Ensure TLS certs + git are present in the VM before any HTTPS git op.
 * Minimal rootfs images can ship without ca-certificates → git clone fails TLS
 * verification and the agent flails against an empty dir. Idempotent + best-effort.
 */
async function ensureVmCerts(workspaceId: string): Promise<void> {
  const script =
    `apk add --no-cache ca-certificates git openssh-client >/dev/null 2>&1 || ` +
    `(apt-get update >/dev/null 2>&1 && apt-get install -y ca-certificates git >/dev/null 2>&1) || true; ` +
    `update-ca-certificates >/dev/null 2>&1 || true; echo CERTS_DONE`;
  try {
    await execOnWorkspace(workspaceId, script, { timeout: 90_000 });
  } catch (err) {
    console.warn(`[ticket-executor] cert-ensure step failed (continuing):`, (err as Error).message?.slice(0, 120));
  }
}

/**
 * Ensure an empty project is scaffolded BEFORE the agent runs — the same
 * deterministic, non-interactive scaffold instant uses (server-side, not
 * agent-driven, which is why instant never loops on create-next-app). Verifies
 * an existing scaffold first (boilerplate fast path); otherwise runs the
 * profile's scaffoldSteps via execOnWorkspace. Returns true when scaffolded.
 */
async function ensureProjectScaffold(
  workspaceId: string,
  projectDirAbs: string,
  ticketId: string,
  ownerId: string
): Promise<boolean> {
  // Already scaffolded? (boilerplate rootfs, or a prior run)
  try {
    const check = await execOnWorkspace(
      workspaceId,
      `test -f ${projectDirAbs}/package.json && test -d ${projectDirAbs}/node_modules && echo SCAFFOLD_OK || echo SCAFFOLD_MISSING`,
      { timeout: 30_000 }
    );
    if (check.output.includes("SCAFFOLD_OK")) {
      console.log(`[ticket-executor] scaffold already present at ${projectDirAbs}`);
      return true;
    }
  } catch { /* fall through to scaffold */ }

  // Run the deterministic scaffold steps server-side (webapp = default app-stack).
  const profile = getBuildProfile(detectProjectType("", "webapp"));
  await addLog(ticketId, "Scaffolding app-stack (Next.js + shadcn)...", "command", ownerId);
  for (const step of profile.scaffoldSteps) {
    try {
      const b64 = Buffer.from(step.script).toString("base64");
      const res = await execOnWorkspace(workspaceId, `echo '${b64}' | base64 -d | sh`, { timeout: 300_000 });
      console.log(`[ticket-executor] scaffold step "${step.message}" exit=${res.exitCode}`);
      if (res.exitCode !== 0) {
        console.warn(`[ticket-executor] scaffold step failed (exit=${res.exitCode}):\n${(res.output ?? "").slice(-800)}`);
      }
    } catch (err) {
      console.warn(`[ticket-executor] scaffold step "${step.message}" errored:`, (err as Error).message?.slice(0, 120));
    }
  }
  // Verify it worked.
  try {
    const verify = await execOnWorkspace(
      workspaceId,
      `test -f ${projectDirAbs}/package.json && echo SCAFFOLD_OK || echo SCAFFOLD_MISSING`,
      { timeout: 20_000 }
    );
    return verify.output.includes("SCAFFOLD_OK");
  } catch {
    return false;
  }
}
const MAX_WAIT_DURATION_MS = 45 * 60 * 1000; // 45 minutes
const CHAT_MAX_WAIT_DURATION_MS = 10 * 60 * 1000; // 10 minutes
// Projects live on the big /data volume (7.8GB), not /root (1.9GB) — avoids ENOSPC.
const WORKING_DIR = "/data";

// ── Stop-a-running-build ─────────────────────────────────────────────────────
// Tickets the user asked to stop mid-execution. The Pi path checks this via
// shouldCancel (kills Pi in-VM); the Claude CLI path is stopped by killing its
// in-VM process, which makes waitForCompletion resolve. After the agent returns the
// main loop calls stoppedByUser() and bails out cleanly instead of failing.
const cancelledTickets = new Set<string>();
// "Skip checks" requests, watched per ticket while its checks may run.
const skipWatchers = new Map<string, ReturnType<typeof watchSkipChecks>>();
function checksSkipped(ticketId: string): boolean {
  let watcher = skipWatchers.get(ticketId);
  if (!watcher) { watcher = watchSkipChecks(ticketId); skipWatchers.set(ticketId, watcher); }
  return watcher.skipped();
}
function stopSkipWatch(ticketId: string): void { skipWatchers.get(ticketId)?.stop(); skipWatchers.delete(ticketId); }

/** Stop a running ticket build: kill the in-VM agent (+ any slow child like apk/go/
 *  npm/pip) and unblock the executor's wait. Best-effort, safe to call anytime. */
export async function requestTicketStop(ticketId: string, projectId?: string): Promise<void> {
  cancelledTickets.add(ticketId);
  // Durable, cross-process cancel signal: the build loop may run in a DIFFERENT
  // process than this HTTP handler, so the in-memory Set alone isn't enough. Mark
  // the ticket 'stopping' in the DB; stoppedByUser() re-reads this so the executor
  // bails cleanly even when it never saw the in-memory flag.
  await db
    .update(projectTickets)
    .set({ queueStatus: "stopping", updatedAt: new Date() })
    .where(eq(projectTickets.id, ticketId))
    .catch(() => {});
  try {
    // EVERY VM this ticket can be running an agent in — not just the build VM. A chat
    // turn runs in the isolated `ticket-chat` sandbox and a worktree run in
    // `ticket-worktree`, so filtering on "ticket" alone left those agents alive and
    // "Stop" silently did nothing for a message sent from the ticket chat.
    const sbs = await db
      .select({ ws: sandboxes.magsWorkspaceId, type: sandboxes.workspaceType })
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.ticketId, ticketId),
          inArray(sandboxes.workspaceType, ["ticket", "ticket-chat", "ticket-worktree", "ticket-clone"]),
        ),
      );

    // SHARED PREVIEW VM: the pattern kill below would take out every OTHER ticket's
    // agent in the same box (and any install the preview is running). Kill only this
    // lane: its recorded agent pid, plus anything whose working directory is this
    // ticket's worktree — which is where the agent and every command it spawns live.
    const sharedRows = sbs.filter((sb) => sb.ws && (sb.type === "ticket-worktree" || sb.ws.startsWith("pv-")));
    if (sharedRows.length) {
      const dir = `${WORKING_DIR}/${ticketWorktreeDirName(ticketId)}`;
      const b64 = Buffer.from(scopedStopScript(dir, laneOf(ticketId)?.pid)).toString("base64");
      await Promise.all(sharedRows.map((sb) =>
        execOnWorkspace(sb.ws!, `echo ${b64} | base64 -d | sh`, { timeout: 30_000 }).catch(() => {})));
      releaseLane(ticketId);
    }
    // Kill the detached agent IN the VM — this is what actually stops a build the
    // loop can't reach cross-process. busybox pkill has no \b/ERE, so match with
    // plain substrings (pkill never matches its own pid). Cover the Pi node agent
    // (pi-coding-agent), its invocation (`pi -p`, `mode json`), Claude, and any
    // long child install so nothing keeps writing/committing after "Stop".
    // (Shared-VM lanes were handled above by the scoped kill — a pattern kill there
    // would stop every other ticket working in the same box.)
    await Promise.all(
      sbs
        .filter((sb) => !!sb.ws && !((sb.type === "ticket-worktree" || sb.ws.startsWith("pv-"))))
        .map((sb) =>
          execOnWorkspace(
            sb.ws!,
            "for f in /data/lfg-jobs/*/pid /data/validation/*/app.pid; do test -f \"$f\" || continue; test -f \"${f%/pid}/exit\" && continue; p=$(cat \"$f\"); case \"$p\" in ''|*[!0-9]*) continue;; esac; kill -TERM -- -\"$p\" 2>/dev/null || true; done; sleep 2; for f in /data/lfg-jobs/*/pid /data/validation/*/app.pid; do test -f \"$f\" || continue; test -f \"${f%/pid}/exit\" && continue; p=$(cat \"$f\"); case \"$p\" in ''|*[!0-9]*) continue;; esac; kill -KILL -- -\"$p\" 2>/dev/null || true; done; pkill -9 -f pi-coding-agent 2>/dev/null; pkill -9 -f 'mode json' 2>/dev/null; pkill -9 -f 'pi -p' 2>/dev/null; pkill -9 -f claude 2>/dev/null; pkill -9 -f 'pip install' 2>/dev/null; pkill -9 -f 'go build' 2>/dev/null; pkill -9 -f 'npm install' 2>/dev/null; pkill -9 -f 'apk add' 2>/dev/null; true",
            { timeout: 25_000 },
          ).catch(() => {}),
        ),
    );
  } catch {
    /* best-effort */
  }
  // A restarted/finished worker cannot acknowledge stopping. Reconcile only after
  // inspecting every dedicated sandbox; never clear a lock on a transport failure.
  if(!executingTickets.has(ticketId) && !isChatTurnActive(ticketId)) {
    const rows=await db.select({ws:sandboxes.magsWorkspaceId,type:sandboxes.workspaceType}).from(sandboxes).where(eq(sandboxes.ticketId,ticketId));
    await confirmTicketStopped(rows,async (workspace,shared)=>{
      const script=Buffer.from(ticketStopVerificationScript(shared ? `${WORKING_DIR}/${ticketWorktreeDirName(ticketId)}` : undefined)).toString("base64");
      return execOnWorkspace(workspace,`echo ${script} | base64 -d | bash`,{timeout:20_000});
    });
    await db.update(projectTickets).set({status:"stopped",queueStatus:"none",updatedAt:new Date()}).where(and(eq(projectTickets.id,ticketId),eq(projectTickets.queueStatus,"stopping")));
    const [owner]=await db.select({ownerId:projects.ownerId}).from(projectTickets).innerJoin(projects,eq(projects.id,projectTickets.projectId)).where(eq(projectTickets.id,ticketId)).limit(1);
    if(owner)broadcastToUser(owner.ownerId,{type:"ticket_status",ticketId,status:"stopped",queueStatus:"none"});
  }
  // Unblock the Claude-path waiter (Pi returns on its own via shouldCancel).
  emit({ type: "ticket.execution_finished", ticketId, status: "failed", exitCode: 130, projectId });
}

/** Tell the browser whether a chat turn is running, so the send button can be a Stop
 *  button for exactly as long as the agent is actually busy (a build's spinner rides
 *  on queueStatus; a chat turn never touches it). */
async function broadcastChatState(ticketId: string, busy: boolean): Promise<void> {
  try {
    const [row] = await db
      .select({ owner: projects.ownerId })
      .from(projectTickets)
      .innerJoin(projects, eq(projects.id, projectTickets.projectId))
      .where(eq(projectTickets.id, ticketId))
      .limit(1);
    if (row?.owner) broadcastToUser(row.owner, { type: "ticket_chat_state", ticketId, busy });
  } catch { /* the turn still runs fine without the indicator */ }
}

/** If the user cancelled this ticket, do the "stopped" bookkeeping and return true so
 *  the caller bails out (skipping the normal complete/failed handling). */
async function stoppedByUser(ticketId: string, ownerId: string): Promise<boolean> {
  let cancelled = cancelledTickets.has(ticketId);
  if (!cancelled) {
    // Cross-process: the stop request may have landed in another process, leaving
    // only the durable DB flag. Honour it so the executor still bails cleanly.
    const [t] = await db
      .select({ q: projectTickets.queueStatus, status:projectTickets.status })
      .from(projectTickets)
      .where(eq(projectTickets.id, ticketId))
      .limit(1)
      .catch(() => [] as { q: string | null;status:string }[]);
    cancelled = t?.q === "stopping" || t?.status === "stopped";
  }
  if (!cancelled) return false;
  cancelledTickets.delete(ticketId);
  await addLog(ticketId, "⏹ Stopped by you.", "command", ownerId).catch(() => {});
  await db
    .update(projectTickets)
    .set({ status: "open", queueStatus: "none", updatedAt: new Date() })
    .where(eq(projectTickets.id, ticketId))
    .catch(() => {});
  // A user-stop short-circuits the normal end-of-build sleep, so let the VM idle-sleep
  // here too (it was pinned awake for the run). Look up the dedicated ticket VM.
  const [sb] = await db
    .select({ ws: sandboxes.magsWorkspaceId })
    .from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticketId), inArray(sandboxes.workspaceType, ["ticket", "ticket-chat"])))
    .limit(1)
    .catch(() => [] as { ws: string | null }[]);
  await sleepTicketVm(sb?.ws ?? null, ticketId, "Stopped");
  broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "stopped", queueStatus: "none" });
  return true;
}

// Concurrency guard: only one ticket per project at a time
const executingProjects = new Set<string>();
// Per-ticket in-flight guard. Prevents the same ticket from executing twice
// concurrently — from double-clicks, a retried queue after a UI error, the
// startup re-queue racing a live run, or duplicate bus listeners after a
// `bun --hot` reload. Added synchronously at the top of the handler (before any
// await) so it's race-safe on the single-threaded event loop.
const executingTickets = new Set<string>();

// ── Subscriber Setup ──────────────────────────────────────────────────

export async function startTicketWorker() {
  // Reset any tickets stuck in executing state from a previous crash
  await db
    .update(projectTickets)
    .set({ queueStatus: "none", updatedAt: new Date() })
    .where(eq(projectTickets.queueStatus, "executing"));

  // Re-queue tickets that were queued before the crash/restart
  const pendingQueued = await db
    .select({ id: projectTickets.id, projectId: projectTickets.projectId })
    .from(projectTickets)
    .where(eq(projectTickets.queueStatus, "queued"));

  if (pendingQueued.length > 0) {
    console.log(`[ticket-executor] Recovering ${pendingQueued.length} queued ticket(s) from before restart`);
    for (const t of pendingQueued) {
      // Re-emit so the worker picks them up
      emit({ type: "ticket.queued", ticketId: t.id, projectId: t.projectId });
    }
  }

  // Recover tickets that completed execution but never got pushed to git.
  // These have status='in_progress', queueStatus='none', a sandbox, but no githubCommitSha.
  // This happens when the server restarts between code completion and git push.
  const operationRecoveryBefore=Date.now();
  void import('../services/ticket-operations.ts').then(m=>m.recoverTicketOperations(operationRecoveryBefore)).catch(console.error);
  setTimeout(() => recoverUnpushedTickets(), 5_000);

  // Resume multi-ticket build runs that a restart or deploy interrupted. Runs live
  // in the database, so "build all five" survives the process that started it: each
  // item is reconciled against its ticket's real state (some may have finished while
  // we were down) and the chain continues from the next one. Delayed so it lands
  // after the sweeps above have settled the tickets they touch.
  setTimeout(() => {
    void import("../services/build-queue.ts")
      .then((m) => m.resumeBuildRuns())
      .catch((e) => console.warn("[ticket-executor] build-run resume failed:", (e as Error).message));
  }, 8_000);

  // Previews a restart cut off mid-setup: mark them interrupted so Retry appears.
  const sweepPreviews = () => void import("../services/dev-preview.ts")
    .then((m) => m.recoverInterruptedPreviews())
    .catch((e) => console.warn("[ticket-executor] preview recovery failed:", (e as Error).message));
  setTimeout(sweepPreviews, 60_000);
  setInterval(sweepPreviews, 2 * 60_000).unref?.();

  // Ticket sandboxes are disposable: delete idle ones once their grace period ends.
  let sweepingSandboxes = false;
  const sweepSandboxes = () => {
    if (sweepingSandboxes) return;
    sweepingSandboxes = true;
    void sweepIdleTicketSandboxes()
      .catch((e) => console.warn("[ticket-executor] sandbox sweep failed:", (e as Error).message))
      .finally(() => { sweepingSandboxes = false; });
  };
  setTimeout(sweepSandboxes, 90_000);
  setInterval(sweepSandboxes, 2 * 60_000).unref?.();

  bus.on("ticket.queued", async (event) => {
    const { ticketId } = event.payload;

    // Idempotency: ignore duplicate queue events for a ticket already running.
    if (executingTickets.has(ticketId)) {
      console.log(`[ticket-executor] Ticket ${ticketId} already executing — ignoring duplicate queue event`);
      return;
    }
    executingTickets.add(ticketId);

    try {
    const projectId = event.payload.projectId ?? await resolveProjectIdForTicket(ticketId);

    // Determine execution mode from user's applicationState
    const useApiMode = await isApiMode(projectId);

    // SHARED PREVIEW VM (opt-in): resolve once here so the build function doesn't
    // re-probe, and admit the ticket into a bounded lane. On the default isolated
    // setting this returns { shared: false } immediately and nothing below changes.
    const placementProject = projectId
      ? (await db.select({ id: projects.id, ownerId: projects.ownerId, ticketBuildIsolation: projects.ticketBuildIsolation })
          .from(projects).where(eq(projects.id, projectId)).limit(1))[0]
      : undefined;
    const placement: BuildPlacement = placementProject && (!event.payload.actorId || event.payload.actorId === placementProject.ownerId)
      ? await resolveBuildPlacement(ticketId, placementProject)
      : { shared: false };

    /** Run a Pi build, holding a lane when this project shares the preview VM. */
    const runApiBuild = async (useCodingAgent: boolean) => {
      if (!placement.shared) return executeTicketApi(ticketId, useCodingAgent, event.payload.actorId);
      const lane = await tryAcquireLane(
        { ticketId, projectId: projectId!, workspaceId: placement.workspaceId, dir: placement.dir,
          kind: "build", credKey: placement.credKey, exclusiveConfig: placement.exclusiveConfig },
        // Out of space → reclaim worktrees before giving up. Their branches are on
        // the remote; the only cost is a re-install on the next build of that ticket.
        async () => {
          const { freed } = await reclaimWorktreeSpace(placement.workspaceId, projectId!, {
            keepTicketId: ticketId,
            targetGb: laneMinFreeGb() + 1,
            includePushed: true,
          });
          if (freed.length) {
            await addLog(ticketId,
              `Freed space in the preview VM by removing ${freed.length} idle worktree${freed.length === 1 ? "" : "s"} (${freed.join(", ")}) — they rebuild from the remote when those tickets are next touched.`,
              "command", placementProject?.ownerId).catch(() => {});
          }
        },
      );
      if (!lane.ok) {
        // Stay QUEUED (not "none") so the ticket is picked up when a lane frees —
        // a release re-dispatches the oldest one waiting. The timer covers the race
        // where every lane freed in the moment between our check and this line.
        console.log(`[ticket-executor] Ticket ${ticketId} waiting for a shared lane — ${lane.reason}`);
        if (!laneWaitNotified.has(ticketId)) {
          laneWaitNotified.add(ticketId);
          // If we're stuck on SPACE (not on a busy slot), say what's using the disk —
          // at that point everything reclaimable is already gone and it's the user's
          // call (drop caches, grow the volume, approve some tickets).
          const detail = /disk/.test(lane.reason)
            ? await topDiskConsumers(placement.workspaceId).then((t) => (t ? ` Largest on /data: ${t}.` : "")).catch(() => "")
            : "";
          await addLog(ticketId, `Waiting for a build slot in the shared preview VM — ${lane.reason}.${detail}`, "command", placementProject?.ownerId).catch(() => {});
        }
        await db.update(projectTickets)
          .set({ queueStatus: "queued", updatedAt: new Date() })
          .where(eq(projectTickets.id, ticketId)).catch(() => {});
        setTimeout(() => { void dispatchNextQueued(projectId!, ""); }, 20_000).unref?.();
        return;
      }
      laneWaitNotified.delete(ticketId);
      try {
        await executeTicketApi(ticketId, useCodingAgent, event.payload.actorId, placement);
      } finally {
        lane.release();
        // Tidy finished tickets' worktrees now, so the next build isn't the one that
        // discovers the disk is full.
        reclaimOpportunistically(placement.workspaceId, projectId!, ticketId);
        void dispatchNextQueued(projectId!, ticketId);
      }
    };

    if (useApiMode) {
      // API mode: parallel across DIFFERENT tickets is fine; the executingTickets
      // guard above prevents the SAME ticket from running twice.
      console.log(`[ticket-executor] API mode — executing ticket ${ticketId}`);
      try {
        await runApiBuild(false);
      } catch (err) {
        console.error(`[ticket-executor] API mode failed for ticket ${ticketId}:`, err);
        await markTicketFailed(ticketId, String(err));
      }
    } else {
      // CLI mode. Claude Code CLI only works with Claude models — route any
      // non-Anthropic builder model to the Pi in-sandbox coding agent instead.
      // Mirrors the instant-mode routing.
      const builderProvider = await getBuilderProvider(projectId, event.payload.actorId);
      if (builderProvider && builderProvider !== "anthropic") {
        console.log(`[ticket-executor] CLI mode + ${builderProvider} — using Pi (Claude Code is Claude-only)`);
        try {
          await runApiBuild(true);
        } catch (err) {
          console.error(`[ticket-executor] Pi (CLI-routed) failed for ticket ${ticketId}:`, err);
          await markTicketFailed(ticketId, String(err));
        }
      } else {
        // Shared mode can't run here: the Claude Code path clones into its own VM.
        // Say so instead of silently ignoring the setting.
        if (placement.shared) {
          await addLog(ticketId,
            "This project is set to build in the shared preview VM, but Claude Code builds run in their own sandbox — using a fresh isolated sandbox for this ticket.",
            "command", placementProject?.ownerId).catch(() => {});
        }
        // CLI mode + Claude → Claude Code CLI. One ticket per project at a time.
        if (projectId && executingProjects.has(projectId)) {
          console.log(`[ticket-executor] Project ${projectId} already executing — deferring ticket ${ticketId}`);
          await db
            .update(projectTickets)
            .set({ queueStatus: "none", updatedAt: new Date() })
            .where(eq(projectTickets.id, ticketId));
        } else {
          if (projectId) executingProjects.add(projectId);
          try {
            await executeTicket(ticketId, event.payload.actorId);
          } catch (err) {
            console.error(`[ticket-executor] Failed for ticket ${ticketId}:`, err);
            await markTicketFailed(ticketId, String(err));
          } finally {
            if (projectId) executingProjects.delete(projectId);
          }
        }
      }
    }
    } finally {
      executingTickets.delete(ticketId); stopSkipWatch(ticketId);
    }
  });

  bus.on("ticket.chat_message", async (event) => {
    const { ticketId, message, sender, actorId, operationId } = event.payload;
    // ONE TURN AT A TIME. Builds have had a concurrency guard forever; chat had none,
    // so two messages sent back to back started two agents in the SAME sandbox on the
    // same branch — interleaved edits and two commits for one request. The user-facing
    // route rejects a second message outright; anything that still lands here (the
    // orchestrator) queues behind the live turn instead of racing it.
    try {
      await runChatTurn(ticketId, async () => {
        await broadcastChatState(ticketId, true);
        await withTicketOperation(operationId, () => executeTicketChat(ticketId, message, sender, actorId));
      });
    } catch (err) {
      console.error(`[ticket-executor] Chat failed for ticket ${ticketId}:`, err);
    } finally {
      // Publish after releasing the turn lock; a subsequent read must agree with
      // this event, and an already queued follow-up must remain visibly active.
      await broadcastChatState(ticketId, isChatTurnActive(ticketId));
    }
  });

  // Push subtask changes to the browser LIVE so the Tasks tab reflects progress as
  // the agent works — covers every source (seeding, the createTasks/updateTaskStatus
  // tools, and the CLI /tasks callbacks) since they all emit this one event.
  bus.on("ticket.tasks_updated", async (event) => {
    const ticketId = event.payload?.ticketId as string | undefined;
    if (!ticketId) return;
    try {
      const [row] = await db
        .select({ owner: projects.ownerId })
        .from(projectTickets)
        .innerJoin(projects, eq(projects.id, projectTickets.projectId))
        .where(eq(projectTickets.id, ticketId))
        .limit(1);
      if (row?.owner) broadcastToUser(row.owner, { type: "tasks_updated", ticketId });
    } catch (err) {
      console.warn(`[ticket-executor] tasks_updated broadcast failed for ${ticketId}:`, err);
    }
  });

  console.log("[ticket-executor] Worker started");
}

// ── Main Executor ─────────────────────────────────────────────────────

/** Branch name for a ticket: `feature/<key>-<title-slug>` (e.g.
 *  `feature/cal-4-retell-voice-agent-provisioning`) — readable instead of the old
 *  `feature/ticket-<uuid>`. Falls back to the uuid form when the ticket has no key. Only
 *  used as the FALLBACK when `githubBranch` is unset, and persisted on first build — so
 *  already-built tickets keep their existing branch (backward-compatible). */
function ticketBranchName(ticket: { ticketKey?: string | null; name?: string | null; id: string }): string {
  const slug = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const key = slug(ticket.ticketKey || "");
  const title = slug(ticket.name || "").slice(0, 40).replace(/-+$/g, "");
  return key ? `feature/${key}${title ? `-${title}` : ""}` : `feature/ticket-${ticket.id}`;
}

async function executeTicketInternal(ticketId: string, actorId?: string): Promise<void> {
  const startTime = Date.now();

  // ── Step 1: Load data ───────────────────────────────────────────────
  console.log(`[ticket-executor] Step 1: Loading data for ticket ${ticketId}`);
  const [ticket] = await db
    .select()
    .from(projectTickets)
    .where(eq(projectTickets.id, ticketId))
    .limit(1);

  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, ticket.projectId))
    .limit(1);

  if (!project) throw new Error(`Project ${ticket.projectId} not found`);

  const ownerId = project.ownerId;
  const buildLlm = await resolveBuildLlm(project!, actorId ?? ticket.assigneeId ?? ownerId);
  if (currentUsage()) { currentUsage()!.userId = buildLlm.actorId; currentUsage()!.billingMode = buildLlm.mode === "api_key" ? "api" : "subscription"; }

  if (buildLlm.mode === "subscription") return executeTicketApi(ticketId, true, buildLlm.actorId);

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, ownerId))
    .limit(1);

  const builderAuthMode = buildLlm.mode;
  const [builderKeys] = await db
    .select({ anthropic: llmApiKeys.anthropicApiKey })
    .from(llmApiKeys)
    .where(eq(llmApiKeys.userId, buildLlm.keyUserId))
    .limit(1);
  const useClaudeSubscription = false;
  // A disconnected subscription falls back to the connected API token for legacy
  // selections; an explicit API-token selection never injects OAuth credentials.
  const anthropicApiKey = useClaudeSubscription ? undefined : builderKeys?.anthropic ?? undefined;
  if (!useClaudeSubscription && !anthropicApiKey) {
    throw new Error("No connected Claude subscription or Anthropic API token is available for the selected Coding Agent model.");
  }

  // Fine-grained Git: whose token clones/pushes this build. The actor is whoever
  // triggered it (fallback: the ticket's assignee). Owner → owner's token; a
  // collaborator → the owner's token only if shareGitAccess is ON, else their OWN.
  const { gitUserId, usingOwnCollaboratorToken } = resolveGitActor(project, actorId ?? ticket.assigneeId);
  const [ghToken] = await db
    .select()
    .from(githubTokens)
    .where(eq(githubTokens.userId, gitUserId))
    .limit(1);

  const githubToken = ghToken?.accessToken;

  // Auto-generate CLI API key if missing (required for callback auth)
  let cliApiKey = profile?.cliApiKey ?? "";
  if (!cliApiKey) {
    cliApiKey = `lfg_cli_${crypto.randomUUID().replace(/-/g, "")}`;
    await db
      .insert(profiles)
      .values({ userId: ownerId, cliApiKey })
      .onConflictDoUpdate({ target: profiles.userId, set: { cliApiKey, updatedAt: new Date() } });
    console.log(`[ticket-executor] Auto-generated CLI API key for user ${ownerId}`);
  }

  // Warn if no GitHub — code will be lost on VM restart. When a collaborator is
  // building without shared access and has no Git of their own, say exactly that.
  if (!githubToken) {
    console.warn(`[ticket-executor] ⚠️ No GitHub token for user ${gitUserId} — code won't be persisted!`);
    await addLog(ticketId, usingOwnCollaboratorToken ? `⚠️ ${NO_SHARED_GIT_MESSAGE}` : "⚠️ GitHub not connected — code will NOT be saved to a repository. Connect GitHub in Settings to persist your work.", "command", ownerId);
  }

  // Seed subtasks up-front (idempotent) so the Tasks tab is populated the moment
  // the build starts, even if the agent skips createTasks or the build fails.
  await seedTasksIfEmpty(ticket, ownerId);
  await markBuildTasksStarted(ticketId);

  // Load tasks
  const tasks = await db
    .select()
    .from(projectTodoLists)
    .where(eq(projectTodoLists.ticketId, ticketId));

  // Mark ticket as executing and move to "In Progress" stage
  await moveTicketToStage(ticketId, project.id, "In Progress");
  await db
    .update(projectTickets)
    .set({ status: "in_progress", queueStatus: "executing", updatedAt: new Date() })
    .where(eq(projectTickets.id, ticketId));
  broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "in_progress", queueStatus: "executing" }); // build started → turn the indicator on

  // Project dir name (relative, e.g. "project")
  const projectDirName = "project"; // Default, matching Django stack_config

  // Feature branch name matching Django
  const featureBranch = ticket.githubBranch ?? ticketBranchName(ticket);

  // The branch this ticket cascades on: its EPIC's branch, so it inherits the
  // earlier tickets of its own delivery unit and NOTHING from other, unapproved
  // epics. Legacy tickets with no epic fall back to the global `lfg-agent`.
  const anchor = await resolveTicketAnchor(ticket);
  const anchorBranch = anchor.anchorBranch;
  const anchorBase = anchor.baseBranch;
  await markEpicBuilding(ticket.epicId);

  // ── Step 2: Find or create sandbox ─────────────────────────────────
  console.log(`[ticket-executor] Step 2: Setting up workspace`);
  let sandboxRow = await findExistingSandbox(ticketId);
  let isReuse = !!sandboxRow;
  let workspaceId = sandboxRow?.magsWorkspaceId ?? null;

  if (isReuse && workspaceId) {
    // Probe existing workspace
    await addLog(ticketId, "Reconnecting to existing workspace...", "command", ownerId);
    console.log(`[ticket-executor] Probing existing workspace: ${workspaceId}`);
    try {
      const probe = await execOnWorkspace(workspaceId, 'echo "WORKSPACE_READY"', { timeout: 60_000 });
      if (!probe.output.includes("WORKSPACE_READY")) {
        console.log(`[ticket-executor] Probe failed, creating fresh workspace`);
        isReuse = false;
        workspaceId = null;
        // Delete stale sandbox record
        if (sandboxRow) {
          await db.delete(sandboxes).where(eq(sandboxes.id, sandboxRow.id));
        }
        sandboxRow = null;
      }
    } catch {
      console.log(`[ticket-executor] Probe threw, creating fresh workspace`);
      isReuse = false;
      workspaceId = null;
      if (sandboxRow) {
        await db.delete(sandboxes).where(eq(sandboxes.id, sandboxRow.id));
      }
      sandboxRow = null;
    }
  }

  if (!workspaceId) {
    const workspaceName = `${ticketId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    await addLog(ticketId, "Creating VM workspace...", "command", ownerId);
    console.log(`[ticket-executor] Creating new workspace: ${workspaceName}`);

    // Ticket build VM: persistent (v2 always) + noSync (no S3 mirror) + keepAlive
    // (no_sleep=true) so Mags can't idle-sleep a live build. Toggled off at build end.
    const { jobId, workspaceId: wsId, cloneIntentId } = await createTicketSandbox({ projectId: project.id, ticketId, userId: ownerId,
      log: message => addLog(ticketId, message, "command", ownerId),
      fresh: () => newWorkspaceV2(workspaceName, {
      vcpus: 4,
      memoryMb: parseInt(process.env.INSTANT_MEM_GB || "4", 10) * 1024,
      diskGb: parseInt(process.env.INSTANT_DISK_GB || "8", 10),
      keepAlive: true,
      noSync: true,
      rootfsType: "claude",
      }),
    });
    workspaceId = wsId;

    // Wait for VM to boot
    if (!cloneIntentId) await sleep(8_000);

    const created = await db
      .insert(sandboxes)
      .values({
        projectId: ticket.projectId,
        userId: ownerId,
        ticketId,
        magsWorkspaceId: wsId,
        magsJobId: jobId,
        workspaceType: "ticket",
        status: "ready",
      })
      .returning();

    sandboxRow = (created[0] as any) ?? null;
    if (cloneIntentId) await db.delete(sandboxes).where(eq(sandboxes.id,cloneIntentId));
  }

  if (!sandboxRow || !workspaceId) throw new Error("Failed to create or find sandbox");
  const sandbox = sandboxRow;

  emit({ type: "ticket.execution_started", ticketId, sandboxId: sandbox.id, projectId: project.id });

  // Ensure TLS certs + git before any HTTPS git op (clone or push).
  await ensureVmCerts(workspaceId);

  // ── Step 3: Setup git repo ──────────────────────────────────────────
  console.log(`[ticket-executor] Step 3: Setting up git`);
  let gitSetupError: string | null = null;

  // Extract GitHub owner/repo from project fields or fallback to stack text
  let githubOwner: string | null = project.repoOwner ?? null;
  let githubRepo: string | null = project.repoName ?? null;
  const repoUrl = project.repoUrl ?? extractRepoUrl(project.stack ?? "");

  if (!githubOwner || !githubRepo) {
    if (repoUrl) {
      const ghMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
      if (ghMatch) {
        githubOwner = ghMatch[1] ?? null;
        githubRepo = ghMatch[2] ?? null;
      }
    }
  }

  if (githubOwner && githubRepo && githubToken) {
    await addLog(ticketId, `Setting up repo: ${githubOwner}/${githubRepo}`, "command", ownerId);
    console.log(`[ticket-executor] Git setup: ${githubOwner}/${githubRepo}, branch: ${featureBranch}`);

    const gitSetupScript = `
cd ${WORKING_DIR}

if [ -d "${projectDirName}/.git" ]; then
    echo "REPO_EXISTS"
    cd ${projectDirName}
    ${refreshOriginCommand(`https://x-access-token:${githubToken}@github.com/${githubOwner}/${githubRepo}.git`)}
    git fetch --prune origin
    # Keep cloned local configuration and caches; branch setup below selects source.
elif [ -d "${projectDirName}" ] && [ "$(ls -A ${projectDirName} 2>/dev/null)" ]; then
    echo "INIT_EXISTING_DIR"
    cd ${projectDirName}
    git init
    git remote add origin https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git 2>/dev/null || \
        git remote set-url origin https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git
    git fetch --prune origin
else
    echo "CLONING_REPO"
    rm -rf ${projectDirName}
    git clone https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git ${projectDirName} 2>&1
    # A failed clone (TLS/network/auth) leaves no dir — do NOT fall through and run
    # git ops in the parent (WORKING_DIR); fail loudly so the caller aborts.
    cd ${projectDirName} 2>/dev/null || { echo "GIT_CLONE_FAILED"; exit 1; }
    [ -d ".git" ] || { echo "GIT_CLONE_FAILED"; exit 1; }
fi

# Ensure the ANCHOR branch exists (the epic's branch, or the legacy global one).
# It is cut from the epic's recorded base — normally the repo default branch — so
# a new epic starts from approved code, never from another epic's pending work.
${emptyRepoBootstrap(anchorBase)}
if ! git rev-parse --verify origin/${anchorBranch} 2>/dev/null; then
    echo "CREATING_ANCHOR_BRANCH"
    ANCHOR_BASE="${anchorBase}"
    git rev-parse --verify origin/$ANCHOR_BASE 2>/dev/null || ANCHOR_BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
    git checkout "$ANCHOR_BASE" 2>/dev/null || git checkout main 2>/dev/null || true
    git checkout -b ${anchorBranch}
    git push -u origin ${anchorBranch} 2>&1
fi

# Checkout feature branch — always branch from the anchor if creating new
if git rev-parse --verify origin/${featureBranch} 2>/dev/null; then
    echo "FEATURE_BRANCH_EXISTS_REMOTE"
    git checkout ${featureBranch} 2>/dev/null || git checkout -b ${featureBranch} origin/${featureBranch}
    git reset --hard origin/${featureBranch}
elif git rev-parse --verify ${featureBranch} 2>/dev/null; then
    echo "FEATURE_BRANCH_EXISTS_LOCAL"
    git checkout ${featureBranch}
else
    echo "CREATING_FEATURE_BRANCH"
    # A cloned preview disk carries the preview's local edits (config patches, build
    # output), so a plain checkout of the anchor fails and used to fall through silently,
    # cutting the ticket from whatever the disk had checked out (often main). Force the
    # new branch onto the anchor; untracked/ignored files (.env, node_modules) are kept.
    ANCHOR_REF=origin/${anchorBranch}
    git rev-parse --verify "$ANCHOR_REF" >/dev/null 2>&1 || ANCHOR_REF=${anchorBranch}
    git checkout -f -B ${featureBranch} "$ANCHOR_REF" 2>&1 || { echo "FEATURE_BASE_FAILED"; exit 1; }
    # A new ticket must start from its epic's code, or the agent builds on the wrong app.
    [ "$(git rev-parse HEAD)" = "$(git rev-parse "$ANCHOR_REF")" ] || { echo "FEATURE_BASE_FAILED: ${featureBranch} is not on ${anchorBranch}"; exit 1; }
fi

git config user.email "ai@lfg.dev"
git config user.name "LFG AI"

# Verify we actually have a repo — a failed clone (TLS/network) leaves no .git,
# and without this the script would report success against an empty dir.
if [ -d ".git" ]; then echo "GIT_SETUP_COMPLETE"; else echo "GIT_SETUP_FAILED_NO_GIT"; fi
pwd
git branch --show-current
`.trim();

    try {
      // exec() breaks with multi-line scripts — base64-encode
      const gitResult = await runGitSetup(workspaceId, gitSetupScript, `${WORKING_DIR}/${projectDirName}`, featureBranch, [githubToken]);
      console.log(`[ticket-executor] Git setup output:`, gitResult.output.slice(0, 300));

      if (gitResult.output.includes("GIT_SETUP_COMPLETE")) {
        console.log(`[ticket-executor] Git setup complete, branch: ${featureBranch}`);
        // Save branch name to ticket
        if (!ticket.githubBranch) {
          await db
            .update(projectTickets)
            .set({ githubBranch: featureBranch, githubMergeStatus: "pending", updatedAt: new Date() })
            .where(eq(projectTickets.id, ticketId));
        }
      } else if (gitResult.output.includes("FEATURE_BASE_FAILED")) {
        // Never let an agent build on a checkout that lacks the epic's code.
        throw new Error(`Couldn't place ${featureBranch} on ${anchorBranch}; the ticket would not contain its epic's code. Nothing was built.`);
      } else if (gitResult.output.includes("GIT_CLONE_FAILED") || gitResult.output.includes("GIT_SETUP_FAILED_NO_GIT")) {
        // The clone genuinely failed — no code in the VM. Running the agent
        // against an empty dir is the "round and round" flailing; fail cleanly.
        const reason = `repository clone failed (network/TLS/auth) — no code in the build VM for ${githubOwner}/${githubRepo}`;
        console.error(`[ticket-executor] ${reason}`);
        await markTicketFailed(ticketId, `Git setup failed — ${reason}`, ownerId);
        return;
      } else {
        gitSetupError = `Git setup issue: ${gitResult.output.slice(0, 200)}`;
        console.warn(`[ticket-executor] ${gitSetupError}`);
      }
    } catch (err) {
      gitSetupError = `Git setup failed: ${err}`;
      console.error(`[ticket-executor] ${gitSetupError}`);
      await markTicketFailed(ticketId, gitSetupError, ownerId);
      return;
    }
  } else if (githubToken) {
    // No repo linked — auto-create one on GitHub (matching Django behavior)
    const repoName = project.providedName || project.name;
    await addLog(ticketId, `Creating GitHub repository: ${repoName}...`, "command", ownerId);
    console.log(`[ticket-executor] No repo linked — auto-creating GitHub repo: ${repoName}`);

    try {
      const repoResult = await createGitHubRepo({
        repoName,
        description: `LFG Project: ${project.name}`,
        isPrivate: true,
        githubToken,
      });

      githubOwner = repoResult.owner;
      githubRepo = repoResult.repoName;

      // Save repo info to project so future executions find it
      await db.update(projects).set({
        repoUrl: repoResult.repoUrl,
        repoOwner: repoResult.owner,
        repoName: repoResult.repoName,
        updatedAt: new Date(),
      }).where(eq(projects.id, project.id));

      await addLog(
        ticketId,
        repoResult.created
          ? `Created repo: ${githubOwner}/${githubRepo}`
          : `Using existing repo: ${githubOwner}/${githubRepo}`,
        "command",
        ownerId
      );

      // Ensure project dir exists, init git, push initial commit
      await execOnWorkspace(workspaceId, `mkdir -p "${WORKING_DIR}/${projectDirName}"`, {
        timeout: 15_000,
      });

      await initAndPushRepo({
        workspaceId,
        projectDir: `${WORKING_DIR}/${projectDirName}`,
        repoUrl: repoResult.repoUrl,
        branch: "main",
        githubToken,
      });

      // Fresh repo: cut the anchor (epic) branch from main, then the feature
      // branch from the anchor. initAndPushRepo leaves us on the legacy anchor,
      // so step back to main first — an epic must start from approved code.
      const branchScript = `
cd "${WORKING_DIR}/${projectDirName}"
git checkout main 2>/dev/null || true
git checkout ${anchorBranch} 2>/dev/null || { git checkout -b ${anchorBranch} && git push -u origin ${anchorBranch} 2>&1; }
git checkout -b ${featureBranch}
echo "BRANCH_CREATED"
`.trim();
      const branchB64 = Buffer.from(branchScript).toString("base64");
      await execOnWorkspace(workspaceId, `echo ${branchB64} | base64 -d | sh`, { timeout: 30_000 });

      // Save branch name to ticket
      await db
        .update(projectTickets)
        .set({ githubBranch: featureBranch, githubMergeStatus: "pending", updatedAt: new Date() })
        .where(eq(projectTickets.id, ticketId));

      console.log(`[ticket-executor] Auto-created repo and set up branch: ${featureBranch}`);
    } catch (err) {
      console.error(`[ticket-executor] Auto-create repo failed:`, err);
      await addLog(ticketId, `Failed to create GitHub repo: ${err}`, "command", ownerId);
      // Fall through — continue without git
      githubOwner = null;
      githubRepo = null;
      await execOnWorkspace(workspaceId, `mkdir -p "${WORKING_DIR}/${projectDirName}"`, {
        timeout: 15_000,
      });
    }
  } else {
    // No GitHub token at all — just ensure project dir exists
    await execOnWorkspace(workspaceId, `mkdir -p "${WORKING_DIR}/${projectDirName}"`, {
      timeout: 15_000,
    });
    console.log(`[ticket-executor] No GitHub token — skipping git setup`);
    await addLog(ticketId, "No GitHub token — code will not be persisted to a repository", "command", ownerId);
  }


  // ── Step 4: Refresh + inject credentials ────────────────────────────
  if (useClaudeSubscription) {
    console.log(`[ticket-executor] Step 4: Refreshing credentials from auth sandbox`);
    await refreshCredentialsFromAuthSandbox(ownerId);
    console.log(`[ticket-executor] Step 4: Subscription credentials will be injected by CLI launcher`);
    await addLog(ticketId, "Injecting Claude subscription credentials...", "command", ownerId);
  } else {
    console.log(`[ticket-executor] Step 4: Using connected Anthropic API token`);
    await addLog(ticketId, "Using connected Anthropic API token...", "command", ownerId);
  }

  await logActivity({
    projectId: project.id,
    ticketId,
    actorType: "system",
    activityType: ACTIVITY_TYPES.CREDENTIALS_INJECTED,
    title: "Claude credentials injected",
    description: `Loaded credentials from DB and injected into workspace for ticket execution.`,
    metadata: { workspaceId },
  });

  // ── Step 5: Build prompt + env vars ────────────────────────────────
  console.log(`[ticket-executor] Step 5: Building prompt`);

  // Load project environment variables early so they're available for prompt + runner
  const projectEnvRows = await db
    .select({ key: projectEnvironmentVariables.key, encryptedValue: projectEnvironmentVariables.encryptedValue, description: projectEnvironmentVariables.description })
    .from(projectEnvironmentVariables)
    .where(and(
      eq(projectEnvironmentVariables.projectId, project.id),
      eq(projectEnvironmentVariables.hasValue, true)
    ));

  // Build git error context
  let gitErrorContext = "";
  if (gitSetupError && gitSetupError !== "No GitHub repo configured or missing token") {
    gitErrorContext = `
⚠️ GIT SETUP ISSUE DETECTED:
${gitSetupError}

Before implementing, fix the git issue:
1. Check: cd ${WORKING_DIR}/${projectDirName} && git status
2. Resolve any conflicts or uncommitted changes
3. Checkout the correct branch: git checkout ${featureBranch}
`;
  }

  // Check for existing session — resume with short prompt
  const existingSessionId = sandbox.cliSessionId ?? undefined;

  let prompt: string;
  let cliAddendaCtx: { block: string; pendingIds: string[] } = { block: "", pendingIds: [] };
  if (existingSessionId) {
    console.log(`[ticket-executor] Resuming session ${existingSessionId.slice(0, 20)}...`);
    await addLog(ticketId, "Resuming existing Claude session...", "command", ownerId);
    prompt = `Continue implementing ticket #${ticket.id}: ${ticket.name}\n\n` +
      `The user clicked 'Continue' to resume execution. ` +
      `Check the current state of the project at ${WORKING_DIR}/${projectDirName}, ` +
      `review what has already been done, and continue implementing any remaining work. ` +
      `When done, call the status API to mark the ticket complete.`;
  } else {
    // Load saved tech stack from sandbox (agent may have reported it in a previous run)
    const savedTechStack = sandbox.techStack as {
      language?: string;
      framework?: string;
      packageManager?: string;
      startCommand?: string;
      buildCommand?: string;
      port?: number;
    } | null;

    prompt = buildBuilderPrompt({
      ticket: {
        id: ticket.id,
        ticketKey: ticket.ticketKey,
        name: ticket.name,
        description: ticket.description,
        details: (ticket.details as Record<string, unknown>) ?? {},
        uiRequirements: (ticket.uiRequirements as Record<string, unknown>) ?? {},
        componentSpecs: (ticket.componentSpecs as Record<string, unknown>) ?? {},
        acceptanceCriteria: (ticket.acceptanceCriteria as string[]) ?? [],
        notes: ticket.notes ?? "",
      },
      project: {
        id: project.id,
        name: project.name,
        repoUrl: repoUrl ?? undefined,
        techStack: project.stack || undefined,
      },
      techStack: savedTechStack ?? undefined,
      callbackBaseUrl: CALLBACK_BASE_URL,
      cliApiKey,
      tasks: tasks.map((t) => ({
        id: t.id,
        description: t.description,
        status: t.status,
      })),
      envVars: projectEnvRows.map((r) => ({ key: r.key, description: r.description ?? "" })),
    });
    // Pending addenda + "already done" history (marked resolved after a good push).
    cliAddendaCtx = await ticketAddendaContext(ticketId);
    prompt += cliAddendaCtx.block;

    // Inject relevant knowledge base patterns into the prompt
    const knowledgeSection = matchKnowledgeForPrompt(
      `${ticket.name} ${ticket.description ?? ""}`
    );
    if (knowledgeSection) prompt += knowledgeSection;

    // Append git error context and project path info
    prompt += `\n\nPROJECT PATH: ${WORKING_DIR}/${projectDirName}\n`;
    if (gitErrorContext) prompt += gitErrorContext;
  }

  prompt += ticketDocumentInstructions(await materializeTicketDocs({
    projectId:project.id,workspaceId,projectDir:`${WORKING_DIR}/${projectDirName}`,
    epicId:ticket.epicId,sourceDocumentId:ticket.sourceDocumentId,sourceDocumentIds:ticketDocumentIds(ticket.details),
    text:[ticket.name,ticket.description,ticket.notes].join('\n'),
  }));

  // LFG env vars passed to the runner script
  const envVars: Record<string, string> = {
    LFG_API_URL: CALLBACK_BASE_URL,
    LFG_API_KEY: cliApiKey,
    LFG_TICKET_ID: ticket.id,
    LFG_PROJECT_ID: project.id,
  };

  // Merge project env vars into runner env
  for (const row of projectEnvRows) {
    envVars[row.key] = decrypt(row.encryptedValue);
  }

  if (projectEnvRows.length > 0) {
    console.log(`[ticket-executor] Injected ${projectEnvRows.length} project env vars: ${projectEnvRows.map(r => r.key).join(", ")}`);
  }

  // ── Step 6: Start Claude CLI ──────────────────────────────────────
  console.log(`[ticket-executor] Step 6: Starting Claude CLI`);
  await addLog(ticketId, "Starting Claude Code CLI...", "command", ownerId);

  // Pin the VM awake for the whole build (see wakeTicketVm).
  await wakeTicketVm(workspaceId);

  let cliResult;
  try {
    cliResult = await startClaudeCli({
      workspaceId,
      prompt: prompt + workJournalBlock(ticket.details) + ticketJournalInstruction(ticketId),
      projectDir: projectDirName,
      sessionId: existingSessionId,
      userId: ownerId,
      envVars,
      anthropicApiKey,
    });
  } catch (err) {
    const msg = `startClaudeCli failed: ${err}`;
    console.error(`[ticket-executor] ${msg}`);
    await addLog(ticketId, msg, "command", ownerId);
    throw err;
  }

  const { outputFile, backgroundPid } = cliResult;
  console.log(`[ticket-executor] CLI started, pid=${backgroundPid}, file=${outputFile}`);
  await addLog(ticketId, `CLI started (pid ${backgroundPid ?? "unknown"})`, "command", ownerId);

  // ── Debug: Check forwarder connectivity after a few seconds ─────
  setTimeout(async () => {
    try {
      const debugResult = await execOnWorkspace(workspaceId, `cat /tmp/forwarder_debug.log 2>/dev/null || echo "NO_DEBUG_LOG"`, { timeout: 15_000 });
      console.log(`[ticket-executor] FORWARDER DEBUG:\n${debugResult.output}`);
      if (debugResult.output.includes("NO_DEBUG_LOG")) {
        console.log(`[ticket-executor] Runner script hasn't written debug log yet — may still be starting`);
      }
    } catch (err) {
      console.log(`[ticket-executor] Could not read debug log:`, err);
    }
  }, 5_000);

  // ── Step 7: Wait for completion via push-based output streaming ─────
  // The VM's runner script pushes JSONL output to POST /api/v1/cli/output/
  // which handles all log parsing, DB inserts, and WS broadcasting.
  // The executor waits for ticket.cli_finished, then commits and publishes the final build result.
  console.log(`[ticket-executor] Waiting for VM to push output via callback API...`);

  const waitResult = await waitForCompletion(ticketId, MAX_WAIT_DURATION_MS);
  if (await stoppedByUser(ticketId, ownerId)) return;

  // The CLI exit code is NOT the source of truth for implementation status.
  // The agent explicitly calls POST /api/v1/cli/status to report completion,
  // which sets ticket.status in the DB. The CLI can exit with non-zero code
  // (e.g., tool failure, session issues) even after successful implementation.
  // Always check the DB status before trusting the exit code.
  let implementationStatus: "complete" | "failed" | null = null;
  if (waitResult.status === "complete") {
    implementationStatus = "complete";
  } else if (waitResult.status === "failed") {
    // Check if the agent already reported completion via the status API
    const [currentTicket] = await db
      .select({ status: projectTickets.status })
      .from(projectTickets)
      .where(eq(projectTickets.id, ticketId))
      .limit(1);
    if (currentTicket?.status === "done") {
      console.log(`[ticket-executor] CLI exited with code ${waitResult.exitCode}, but agent reported COMPLETE via status API — treating as complete`);
      implementationStatus = "complete";
    } else {
      implementationStatus = "failed";
    }
  } else {
    // timeout — but also check if agent already reported success
    const [currentTicket] = await db
      .select({ status: projectTickets.status })
      .from(projectTickets)
      .where(eq(projectTickets.id, ticketId))
      .limit(1);
    if (currentTicket?.status === "done") {
      console.log(`[ticket-executor] Execution timed out, but agent reported COMPLETE via status API — treating as complete`);
      implementationStatus = "complete";
    } else {
      implementationStatus = "failed";
      await addLog(ticketId, "Execution timed out (45 minutes)", "command", ownerId);
    }
  }

  console.log(`[ticket-executor] Wait finished: status=${waitResult.status}, exitCode=${waitResult.exitCode}, implementationStatus=${implementationStatus}`);


  // ── Step 8: Commit & finalize ───────────────────────────────────────
  const durationMs = Date.now() - startTime;

  // A build isn't "done" until the work is on the remote. If we can't push (no
  // repo/token) or the push throws, that's a FAILURE — don't mark it In Review.
  let commitFailed = false;
  let publicationFailure = "";
  let publicationFailureKind: ValidationFailure["failureKind"] | undefined;
  let publicationDocumentation = "";
  if (implementationStatus === "complete" && !(githubOwner && githubRepo && githubToken)) {
    commitFailed = true;
    publicationFailure = "Repository or credentials are missing; connect the repository in Settings.";
    await addLog(ticketId, "Build finished but the work was NOT pushed — GitHub isn't connected (no repo/token). Connect GitHub in Settings and rebuild.", "cli_error", ownerId);
  }
  if (implementationStatus === "complete" && githubOwner && githubRepo && githubToken) {
    try {
      await addLog(ticketId, "Committing changes...", "command", ownerId);
      // One provider-aware credential for the push and the merge below — both used to
      // hardcode github.com regardless of where the repo actually lives.
      const gitAuth = await resolveRepoAuth(project, gitUserId).catch(() => null);
      const { sha, documentation } = await commitAndPush({
      validation: { gitCredentialUserId: gitUserId, projectId: project.id, userId: buildLlm.actorId, ticketId: ticketId, epicId: ticket.epicId ?? undefined, baselineBranch: anchorBase, cancelled: () => cancelledTickets.has(ticketId) || checksSkipped(ticketId), skipped: () => checksSkipped(ticketId), onLog: line => { addLog(ticketId, line, checkLogType(line), ownerId).catch(() => {}); }, onCheckpoint: async message => { await addLog(ticketId, message, "agent_progress", ownerId); } },
        workspaceId,
        projectDir: `${WORKING_DIR}/${projectDirName}`,
        commitMessage: `feat: ${ticket.ticketKey ? ticket.ticketKey + " " : ""}${ticket.name}`,
        featureBranch,
        repoUrl: gitAuth?.repoUrl ?? `https://github.com/${githubOwner}/${githubRepo}.git`,
        githubToken: gitAuth?.token ?? githubToken,
        tokenUser: gitAuth?.tokenUser,
      });
      publicationDocumentation = documentation?.message ?? "";

      await db
        .update(projectTickets)
        .set({
          githubBranch: featureBranch,
          githubCommitSha: sha,
          githubMergeStatus: "pushed", // clears any prior "not_pushed" flag
          updatedAt: new Date(),
        })
        .where(eq(projectTickets.id, ticketId));

      await logActivity({
        projectId: project.id,
        ticketId,
        actorType: "system",
        activityType: ACTIVITY_TYPES.GIT_PUSHED,
        title: `Pushed to ${featureBranch}`,
        description: `Commit ${sha.slice(0, 7)} pushed to ${githubOwner}/${githubRepo}.`,
        metadata: { sha, branch: featureBranch, repo: `${githubOwner}/${githubRepo}` },
      });

      // Merge feature branch → the epic's anchor branch (direct push, no PR).
      // This is the cascade: the NEXT ticket in this epic branches off the anchor
      // and so inherits this code — and only this epic's code.
      try {
        await addLog(ticketId, `Merging to ${anchorBranch}...`, "command", ownerId);
        // Provider-aware: this used to hardcode github.com with a GitHub-shaped
        // credential, so on a GitLab project the merge fetched from a repo that doesn't
        // exist. resolveRepoAuth gives the right host, token and credential username.
        const mergeAuth = gitAuth;
        const { sha: mergeSha, files: mergedFiles } = await mergeToAnchor({
      validation: { gitCredentialUserId: gitUserId, projectId: project.id, userId: buildLlm.actorId, ticketId: ticketId, epicId: ticket.epicId ?? undefined, baselineBranch: anchorBase, cancelled: () => cancelledTickets.has(ticketId) || checksSkipped(ticketId), skipped: () => checksSkipped(ticketId), onLog: line => { addLog(ticketId, line, checkLogType(line), ownerId).catch(() => {}); }, onCheckpoint: async message => { await addLog(ticketId, message, "agent_progress", ownerId); } },
          workspaceId,
          projectDir: `${WORKING_DIR}/${projectDirName}`,
          featureBranch,
          repoUrl: mergeAuth?.repoUrl ?? `https://github.com/${githubOwner}/${githubRepo}.git`,
          githubToken: mergeAuth?.token ?? githubToken!,
          tokenUser: mergeAuth?.tokenUser,
          targetBranch: anchorBranch,
          baseBranch: anchorBase,
        });
        await recordEpicFilesTouched(ticket.epicId, mergedFiles);
        await db
          .update(projectTickets)
          .set({
            githubMergeStatus: "merged",
            updatedAt: new Date(),
          })
          .where(eq(projectTickets.id, ticketId));
        await addLog(ticketId, `Merged to ${anchorBranch} (${mergeSha.slice(0, 7)})`, "command", ownerId);

        await logActivity({
          projectId: project.id,
          ticketId,
          actorType: "system",
          activityType: ACTIVITY_TYPES.GIT_MERGED,
          title: `Merged to ${anchorBranch}`,
          description: `Feature branch ${featureBranch} merged (${mergeSha.slice(0, 7)}).`,
          metadata: { mergeSha, branch: featureBranch, anchorBranch, epicId: ticket.epicId ?? null },
        });

        // Last ticket in the epic? Hand the whole unit to the client for review.
        await maybeSubmitEpicForReview(ticket.epicId);
      } catch (mergeErr) {
        // CONFLICT is a distinct, recoverable outcome — the merge has already been
        // aborted and the checkout put back, so we can hand the files to the resolver.
        // Anything else is a real failure and just gets reported.
        const { MergeConflictError } = await import("../services/git.ts");
        const conflictFiles = mergeErr instanceof MergeConflictError ? mergeErr.files : undefined;
        if (conflictFiles?.length) {
          await addLog(ticketId, `Merge to ${anchorBranch} hit conflicts in: ${conflictFiles.join(", ")}`, "command", ownerId);
        } else {
          console.warn(`[ticket-executor] Merge to ${anchorBranch} failed:`, mergeErr);
          await addLog(ticketId, `Merge to ${anchorBranch} failed: ${String(mergeErr).slice(0, 400)}`, "cli_error", ownerId);
        }
        const merged = await tryAgentMerge({
          ticketId, ownerId, actorId: buildLlm.actorId, workspaceId,
          projectDir: `${WORKING_DIR}/${projectDirName}`,
          featureBranch, targetBranch: anchorBranch,
          files: conflictFiles,
          authUrl: gitAuth?.authUrl
            ?? `https://x-access-token:${githubToken}@github.com/${githubOwner}/${githubRepo}.git`,
          projectId: project.id,
          error: String(mergeErr),
        });
        if (merged?.merged && merged.sha) {
          const status = conflictFiles?.length ? "merged_with_conflicts" : "merged";
          await db.update(projectTickets)
            .set({ githubMergeStatus: status, updatedAt: new Date() })
            .where(eq(projectTickets.id, ticketId));
          await addLog(ticketId, `Merged to ${anchorBranch} (${merged.sha.slice(0, 7)}) — ${merged.summary}`, "command", ownerId);
          await maybeSubmitEpicForReview(ticket.epicId);
        } else {
          await db.update(projectTickets)
            .set({ githubMergeStatus: "conflict", updatedAt: new Date() })
            .where(eq(projectTickets.id, ticketId));
          await addLog(ticketId, `Merge to ${anchorBranch} blocked: ${merged?.summary ?? "no agent available"}`, "cli_error", ownerId);
          throw mergeErr;
        }
      }
    } catch (err) {
      // A thrown commit/push means the work is NOT on the remote → not a success.
      commitFailed = true;
      publicationFailureKind = err instanceof ValidationFailure ? err.failureKind : undefined;
      publicationFailure = failureSummary((err as Error).message || String(err), 2400).split("\nFailed command:")[0] || "No diagnostic returned";
      await addLog(ticketId, `Publication/validation FAILED — candidate is not ready for review: ${publicationFailure}`, "cli_error", ownerId);
    }
  }

  if (implementationStatus === "complete" && !commitFailed) {
    const reviewStageId = await moveTicketToStage(ticketId, project.id, "In Review");
    await db
      .update(projectTickets)
      .set({
        status: "review",
        queueStatus: "none",
        executionTimeSeconds: durationMs / 1000,
        lastExecutionAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectTickets.id, ticketId));
    const [savedRow] = await db.select({ sha: projectTickets.githubCommitSha, merge: projectTickets.githubMergeStatus }).from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
    const cliWhat = await recentWorkSummary(ticketId).catch(() => "");
    const cliSummary = `✅ **Ticket complete** — moved to In Review.\n\n` +
      (cliWhat ? `**What got done:** ${cliWhat}\n\n` : "") +
      (publicationDocumentation ? publicationDocumentation + "\n\n" : "") +
      `- Branch: \`${featureBranch}\`\n` +
      (savedRow?.sha ? `- Commit: \`${savedRow.sha.slice(0, 7)}\`\n` : "") +
      (savedRow?.merge === "merged" ? `- Merged to \`${anchorBranch}\` ✓\n` : savedRow?.sha ? `- Pushed (merge to ${anchorBranch} pending/failed — see logs)\n` : "") +
      `\nOpen the **Git** tab to review the diff, or the **Preview** tab to run this branch.`;
    await addLog(ticketId, cliSummary, "ai_response", ownerId);
    await markBuildTasksComplete(ticketId);
    await resolveTicketAddenda(ticketId, cliAddendaCtx.pendingIds);
    await maybeSubmitEpicForReview(ticket.epicId);
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "review", queueStatus: "none", stageId: reviewStageId, mergeStatus: "merged" });
    emit({ type: "ticket.execution_finished", ticketId, projectId: project.id, status: "complete", exitCode: 0, durationMs: Date.now() - startTime });
    // Feature testing and recording already completed inside runtime validation.
    // QA (opt-in, projects.qaMode = "tests"): write a test suite for the ticket's
    // acceptance criteria and verify it red/green against the branch point, in the
    // sandbox that just built it. Fire-and-forget like the demo — it never throws,
    // never fails the ticket, and reports into the ticket's log.
    void runTicketQa(ticketId, { ownerId, llmUserId: buildLlm.actorId, projectId: project.id });
  } else {
    const _detail = commitFailed ? "" : await lastErrorSnippet(ticketId);
    const reason = commitFailed
      ? `publication or integration validation failed: ${publicationFailure || "No diagnostic returned"}`
      : (_detail ? `did not complete — ${_detail}` : "Implementation did not complete (the agent stopped without a specific error)");
    if (commitFailed) await db.update(projectTickets).set({ githubMergeStatus: "failed", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId)).catch(() => {});
    await markTicketFailed(ticketId, reason, ownerId, { failureKind: publicationFailureKind });
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: /Runtime validation (paused|blocked: required environment)/.test(reason) ? "blocked" : "failed", queueStatus: "none", mergeStatus: commitFailed ? "failed" : undefined });
  }

  // Session ID is now saved by the /api/v1/cli/output/ endpoint
  // when it receives the init event from the JSONL stream.

  // Save credentials back to DB (may have been refreshed during the run)
  if (sandbox?.magsWorkspaceId) {
    const saved = await saveCredentialsFromVm(sandbox.magsWorkspaceId, ownerId);
    if (saved) {
      await logActivity({
        projectId: project.id,
        ticketId,
        actorType: "system",
        activityType: ACTIVITY_TYPES.CREDENTIALS_SAVED,
        title: "Claude credentials saved",
        description: `Credentials from sandbox pushed back to DB after execution.`,
        metadata: { workspaceId: sandbox.magsWorkspaceId },
      });
    }
  }

  // Build done — save the journal and retire the VM (deleted after the grace period).
  await sleepTicketVm(workspaceId, ticketId, "Build");
}

/**
 * A DEDICATED isolated sandbox for ticket CHAT — a fresh VM cloned to the ticket's
 * branch, REUSED across chat messages (warm) but NEVER the shared preview VM. This
 * keeps chat commits clean: the preview VM accumulates run-enabling config hacks on
 * /data/project that a `git add -A` there would sweep into the branch. Reuses a live
 * "ticket-chat" sandbox; otherwise provisions + clones. Torn down when the ticket is
 * approved/Done (cleanupTicketWorktree), kept warm meanwhile for fast follow-ups.
 */
/**
 * SHARED MODE ONLY: make sure the ticket's worktree exists in the preview VM and is
 * on its branch, so a chat turn can run there. Reuses the worktree the build left
 * behind (with its node_modules/obj intact); creates it if the ticket hasn't been
 * built yet. Never touches /data/project itself — that's what the preview serves.
 */
async function ensureSharedChatWorktree(
  ticket: { id: string; projectId: string; githubBranch: string | null; epicId?: string | null },
  project: { id: string; repoOwner: string | null; repoName: string | null; repoUrl: string | null; repoProvider?: string | null; stack?: string | null },
  ownerId: string,
  gitUserId: string,
  usingOwnGit: boolean,
  workspaceId: string,
): Promise<{ dir: string } | { error: string }> {
  const dir = ticketWorktreeDirName(ticket.id);
  const featureBranch = ticket.githubBranch ?? ticketBranchName(ticket);
  const { anchorBranch } = await resolveTicketAnchor(ticket);
  const auth = await resolveRepoAuth(project, gitUserId);
  if (!auth) return { error: usingOwnGit ? NO_SHARED_GIT_MESSAGE : "No repository/credentials configured — connect the repo in Settings, then chat with the agent." };

  const script = `
cd ${WORKING_DIR}/project 2>/dev/null || { echo NO_BASE_CHECKOUT; exit 1; }
git config --global --add safe.directory '*' 2>/dev/null || true
git remote set-url origin "${auth.authUrl}" 2>/dev/null || true
git fetch --prune origin 2>&1 | tail -1
if [ -e "${WORKING_DIR}/${dir}/.git" ]; then
    cd ${WORKING_DIR}/${dir} || { echo WT_FAILED; exit 1; }
    test "$(git symbolic-ref --short HEAD)" = ${shellQuote(featureBranch)} || { echo WT_FAILED; exit 1; }
else
    git worktree prune 2>/dev/null || true
    if git rev-parse --verify origin/${featureBranch} 2>/dev/null; then
        git worktree add --force -B ${featureBranch} ${WORKING_DIR}/${dir} origin/${featureBranch} 2>&1 | tail -2
    else
        git worktree add --force -B ${featureBranch} ${WORKING_DIR}/${dir} origin/${anchorBranch} 2>&1 | tail -2 \\
          || git worktree add --force -B ${featureBranch} ${WORKING_DIR}/${dir} ${anchorBranch} 2>&1 | tail -2
    fi
fi
cd ${WORKING_DIR}/${dir} 2>/dev/null || { echo WT_FAILED; exit 1; }
git config user.email "ai@lfg.dev"; git config user.name "LFG AI"
[ -e .git ] && echo WT_READY || echo WT_FAILED
`.trim();
  const b64 = Buffer.from(script).toString("base64");
  const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | sh`, { timeout: 180_000 })
    .catch((e) => ({ output: `EXEC_FAILED: ${(e as Error).message}` }));
  if (!r.output.includes("WT_READY")) {
    return { error: `Couldn't prepare this ticket's worktree in the preview VM: ${(r.output || "").slice(-300)}` };
  }
  // Bookkeeping row so Stop, cleanup and eviction can find this worktree.
  const [existing] = await db.select({ id: sandboxes.id }).from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticket.id), eq(sandboxes.workspaceType, "ticket-worktree"))).limit(1);
  if (!existing) {
    await db.insert(sandboxes).values({
      projectId: ticket.projectId, userId: ownerId, ticketId: ticket.id,
      magsWorkspaceId: workspaceId, workspaceType: "ticket-worktree", status: "ready",
    }).catch(() => {});
  }
  return { dir };
}

async function ensureIsolatedChatSandbox(
  ticket: { id: string; projectId: string; githubBranch: string | null; epicId?: string | null },
  project: { id: string; repoOwner: string | null; repoName: string | null; repoUrl: string | null; repoProvider?: string | null; stack?: string | null },
  ownerId: string,
  // Whose Git token clones the repo here (fine-grained sharing) + whether it's the
  // collaborator's OWN token, so a missing token yields the right "connect/ask owner" text.
  gitUserId: string = ownerId,
  usingOwnGit: boolean = false,
  // SHARED PREVIEW VM (opt-in): chat runs in the ticket's worktree inside the preview
  // VM instead of a dedicated clone — same box the build used, so an "answer" turn can
  // look at the branch (and the running app + its databases) with no VM boot at all.
  sharedWorkspaceId: string | null = null,
): Promise<{ workspaceId: string; projectDir: string } | { error: string }> {
  if (sharedWorkspaceId) {
    const wt = await ensureSharedChatWorktree(ticket, project, ownerId, gitUserId, usingOwnGit, sharedWorkspaceId);
    if ("error" in wt) return wt;
    return { workspaceId: sharedWorkspaceId, projectDir: wt.dir };
  }
  // Continue from the same verified checkout/checkpoint without resetting or cleaning edits.
  const [savedTicket] = await db.select().from(projectTickets).where(eq(projectTickets.id,ticket.id));
  const [savedProject] = await db.select().from(projects).where(eq(projects.id,project.id));
  if (!savedTicket || !savedProject) return {error:'Ticket or project not found.'};
  if (!savedTicket.githubBranch) return provisionInitialChatSandbox(ticket,project,ownerId,gitUserId,usingOwnGit);
  try {
    const workspace = await openTicketWorkspace({ticket:savedTicket,project:savedProject,actorId:gitUserId,canRestore:true,continuation:true,
      progress:message=>{void addLog(ticket.id,message,'command',ownerId);}});
    await wakeTicketVm(workspace.workspaceId);
    return {workspaceId:workspace.workspaceId,projectDir:workspace.root.replace(/^\/data\//,'')};
  } catch (error) { return {error: error instanceof Error ? error.message : 'Could not open ticket workspace'}; }

}

async function provisionInitialChatSandbox(
  ticket: { id: string; projectId: string; githubBranch: string | null; epicId?: string | null },
  project: { id: string; repoOwner: string | null; repoName: string | null; repoUrl: string | null; repoProvider?: string | null; stack?: string | null },
  ownerId: string,
  // Whose Git token clones the repo here (fine-grained sharing) + whether it's the
  // collaborator's OWN token, so a missing token yields the right "connect/ask owner" text.
  gitUserId: string = ownerId,
  usingOwnGit: boolean = false,
  // SHARED PREVIEW VM (opt-in): chat runs in the ticket's worktree inside the preview
  // VM instead of a dedicated clone — same box the build used, so an "answer" turn can
  // look at the branch (and the running app + its databases) with no VM boot at all.
  sharedWorkspaceId: string | null = null,
): Promise<{ workspaceId: string; projectDir: string } | { error: string }> {
  const projectDirName = "project";
  const featureBranch = ticket.githubBranch ?? ticketBranchName(ticket);
  const { anchorBranch } = await resolveTicketAnchor(ticket);

  const auth = await resolveRepoAuth(project, gitUserId);
  if (!auth) return { error: usingOwnGit ? NO_SHARED_GIT_MESSAGE : "No repository/credentials configured — connect the repo in Settings, then chat with the agent." };

  // 2) Provision a fresh isolated VM (same call + rootfs the build uses).
  await addLog(ticket.id, "Spinning up a clean isolated sandbox for this chat…", "command", ownerId);
  let workspaceId: string;
  try {
    const workspaceName = `chat-${ticket.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    const { workspaceId: wsId, jobId } = await newWorkspaceV2(workspaceName, {
      vcpus: 4,
      memoryMb: parseInt(process.env.INSTANT_MEM_GB || "4", 10) * 1024,
      diskGb: parseInt(process.env.INSTANT_DISK_GB || "8", 10),
      keepAlive: true, // no_sleep while working (toggled off at chat end)
      noSync: true,    // ticket sandbox — no S3 mirror
      rootfsType: process.env.PREVIEW_ROOTFS || "pi",
    });
    workspaceId = wsId;
    await sleep(8_000);
    await db.insert(sandboxes).values({
      projectId: ticket.projectId, userId: ownerId, ticketId: ticket.id,
      magsWorkspaceId: wsId, magsJobId: jobId, workspaceType: "ticket-chat", status: "ready",
    });
  } catch (e) {
    return { error: `Could not create a sandbox: ${(e as Error).message}` };
  }

  // 3) Certs + clone + checkout the ticket's branch (fresh, clean state).
  await ensureVmCerts(workspaceId);
  const cloneScript = `
cd ${WORKING_DIR}
echo CLONING
rm -rf ${projectDirName}
git clone "${auth.authUrl}" ${projectDirName} 2>&1
cd ${projectDirName} 2>/dev/null || { echo GIT_CLONE_FAILED; exit 1; }
[ -d .git ] || { echo GIT_CLONE_FAILED; exit 1; }
git config --global --add safe.directory '*' 2>/dev/null || true
git config user.email "ai@lfg.dev"; git config user.name "LFG AI"
if git rev-parse --verify origin/${featureBranch} 2>/dev/null; then
  git checkout -B ${featureBranch} origin/${featureBranch} 2>&1
elif git rev-parse --verify origin/${anchorBranch} 2>/dev/null; then
  git checkout -B ${featureBranch} origin/${anchorBranch} 2>&1
else
  DEF=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo main)
  git checkout -B ${featureBranch} origin/$DEF 2>&1 || git checkout -B ${featureBranch} 2>&1
fi
[ -d .git ] && echo GIT_SETUP_COMPLETE || echo GIT_SETUP_FAILED
`.trim();
  try {
    await runGitSetup(workspaceId,cloneScript,`${WORKING_DIR}/${projectDirName}`,featureBranch,[auth.token]);
  } catch (e) {
    return { error: `Couldn't prepare the chat repository: ${(e as Error).message}` };
  }
  return { workspaceId, projectDir: projectDirName };
}

// ── Chat Resume Executor ──────────────────────────────────────────────

/**
 * The context blocks a chat turn needs, shared by the Pi and Claude Code paths:
 * the requirements (acceptance criteria + notes), what was already built, the
 * conversation so far, pending addenda and the project's directives.
 *
 * The conversation block is what makes a chat feel like a chat — it now carries
 * questions the agent asked as well as its answers, so "the blue one" on line 3
 * still means something on line 4.
 */
async function buildChatContext(
  ticket: {
    id: string;
    acceptanceCriteria?: unknown;
    notes?: string | null;
    githubBranch?: string | null;
    githubCommitSha?: string | null;
    epicId?: string | null;
  },
  projectId: string,
  currentMessage: string,
): Promise<string> {
  const ac = ((ticket.acceptanceCriteria as string[] | null) ?? []).filter(Boolean);
  const acBlock = ac.length ? `\n## Acceptance criteria (must all still hold)\n${ac.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n` : "";
  const notesBlock = ticket.notes?.trim() ? `\n## Notes / rules to honor\n${ticket.notes.trim()}\n` : "";
  const built = ticket.githubBranch || ticket.githubCommitSha;
  const statusBlock = built
    ? `\n## Current status of this job\nThis ticket was ALREADY built and its code is in the working tree (branch ${ticket.githubBranch ?? "?"}${ticket.githubCommitSha ? `, last commit ${ticket.githubCommitSha.slice(0, 7)}` : ""}). You are ITERATING on that existing implementation — build on it, don't start over.\n`
    : `\n## Current status of this job\nThis ticket has not been built yet — there is no implementation on the branch.\n`;
  // Conversation so far — questions included, and long enough to actually be one.
  const recent = await db.select({ t: ticketLogs.logType, m: ticketLogs.command })
    .from(ticketLogs)
    .where(and(eq(ticketLogs.ticketId, ticket.id), inArray(ticketLogs.logType, ["user_message", "ai_response", "question"])))
    .orderBy(desc(ticketLogs.createdAt)).limit(20);
  const convo = recent.reverse().filter((r) => (r.m ?? "").trim() && (r.m ?? "").trim() !== currentMessage.trim());
  const speaker = (t: string) => (t === "user_message" ? "User" : t === "question" ? "Agent (asked)" : "Agent");
  const convoBlock = convo.length
    ? `\n## Conversation so far (oldest first)\n${convo.map((r) => `${speaker(r.t)}: ${(r.m ?? "").slice(0, 800)}`).join("\n")}\n`
    : "";
  const dirBlock = await directivesBlock(projectId, (await resolveTicketAnchor(ticket)).anchorBranch, true);
  const addBlock = (await ticketAddendaContext(ticket.id)).block; // pending addenda + history
  const tasks = await db.select({id:projectTodoLists.id,description:projectTodoLists.description,status:projectTodoLists.status})
    .from(projectTodoLists).where(eq(projectTodoLists.ticketId,ticket.id)).orderBy(projectTodoLists.order);
  const taskBlock = `\n## Existing ticket tasks (preserve completed history)\n${JSON.stringify(tasks)}\n`;
  const [saved] = await db.select({ details: projectTickets.details }).from(projectTickets).where(eq(projectTickets.id, ticket.id));
  const journalBlock = workJournalBlock(saved?.details);
  return `${acBlock}${notesBlock}${statusBlock}${journalBlock}${convoBlock}${addBlock}${dirBlock}${taskBlock}`;
}

/**
 * End a chat turn honestly: the agent's declared mode AND the working tree decide
 * what happens. Only a turn that actually changed files commits/pushes/merges and
 * moves the ticket; an answer or a question is just logged (a question as a tagged
 * `question` row, so the UI shows it as ACTION REQUIRED), and any stray edits an
 * answer left behind are preserved without publishing or deleting earlier work.
 */
async function concludeChatTurn(params: {
  actorId?: string;
  ticketId: string;
  ownerId: string;
  project: { id: string; repoOwner: string | null; repoName: string | null; repoUrl: string | null; repoProvider?: string | null; stack?: string | null };
  ticket: { id: string; name: string; githubBranch: string | null; epicId?: string | null };
  workspaceId: string;
  projectPath: string;
  message: string;
  gitUserId: string;
  /** The agent's final message, when this path has it in hand (Pi's summary — the
   *  raw tail is JSONL, so the human text has to be extracted before it gets here). */
  replyText?: string;
  baselineProblem?: string;
}): Promise<void> {
  const { ticketId, ownerId, project, ticket, workspaceId, projectPath, message, gitUserId, replyText } = params;

  const outcome = await resolveTurnOutcome({ ticketId, workspaceId, projectDir: projectPath, replyText });

  if (outcome.mode === "change" && params.baselineProblem) {
    await addLog(ticketId, `Changes were preserved without publication because the ticket baseline is not ready: ${params.baselineProblem}`, "cli_error", ownerId);
    return;
  }

  if (outcome.mode === "change") {
    // Strip the mode markers out of the summary — they're protocol, not prose.
    const summary = outcome.reply.text.slice(0, 1200);
    await finalizeTicketChat(ticketId, ownerId, project, ticket, workspaceId, message, summary, gitUserId, projectPath, params.actorId);
    return;
  }

  if (outcome.preservedEdits) {
    await addLog(ticketId, "Existing working-tree changes were preserved. This answer did not commit or publish them.", "command", ownerId);
  }

  // The streamed output already surfaced the reply (and typed it correctly, question
  // included) — don't post it twice.
  let text = outcome.reply.text.trim();
  if(!text && outcome.repliedInStream) {
    const [reply]=await db.select().from(ticketLogs).where(and(eq(ticketLogs.ticketId,ticketId),inArray(ticketLogs.logType,['ai_response','question']))).orderBy(desc(ticketLogs.createdAt)).limit(1);
    text=reply?.command || reply?.output || '';
  }
  await updateTicketOperation(outcome.mode === 'question' ? 'needs_input' : 'completed', text || (outcome.mode === 'question' ? 'The ticket needs more information; open its question.' : 'Ticket investigation completed; no source changes were needed.'));
  if (outcome.repliedInStream) return;
  if (outcome.mode === "question") {
    await addLog(
      ticketId,
      text || "I need a bit more detail before I change anything — what exactly should I do?",
      "question",
      ownerId,
      { options: outcome.reply.options },
      { explanation: encodeQuestionMeta({ blocking: false, options: outcome.reply.options }) },
    );
    return;
  }
  await addLog(ticketId, text || "Done — no code changes were needed.", "ai_response", ownerId);
}

async function executeTicketChatInternal(
  ticketId: string,
  message: string,
  sender: string,
  actorId?: string, // real userId who sent the chat (sender is a ROLE: "user"/"orchestrator")
): Promise<void> {
  const [ticket] = await db
    .select()
    .from(projectTickets)
    .where(eq(projectTickets.id, ticketId))
    .limit(1);

  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, ticket.projectId))
    .limit(1);

  const ownerId = project!.ownerId;
  const buildLlm = await resolveBuildLlm(project!, actorId ?? ticket.assigneeId ?? ownerId);
  if (currentUsage()) { currentUsage()!.userId = buildLlm.actorId; currentUsage()!.billingMode = buildLlm.mode === "api_key" ? "api" : "subscription"; }

  // Fine-grained Git: the person CHATTING is the actor (fallback: the ticket's assignee).
  // Owner → owner's token; a collaborator → the owner's token only if shareGitAccess is
  // ON, else their own. NOTE: `sender` is a role ("user"/"orchestrator"), not a userId.
  const { gitUserId, usingOwnCollaboratorToken } = resolveGitActor(project!, actorId ?? ticket.assigneeId);

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, ownerId))
    .limit(1);

  // Auto-generate CLI API key if missing (required for callback auth)
  // Disconnect wipes cliApiKey, so re-generate on next chat too
  let cliApiKey = profile?.cliApiKey ?? "";
  if (!cliApiKey) {
    cliApiKey = `lfg_cli_${crypto.randomUUID().replace(/-/g, "")}`;
    await db
      .insert(profiles)
      .values({ userId: ownerId, cliApiKey })
      .onConflictDoUpdate({ target: profiles.userId, set: { cliApiKey, updatedAt: new Date() } });
    console.log(`[ticket-executor] Auto-generated CLI API key for chat user ${ownerId}`);
  }

  // Chat runs in a DEDICATED isolated sandbox (fresh clone of the branch), REUSED
  // across messages but NEVER the shared preview VM — so a chat commit can't sweep
  // the preview's run-enabling config hacks into the branch.
  // SHARED PREVIEW VM (opt-in): chat happens in this ticket's worktree in the preview
  // VM — no VM boot, no re-clone, and the agent can see the branch the preview runs.
  // On the default isolated setting this resolves to null and the chat behaves exactly
  // as before: its own dedicated sandbox with a fresh clone of the branch.
  const chatPlacement = buildLlm.actorId !== ownerId ? { shared: false as const } : await resolveBuildPlacement(ticketId, {
    id: project!.id, ownerId, ticketBuildIsolation: (project as { ticketBuildIsolation?: string }).ticketBuildIsolation,
  });
  let chatLane: { release: () => void } | null = null;
  if (chatPlacement.shared) {
    // Interactive: wait briefly for a slot rather than refusing the user's message,
    // then go ahead anyway — a slower answer beats no answer.
    const d = await acquireLaneWaiting(
      { ticketId, projectId: project!.id, workspaceId: chatPlacement.workspaceId, dir: chatPlacement.dir,
        kind: "chat", credKey: chatPlacement.credKey, exclusiveConfig: chatPlacement.exclusiveConfig },
      90_000,
      (reason) => { void addLog(ticketId, `Waiting for a slot in the preview VM — ${reason}.`, "command", ownerId).catch(() => {}); },
    );
    if (d.ok) chatLane = d;
    else throw new Error("The shared sandbox is busy: " + d.reason);
  }

  try {
  const chatSb = await ensureIsolatedChatSandbox(
    { id: ticket.id, projectId: ticket.projectId, githubBranch: ticket.githubBranch, epicId: ticket.epicId },
    project!, ownerId, gitUserId, usingOwnCollaboratorToken,
    chatPlacement.shared ? chatPlacement.workspaceId : null,
  );
  if ("error" in chatSb) {
    await addLog(ticketId, chatSb.error, "cli_error", ownerId);
    return;
  }
  const workspaceId = chatSb.workspaceId;

  // Resume the CLI session this ticket's chat has been using. This row is written by
  // the /api/v1/cli/output webhook on every turn; the chat used to hardcode null here,
  // so every Claude message started a BLIND fresh session — the agent had no memory of
  // the conversation it was supposedly continuing.
  // Keyed on the TICKET, not just the workspace — in shared mode every ticket's row
  // points at the same preview VM, so a workspace-only lookup would hand this chat
  // another ticket's CLI session.
  const [chatSbRow] = await db
    .select({ cliSessionId: sandboxes.cliSessionId })
    .from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticketId), eq(sandboxes.magsWorkspaceId, workspaceId)))
    .limit(1);
  const sandbox = { magsWorkspaceId: workspaceId, cliSessionId: chatSbRow?.cliSessionId ?? null };
  // New user request → pin the (possibly slept) chat VM awake for the duration.
  await wakeTicketVm(workspaceId);
  // "project" for a dedicated chat sandbox; the ticket's worktree in shared mode.
  const projectDirName = chatSb.projectDir;
  const projectPath = `${WORKING_DIR}/${projectDirName}`;
  let sessionId = sandbox.cliSessionId ?? undefined;

  // An old ticket VM can predate repairs already merged by other tickets. Refresh
  // before implementation so a small follow-up does not rebuild obsolete code.
  const { anchorBranch: followupAnchor } = await resolveTicketAnchor(ticket);
  let baselineProblem = '';
  try {
    const followupAuth = await resolveRepoAuth(project!, gitUserId);
    if (!followupAuth) throw new Error('Repository access is required to refresh the ticket baseline. Existing work is preserved.');
    await addLog(ticketId, `Refreshing ticket from ${followupAnchor}…`, 'command', ownerId);
    const { ticketFollowupBaselineScript } = await import('../services/ticket-followup-baseline.ts');
    const baseline = await execOnWorkspace(workspaceId, ticketFollowupBaselineScript(projectPath, ticket.githubBranch ?? ticketBranchName(ticket), followupAnchor, followupAuth.authUrl), {timeout:120_000});
    if (baseline.exitCode !== 0) {
      const reason = baseline.output.includes('BASELINE_LOCAL_EDITS') ? 'The epic has newer code and this ticket has saved uncommitted edits. Reconcile those edits before starting another repair.'
        : baseline.output.includes('BASELINE_CONFLICT') ? 'The ticket conflicts with the latest epic. Existing work is preserved. Retry integration of the published ticket branch before starting another implementation.'
        : 'Could not fetch the latest epic baseline. Check repository access; existing work is preserved.';
      throw new Error(reason);
    }
    if (baseline.output.includes('BASELINE_UPDATED')) {
      sessionId = undefined; // A resumed agent must not rely on obsolete checkout state.
      await addLog(ticketId, 'Ticket checkout updated to include the latest epic code.', 'command', ownerId);
    }
  } catch (error) {
    // Keep questions and diagnosis available, but never silently publish another
    // implementation based on a checkout we could not synchronize.
    baselineProblem = (error as Error).message;
    sessionId = undefined;
    await addLog(ticketId, `Baseline refresh needs attention: ${baselineProblem} This turn can inspect and answer; publication is paused.`, 'command', ownerId);
  }

  // Shared context for BOTH agent paths (Pi and Claude Code): the requirements, what
  // was already built, and the conversation so far — so a follow-up isn't blind and a
  // question can be answered from what the ticket actually is.
  chatTurnAddenda.set(ticketId, (await ticketAddendaContext(ticketId)).pendingIds);
  const chatContext = (baselineProblem ? `## Current checkout limitation\n${baselineProblem}\nThis turn is read-only: inspect and answer the request, state the concrete synchronization problem if implementation is requested, and preserve all existing edits. Do not implement or publish code on this stale baseline.\n\n` : '') + await buildChatContext(ticket, project!.id, message) + ticketDocumentInstructions(await materializeTicketDocs({
    projectId:project!.id,workspaceId,projectDir:projectPath,epicId:ticket.epicId,sourceDocumentId:ticket.sourceDocumentId,sourceDocumentIds:ticketDocumentIds(ticket.details),
    text:[ticket.name,ticket.description,ticket.notes,message].join('\n'),
  }));

  // ── Route to Pi for non-Claude models (mirror the BUILD path) ───────────
  // The chat used to be hardcoded to Claude Code — a DeepSeek/OpenAI/GLM user
  // got "No valid Claude credentials" even though their ticket built with Pi.
  // Same routing as the builder: a Pi-supported provider with an API key or a
  // short-lived OpenAI Codex subscription bearer → Pi.
  const chatModelKey = buildLlm.model;
  const chatProvider = getProviderName(chatModelKey);
  const chatBuilderAuthMode = buildLlm.mode;
  const [chatUserKeys] = buildLlm.mode === "api_key" ? await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, buildLlm.keyUserId)).limit(1) : [];
  const chatProviderKey = chatProvider
    ? ({
        anthropic: chatUserKeys?.anthropicApiKey,
        openai: chatUserKeys?.openaiApiKey,
        google: chatUserKeys?.googleApiKey,
        kimi: chatUserKeys?.kimiApiKey,
        deepseek: chatUserKeys?.deepseekApiKey,
        glm: chatUserKeys?.glmApiKey,
      } as Record<string, string | null | undefined>)[chatProvider]
    : undefined;
  if (buildLlm.mode === "api_key" && !chatProviderKey) throw new Error("No team API token configured for this model");
  const chatUsesClaudeSubscription = chatProvider === "anthropic"
    && chatBuilderAuthMode === "subscription"
    && !!profile?.claudeCodeAuthenticated
    && !!profile.claudeCodeCredentials;
  const chatAnthropicApiKey = chatProvider === "anthropic" && !chatUsesClaudeSubscription
    ? chatUserKeys?.anthropicApiKey ?? undefined
    : undefined;
  const chatUsesOpenAICodex = chatBuilderAuthMode === "subscription"
    && chatProvider === "openai"
    && await hasOpenAICodexCredentials(buildLlm.actorId);
  const chatOAuthToken = chatUsesOpenAICodex
    ? await getOpenAICodexAccessToken(buildLlm.actorId).catch(async (error) => {
        await addLog(ticketId, `OpenAI Codex session error: ${(error as Error).message}`, "cli_error", ownerId);
        return undefined;
      })
    : undefined;
  if (chatUsesOpenAICodex && !chatOAuthToken && !chatProviderKey) return;
  const chatUsePi = USE_PI_TICKET_BUILDER && !!chatProvider && chatProvider !== "anthropic"
    && isPiSupportedProvider(chatProvider) && !!(chatProviderKey || chatOAuthToken);

  if (chatUsePi && chatProvider && (chatProviderKey || chatOAuthToken)) {
    const piModelId = getProviderModel(chatModelKey) ?? chatModelKey;
    await addLog(ticketId, `Continuing with Pi (${chatProvider}/${piModelId})…`, "command", ownerId);
    const piEnvVars: Record<string, string> = {
      LFG_API_URL: CALLBACK_BASE_URL, LFG_API_KEY: cliApiKey,
      LFG_TICKET_ID: ticket.id, LFG_PROJECT_ID: project!.id,
    };
    // SHARED VM: same toolchain the preview installed on this box, so a chat turn can
    // build/run the app in the worktree instead of hunting for a missing SDK.
    const chatToolchainPaths: string[] = [];
    if (chatPlacement.shared) {
      piEnvVars.DOTNET_ROOT = "/data/.dotnet";
      piEnvVars.DOTNET_CLI_HOME = "/data/.dotnet";
      piEnvVars.NUGET_PACKAGES = "/data/.nuget";
      chatToolchainPaths.push("/data/.dotnet", "/data/.dotnet/tools");
    }
    const piEnvRows = await db
      .select({ key: projectEnvironmentVariables.key, encryptedValue: projectEnvironmentVariables.encryptedValue })
      .from(projectEnvironmentVariables)
      .where(and(eq(projectEnvironmentVariables.projectId, project!.id), eq(projectEnvironmentVariables.hasValue, true)));
    for (const r of piEnvRows) piEnvVars[r.key] = decrypt(r.encryptedValue);
    const piPrompt = `You are the agent on an existing ticket in the repository at /data/${projectDirName}.

## Ticket
${ticket.name}

## Description
${ticket.description ?? ""}
${chatContext}
## New message from the user
${message}

${TICKET_CHAT_MODE_CONTRACT}

${TICKET_FOLLOWUP_TASKS}

${TICKET_FOLLOWUP_SCOPE}
${ENGINEERING_CONTRACT}

## Working rules
- The repo is already cloned and set up at /data/${projectDirName}; explore it and reuse existing patterns.
- Honor the acceptance criteria, notes, and MANDATORY DIRECTIVES above; do NOT regress work already done.
- Do not commit, push or switch branches; the server handles publication and configured validation stages. Exclude secrets and generated files.
- In change mode: keep the change focused, and make sure the project still builds/compiles.${ticketJournalInstruction(ticketId)}`;
    try {
      const webhookReachable = !!cliApiKey && !/localhost|127\.0\.0\.1|\/\/0\.0\.0\.0/.test(CALLBACK_BASE_URL);
      const pi = await startPiCli({
        workspaceId, prompt: piPrompt, projectDir: projectDirName,
        provider: chatProvider, modelId: piModelId,
        // Credential picked from the token we actually HAVE (see the build path).
        apiKey: chatOAuthToken ? undefined : chatProviderKey ?? undefined,
        oauthAccessToken: chatOAuthToken, envVars: piEnvVars,
        ...(chatToolchainPaths.length ? { extraPathDirs: chatToolchainPaths } : {}),
        forward: webhookReachable ? { apiUrl: CALLBACK_BASE_URL, apiKey: cliApiKey, mode: "ticket" as const, ticketId } : undefined,
      });
      // Shared VM: remember the pid so Stop ends THIS chat turn, not the whole box.
      if (chatPlacement.shared) noteLanePid(ticketId, pi.backgroundPid ? parseInt(pi.backgroundPid, 10) : undefined);
      let lastPiLog = 0;
      const piResult = await streamPiToCompletion({
        workspaceId, outputFile: pi.outputFile, backgroundPid: pi.backgroundPid, timeoutMs: BUILD_TIMEOUT_MS,
        ticketId, // webhook output = proof-of-life
        shouldCancel: () => cancelledTickets.has(ticketId),
        onProgress: webhookReachable ? undefined : (msg) => {
          const now = Date.now(); if (now - lastPiLog < 4_000) return; lastPiLog = now;
          void addLog(ticketId, msg, "command", ownerId).catch(() => {});
        },
      });
      if (await stoppedByUser(ticketId, ownerId)) return;
      const piOk = (piResult.exitCode === null || piResult.exitCode === 0) && !piResult.fatalError;
      if (!piOk) {
        const _piDetail = piResult.fatalError ? "" : await lastErrorSnippet(ticketId, piResult.tail);
        const _piBase = piResult.fatalError ?? (piResult.exitCode ? `exit code ${piResult.exitCode}` : "the agent stopped without finishing");
        const reason = _piDetail ? `${_piBase} — ${_piDetail}` : _piBase;
        await addLog(ticketId, `Pi chat failed: ${reason}`, "cli_error", ownerId);
      } else {
        // What KIND of turn was this? `piResult.didWork` can't answer that — it's
        // `toolCalls > 0 || hadSuccess`, true the moment the agent reads a file, so
        // gating the commit on it turned every question into a commit + merge + "✅
        // Update applied". The declared mode plus the actual working tree decide.
        await concludeChatTurn({
          ticketId, ownerId, actorId: buildLlm.actorId, project: project!, ticket, workspaceId, projectPath, message, gitUserId, baselineProblem,
          replyText: piWorkSummary(piResult.tail), // the agent's prose, pulled out of Pi's JSONL
        });
      }
    } catch (err) {
      await addLog(ticketId, `Pi chat error: ${(err as Error).message}`, "cli_error", ownerId);
    }
    return;
  }

  // ── Otherwise: Claude Code path (Anthropic models) ──────────────────────
  // Refresh/inject OAuth only for the selected subscription source. API-token mode
  // exports ANTHROPIC_API_KEY into the Claude CLI process instead.
  if (chatUsesClaudeSubscription) await refreshCredentialsFromAuthSandbox(ownerId);

  await logActivity({
    projectId: project!.id,
    ticketId,
    actorType: "system",
    activityType: ACTIVITY_TYPES.CREDENTIALS_INJECTED,
    title: "Claude credentials injected",
    description: `Loaded credentials from DB and injected into workspace for chat session.`,
    metadata: { workspaceId },
  });

  if (chatUsesClaudeSubscription) {
    // Pre-flight: verify Claude CLI OAuth is working
    console.log(`[ticket-executor] Chat: running pre-flight check on workspace ${workspaceId}`);
    const preflight = await preflightCheck(workspaceId, ownerId);
    if (!preflight.ok) {
      console.error(`[ticket-executor] Chat: pre-flight failed:`, preflight.error);
      const errorMsg = preflight.error ?? "Claude CLI is not connected. Please connect Claude Code in Settings.";
      if (preflight.needsReconnect) await markClaudeDisconnected(ownerId);
      await addLog(ticketId, errorMsg, "cli_error", ownerId);
      return;
    }
    console.log(`[ticket-executor] Chat: pre-flight passed`);
  } else if (!chatAnthropicApiKey) {
    await addLog(ticketId, "No connected Anthropic API token is available for this Coding Agent model.", "cli_error", ownerId);
    return;
  }

  const prompt = buildTicketChatPrompt(
    {
      ticket: { id: ticket.id, ticketKey: ticket.ticketKey, name: ticket.name, description: ticket.description },
      project: { id: project!.id, name: project!.name },
      callbackBaseUrl: CALLBACK_BASE_URL,
      cliApiKey,
    },
    message,
    chatContext, // requirements + build state + the conversation so far
  ) + ticketJournalInstruction(ticketId);

  const envVars: Record<string, string> = {
    LFG_API_URL: CALLBACK_BASE_URL,
    LFG_API_KEY: cliApiKey,
    LFG_TICKET_ID: ticket.id,
    LFG_PROJECT_ID: project!.id,
  };

  // Load project environment variables and merge into envVars
  const chatEnvRows = await db
    .select({ key: projectEnvironmentVariables.key, encryptedValue: projectEnvironmentVariables.encryptedValue })
    .from(projectEnvironmentVariables)
    .where(and(
      eq(projectEnvironmentVariables.projectId, project!.id),
      eq(projectEnvironmentVariables.hasValue, true)
    ));

  for (const row of chatEnvRows) {
    envVars[row.key] = decrypt(row.encryptedValue);
  }

  console.log(`[ticket-executor] Chat: starting CLI for ticket ${ticketId}, workspace ${workspaceId}, session=${sessionId ?? 'none'}`);

  // Use lightweight chat launcher (no user creation, just prompt + launch)
  let chatResult = await startClaudeCliChat({
    workspaceId,
    prompt,
    projectDir: projectDirName,
    sessionId,
    userId: ownerId,
    envVars,
    anthropicApiKey: chatAnthropicApiKey,
  });

  console.log(`[ticket-executor] Chat: CLI started, pid=${chatResult.backgroundPid}, output=${chatResult.outputFile}`);

  // Wait for completion via push-based output streaming
  let waitResult = await waitForCompletion(ticketId, CHAT_MAX_WAIT_DURATION_MS);
  console.log(`[ticket-executor] Chat: wait finished, status=${waitResult.status}, exitCode=${waitResult.exitCode}`);

  // Stop pressed → requestTicketStop unblocks the waiter with a synthetic "failed".
  // Bail BEFORE the stale-session retry below, otherwise a Stop would immediately
  // relaunch the agent in a fresh session instead of ending the turn.
  if (await stoppedByUser(ticketId, ownerId)) return;

  // If session resume failed (exit code != 0), check if agent actually succeeded
  // before retrying — the CLI can exit non-zero even after successful work
  if (waitResult.status === "failed") {
    const [chatTicketCheck] = await db
      .select({ status: projectTickets.status })
      .from(projectTickets)
      .where(eq(projectTickets.id, ticketId))
      .limit(1);
    if (chatTicketCheck?.status === "done") {
      console.log(`[ticket-executor] Chat: CLI exited non-zero but agent reported complete — treating as success`);
      waitResult = { status: "complete", exitCode: waitResult.exitCode };
    }
  }

  // If genuinely failed and we had a session, retry without session (stale session)
  if (waitResult.status === "failed" && sessionId) {
    console.log(`[ticket-executor] Chat: session resume failed, retrying without session`);
    await addLog(ticketId, "Session expired, starting fresh conversation...", "command", ownerId);

    // Clear stale session ID from sandbox
    await db
      .update(sandboxes)
      .set({ cliSessionId: null, updatedAt: new Date() })
      .where(eq(sandboxes.ticketId, ticketId));

    chatResult = await startClaudeCliChat({
      workspaceId,
      prompt,
      projectDir: projectDirName,
      // no sessionId — fresh session
      userId: ownerId,
      envVars,
      anthropicApiKey: chatAnthropicApiKey,
    });

    console.log(`[ticket-executor] Chat: fresh CLI started, pid=${chatResult.backgroundPid}`);
    waitResult = await waitForCompletion(ticketId, CHAT_MAX_WAIT_DURATION_MS);
    console.log(`[ticket-executor] Chat: fresh wait finished, status=${waitResult.status}, exitCode=${waitResult.exitCode}`);
    if (await stoppedByUser(ticketId, ownerId)) return;
  }

  // ── End the turn: commit ONLY a real change ──────────────────────────
  // Same gate as the Pi path — the declared mode plus the working tree. An answer
  // or a question commits nothing and moves no status; a change goes through the
  // shared finalize (commit → push → merge → In Review → "Update applied").
  if (waitResult.status === "complete") {
    await concludeChatTurn({
      ticketId, ownerId, actorId: buildLlm.actorId, project: project!, ticket, workspaceId, projectPath, message, gitUserId, baselineProblem,
    });
  }

  // Save credentials back to DB after chat
  const chatSaved = chatUsesClaudeSubscription && await saveCredentialsFromVm(workspaceId, buildLlm.actorId);
  if (chatSaved) {
    await logActivity({
      projectId: project!.id,
      ticketId,
      actorType: "system",
      activityType: ACTIVITY_TYPES.CREDENTIALS_SAVED,
      title: "Claude credentials saved",
      description: `Credentials from sandbox pushed back to DB after chat session.`,
      metadata: { workspaceId },
    });
  }

  // Chat turn done — save the journal and retire the VM; a later follow-up starts fresh.
  await sleepTicketVm(workspaceId, ticketId, "Follow-up");
  } finally {
    chatTurnAddenda.delete(ticketId);
    chatLane?.release();
  }
}

/**
 * Commit + push + merge the code a CHAT turn produced, then move the ticket to
 * In Review — mirroring the build finalize. Without this, a chat that edits code
 * leaves the work uncommitted in the VM, the ticket status frozen, and nothing on
 * the remote. Best-effort + honest: a push/merge failure is logged, not silent.
 */
async function finalizeTicketChat(
  ticketId: string,
  ownerId: string,
  project: { id: string; repoOwner: string | null; repoName: string | null; repoUrl: string | null; repoProvider?: string | null; stack?: string | null },
  ticket: { id: string; name: string; githubBranch: string | null; epicId?: string | null },
  workspaceId: string,
  message: string,
  workSummary = "",
  gitUserId: string = ownerId, // fine-grained Git: whose token commits/pushes this chat's edits
  // Where the chat's edits actually are: the dedicated sandbox's clone, or — in shared
  // preview-VM mode — this ticket's worktree. Committing from the wrong directory would
  // push the WRONG tree (or nothing at all).
  projectDir: string = `${WORKING_DIR}/project`,
  actorId: string = ownerId,
): Promise<void> {
  const featureBranch = ticket.githubBranch ?? ticketBranchName(ticket);
  const { anchorBranch, baseBranch: anchorBase } = await resolveTicketAnchor(ticket);
  const auth = await resolveRepoAuth(project, gitUserId);
  if (!auth) {
    await addLog(ticketId, "Changes made, but no git remote/token is configured — they stay in the sandbox. Connect the repo to persist chat edits.", "cli_error", ownerId);
    return;
  }
  // Commit summary from the user's instruction (first line, trimmed).
  const summary = (message.split("\n")[0] || "update").trim().slice(0, 72);
  let publishedSha = '';
  let integrated = false;
  try {
    await addLog(ticketId, "Committing chat changes…", "command", ownerId);
    const { sha, documentation } = await commitAndPush({
      validation: { gitCredentialUserId: gitUserId, projectId: project.id, userId: actorId, ticketId: ticketId, epicId: ticket.epicId ?? undefined, baselineBranch: anchorBase, cancelled: () => cancelledTickets.has(ticketId) || checksSkipped(ticketId), skipped: () => checksSkipped(ticketId), onLog: line => { addLog(ticketId, line, checkLogType(line), ownerId).catch(() => {}); }, onCheckpoint: async message => { await addLog(ticketId, message, "agent_progress", ownerId); } },
      workspaceId, projectDir,
      commitMessage: `chore: ${summary}`,
      featureBranch,
      repoUrl: auth.repoUrl, githubToken: auth.token, tokenUser: auth.tokenUser,
    });
    publishedSha = sha;
    await db.update(projectTickets).set({ githubBranch: featureBranch, githubCommitSha: sha, githubMergeStatus: "pushed", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
    await addLog(ticketId, `Committed + pushed ${sha.slice(0, 7)} to ${featureBranch}.`, "command", ownerId);

    let mergedOk = false;
    try {
      await addLog(ticketId, `Merging to ${anchorBranch}…`, "command", ownerId);
      const { sha: mergeSha } = await mergeToAnchor({
      validation: { gitCredentialUserId: gitUserId, projectId: project.id, userId: actorId, ticketId: ticketId, epicId: ticket.epicId ?? undefined, baselineBranch: anchorBase, cancelled: () => cancelledTickets.has(ticketId) || checksSkipped(ticketId), skipped: () => checksSkipped(ticketId), onLog: line => { addLog(ticketId, line, checkLogType(line), ownerId).catch(() => {}); }, onCheckpoint: async message => { await addLog(ticketId, message, "agent_progress", ownerId); } },
        workspaceId, projectDir, featureBranch,
        repoUrl: auth.repoUrl, githubToken: auth.token, tokenUser: auth.tokenUser,
        targetBranch: anchorBranch, baseBranch: anchorBase,
      });
      integrated = true;
      mergedOk = true;
      await db.update(projectTickets).set({ githubMergeStatus: "merged", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
      await addLog(ticketId, `Merged to ${anchorBranch} (${mergeSha.slice(0, 7)}).`, "command", ownerId);
    } catch (mergeErr) {
      await addLog(ticketId, `Pushed, but merge to ${anchorBranch} failed: ${(mergeErr as Error).message?.slice(0, 200)}`, "cli_error", ownerId);
    }

    if (!mergedOk) throw new Error("Integration validation failed; chat changes are not ready for review.");

    // Move to In Review + broadcast so the status banner/kanban update live and
    // survive a refresh (the durable ticket row now reflects the outcome).
    const reviewStageId = await moveTicketToStage(ticketId, project.id, "In Review");
    await db.update(projectTickets).set({ status: "review", queueStatus: "none", lastExecutionAt: new Date(), updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
    // Clear agent-style summary so the chat ends with an explicit "what I did".
    const done = `✅ **Update applied.**\n\n` +
      (shortSummary(workSummary) ? `**What got done:** ${shortSummary(workSummary)}\n\n` : "") +
      (documentation ? documentation.message + "\n\n" : "") +
      `- Branch: \`${featureBranch}\`\n- Commit: \`${sha.slice(0, 7)}\`\n${mergedOk ? `- Merged to \`${anchorBranch}\` ✓\n` : ""}\nRe-run the **Preview** to see the change, or open the **Git** tab for the diff.`;
    await addLog(ticketId, done, "ai_response", ownerId);
    await publishTicketOperation(featureBranch, anchorBranch, sha, done, workSummary);
    // The change requests this turn was given are now published: stop carrying them.
    await resolveTicketAddenda(ticketId, chatTurnAddenda.get(ticketId) ?? []);
    // A published follow-up does not prove every historical or verification task
    // succeeded. Preserve the individual task outcomes reported by the agent.
    await maybeSubmitEpicForReview(ticket.epicId);
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "review", queueStatus: "none", stageId: reviewStageId, mergeStatus: mergedOk ? "merged" : "pushed" });
    // Configured feature testing/recording already ran during publication. Do not
    // start a second background recorder or bypass disabled project stages.
    // QA (opt-in, projects.qaMode = "tests"): write a test suite for the ticket's
    // acceptance criteria and verify it red/green against the branch point, in the
    // sandbox that just built it. Fire-and-forget like the demo — it never throws,
    // never fails the ticket, and reports into the ticket's log.
    void runTicketQa(ticketId, { ownerId, llmUserId: actorId, projectId: project.id });
  } catch (err) {
    const state = integrated ? `Changes were pushed and merged into ${anchorBranch}, but final bookkeeping failed`
      : publishedSha ? `Changes are saved on ${featureBranch} (${publishedSha.slice(0,7)}); integration into ${anchorBranch} did not complete`
      : 'Publication did not complete; inspect the saved checkout and remote branch before retrying';
    const reason = `${state}: ${(err as Error).message?.slice(0, 300)}`;
    await addLog(ticketId, reason, "cli_error", ownerId);
    if (!integrated) await markTicketFailed(ticketId, reason, ownerId, {emitEvent:false});
  }
}

// ── API-Based Executor ────────────────────────────────────────────────

/**
 * Check if the project owner has API mode enabled (claudeCodeEnabled = false).
 * claudeCodeEnabled = true means CLI mode (default); false = API mode.
 */
async function isApiMode(projectId: string | null): Promise<boolean> {
  if (!projectId) return false;
  const [project] = await db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return false;

  const [appState] = await db.select().from(applicationState).where(eq(applicationState.userId, project.ownerId)).limit(1);
  // claudeCodeEnabled = true means CLI mode; false/missing = API mode
  return appState ? !appState.claudeCodeEnabled : true;
}

/** Provider of the owner's selected builder model (used to route CLI mode:
 *  Claude → Claude Code CLI; anything else → Pi). */
async function getBuilderProvider(projectId: string | null, actorId?: string): Promise<ProviderName | null> {
  if (!projectId) return null;
  const [project] = await db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;
  return getProviderName((await resolveBuildLlm({ id: projectId, ownerId: project.ownerId }, actorId ?? project.ownerId)).model);
}

/** Execute with direct provider tools, or with Pi when Coding Agent mode is requested. */
async function executeTicketApiInternal(
  ticketId: string,
  useCodingAgent: boolean,
  actorId?: string,
  // Resolved by the dispatcher when the project shares the preview VM, so we don't
  // probe it twice. Absent → the isolated path, exactly as before.
  placement?: BuildPlacement,
): Promise<void> {
  const startTime = Date.now();

  // ── Load data (shared with CLI mode) ────────────────────────────────
  console.log(`[ticket-executor-api] Loading data for ticket ${ticketId}`);
  const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  const [project] = await db.select().from(projects).where(eq(projects.id, ticket.projectId)).limit(1);
  if (!project) throw new Error(`Project ${ticket.projectId} not found`);

  const ownerId = project.ownerId;
  const buildLlm = await resolveBuildLlm(project!, actorId ?? ticket.assigneeId ?? ownerId);
  if (currentUsage()) { currentUsage()!.userId = buildLlm.actorId; currentUsage()!.billingMode = buildLlm.mode === "api_key" ? "api" : "subscription"; }

  // Fine-grained Git: owner → owner's token; a collaborator → owner's token only if
  // shareGitAccess is ON, else their OWN connected Git. Actor = trigger (fallback: assignee).
  const { gitUserId, usingOwnCollaboratorToken } = resolveGitActor(project, actorId ?? ticket.assigneeId);
  const [ghToken] = await db.select().from(githubTokens).where(eq(githubTokens.userId, gitUserId)).limit(1);
  const githubToken = ghToken?.accessToken;

  if (!githubToken) {
    console.warn(`[ticket-executor-api] No GitHub token for user ${gitUserId}`);
    await addLog(ticketId, usingOwnCollaboratorToken ? NO_SHARED_GIT_MESSAGE : "No GitHub token — code will NOT be saved to a repository.", "command", ownerId);
  }

  // Seed subtasks up-front (idempotent) so the Tasks tab is populated the moment
  // the build starts — this is the Pi/DeepSeek/Kimi path, the common one.
  await seedTasksIfEmpty(ticket, ownerId);
  await markBuildTasksStarted(ticketId);

  const tasks = await db.select().from(projectTodoLists).where(eq(projectTodoLists.ticketId, ticketId));

  // Mark ticket as executing
  await moveTicketToStage(ticketId, project.id, "In Progress");
  await db.update(projectTickets).set({ status: "in_progress", queueStatus: "executing", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
  broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "in_progress", queueStatus: "executing" }); // build started → turn the indicator on

  let projectDirName = "project";
  const featureBranch = ticket.githubBranch ?? ticketBranchName(ticket);
  // The epic's branch: what this ticket is cut from and merged back into, so the
  // cascade stops at the delivery unit's edge instead of at `lfg-agent`.
  const { anchorBranch, baseBranch: anchorBase } = await resolveTicketAnchor(ticket);
  await markEpicBuilding(ticket.epicId);

  // ── Reuse the project's always-on PREVIEW sandbox via a git WORKTREE ──
  // If the project has a running preview env (env-<projectId> with the repo at
  // /data/project), run this ticket in a worktree there — same env + cached
  // toolchain, on its own branch — instead of a fresh VM + full clone. Only
  // when that sandbox exists; otherwise fall back to the fresh-VM path.
  // Build isolation: "isolated" (default) → a FRESH throwaway pi VM per ticket
  // (build → commit → push → destroy), so a bad build can never disrupt the
  // always-on preview VM (which reconstructs the branch worktree from the remote
  // on demand). "shared" → reuse the preview VM via a git worktree (warm caches).
  const isolatedBuild = buildLlm.actorId !== ownerId || ((project as { ticketBuildIsolation?: string }).ticketBuildIsolation ?? "isolated") !== SHARED_MODE;
  const sharedWorkspaceId = isolatedBuild
    ? null
    : (placement?.shared ? placement.workspaceId : await resolvePreviewSandbox(project.id));
  const useWorktree = !!sharedWorkspaceId;
  if (useWorktree) {
    projectDirName = ticketWorktreeDirName(ticketId);
    const others = activeLanes(sharedWorkspaceId!).filter((l) => l.ticketId !== ticketId).length;
    await addLog(ticketId,
      `Building in the project's preview VM (git worktree ${projectDirName})` +
      `${others ? ` — ${others} other ticket${others === 1 ? " is" : "s are"} also working in it` : ""}.`,
      "command", ownerId);
  } else if (isolatedBuild) {
    await addLog(ticketId, `Isolated build: spinning up a fresh sandbox for this ticket (it's destroyed after the branch is pushed).`, "command", ownerId);
  }

  // ── Resolve builder model early (needed to choose the VM rootfs) ─────
  // Follows the user's chat selection (e.g. DeepSeek) when no explicit builder
  // model is set — NOT a hardcoded Claude.
  const modelKey = buildLlm.model;
  const [userKeys] = buildLlm.mode === "api_key" ? await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, buildLlm.keyUserId)).limit(1) : [];
  if (buildLlm.mode === "subscription") useCodingAgent = true;
  const provider = getProviderName(modelKey);

  // "Default app-stack": for a brand-new project (no linked repo) built by a
  // non-Anthropic (Pi) model, boot the pre-scaffolded boilerplate rootfs so the
  // Next.js app is already present and the agent implements the ticket instead
  // of running create-next-app from scratch (which weak agents loop on). Existing
  // repos clone on the plain rootfs; Anthropic builds keep the claude rootfs.
  const BOILERPLATE_ROOTFS = process.env.INSTANT_BOILERPLATE_ROOTFS || "lfg-instant-boiler";
  const isEmptyProject = !project.repoOwner && !project.repoName && !extractRepoUrl(project.stack ?? "");
  const useBoilerplate = isEmptyProject && !!githubToken && !!provider && provider !== "anthropic";
  let prescaffolded = false;

  // ── Setup workspace ─────────────────────────────────────────────────
  // SAME TICKET → SAME SANDBOX. Reuse the ticket's ONE dedicated VM — its build
  // "ticket" VM or a prior "ticket-chat" VM (chat and build share it now) — and delete
  // any redundant duplicates so a ticket never accumulates more than one. A "pv-…" /
  // worktree row is the SHARED preview VM and must NEVER be reused for an isolated
  // build (we'd build inside it, then try to destroy it).
  console.log(`[ticket-executor-api] Setting up workspace`);
  let sandboxRow = await findExistingSandbox(ticketId);
  if (isolatedBuild) {
    const rows = await db.select().from(sandboxes)
      .where(and(eq(sandboxes.ticketId, ticketId), inArray(sandboxes.workspaceType, ["ticket", "ticket-chat"])))
      .orderBy(desc(sandboxes.updatedAt));
    const dedicated = rows.filter((r) => r.magsWorkspaceId && !r.magsWorkspaceId.startsWith("pv-"));
    sandboxRow = dedicated[0] ?? null;
    // Converge on ONE: destroy + drop every OTHER dedicated VM, plus any shared-preview/
    // worktree rows for this ticket (their branch work is already on the remote).
    for (const r of rows) {
      if (sandboxRow && r.id === sandboxRow.id) continue;
      if (r.magsWorkspaceId && !r.magsWorkspaceId.startsWith("pv-")) await deleteWorkspace(r.magsWorkspaceId).catch(() => {});
      await db.delete(sandboxes).where(eq(sandboxes.id, r.id)).catch(() => {});
    }
    // Canonicalize a reused chat VM to the build type so it's the single "ticket" row.
    if (sandboxRow && sandboxRow.workspaceType !== "ticket") {
      await db.update(sandboxes).set({ workspaceType: "ticket", updatedAt: new Date() }).where(eq(sandboxes.id, sandboxRow.id)).catch(() => {});
      sandboxRow = { ...sandboxRow, workspaceType: "ticket" };
    }
  }
  let workspaceId = sandboxRow?.magsWorkspaceId ?? null;

  // Worktree path: use the shared preview sandbox directly (don't create a VM).
  if (useWorktree) {
    workspaceId = sharedWorkspaceId!;
    if (!sandboxRow) {
      const created = await db.insert(sandboxes).values({
        projectId: ticket.projectId, userId: ownerId, ticketId,
        magsWorkspaceId: workspaceId, workspaceType: "ticket-worktree", status: "ready",
      }).returning();
      sandboxRow = (created[0] as any) ?? null;
    }
  }

  let preserveCheckout = false;
  if (isolatedBuild && !useWorktree && ticket.githubBranch && (sandboxRow || ticket.githubCommitSha)) {
    const recovered = await openTicketWorkspace({project,ticket,actorId:gitUserId,canRestore:true,continuation:true,
      progress:message=>{void addLog(ticketId,message,'command',ownerId);}});
    workspaceId = recovered.workspaceId;
    sandboxRow = await latestTicketWorkspace(project.id,ticketId) ?? null;
    preserveCheckout = true;
  }

  if (!useWorktree && workspaceId && !preserveCheckout) {
    await addLog(ticketId, "Reconnecting to existing workspace...", "command", ownerId);
    try {
      const probe = await execOnWorkspace(workspaceId, 'echo "WORKSPACE_READY"', { timeout: 60_000 });
      if (!probe.output.includes("WORKSPACE_READY")) {
        if (sandboxRow) await db.delete(sandboxes).where(eq(sandboxes.id, sandboxRow.id));
        sandboxRow = null;
        workspaceId = null;
      }
    } catch {
      if (sandboxRow) await db.delete(sandboxes).where(eq(sandboxes.id, sandboxRow.id));
      sandboxRow = null;
      workspaceId = null;
    }
  }

  if (!workspaceId) {
    const workspaceName = `${ticketId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    await addLog(ticketId, useBoilerplate ? "Creating VM workspace (app-stack)..." : "Creating VM workspace...", "command", ownerId);
    // Pi builds need memGb set both to avoid OOM-killing Pi + Next, AND because
    // mags only routes a custom rootfs (the boilerplate) via env when memGb is set.
    // Use newWorkspaceV2 (the SAME call the preview uses) so rootfs_type is a
    // top-level v2 field — proven to boot the "pi" rootfs (pi-agent-vm, node 22 + Pi
    // preinstalled). The older newWorkspace routes rootfs via the __MAGS_ROOTFS_TYPE
    // env passthrough, which was silently landing on the DEFAULT rootfs (mags-vm,
    // node 20.15.1) → Pi exit 127.
    const { jobId, workspaceId: wsId, cloneIntentId } = await createTicketSandbox({ projectId: project.id, ticketId, userId: ownerId,
      log: message => addLog(ticketId, message, "command", ownerId),
      fresh: () => newWorkspaceV2(workspaceName, {
      vcpus: 4,
      memoryMb: parseInt(process.env.INSTANT_MEM_GB || "4", 10) * 1024,
      diskGb: parseInt(process.env.INSTANT_DISK_GB || "8", 10),
      keepAlive: true, // no_sleep while building (toggled off at build end)
      noSync: true,    // ticket sandbox — no S3 mirror
      // Empty projects → the pre-scaffolded boilerplate rootfs; everything else →
      // the "pi" rootfs (node 22 + Pi preinstalled), same base as the preview VM.
      rootfsType: useBoilerplate ? BOILERPLATE_ROOTFS : (process.env.PREVIEW_ROOTFS || "pi"),
      }),
    });
    workspaceId = wsId;
    if (!cloneIntentId) await sleep(8_000);

    const created = await db.insert(sandboxes).values({
      projectId: ticket.projectId,
      userId: ownerId,
      ticketId,
      magsWorkspaceId: wsId,
      magsJobId: jobId,
      workspaceType: "ticket",
      status: "ready",
    }).returning();
    sandboxRow = (created[0] as any) ?? null;
    if (cloneIntentId) await db.delete(sandboxes).where(eq(sandboxes.id,cloneIntentId));
  }

  if (!sandboxRow || !workspaceId) throw new Error("Failed to create or find sandbox");

  emit({ type: "ticket.execution_started", ticketId, sandboxId: sandboxRow.id, projectId: project.id });

  // Ensure TLS certs + git before any HTTPS git op (clone or push).
  await ensureVmCerts(workspaceId);

  // For a brand-new/empty project, scaffold the app-stack DETERMINISTICALLY
  // (server-side) before Pi runs — exactly like instant. The agent is then told
  // the scaffold is done, so it never runs create-next-app (the loop source).
  if (isEmptyProject) {
    prescaffolded = await ensureProjectScaffold(
      workspaceId,
      `${WORKING_DIR}/${projectDirName}`,
      ticketId,
      ownerId
    );
  }

  // ── Git setup (same as CLI mode) — provider-aware (GitHub OR GitLab) ─
  console.log(`[ticket-executor-api] Setting up git`);
  const auth = await resolveRepoAuth(project, gitUserId);
  let githubOwner: string | null = auth?.owner ?? project.repoOwner ?? null;
  let githubRepo: string | null = auth?.repo ?? project.repoName ?? null;
  const repoUrl = auth?.repoUrl ?? project.repoUrl ?? extractRepoUrl(project.stack ?? "");
  // The credential used for the commit/push phase — provider-correct.
  let pushAuth: { repoUrl: string; token: string; tokenUser: string } | null =
    auth ? { repoUrl: auth.repoUrl, token: auth.token, tokenUser: auth.tokenUser } : null;

  if (auth) {
    await addLog(ticketId, `Setting up repo: ${auth.owner}/${auth.repo} (${auth.provider})`, "command", ownerId);

    // Worktree path: the repo is already cloned in the shared preview sandbox at
    // /data/project. Add a git worktree for this ticket's branch (own working
    // dir, shared .git) so it never disturbs the running preview. In a worktree
    // `.git` is a FILE, not a dir — so the readiness check accepts either.
    const worktreeScript = `
cd ${WORKING_DIR}/project || { echo "GIT_SETUP_FAILED_NO_GIT"; exit 1; }
git config user.email "ai@lfg.dev"; git config user.name "LFG AI"
git remote set-url origin "${auth.authUrl}" 2>/dev/null || git remote add origin "${auth.authUrl}" 2>/dev/null || true
git fetch --prune origin 2>&1 || true
${emptyRepoBootstrap(anchorBase)}
if ! git rev-parse --verify origin/${anchorBranch} 2>/dev/null; then
    echo "CREATING_ANCHOR_BRANCH"
    ANCHOR_BASE="${anchorBase}"
    git rev-parse --verify origin/$ANCHOR_BASE 2>/dev/null || ANCHOR_BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
    git branch ${anchorBranch} origin/$ANCHOR_BASE 2>/dev/null || git branch ${anchorBranch} 2>/dev/null || true
    git push -u origin ${anchorBranch} 2>&1 || true
fi
# REUSE an existing worktree instead of deleting it. Two reasons: this directory is
# the SAME one the preview serves the branch from, so an rm -rf pulls the files out
# from under a running app; and keeping it preserves node_modules/obj between builds,
# which is most of the speed-up the shared VM is for. git clean -fd (no -x) drops
# stray tracked-tree files but leaves gitignored build output alone.
if [ -e "${WORKING_DIR}/${projectDirName}/.git" ]; then
    echo "WORKTREE_REUSED"
    cd ${WORKING_DIR}/${projectDirName} || { echo "GIT_SETUP_FAILED_NO_GIT"; exit 1; }
    if git rev-parse --verify origin/${featureBranch} 2>/dev/null; then
        git checkout -B ${featureBranch} origin/${featureBranch} 2>&1
        git reset --hard origin/${featureBranch} 2>&1 | tail -1
    else
        git checkout -B ${featureBranch} origin/${anchorBranch} 2>&1 || git checkout -B ${featureBranch} ${anchorBranch} 2>&1
    fi
    git clean -fd 2>/dev/null || true
    cd ${WORKING_DIR}/project || true
else
    git worktree remove --force ${WORKING_DIR}/${projectDirName} 2>/dev/null || true
    rm -rf ${WORKING_DIR}/${projectDirName} 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    if git rev-parse --verify origin/${featureBranch} 2>/dev/null; then
        git worktree add --force -B ${featureBranch} ${WORKING_DIR}/${projectDirName} origin/${featureBranch} 2>&1
    else
        git worktree add --force -B ${featureBranch} ${WORKING_DIR}/${projectDirName} origin/${anchorBranch} 2>&1 || git worktree add --force -B ${featureBranch} ${WORKING_DIR}/${projectDirName} ${anchorBranch} 2>&1
    fi
fi
cd ${WORKING_DIR}/${projectDirName} 2>/dev/null || { echo "GIT_SETUP_FAILED_NO_GIT"; exit 1; }
git config user.email "ai@lfg.dev"; git config user.name "LFG AI"
if [ -e ".git" ]; then echo "GIT_SETUP_COMPLETE"; else echo "GIT_SETUP_FAILED_NO_GIT"; fi
pwd
git branch --show-current
`.trim();

    const cloneScript = `
cd ${WORKING_DIR}

if [ -d "${projectDirName}/.git" ]; then
    echo "REPO_EXISTS"
    cd ${projectDirName}
    ${refreshOriginCommand(auth.authUrl)}
    git fetch --prune origin
    # Keep cloned local configuration and caches; branch setup below selects source.
elif [ -d "${projectDirName}" ] && [ "$(ls -A ${projectDirName} 2>/dev/null)" ]; then
    echo "INIT_EXISTING_DIR"
    cd ${projectDirName}
    git init
    git remote add origin "${auth.authUrl}" 2>/dev/null || \\
        git remote set-url origin "${auth.authUrl}"
    git fetch --prune origin
else
    echo "CLONING_REPO"
    rm -rf ${projectDirName}
    git clone "${auth.authUrl}" ${projectDirName} 2>&1
    # A failed clone (TLS/network/auth) leaves no dir — do NOT fall through and run
    # git ops in the parent (WORKING_DIR); fail loudly so the caller aborts.
    cd ${projectDirName} 2>/dev/null || { echo "GIT_CLONE_FAILED"; exit 1; }
    [ -d ".git" ] || { echo "GIT_CLONE_FAILED"; exit 1; }
fi

${emptyRepoBootstrap(anchorBase)}
if ! git rev-parse --verify origin/${anchorBranch} 2>/dev/null; then
    echo "CREATING_ANCHOR_BRANCH"
    ANCHOR_BASE="${anchorBase}"
    git rev-parse --verify origin/$ANCHOR_BASE 2>/dev/null || ANCHOR_BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
    git checkout "$ANCHOR_BASE" 2>/dev/null || git checkout main 2>/dev/null || true
    git checkout -b ${anchorBranch}
    git push -u origin ${anchorBranch} 2>&1
fi

if git rev-parse --verify origin/${featureBranch} 2>/dev/null; then
    echo "FEATURE_BRANCH_EXISTS_REMOTE"
    git checkout ${featureBranch} 2>/dev/null || git checkout -b ${featureBranch} origin/${featureBranch}
    git reset --hard origin/${featureBranch}
elif git rev-parse --verify ${featureBranch} 2>/dev/null; then
    echo "FEATURE_BRANCH_EXISTS_LOCAL"
    git checkout ${featureBranch}
else
    echo "CREATING_FEATURE_BRANCH"
    # A cloned preview disk carries the preview's local edits (config patches, build
    # output), so a plain checkout of the anchor fails and used to fall through silently,
    # cutting the ticket from whatever the disk had checked out (often main). Force the
    # new branch onto the anchor; untracked/ignored files (.env, node_modules) are kept.
    ANCHOR_REF=origin/${anchorBranch}
    git rev-parse --verify "$ANCHOR_REF" >/dev/null 2>&1 || ANCHOR_REF=${anchorBranch}
    git checkout -f -B ${featureBranch} "$ANCHOR_REF" 2>&1 || { echo "FEATURE_BASE_FAILED"; exit 1; }
    # A new ticket must start from its epic's code, or the agent builds on the wrong app.
    [ "$(git rev-parse HEAD)" = "$(git rev-parse "$ANCHOR_REF")" ] || { echo "FEATURE_BASE_FAILED: ${featureBranch} is not on ${anchorBranch}"; exit 1; }
fi

git config user.email "ai@lfg.dev"
git config user.name "LFG AI"

# Verify we actually have a repo — a failed clone (TLS/network) leaves no .git,
# and without this the script would report success against an empty dir.
if [ -d ".git" ]; then echo "GIT_SETUP_COMPLETE"; else echo "GIT_SETUP_FAILED_NO_GIT"; fi
pwd
git branch --show-current
`.trim();

    const gitSetupScript = preserveCheckout
      ? `set -eu\ncd ${WORKING_DIR}/${projectDirName}\n${refreshOriginCommand(auth.authUrl)}\ngit fetch origin\necho GIT_SETUP_COMPLETE`
      : useWorktree ? worktreeScript : cloneScript;

    try {
      const gitResult = await recoverSandboxStorage({
        run: () => runGitSetup(workspaceId!, preserveCheckout ? gitSetupScript : (useWorktree ? worktreeScript : cloneScript), `${WORKING_DIR}/${projectDirName}`, featureBranch, [auth.token]),
        onLog: async message => { await addLog(ticketId,message,"command",ownerId); },
        discard: async () => {
          // A ticket must never destroy a shared preview or another ticket's VM.
          const id = workspaceId!;
          const references = await db.select().from(sandboxes).where(eq(sandboxes.magsWorkspaceId,id));
          const previews = await db.select({id:projectEnvironments.id}).from(projectEnvironments).where(eq(projectEnvironments.workspaceId,id));
          if (!isolatedBuild || useWorktree || id.startsWith("pv-") || previews.length || !references.length ||
              references.some(r=>r.ticketId!==ticketId || !["ticket","ticket-chat"].includes(r.workspaceType))) {
            throw new Error("Storage failure in a shared or unowned sandbox; automatic destruction is blocked to protect other workloads.");
          }
          await addLog(ticketId,`Destroying failed isolated sandbox ${id}; the remote Git branch will be restored.`,"command",ownerId);
          await addLog(ticketId, "Stopping the failed sandbox job before deleting its storage…", "command", ownerId);
          await destroyWorkspaceAfterStop({
            stop: () => stopWorkspace(sandboxRow?.magsJobId || id),
            remove: () => deleteWorkspace(id),
          });
          await db.delete(sandboxes).where(and(eq(sandboxes.ticketId,ticketId),eq(sandboxes.magsWorkspaceId,id)));
          sandboxRow = null;
          workspaceId = null;
          preserveCheckout = false;
        },
        create: async () => {
          const fresh = await newWorkspaceV2(`${ticketId.slice(0,8)}-${crypto.randomUUID().slice(0,8)}`, {
            vcpus:4, memoryMb:parseInt(process.env.INSTANT_MEM_GB || "4",10)*1024,
            diskGb:parseInt(process.env.INSTANT_DISK_GB || "8",10), keepAlive:true, noSync:true,
            rootfsType:useBoilerplate ? BOILERPLATE_ROOTFS : (process.env.PREVIEW_ROOTFS || "pi"),
          });
          workspaceId = fresh.workspaceId;
          const created = await db.insert(sandboxes).values({projectId:ticket.projectId,userId:ownerId,ticketId,
            magsWorkspaceId:fresh.workspaceId,magsJobId:fresh.jobId,workspaceType:"ticket",status:"ready"}).returning();
          sandboxRow = created[0] ?? null;
          await sleep(8_000);
          await ensureVmCerts(fresh.workspaceId);
          if (!sandboxRow) throw new Error("Failed to register replacement sandbox");
          emit({type:"ticket.execution_started",ticketId,sandboxId:sandboxRow.id,projectId:project.id});
        },
      });

      if (gitResult.output.includes("GIT_SETUP_COMPLETE")) {
        if (!ticket.githubBranch) {
          await db.update(projectTickets).set({ githubBranch: featureBranch, githubMergeStatus: "pending", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
        }
      } else {
        // Clone/setup failed — do NOT run the agent against an empty dir (that's
        // the "round and round" flailing). Fail the ticket with a clear reason.
        throw new Error(
          gitResult.output.includes("GIT_CLONE_FAILED") || gitResult.output.includes("GIT_SETUP_FAILED_NO_GIT")
            ? `repository clone failed (network/TLS/auth) — no code in the build VM for ${githubOwner}/${githubRepo}`
            : `git setup did not complete: ${gitResult.output.slice(0, 200)}`
        );
      }
    } catch (err) {
      console.error(`[ticket-executor-api] Git setup failed:`, err);
      await markTicketFailed(ticketId, `Git setup failed — ${(err as Error).message}`, ownerId);
      return;
    }
  } else if (githubToken) {
    // Auto-create repo
    const repoName = project.providedName || project.name;
    await addLog(ticketId, `Creating GitHub repository: ${repoName}...`, "command", ownerId);
    try {
      const repoResult = await createGitHubRepo({ repoName, description: `LFG Project: ${project.name}`, isPrivate: true, githubToken });
      githubOwner = repoResult.owner;
      githubRepo = repoResult.repoName;
      pushAuth = { repoUrl: `https://github.com/${repoResult.owner}/${repoResult.repoName}.git`, token: githubToken, tokenUser: "x-access-token" };

      await db.update(projects).set({ repoUrl: repoResult.repoUrl, repoOwner: repoResult.owner, repoName: repoResult.repoName, updatedAt: new Date() }).where(eq(projects.id, project.id));

      await execOnWorkspace(workspaceId, `mkdir -p "${WORKING_DIR}/${projectDirName}"`, { timeout: 15_000 });
      await initAndPushRepo({ workspaceId, projectDir: `${WORKING_DIR}/${projectDirName}`, repoUrl: repoResult.repoUrl, branch: "main", githubToken });

      // Fresh repo: step back to main, cut the anchor (epic) branch, then the
      // feature branch off it — an epic must start from approved code.
      const branchScript = `cd "${WORKING_DIR}/${projectDirName}" && git checkout main 2>/dev/null || true && { git checkout ${anchorBranch} 2>/dev/null || { git checkout -b ${anchorBranch} && git push -u origin ${anchorBranch} 2>&1; }; } && git checkout -b ${featureBranch} && echo "BRANCH_CREATED"`;
      const branchB64 = Buffer.from(branchScript).toString("base64");
      await execOnWorkspace(workspaceId, `echo ${branchB64} | base64 -d | sh`, { timeout: 30_000 });

      await db.update(projectTickets).set({ githubBranch: featureBranch, githubMergeStatus: "pending", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
    } catch (err) {
      console.error(`[ticket-executor-api] Auto-create repo failed:`, err);
      githubOwner = null;
      githubRepo = null;
      await execOnWorkspace(workspaceId, `mkdir -p "${WORKING_DIR}/${projectDirName}"`, { timeout: 15_000 });
    }
  } else {
    await execOnWorkspace(workspaceId, `mkdir -p "${WORKING_DIR}/${projectDirName}"`, { timeout: 15_000 });
  }

  // ── Inject env vars into VM ─────────────────────────────────────────
  const projectEnvRows = await db
    .select({ key: projectEnvironmentVariables.key, encryptedValue: projectEnvironmentVariables.encryptedValue, description: projectEnvironmentVariables.description })
    .from(projectEnvironmentVariables)
    .where(and(eq(projectEnvironmentVariables.projectId, project.id), eq(projectEnvironmentVariables.hasValue, true)));

  // NEVER inject machine-specific vars into the VM's shells. PATH especially: a
  // previous run may have PERSISTED a PATH like "/data/.dotnet:…" (via the preview
  // driver's setEnv). In THIS fresh VM those dirs don't exist, so exporting it into
  // /etc/profile.d clobbers every shell's PATH → `ls`/`node`/`apk` "not found" →
  // Pi dies with exit 127. Filter these out.
  const UNSAFE_ENV_KEYS = new Set(["PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "TERM", "HOSTNAME", "SHLVL", "_", "LD_LIBRARY_PATH", "LD_PRELOAD"]);
  const safeEnvRows = projectEnvRows.filter((r) => !UNSAFE_ENV_KEYS.has(r.key));
  if (safeEnvRows.length > 0) {
    // Append/export onto the EXISTING PATH (never replace it), in case a value does
    // reference PATH.
    const envExports = safeEnvRows.map(r => `export ${r.key}="${decrypt(r.encryptedValue).replace(/"/g, '\\"')}"`).join("\n");
    const envB64 = Buffer.from(envExports).toString("base64");
    // Write to /etc/profile.d so all shells get them
    await execOnWorkspace(workspaceId, `echo ${envB64} | base64 -d > /etc/profile.d/lfg_env.sh && source /etc/profile.d/lfg_env.sh`, { timeout: 15_000 });
    console.log(`[ticket-executor-api] Injected ${safeEnvRows.length} env vars (skipped machine-specific: ${projectEnvRows.filter((r) => UNSAFE_ENV_KEYS.has(r.key)).map((r) => r.key).join(", ") || "none"})`);
  }

  // ── Build prompt + tools ────────────────────────────────────────────
  console.log(`[ticket-executor-api] Building prompt and tools`);

  const savedTechStack = sandboxRow.techStack as { language?: string; framework?: string; packageManager?: string; startCommand?: string; buildCommand?: string; port?: number; } | null;

  // Pending addenda (new change requests) + "already done" history — a rebuild
  // addresses these, and they're marked resolved after a successful push.
  const addendaCtx = await ticketAddendaContext(ticketId);

  const systemPrompt = buildApiBuilderPrompt({
    ticket: {
      id: ticket.id,
      ticketKey: ticket.ticketKey,
      name: ticket.name,
      description: ticket.description,
      details: (ticket.details as Record<string, unknown>) ?? {},
      uiRequirements: (ticket.uiRequirements as Record<string, unknown>) ?? {},
      componentSpecs: (ticket.componentSpecs as Record<string, unknown>) ?? {},
      acceptanceCriteria: (ticket.acceptanceCriteria as string[]) ?? [],
      notes: ticket.notes ?? "",
    },
    project: {
      id: project.id,
      name: project.name,
      repoUrl: repoUrl ?? undefined,
      techStack: project.stack || undefined,
    },
    techStack: savedTechStack ?? undefined,
    callbackBaseUrl: CALLBACK_BASE_URL,
    cliApiKey: "", // Not used in API mode
    tasks: tasks.map(t => ({ id: t.id, description: t.description, status: t.status })),
    envVars: projectEnvRows.map(r => ({ key: r.key, description: r.description ?? "" })),
  }) + addendaCtx.block; // append addenda + history (fallback/agent path)

  const projectDir = `${WORKING_DIR}/${projectDirName}`;

  const tools = createBuilderTools({
    workspaceId,
    ticketId,
    projectId: project.id,
    userId: ownerId,
    projectDir,
  });

  console.log(`[ticket-executor-api] Using model: ${modelKey}`);

  let implementationStatus = "failed" as "complete" | "failed";
  let workSummary = ""; // Pi's "here's what I did" summary, for the completion message

  // Provider/native model id for the Pi in-sandbox coding agent (provider up top).
  const piModelId = getProviderModel(modelKey) ?? modelKey;
  const providerApiKey = provider
    ? ({
        anthropic: userKeys?.anthropicApiKey,
        openai: userKeys?.openaiApiKey,
        google: userKeys?.googleApiKey,
        kimi: userKeys?.kimiApiKey,
        deepseek: userKeys?.deepseekApiKey,
        glm: userKeys?.glmApiKey,
      } as Record<string, string | null | undefined>)[provider]
    : undefined;
  const builderAuthMode = buildLlm.mode;
  const useOpenAICodex = useCodingAgent && builderAuthMode === "subscription"
    && provider === "openai" && await hasOpenAICodexCredentials(buildLlm.actorId);
  // Pin the VM awake for the whole build (wakes a reused/slept VM too) so Mags can't
  // idle-sleep a live build → "lost contact". Turned back off at build end.
  await wakeTicketVm(workspaceId);
  // Reuse preview discoveries, but verify/install the SDK in this build VM.

  // Direct API mode must stay on the provider API path. Pi (and therefore a
  // connected OpenAI Codex subscription) is reserved for Coding Agent mode.
  const usePi = useCodingAgent && USE_PI_TICKET_BUILDER && !!provider && isPiSupportedProvider(provider)
    && !!(providerApiKey || useOpenAICodex);

  if (usePi && provider && (providerApiKey || useOpenAICodex)) {
    // ── Pi coding agent inside the VM (model-agnostic, robust) ──────────
    await addLog(ticketId, `Starting Pi build (${provider}/${piModelId})...`, "command", ownerId);
    console.log(`[ticket-executor-api] Using Pi in-sandbox agent: ${provider}/${piModelId}`);
    const piEnvVars: Record<string, string> = {};
    for (const r of projectEnvRows) piEnvVars[r.key] = decrypt(r.encryptedValue);
    // SHARED VM: point the build at the toolchain the PREVIEW already installed on
    // this box (/data/.dotnet, /data/.nuget) instead of letting it restore into a
    // fresh cache or fail to find `dotnet` at all. Pi's own cache vars already cover
    // node/go/python/rust; .NET is set up on the preview side only. No effect on the
    // isolated path, which never sets these.
    const sharedToolchainPaths: string[] = [];
    if (useWorktree) {
      piEnvVars.DOTNET_ROOT = piEnvVars.DOTNET_ROOT ?? "/data/.dotnet";
      piEnvVars.DOTNET_CLI_HOME = piEnvVars.DOTNET_CLI_HOME ?? "/data/.dotnet";
      piEnvVars.NUGET_PACKAGES = piEnvVars.NUGET_PACKAGES ?? "/data/.nuget";
      sharedToolchainPaths.push("/data/.dotnet", "/data/.dotnet/tools");
    }
    // Screenshots the user attached to this ticket → absolute URLs the agent can fetch.
    const ticketAttRows = await db.select().from(projectTicketAttachments)
      .where(eq(projectTicketAttachments.ticketId, ticketId)).catch(() => []);
    const ticketAttachments = ticketAttRows
      .filter((a) => !a.fileType || /^image\//.test(a.fileType))
      .map((a) => ({ url: /^https?:\/\//.test(a.filePath) ? a.filePath : `${CALLBACK_BASE_URL}${a.filePath}`, name: a.originalFilename ?? "image" }));
    const piPrompt = buildPiTicketPrompt({
      ticket: {
        name: ticket.name,
        description: ticket.description,
        notes: ticket.notes,
        acceptanceCriteria: (ticket.acceptanceCriteria as string[] | null) ?? [],
      },
      techStack: savedTechStack,
      projectDir,
      prescaffolded,
      runInfo: await loadRunInfo(project.id),
      directives: await directivesBlock(project.id, featureBranch),
      addenda: addendaCtx.block,
      attachments: ticketAttachments,
      // Saved project/epic requirements and explicit design references are readable files.
      designRefs: await materializeTicketDocs({
        projectId: project.id,
        workspaceId,
        projectDir,
        epicId: ticket.epicId, sourceDocumentId: ticket.sourceDocumentId, sourceDocumentIds:ticketDocumentIds(ticket.details),
        text: [ticket.name, ticket.description ?? "", ticket.notes ?? ""].join("\n"),
      }),
    }) + workJournalBlock(ticket.details) + ticketJournalInstruction(ticketId);
    try {
      // Resolve (or mint) the CLI API key that authenticates the VM→server webhook.
      let cliApiKey = (await db.select({ k: profiles.cliApiKey }).from(profiles).where(eq(profiles.userId, ownerId)).limit(1))[0]?.k ?? "";
      if (!cliApiKey) {
        cliApiKey = `lfg_cli_${crypto.randomUUID().replace(/-/g, "")}`;
        await db.insert(profiles).values({ userId: ownerId, cliApiKey })
          .onConflictDoUpdate({ target: profiles.userId, set: { cliApiKey, updatedAt: new Date() } });
      }
      // Prefer WEBHOOK (the in-VM forwarder pushes Pi's JSONL live to
      // /api/v1/cli/output) when the callback URL is publicly reachable by the VM.
      // In local dev (localhost APP_URL) the VM can't reach us → fall back to the
      // server polling the VM. Exactly one channel writes logs (no duplicates).
      const webhookReachable = !!cliApiKey && !/localhost|127\.0\.0\.1|\/\/0\.0\.0\.0/.test(CALLBACK_BASE_URL);

      // Resume loop: if Pi does real work but is cut short we kill the stuck process and
      // RELAUNCH it against the persisted repo (the working tree at /data/<dir> is the
      // checkpoint — no thread id needed) with a "continue, don't restart" preface. A
      // transient LOST-CONTACT/timeout is infra (not a build failure) so it retries
      // generously (MAX_INFRA_RESUMES); a real cut-short (OOM/runaway) gets the small
      // MAX_BUILD_RESUMES. Only after exhausting the relevant budget do we give up.
      let attempt = 0;       // total resumes (drives the "continue" preface + settle)
      let infraResumes = 0;  // lost-contact / poll-timeout (transient) — generous budget
      let workResumes = 0;   // OOM / runaway (did work, cut short) — small budget
      while (true) {
        const isResume = attempt > 0;
        const runPrompt = isResume
          ? `⚠️ RESUMING an interrupted build. Your previous run did real work but was stopped mid-way — that work-in-progress is ALREADY in the repository at /data/${projectDirName}. Do NOT start over: run \`git status\`, inspect what already exists, and CONTINUE from there to finish the ticket below.\n\n${piPrompt}`
          : piPrompt;
        const pi = await startPiCli({
          workspaceId,
          prompt: runPrompt,
          projectDir: projectDirName,
          provider,
          modelId: piModelId,
          // Mint the subscription token FIRST and pick the credential from what we
          // actually got. Deciding "Codex is connected → send no API key" before knowing
          // whether the token minted is how Pi ends up started with neither credential
          // ("an API key or OAuth access token is required") on a user who has a key.
          ...(await (async () => {
            const tok = useOpenAICodex
              ? await getOpenAICodexAccessToken(buildLlm.actorId).catch(async (e: Error) => {
                  await addLog(ticketId, `OpenAI Codex subscription token unavailable (${e.message?.slice(0, 120)})${providerApiKey ? " — using the stored API key instead" : ""}`, "command", ownerId).catch(() => {});
                  return undefined;
                })
              : undefined;
            return { apiKey: tok ? undefined : providerApiKey ?? undefined, oauthAccessToken: tok };
          })()),
          envVars: piEnvVars,
          ...(sharedToolchainPaths.length ? { extraPathDirs: sharedToolchainPaths } : {}),
          forward: webhookReachable ? { apiUrl: CALLBACK_BASE_URL, apiKey: cliApiKey, mode: "ticket" as const, ticketId } : undefined,
        });
        // Remember the agent's pid so Stop can kill THIS lane and leave the other
        // tickets (and the running preview) in the shared VM alone.
        if (useWorktree) noteLanePid(ticketId, pi.backgroundPid ? parseInt(pi.backgroundPid, 10) : undefined);
        if (webhookReachable && !isResume) await addLog(ticketId, "Streaming build logs via webhook…", "command", ownerId);
        let lastPiLog = 0;
        const piResult = await streamPiToCompletion({
          workspaceId,
          outputFile: pi.outputFile,
          backgroundPid: pi.backgroundPid,
          timeoutMs: BUILD_TIMEOUT_MS,
          ticketId, // webhook output = proof-of-life (don't fail a live, streaming build)
          shouldCancel: () => cancelledTickets.has(ticketId),
          // Webhook active → poll is completion-only. Otherwise poll → logs.
          onProgress: webhookReachable ? undefined : (msg) => {
            const now = Date.now();
            if (now - lastPiLog < 4_000) return;
            lastPiLog = now;
            void addLog(ticketId, msg, "command", ownerId).catch(() => {});
          },
        });
        if (await stoppedByUser(ticketId, ownerId)) return;
        // Git-truth rescue: if the run wasn't cut short by a real problem (no fatalError:
        // no stall/lost-contact/OOM) but the log heuristic says "didWork=false", the agent
        // very likely finished the edits and just never signalled completion (common with
        // Kimi/Pi) — or it ran to the 30-min stop mid-verification. Trust the WORKING TREE:
        // if it has real changes, treat the build as complete and commit them, instead of
        // discarding real work as "no changes were made".
        let rescuedByGit = false;
        if (!piResult.fatalError && !piResult.didWork) {
          rescuedByGit = await gitWorkingTreeHasChanges(workspaceId, projectDirName);
          if (rescuedByGit) await addLog(ticketId, "Agent didn't send a completion signal, but the working tree has real changes — committing them.", "command", ownerId);
        }
        const piOk = (piResult.exitCode === null || piResult.exitCode === 0) && !piResult.fatalError && (piResult.didWork || rescuedByGit);
        if (piOk) {
          implementationStatus = "complete";
          workSummary = piWorkSummary(piResult.tail);
          break;
        }
        const _piDetail2 = piResult.fatalError ? "" : await lastErrorSnippet(ticketId, piResult.tail);
        const _piBase2 = piResult.fatalError
          ?? (piResult.exitCode ? `exit code ${piResult.exitCode}` : (!piResult.didWork ? "no changes were made" : "the agent stopped without finishing"));
        const reason = _piDetail2 ? `${_piBase2} — ${_piDetail2}` : _piBase2;

        // Cut short but it did real work → kill the stuck process and resume. A transient
        // lost-contact is NOT a failure (VM restores, /data is safe) → retry generously.
        const isInfra = piResult.lostContact;
        const cap = isInfra ? MAX_INFRA_RESUMES : MAX_BUILD_RESUMES;
        const used = isInfra ? infraResumes : workResumes;
        if (piResult.resumable && used < cap) {
          attempt++;
          if (isInfra) infraResumes++; else workResumes++;
          await killPiInVm(workspaceId, pi.backgroundPid);
          await addLog(ticketId, isInfra
            ? `⟳ Lost contact with the build VM (transient — your work is safe on /data). Reconnecting and continuing (retry ${infraResumes} of ${MAX_INFRA_RESUMES})…`
            : `⟳ Build didn't finish (${reason}) — resuming where it left off (attempt ${workResumes} of ${MAX_BUILD_RESUMES})…`, "command", ownerId);
          await sleep(2500); // let the VM settle after the kill
          continue;
        }

        const finalReason = attempt > 0 ? `${reason} (still unfinished after ${attempt} auto-resume${attempt > 1 ? "s" : ""})` : reason;
        await addLog(ticketId, `Pi build failed: ${finalReason}`, "cli_error", ownerId);
        console.error(`[ticket-executor-api] Pi failed (${finalReason}). Output tail:\n${piResult.tail.slice(-2000)}`);
        break;
      }
    } catch (err) {
      await addLog(ticketId, `Pi build error: ${(err as Error).message}`, "cli_error", ownerId);
      console.error(`[ticket-executor-api] Pi error:`, err);
    }
    // Persist Pi's raw output + prompt to S3 while the VM is still alive — it's reaped/
    // slept soon, and /data/.pi auto-cleans, so this is the durable copy for later review.
    await backupPiArtifacts(ticketId, workspaceId);

  } else {
  await addLog(ticketId, `Starting AI execution (${modelKey})...`, "command", ownerId);

  const model = getModel(modelKey, {
    anthropic: userKeys?.anthropicApiKey ?? undefined,
    openai: userKeys?.openaiApiKey ?? undefined,
    google: userKeys?.googleApiKey ?? undefined,
    kimi: userKeys?.kimiApiKey ?? undefined,
    deepseek: userKeys?.deepseekApiKey ?? undefined,
    glm: userKeys?.glmApiKey ?? undefined,
  });

  // ── Run generateText with tools (fallback / TICKET_BUILDER=agent) ────
  const abortController = new AbortController();
  const abortTimeout = setTimeout(() => abortController.abort(), BUILD_TIMEOUT_MS);

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Implement the ticket. The project is at ${projectDir}. Start by exploring the codebase, then create tasks, implement changes, and report your status when done.`,
        },
      ],
      tools,
      stopWhen: stepCountIs(100),
      abortSignal: abortController.signal,
      onStepFinish: async (event) => {
        const { toolCalls, toolResults } = event;
        // Log each tool call for visibility
        if (toolCalls?.length) {
          for (const tc of toolCalls) {
            const toolName = tc.toolName;
            // Don't log the full input for writeFile (too verbose)
            const inputSummary = toolName === "writeFile"
              ? `path: ${(tc as any).input?.path ?? "?"}`
              : JSON.stringify((tc as any).input ?? {}).slice(0, 200);
            await addLog(ticketId, `Tool: ${toolName}(${inputSummary})`, "command", ownerId);
          }
        }

        // Check if reportStatus was called
        if (toolResults?.length) {
          for (const tr of toolResults) {
            if (tr.toolName === "reportStatus" && typeof (tr as any).output === "object" && (tr as any).output !== null) {
              const res = (tr as any).output as { status?: string };
              if (res.status === "complete") implementationStatus = "complete";
            }
          }
        }
      },
    });

    // If the model finished all steps without calling reportStatus, check text
    if (implementationStatus !== "complete") {
      const text = result.text ?? "";
      if (text.includes("IMPLEMENTATION_STATUS: COMPLETE")) {
        implementationStatus = "complete";
      }
    }

    console.log(`[ticket-executor-api] generateText finished, steps=${result.steps?.length ?? 0}, status=${implementationStatus}`);
  } catch (err) {
    const msg = (err as Error).name === "AbortError"
      ? "Execution timed out (30 minutes)"
      : `AI execution error: ${(err as Error).message}`;
    console.error(`[ticket-executor-api] ${msg}`);
    await addLog(ticketId, msg, "command", ownerId);
  } finally {
    clearTimeout(abortTimeout);
  }
  }


  // ── Finalize: commit, push, merge ───────────────────────────────────
  const durationMs = Date.now() - startTime;

  let commitFailed = false;
  let publicationFailure = "";
  let publicationFailureKind: ValidationFailure["failureKind"] | undefined;
  let publicationDocumentation = "";
  let completedSha = "";   // captured for the final completion summary
  let mergedOk = false;
  // Build succeeded but we have NO way to push (no repo linked or the token
  // expired/was revoked). Silently skipping the push here used to mark the ticket
  // "In Review" anyway — and for an isolated build the VM is then destroyed, so
  // the work is LOST while the UI says done. Treat it as a not-saved failure with
  // an actionable message instead.
  if (implementationStatus === "complete" && !pushAuth) {
    commitFailed = true;
    publicationFailure = "Repository credentials could not be resolved; check the GitHub/GitLab integration in Settings.";
    await addLog(ticketId, "Build finished but the work was NOT pushed — no repository/credentials resolved (repo not linked, or the GitHub/GitLab token expired). Reconnect the repo in Settings and rebuild.", "cli_error", ownerId);
    console.error(`[ticket-executor-api] complete but pushAuth is null — cannot push ticket ${ticketId}`);
  }
  if (implementationStatus === "complete" && pushAuth) {
    try {
      await addLog(ticketId, "Committing changes...", "command", ownerId);
      const { sha, documentation } = await commitAndPush({
      validation: { gitCredentialUserId: gitUserId, projectId: project.id, userId: buildLlm.actorId, ticketId: ticketId, epicId: ticket.epicId ?? undefined, baselineBranch: anchorBase, cancelled: () => cancelledTickets.has(ticketId) || checksSkipped(ticketId), skipped: () => checksSkipped(ticketId), onLog: line => { addLog(ticketId, line, checkLogType(line), ownerId).catch(() => {}); }, onCheckpoint: async message => { await addLog(ticketId, message, "agent_progress", ownerId); } },
        workspaceId,
        projectDir,
        commitMessage: `feat: ${ticket.ticketKey ? ticket.ticketKey + " " : ""}${ticket.name}`,
        featureBranch,
        repoUrl: pushAuth.repoUrl,
        githubToken: pushAuth.token,
        tokenUser: pushAuth.tokenUser,
      });
      publicationDocumentation = documentation?.message ?? "";

      completedSha = sha;
      // "pushed" clears any prior "not_pushed" flag even if the merge below fails.
      await db.update(projectTickets).set({ githubBranch: featureBranch, githubCommitSha: sha, githubMergeStatus: "pushed", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));

      await logActivity({
        projectId: project.id,
        ticketId,
        actorType: "system",
        activityType: ACTIVITY_TYPES.GIT_PUSHED,
        title: `Pushed to ${featureBranch}`,
        description: `Commit ${sha.slice(0, 7)} pushed to ${githubOwner}/${githubRepo}.`,
        metadata: { sha, branch: featureBranch, repo: `${githubOwner}/${githubRepo}` },
      });

      try {
        await addLog(ticketId, `Merging to ${anchorBranch}...`, "command", ownerId);
        const { sha: mergeSha, files: mergedFiles } = await mergeToAnchor({
      validation: { gitCredentialUserId: gitUserId, projectId: project.id, userId: buildLlm.actorId, ticketId: ticketId, epicId: ticket.epicId ?? undefined, baselineBranch: anchorBase, cancelled: () => cancelledTickets.has(ticketId) || checksSkipped(ticketId), skipped: () => checksSkipped(ticketId), onLog: line => { addLog(ticketId, line, checkLogType(line), ownerId).catch(() => {}); }, onCheckpoint: async message => { await addLog(ticketId, message, "agent_progress", ownerId); } },
          workspaceId,
          projectDir,
          featureBranch,
          repoUrl: pushAuth.repoUrl,
          githubToken: pushAuth.token,
          tokenUser: pushAuth.tokenUser,
          targetBranch: anchorBranch,
          baseBranch: anchorBase,
        });
        await recordEpicFilesTouched(ticket.epicId, mergedFiles);
        mergedOk = true;
        await db.update(projectTickets).set({ githubMergeStatus: "merged", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
        await addLog(ticketId, `Merged to ${anchorBranch} (${mergeSha.slice(0, 7)})`, "command", ownerId);
        // Last ticket in the epic? Hand the whole unit to the client for review.
        await maybeSubmitEpicForReview(ticket.epicId);
      } catch (mergeErr) {
        console.warn(`[ticket-executor-api] Merge to ${anchorBranch} failed:`, mergeErr);
        throw mergeErr;
      }
    } catch (err) {
      // A failed commit/push means the work is NOT saved — do NOT report success.
      commitFailed = true;
      publicationFailureKind = err instanceof ValidationFailure ? err.failureKind : undefined;
      publicationFailure = failureSummary((err as Error).message || String(err), 2400).split("\nFailed command:")[0] || "No diagnostic returned";
      const msg = publicationFailure;
      await addLog(ticketId, `Publication/validation FAILED — candidate is not ready for review: ${msg}`, "command", ownerId);
      console.error(`[ticket-executor-api] commit/push failed:`, err);
    }
  }

  if (implementationStatus === "complete" && !commitFailed) {
    const reviewStageId = await moveTicketToStage(ticketId, project.id, "In Review");
    await db.update(projectTickets).set({
      status: "review",
      queueStatus: "none",
      executionTimeSeconds: durationMs / 1000,
      lastExecutionAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(projectTickets.id, ticketId));
    // A clear, agent-style completion summary (green ai_response bubble) so the
    // user gets an explicit "here's what got done" message, not just a buried log.
    // Always lead with a short "what got done" so the ticket is easy to track.
    const whatGotDone = shortSummary(workSummary) || await recentWorkSummary(ticketId).catch(() => "");
    const summary = `✅ **Ticket complete** — moved to In Review.\n\n` +
      (whatGotDone ? `**What got done:** ${whatGotDone}\n\n` : "") +
      (publicationDocumentation ? publicationDocumentation + "\n\n" : "") +
      `- Branch: \`${featureBranch}\`\n` +
      (completedSha ? `- Commit: \`${completedSha.slice(0, 7)}\`\n` : "") +
      (mergedOk ? `- Merged to \`${anchorBranch}\` ✓\n` : (completedSha ? `- Pushed (merge to ${anchorBranch} pending/failed — see logs)\n` : "")) +
      `\nOpen the **Git** tab to review the diff, or the **Preview** tab to run this branch.`;
    await addLog(ticketId, summary, "ai_response", ownerId);
    await markBuildTasksComplete(ticketId);
    // The build addressed the pending addenda → mark them resolved.
    await resolveTicketAddenda(ticketId, addendaCtx.pendingIds);
    await maybeSubmitEpicForReview(ticket.epicId);
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "review", queueStatus: "none", stageId: reviewStageId, mergeStatus: mergedOk ? "merged" : "pushed" });
    // TELL THE CHAIN IT SUCCEEDED. This emit was missing, and it's the reason a
    // "build them all" stopped dead after the first ticket: the event that advances
    // the queue was only ever emitted on FAILURE (markTicketFailed), on Stop, or by
    // the Claude CLI forwarder's done=true — which the Pi forwarder never sends. So a
    // build that WORKED signalled nothing and the chain died silently, while a build
    // that failed moved things along.
    emit({
      type: "ticket.execution_finished",
      ticketId,
      status: "complete",
      durationMs: Date.now() - startTime,
      exitCode: 0,
      projectId: project.id,
    });
    // Feature testing and recording already completed inside runtime validation.
    // QA (opt-in, projects.qaMode = "tests"): write a test suite for the ticket's
    // acceptance criteria and verify it red/green against the branch point, in the
    // sandbox that just built it. Fire-and-forget like the demo — it never throws,
    // never fails the ticket, and reports into the ticket's log.
    void runTicketQa(ticketId, { ownerId, llmUserId: buildLlm.actorId, projectId: project.id });
  } else {
    const _lastErr = commitFailed ? "" : await lastErrorSnippet(ticketId);
    const reason = commitFailed
      ? `publication or integration validation failed: ${publicationFailure || "No diagnostic returned"}; the build sandbox is kept`
      : `the agent finished without reporting completion${_lastErr ? ` — last error: ${_lastErr}` : ""}`;
    // Persist a durable "not_pushed" merge state so the Git tab flags it (red)
    // even after refresh — not just a transient Actions-log line.
    if (commitFailed) await db.update(projectTickets).set({ githubMergeStatus: "failed", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId)).catch(() => {});
    await markTicketFailed(ticketId, reason, ownerId, { failureKind: publicationFailureKind });
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: /Runtime validation (paused|blocked: required environment)/.test(reason) ? "blocked" : "failed", queueStatus: "none", mergeStatus: commitFailed ? "failed" : undefined });
  }

  // ISOLATED build: save the journal and retire the dedicated VM. It is deleted after a
  // short grace period once its work is on GitHub (or checkpointed); a later follow-up
  // starts a fresh clone on the ticket branch. Never touches the preview VM ("pv-…").
  if (isolatedBuild && !useWorktree && workspaceId && !workspaceId.startsWith("pv-")) {
    await sleepTicketVm(workspaceId, ticketId, implementationStatus === "complete" && !commitFailed ? "Build" : "Build (stopped)");
  }
  // SHARED build: the ticket's git worktree + sandbox row are intentionally KEPT.
  // They are cleaned up only when the ticket is approved and moved to Done (via
  // cleanupTicketWorktree), so the user can preview/test the branch first — and a
  // failed push never destroys the work.
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Wait for a ticket's execution to finish via the event bus.
 * The VM pushes output to /api/v1/cli/output/ which emits
 * ticket.cli_finished when done=true is received. Stop also wakes this waiter.
 * Returns when the event fires or when timeout is reached.
 */
function waitForCompletion(
  ticketId: string,
  timeoutMs: number
): Promise<{ status: "complete" | "failed" | "timeout"; exitCode?: number }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ status: "timeout" });
    }, timeoutMs);

    const handler = (event: any) => {
      if (event.payload.ticketId !== ticketId) return;
      cleanup();
      resolve({
        status: event.payload.exitCode === 0 ? "complete" : "failed",
        exitCode: event.payload.exitCode,
      });
    };

    const cleanup = () => {
      clearTimeout(timeout);
      bus.off("ticket.cli_finished", handler);
      bus.off("ticket.execution_finished", handler);
    };

    bus.on("ticket.cli_finished", handler);
    bus.on("ticket.execution_finished", handler);
  });
}

/** Retry publication of saved code without asking the builder to implement again. */
export async function startTicketMergeRetry(ticketId: string, actorId?: string, conversationId?: string): Promise<void> {
  if (executingTickets.has(ticketId) || isChatTurnActive(ticketId)) throw new Error('This ticket already has an active operation.');
  executingTickets.add(ticketId);
  let launched = false;
  try {
    const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
    if (!ticket?.githubBranch || !ticket.githubCommitSha) throw new Error('No saved ticket commit is available to merge.');
    if (/^(queued|executing|stopping)$/.test(ticket.queueStatus)) throw new Error('This ticket already has an active operation.');
    const [project] = await db.select().from(projects).where(eq(projects.id, ticket.projectId)).limit(1);
    if (!project) throw new Error('Project not found.');
    const actor = actorId ?? ticket.assigneeId ?? project.ownerId;
    const { gitUserId, usingOwnCollaboratorToken } = resolveGitActor(project, actor);
    const auth = await resolveRepoAuth(project, gitUserId);
    if (!auth) throw new Error('Repository access could not be resolved. The published ticket commit is preserved.');
    const anchor = await resolveTicketAnchor(ticket);
    const claimed = await db.update(projectTickets).set({ queueStatus: 'executing', updatedAt: new Date() })
      .where(and(eq(projectTickets.id, ticketId), eq(projectTickets.queueStatus, ticket.queueStatus))).returning({ id: projectTickets.id });
    if (!claimed.length) throw new Error('Another operation claimed this ticket.');
    cancelledTickets.delete(ticketId);
    const job = runChatTurn(ticketId, () => withTicketUsage(ticketId, actor, 'ticket_build', async () => {
      let workspaceId: string | undefined;
      let mergedSha: string | undefined;
      try {
        await setBuildOrigin(ticketId, conversationId ?? null, actor);
        await reportBuildStatus(ticketId, 'started', 'Retrying the merge of saved ticket changes.');
        broadcastToUser(project.ownerId, { type: 'ticket_status', ticketId, status: ticket.status, queueStatus: 'executing' });
        // Reuse the ticket checkout (and saved merge candidate). If the VM was
        // lost, a dedicated clone can integrate the already-published branch.
        const sb = await ensureIsolatedChatSandbox(ticket, project, project.ownerId, gitUserId, usingOwnCollaboratorToken, null);
        if ('error' in sb) throw new Error(sb.error);
        workspaceId = sb.workspaceId;
        await wakeTicketVm(workspaceId);
        if (cancelledTickets.has(ticketId)) throw new Error('Merge cancelled.');
        await addLog(ticketId, `Retrying merge of ${ticket.githubBranch} into ${anchor.anchorBranch}; implementation is already saved.`, 'command', project.ownerId);
        const result = await mergeToAnchor({
          workspaceId, projectDir: `${WORKING_DIR}/${sb.projectDir}`, featureBranch: ticket.githubBranch!,
          repoUrl: auth.repoUrl, githubToken: auth.token, tokenUser: auth.tokenUser,
          targetBranch: anchor.anchorBranch, baseBranch: anchor.baseBranch,
          validation: { projectId: project.id, userId: actor, gitCredentialUserId: gitUserId, ticketId,
            epicId: ticket.epicId ?? undefined, baselineBranch: anchor.baseBranch,
            cancelled: () => cancelledTickets.has(ticketId),
            onLog: line => { void addLog(ticketId, line, 'command', project.ownerId).catch(() => {}); },
            onCheckpoint: async message => { await addLog(ticketId, message, 'agent_progress', project.ownerId); } },
        });
        mergedSha = result.sha;
        // Persist publication evidence before any subsequent UI/bookkeeping work.
        await db.update(projectTickets).set({ githubMergeStatus: 'merged', githubMergeCommitSha: result.sha, updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
        const stageId = await moveTicketToStage(ticketId, project.id, 'In Review');
        await db.update(projectTickets).set({ status: 'review', lastExecutionAt: new Date(), updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
        await addLog(ticketId, `Saved ticket changes merged into ${anchor.anchorBranch} (${result.sha.slice(0, 7)}).`, 'ai_response', project.ownerId);
        await reportBuildStatus(ticketId, 'complete', 'Saved ticket changes merged successfully.');
        broadcastToUser(project.ownerId, { type: 'ticket_status', ticketId, status: 'review', stageId, queueStatus: 'executing', mergeStatus: 'merged' });
        await maybeSubmitEpicForReview(ticket.epicId);
      } catch (error) {
        if (mergedSha) {
          await addLog(ticketId, `Merged into ${anchor.anchorBranch} (${mergedSha.slice(0, 7)}), but final status reporting failed: ${(error as Error).message}`, 'cli_error', project.ownerId);
        } else if (!await stoppedByUser(ticketId, project.ownerId)) {
          await markTicketFailed(ticketId, `Merge retry failed; the ticket commit remains saved: ${(error as Error).message}`, project.ownerId, { emitEvent: false });
        }
      } finally {
        if (workspaceId) await sleepTicketVm(workspaceId, ticketId, 'Merge retry').catch(() => {});
        await db.update(projectTickets).set({ queueStatus: 'none', updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
        const [current] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
        broadcastToUser(project.ownerId, { type: 'ticket_status', ticketId, status: current?.status ?? ticket.status, queueStatus: 'none', mergeStatus: current?.githubMergeStatus });
      }
    }));
    launched = true;
    void job.catch(error => console.error('Merge retry failed', error)).finally(() => { executingTickets.delete(ticketId); stopSkipWatch(ticketId); });
  } finally {
    if (!launched) { executingTickets.delete(ticketId); stopSkipWatch(ticketId); }
  }
}

/** Start a validation-only run on an existing dedicated ticket checkout. */
export async function startTicketValidationRetry(ticketId:string,actorId:string,phase:'validation'|'feature-testing'|'checks'='checks'):Promise<void> {
  if(executingTickets.has(ticketId) || isChatTurnActive(ticketId))throw new Error("This ticket already has an active operation.");
  executingTickets.add(ticketId);
  let launched=false;
  try {
    const [ticket]=await db.select().from(projectTickets).where(eq(projectTickets.id,ticketId)).limit(1);
    if(!ticket)throw new Error("Ticket not found.");
    if(/^(queued|executing|stopping)$/.test(ticket.queueStatus))throw new Error(`Ticket operation is ${ticket.queueStatus}. Wait for it to finish or stop it before retrying validation.`);
    const [project]=await db.select().from(projects).where(eq(projects.id,ticket.projectId)).limit(1);
    if(!project)throw new Error("Project not found.");
    if ((phase === "validation" && project.validationEnabled === false) || (phase === "feature-testing" && project.featureTestingEnabled === false) || (phase === "checks" && project.validationEnabled === false && project.featureTestingEnabled === false)) throw new Error("Checks are turned off in Project Settings.");
    // The build sandbox is usually gone by now (sandboxes are disposable): checks run
    // in a fresh clone of the prepared environment on the saved ticket branch.
    const branch=ticket.githubBranch;
    if(!branch)throw new Error("No saved ticket branch is available.");
    const {runtimeValidations}=await import("../db/schema/runtime-validation.ts");
    const [previous]=await db.select().from(runtimeValidations).where(and(eq(runtimeValidations.projectId,project.id),eq(runtimeValidations.ticketId,ticketId),eq(runtimeValidations.branch,branch))).orderBy(desc(runtimeValidations.createdAt)).limit(1);

    const buildLlm=await resolveBuildLlm(project,actorId);
    const {gitUserId}=resolveGitActor(project,actorId);
    const auth=await resolveRepoAuth(project,gitUserId);
    if(!auth)throw new Error("Repository access could not be resolved.");
    cancelledTickets.delete(ticketId);
    if(ticket.status==="stopped")ticket.status="open";
    const claimed=await db.update(projectTickets).set({status:ticket.status,queueStatus:"executing",updatedAt:new Date()}).where(and(eq(projectTickets.id,ticketId),eq(projectTickets.queueStatus,ticket.queueStatus))).returning({id:projectTickets.id});
    if(!claimed.length)throw new Error("Another operation claimed this ticket. Retry after it finishes.");
    await setBuildOrigin(ticketId, null, actorId);
    await reportBuildStatus(ticketId, "started", `${phase === "feature-testing" ? "Feature testing" : phase === "checks" ? "Checks" : "Validation"} started.`);
    broadcastToUser(project.ownerId,{type:"ticket_status",ticketId,status:ticket.status,queueStatus:"executing"});
    let workspaceId="",projectDir="/data/project";
    const job=runChatTurn(ticketId,async()=>{
      let polling=false;
      const refreshCancellation=async()=>{
        if(polling)return;
        polling=true;
        try {const [current]=await db.select({q:projectTickets.queueStatus,status:projectTickets.status}).from(projectTickets).where(eq(projectTickets.id,ticketId)).limit(1);if(current?.q==="stopping" || current?.status==="stopped")cancelledTickets.add(ticketId);}
        finally {polling=false;}
      };
      const cancelPoll=setInterval(()=>{void refreshCancellation().catch(()=>{});},1000);
      try {
        await refreshCancellation();
        if(cancelledTickets.has(ticketId))throw new Error("Validation cancelled");
        const opened=await ensureIsolatedChatSandbox(ticket,project,project.ownerId,gitUserId,false,null);
        if("error" in opened)throw new Error(opened.error);
        workspaceId=opened.workspaceId;projectDir=`${WORKING_DIR}/${opened.projectDir}`;
        await wakeTicketVm(workspaceId);
        const {retrySavedValidation}=await import("../services/retry-validation.ts");
        const sha=await retrySavedValidation({workspaceId,projectDir,featureBranch:branch,repoUrl:auth.repoUrl,githubToken:auth.token,tokenUser:auth.tokenUser,
          validation:{projectId:project.id,userId:buildLlm.actorId,ticketId,gitCredentialUserId:gitUserId,cancelled:()=>cancelledTickets.has(ticketId)||checksSkipped(ticketId),skipped:()=>checksSkipped(ticketId),onLog:line=>{void addLog(ticketId,line,checkLogType(line),project.ownerId).catch(()=>{});},onCheckpoint:async message=>{await addLog(ticketId,message,"agent_progress",project.ownerId);}}},previous?.baseline ?? "",phase);
        await refreshCancellation();
        if(cancelledTickets.has(ticketId))throw new Error("Validation cancelled");
        if(phase==='feature-testing') {
          // A successful retry supersedes the previous operation failure. Preserve
          // completed tickets and Git metadata; testing alone does not publish code.
          const recovered = ticket.status === 'failed' || ticket.status === 'blocked';
          const status = recovered ? 'review' : ticket.status;
          const stageId = recovered ? await moveTicketToStage(ticketId, project.id, 'In Review') : ticket.stageId;
          await db.update(projectTickets).set({status, lastExecutionAt:new Date(), updatedAt:new Date()}).where(eq(projectTickets.id,ticketId));
          broadcastToUser(project.ownerId,{type:'ticket_status',ticketId,status,stageId,queueStatus:'executing'});
          await reportBuildStatus(ticketId, "complete", "Feature testing passed on the saved app. Build and validation were not repeated.");
          await addLog(ticketId,'Feature testing completed on the saved app. See the result in the Feature testing panel above. This run did not repeat build or validation.',"ai_response",project.ownerId);
          return;
        }
        const reviewStageId = await moveTicketToStage(ticketId, project.id, "In Review");
        await db.update(projectTickets).set({
          status: "review",
          githubCommitSha: sha,
          githubMergeStatus: sha !== ticket.githubCommitSha ? "pending" : ticket.githubMergeStatus,
          lastExecutionAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(projectTickets.id, ticketId));
        broadcastToUser(project.ownerId, { type: "ticket_status", ticketId, status: "review", queueStatus: "executing", stageId: reviewStageId });
        await reportBuildStatus(ticketId, "complete", "Validation passed on the saved code. This action did not push or merge.");
        await addLog(ticketId,`✅ **Validation passed** for saved commit \`${sha.slice(0,12)}\`. Moved to **In Review**. Development was skipped. Any repairs were committed locally; this action did not push or merge.`,"ai_response",project.ownerId);
      } catch(error) {
        clearInterval(cancelPoll);
        if(!await stoppedByUser(ticketId,project.ownerId)) await markTicketFailed(ticketId,(phase==='feature-testing'?'Feature testing failed: ':phase==='checks'?'Checks failed: ':'Validation failed: ')+(failureSummary((error as Error).message).split("\nFailed command:")[0] || "No diagnostic returned"),project.ownerId,{emitEvent:false,failureKind:error instanceof ValidationFailure?error.failureKind:undefined});
      } finally {
        clearInterval(cancelPoll);
        if(workspaceId)await sleepTicketVm(workspaceId, ticketId, "Checks retry");
        await db.update(projectTickets).set({queueStatus:"none",updatedAt:new Date()}).where(eq(projectTickets.id,ticketId));
        const [current]=await db.select({status:projectTickets.status,stageId:projectTickets.stageId}).from(projectTickets).where(eq(projectTickets.id,ticketId)).limit(1);
        broadcastToUser(project.ownerId,{type:"ticket_status",ticketId,status:current?.status||ticket.status,stageId:current?.stageId,queueStatus:"none"});
      }
    });
    launched=true;
    void job.catch(error=>console.error("Validation retry failed",error)).finally(()=>{executingTickets.delete(ticketId);stopSkipWatch(ticketId);});
  } finally {if(!launched){executingTickets.delete(ticketId);stopSkipWatch(ticketId);}}
}

async function findExistingSandbox(ticketId: string) {
  // Match the ticket's sandbox regardless of workspaceType — worktree runs store
  // "ticket-worktree", so restricting to "ticket" meant retries never found the
  // existing row and re-inserted (→ unique-constraint clash on the shared
  // preview workspace). Order by most-recent so a ticket with more than one row
  // (legacy build + chat) deterministically resolves to the same sandbox instead of
  // an arbitrary LIMIT 1 (which could orphan the other VM).
  const result = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticketId), inArray(sandboxes.workspaceType, ["ticket", "ticket-chat", "ticket-worktree"])))
    .orderBy(desc(sandboxes.updatedAt))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Try to refresh DB credentials from the auth sandbox.
 * The auth sandbox may have auto-refreshed tokens that the DB doesn't have.
 * This is a best-effort operation — if the auth sandbox is unavailable, we continue with DB creds.
 */
async function refreshCredentialsFromAuthSandbox(userId: string): Promise<void> {
  try {
    // Find the user's auth sandbox
    const [authSandbox] = await db.select().from(sandboxes)
      .where(and(eq(sandboxes.userId, userId), eq(sandboxes.workspaceType, "claude_auth")))
      .limit(1);

    if (!authSandbox?.magsWorkspaceId) return;

    // Try to read fresh credentials from the auth sandbox
    const { saveCredentialsFromVm: saveCreds } = await import("../services/claude-cli.ts");
    const saved = await saveCreds(authSandbox.magsWorkspaceId, userId);
    if (saved) {
      console.log(`[ticket-executor] Refreshed credentials from auth sandbox ${authSandbox.magsWorkspaceId}`);
    }
  } catch (err) {
    // Auth sandbox might be sleeping/unavailable — that's fine, continue with DB creds
    console.log(`[ticket-executor] Could not refresh from auth sandbox: ${(err as Error).message?.slice(0, 100)}`);
  }
}

async function resolveProjectIdForTicket(ticketId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: projectTickets.projectId })
    .from(projectTickets)
    .where(eq(projectTickets.id, ticketId))
    .limit(1);
  return row?.projectId ?? null;
}

async function markTicketFailed(ticketId: string, reason: string, userId?: string, opts?: { emitEvent?: boolean; failureKind?: ValidationFailure["failureKind"] }) {
  const paused = /Runtime validation (paused|blocked: required environment)/.test(reason);
  const terminalStatus = paused ? "blocked" : "failed";
  const projectId = await resolveProjectIdForTicket(ticketId);
  // Early provisioning errors reach this helper before the worker has an owner ID.
  // Still publish terminal status so connected ticket UIs stop their spinner.
  if (!userId && projectId) {
    const [owner] = await db.select({ownerId: projects.ownerId}).from(projects).where(eq(projects.id, projectId)).limit(1);
    userId = owner?.ownerId;
  }
  const failureStageId = projectId
    ? await moveTicketToStage(ticketId, projectId, "Failed / Blocked")
    : null;
  await db
    .update(projectTickets)
    .set({
      status: terminalStatus,
      queueStatus: "none",
      updatedAt: new Date(),
    })
    .where(eq(projectTickets.id, ticketId));

  if (userId) {
    broadcastToUser(userId, {
      type: "ticket_status",
      ticketId,
      status: terminalStatus,
      queueStatus: "none",
      stageId: failureStageId,
    });
  }

  // Concise machine line the failure banner scrapes for its reason.
  await addLog(ticketId, `Execution failed: ${reason}`, "command", userId);

  // Rich agent-style failure explanation (red-ish ai_response bubble), mirroring
  // the success summary — so the user sees WHAT went wrong and HOW to proceed,
  // not just a buried "Execution failed" log line.
  const failMsg =
    (paused ? `⏸ **Validation paused** — saved code still needs verification.\n\n` : /^Feature testing failed:/i.test(reason) ? `❌ **Feature testing failed** — see the browser attempt and diagnostics above.\n\n` : /validation failed|recovery stopped|Automatic repair stopped/i.test(reason) ? `❌ **Validation blocked** — this ticket is not ready for review.\n\n` : `❌ **Build failed** — this attempt could not complete.\n\n`) +
    `**What went wrong:** ${reason}\n\n` +
    (paused ? `**Next step:** resume validation on the saved ticket sandbox. Implementation changes are retained; no successful validation or commit is implied by this pause.` : /clone submission|clone response missing request_id/i.test(reason)
      ? `**How to proceed:** the clone request was not confirmed. Check Magpie for an accepted clone before retrying; automatic resubmission is blocked to avoid duplicate sandboxes. Ticket implementation has not started.`
      : opts?.failureKind === "http"
        ? `**Next step:** the app did not pass its HTTP check. The connection/status diagnostic is shown above. Use Retry validation to test the saved code again, with automatic repair if needed.`
      : opts?.failureKind === "schema"
        ? `**Next step:** database setup needs a repair before validation can pass. The failure is shown above. You can ask the agent to repair it using the message box below; repeating the same build without a repair may fail again.`
        : /validation failed|recovery stopped|Automatic repair stopped/i.test(reason)
          ? `**Next step:** the failure is shown above. You can ask the agent to repair it using the message box below. This attempt has stopped; another attempt must pass validation before the ticket is ready for review.`
          : `**Next step:** the failure is shown above. Use the message box below to request a repair or provide missing details, then retry when the blocker has been resolved.`);
  await addLog(ticketId, failMsg, "ai_response", userId);

  if (opts?.emitEvent === false) await reportBuildStatus(ticketId, "failed", reason);

  // Emit execution_finished so the handler chain continues (auto-queue next ticket).
  // Startup recovery can suppress queue advancement explicitly; normal build failures
  // must emit here because CLI exit is a separate, non-final event.
  if (opts?.emitEvent !== false) {
    emit({
      type: "ticket.execution_finished",
      ticketId,
      projectId: projectId ?? undefined,
      status: "failed",
      exitCode: 1,
    });
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Startup Recovery: Push Unpushed Tickets ──────────────────────────

/**
 * Find tickets that finished execution (code written) but never got pushed
 * to GitHub — typically because the server restarted before the git step.
 * For each, attempt commit + push + merge using the existing sandbox.
 */
async function recoverUnpushedTickets() {
  try {
    // Tickets in in_progress with no queue activity and no git commit
    const candidates = await db
      .select({
        id: projectTickets.id,
        name: projectTickets.name,
        projectId: projectTickets.projectId,
        githubCommitSha: projectTickets.githubCommitSha,
        githubBranch: projectTickets.githubBranch,
        assigneeId: projectTickets.assigneeId,
        ticketKey: projectTickets.ticketKey, // so the recovered commit is traceable to a ticket
        epicId: projectTickets.epicId, // decides which anchor the recovered work merges into
      })
      .from(projectTickets)
      .where(
        and(
          eq(projectTickets.status, "in_progress"),
          eq(projectTickets.queueStatus, "none"),
        )
      );

    for (const ticket of candidates) {
      // Skip if already pushed
      if (ticket.githubCommitSha) continue;

      // Must have a live sandbox
      const [sandbox] = await db
        .select({ magsWorkspaceId: sandboxes.magsWorkspaceId, workspaceType: sandboxes.workspaceType })
        .from(sandboxes)
        .where(eq(sandboxes.ticketId, ticket.id))
        .limit(1);

      if (!sandbox?.magsWorkspaceId) continue;

      // Load project + github token
      const [project] = await db
        .select({
          id: projects.id,
          ownerId: projects.ownerId,
          repoOwner: projects.repoOwner,
          repoName: projects.repoName,
          // Needed to work out WHICH host this repo is on — without them the recovery
          // path assumed GitHub for every project.
          repoUrl: projects.repoUrl,
          repoProvider: projects.repoProvider,
          shareGitAccess: projects.shareGitAccess,
        })
        .from(projects)
        .where(eq(projects.id, ticket.projectId))
        .limit(1);

      if (!project?.repoOwner || !project?.repoName) continue;

      // Fine-grained Git: push the recovered work with the ticket's assignee's effective
      // token (no trigger actor available in this background sweep; falls back to owner).
      const { gitUserId } = resolveGitActor(project, ticket.assigneeId);
      const [ghToken] = await db
        .select({ accessToken: githubTokens.accessToken })
        .from(githubTokens)
        .where(eq(githubTokens.userId, gitUserId))
        .limit(1);

      if (!ghToken?.accessToken) continue;

      console.log(`[ticket-executor] Recovery: pushing unpushed ticket "${ticket.name}" (${ticket.id})`);

      const workspaceId = sandbox.magsWorkspaceId;
      const featureBranch = ticket.githubBranch ?? ticketBranchName(ticket);
      const recoveryAnchor = await resolveTicketAnchor(ticket);
      // SHARED preview VM: the unpushed work is in the ticket's WORKTREE. Committing
      // from /data/project here would push the preview's main checkout to the ticket's
      // branch — the wrong tree entirely.
      const projectDirName = sandbox.workspaceType === "ticket-worktree"
        ? ticketWorktreeDirName(ticket.id)
        : "project";

      // The build VM is ephemeral — after a server restart / VM sleep it may be
      // gone. Its changes lived only inside that VM and were never pushed, so if
      // the workspace is dead there is nothing to recover. Probe liveness first;
      // on a dead workspace, clean up (delete the stale sandbox row so we don't
      // retry this on every restart) and mark the ticket failed — instead of
      // throwing an opaque "Commit/push failed" (exit 2, empty output) each boot.
      let workspaceAlive = false;
      try {
        const probe = await execOnWorkspace(workspaceId, "echo WORKSPACE_ALIVE", { timeout: 15_000 });
        workspaceAlive = probe.output.includes("WORKSPACE_ALIVE");
      } catch {
        workspaceAlive = false;
      }

      if (!workspaceAlive) {
        console.log(`[ticket-executor] Recovery: workspace ${workspaceId} for ticket ${ticket.id} is gone — unpushed changes can't be recovered; clearing stale sandbox.`);
        await db.delete(sandboxes).where(eq(sandboxes.ticketId, ticket.id));
        await markTicketFailed(
          ticket.id,
          "Build VM was lost before changes were pushed — re-run the ticket to rebuild.",
          project.ownerId,
          { emitEvent: false }
        );
        continue;
      }

      // Provider-aware credential for the push AND the merge below — both used to be
      // hardcoded to github.com, which simply doesn't resolve for a GitLab project.
      const recoverAuth = await resolveRepoAuth(project, project.ownerId).catch(() => null);

      try {
        const { sha, documentation } = await commitAndPush({
      validation: { gitCredentialUserId: gitUserId, projectId: project.id, userId: project.ownerId, ticketId: ticket.id, epicId: ticket.epicId ?? undefined, baselineBranch: recoveryAnchor.baseBranch, cancelled: () => cancelledTickets.has(ticket.id), onLog: line => { addLog(ticket.id, line, checkLogType(line), project.ownerId).catch(() => {}); }, onCheckpoint: async message => { await addLog(ticket.id, message, "agent_progress", project.ownerId); } },
          workspaceId,
          projectDir: `${WORKING_DIR}/${projectDirName}`,
          commitMessage: `feat: ${ticket.ticketKey ? ticket.ticketKey + " " : ""}${ticket.name}`,
          featureBranch,
          repoUrl: recoverAuth?.repoUrl ?? `https://github.com/${project.repoOwner}/${project.repoName}.git`,
          githubToken: recoverAuth?.token ?? ghToken.accessToken,
          tokenUser: recoverAuth?.tokenUser,
        });

        await db
          .update(projectTickets)
          .set({
            githubBranch: featureBranch,
            githubCommitSha: sha,
            updatedAt: new Date(),
          })
          .where(eq(projectTickets.id, ticket.id));

        await logActivity({
          projectId: project.id,
          ticketId: ticket.id,
          actorType: "system",
          activityType: ACTIVITY_TYPES.GIT_PUSHED,
          title: `Pushed to ${featureBranch} (recovered)`,
          description: `Commit ${sha.slice(0, 7)} pushed after server recovery.`,
          metadata: { sha, branch: featureBranch, recovered: true },
        });

        // Also attempt merge
        try {
          const { sha: mergeSha } = await mergeToAnchor({
      validation: { gitCredentialUserId: gitUserId, projectId: project.id, userId: project.ownerId, ticketId: ticket.id, epicId: ticket.epicId ?? undefined, baselineBranch: recoveryAnchor.baseBranch, cancelled: () => cancelledTickets.has(ticket.id), onLog: line => { addLog(ticket.id, line, checkLogType(line), project.ownerId).catch(() => {}); }, onCheckpoint: async message => { await addLog(ticket.id, message, "agent_progress", project.ownerId); } },
            workspaceId,
            projectDir: `${WORKING_DIR}/${projectDirName}`,
            featureBranch,
            repoUrl: recoverAuth?.repoUrl ?? `https://github.com/${project.repoOwner}/${project.repoName}.git`,
            githubToken: recoverAuth?.token ?? ghToken.accessToken,
            tokenUser: recoverAuth?.tokenUser,
            targetBranch: recoveryAnchor.anchorBranch,
            baseBranch: recoveryAnchor.baseBranch,
          });
          await db
            .update(projectTickets)
            .set({ githubMergeStatus: "merged", updatedAt: new Date() })
            .where(eq(projectTickets.id, ticket.id));

          await logActivity({
            projectId: project.id,
            ticketId: ticket.id,
            actorType: "system",
            activityType: ACTIVITY_TYPES.GIT_MERGED,
            title: `Merged to ${recoveryAnchor.anchorBranch} (recovered)`,
            description: `Feature branch ${featureBranch} merged (${mergeSha.slice(0, 7)}).`,
            metadata: { mergeSha, branch: featureBranch, recovered: true },
          });
        } catch (mergeErr) {
          console.warn(`[ticket-executor] Recovery merge failed for ${ticket.id}:`, mergeErr);
          throw mergeErr;
        }

        if (documentation) await addLog(ticket.id, documentation.message, "ai_response", project.ownerId);
        // Move to review
        const reviewStageId = await moveTicketToStage(ticket.id, project.id, "In Review");
        await db
          .update(projectTickets)
          .set({ status: "review", updatedAt: new Date() })
          .where(eq(projectTickets.id, ticket.id));

        broadcastToUser(project.ownerId, {
          type: "ticket_status",
          ticketId: ticket.id,
          status: "review",
          queueStatus: "none",
          stageId: reviewStageId,
        });

        console.log(`[ticket-executor] Recovery: successfully pushed and merged ticket ${ticket.id}`);
      } catch (err) {
        const firstLine = (err as Error).message?.split("\n")[0] ?? String(err);
        console.warn(`[ticket-executor] Recovery git push failed for ${ticket.id}: ${firstLine}`);
        await addLog(ticket.id, `Recovery: git push failed — ${firstLine}`, "command", project.ownerId);
        // The recovery push failed (the VM's working tree is gone/broken even if
        // the VM answers a probe). It won't succeed on the next restart either, so
        // stop re-selecting this ticket every boot: drop the stale sandbox and mark
        // it failed. Re-run the ticket to rebuild.
        await db.delete(sandboxes).where(eq(sandboxes.ticketId, ticket.id));
        await markTicketFailed(
          ticket.id,
          "Unpushed changes could not be recovered — re-run the ticket to rebuild.",
          project.ownerId,
          { emitEvent: false }
        );
      }
    }
  } catch (err) {
    console.error("[ticket-executor] recoverUnpushedTickets error:", err);
  }
}

async function executeTicket(ticketId: string, actorId?: string): Promise<void> {
  return withTicketUsage(ticketId, actorId, "ticket_build", () => executeTicketInternal(ticketId, actorId));
}

async function executeTicketApi(ticketId: string, useCodingAgent: boolean, actorId?: string, placement?: BuildPlacement): Promise<void> {
  return withTicketUsage(ticketId, actorId, "ticket_build", () => executeTicketApiInternal(ticketId, useCodingAgent, actorId, placement));
}

async function executeTicketChat(ticketId: string, message: string, sender: string, actorId?: string): Promise<void> {
  return withTicketUsage(ticketId, actorId, "ticket_chat", () => executeTicketChatInternal(ticketId, message, sender, actorId));
}
