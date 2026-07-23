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
import { projectTickets, projectTodoLists, ticketStages } from "../db/schema/tickets.ts";
import { projects, projectEnvironmentVariables } from "../db/schema/projects.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { profiles, githubTokens, applicationState, llmApiKeys } from "../db/schema/users.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { decrypt } from "../ai/tools/env-tools.ts";
import { bus, emit } from "../events/bus.ts";
import {
  newWorkspace,
  execOnWorkspace,
  deleteWorkspace,
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
  mergeToLfgAgent,
  createGitHubRepo,
  initAndPushRepo,
} from "../services/git.ts";
import {
  buildBuilderPrompt,
  buildTicketChatPrompt,
} from "../ai/prompts/builder.ts";
import { buildApiBuilderPrompt } from "../ai/prompts/builder-api.ts";
import { createBuilderTools } from "../ai/tools/builder-tools.ts";
import { getModel, getProviderName, getProviderModel, DEFAULT_MODEL_KEY, type ProviderName } from "../ai/provider.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { getValidGitlabToken } from "../services/gitlab-token.ts";

interface RepoAuth {
  provider: "github" | "gitlab";
  owner: string; repo: string;
  repoUrl: string;   // https, no creds, ends .git
  authUrl: string;   // https with embedded credential
  token: string;
  tokenUser: string; // "x-access-token" (GitHub) | "oauth2" (GitLab)
}

/**
 * Resolve the project's repo provider + a correctly-authenticated remote URL.
 * Supports BOTH GitHub (x-access-token) and GitLab (oauth2). Provider is inferred
 * from the repo URL host (dual-provider apps), falling back to repoProvider.
 * Returns null if there's no connected repo or no valid token for its provider.
 */
async function resolveRepoAuth(
  project: { repoOwner: string | null; repoName: string | null; repoUrl: string | null; repoProvider?: string | null; stack?: string | null },
  ownerId: string,
): Promise<RepoAuth | null> {
  const columnProvider = (project.repoProvider || "github").toLowerCase();
  let repoUrl = (project.repoUrl || extractRepoUrl(project.stack ?? "") || "").trim();
  let owner = project.repoOwner ?? "";
  let repo = project.repoName ?? "";
  if ((!owner || !repo) && repoUrl) {
    const m = repoUrl.match(/(?:github|gitlab)\.com[:/]+([^/]+)\/([^/.]+)/i);
    if (m) { owner = owner || m[1]!; repo = repo || m[2]!; }
  }
  const provider: "github" | "gitlab" = /gitlab\.com|\/gitlab\b/i.test(repoUrl) ? "gitlab"
    : /github\.com/i.test(repoUrl) ? "github" : (columnProvider === "gitlab" ? "gitlab" : "github");
  const host = provider === "gitlab" ? "gitlab.com" : "github.com";
  if (!repoUrl && owner && repo) repoUrl = `https://${host}/${owner}/${repo}.git`;
  if (!repoUrl || !owner || !repo) return null;
  repoUrl = repoUrl.replace(/^git@([^:]+):/, "https://$1/").replace(/\/+$/, "").replace(/\.git$/, "") + ".git";
  const token = provider === "gitlab"
    ? (await getValidGitlabToken(ownerId)) || ""
    : (await db.select().from(githubTokens).where(eq(githubTokens.userId, ownerId)).limit(1))[0]?.accessToken || "";
  if (!token) return null;
  const tokenUser = provider === "gitlab" ? "oauth2" : "x-access-token";
  return { provider, owner, repo, repoUrl, authUrl: repoUrl.replace("https://", `https://${tokenUser}:${token}@`), token, tokenUser };
}

/**
 * Remove a ticket's git worktree from the shared preview sandbox and drop its
 * sandbox row. Called ONLY when the ticket is approved and moved to Done — the
 * worktree is kept alive through In-Review so the user can preview/test the branch.
 */
export async function cleanupTicketWorktree(ticketId: string): Promise<void> {
  const [sb] = await db.select().from(sandboxes).where(eq(sandboxes.ticketId, ticketId)).limit(1);
  if (!sb) return;
  if (sb.magsWorkspaceId && sb.workspaceType === "ticket-worktree") {
    const dir = `wt-ticket-${ticketId.slice(0, 12)}`;
    await execOnWorkspace(sb.magsWorkspaceId, `cd ${WORKING_DIR}/project 2>/dev/null && git worktree remove --force ${WORKING_DIR}/${dir} 2>/dev/null; rm -rf ${WORKING_DIR}/${dir} 2>/dev/null; git worktree prune 2>/dev/null; echo cleaned`, { timeout: 60_000 }).catch(() => {});
  }
  await db.delete(sandboxes).where(eq(sandboxes.id, sb.id)).catch(() => {});
}

/**
 * The model to build tickets with. Precedence: an explicit builder model (if the
 * user set one in Settings) → the user's SELECTED CHAT model → the global default.
 * This is why a DeepSeek chat user's tickets build with DeepSeek, not a hardcoded
 * Claude. (The old hardcoded "claude_4.5_sonnet" fallback ignored the chat pick
 * AND was a dead key.)
 */
// The old schema DEFAULT wrote this into builderModelKey for every row, so a
// stored value equal to it is indistinguishable from "never chose a builder
// model" — treat it as unset so those users follow their chat pick.
const LEGACY_BUILDER_DEFAULT = "claude_4.5_sonnet";
async function resolveBuilderModelKey(ownerId: string): Promise<string> {
  const [appState] = await db.select({ k: applicationState.builderModelKey }).from(applicationState).where(eq(applicationState.userId, ownerId)).limit(1);
  if (appState?.k && appState.k !== LEGACY_BUILDER_DEFAULT) return appState.k; // explicit, non-legacy pick
  const [sel] = await db.select({ m: modelSelections.selectedModel }).from(modelSelections).where(eq(modelSelections.userId, ownerId)).limit(1);
  return sel?.m || DEFAULT_MODEL_KEY;
}
import { startPiCli, streamPiToCompletion, isPiSupportedProvider } from "../services/pi-cli.ts";
import { getBuildProfile, detectProjectType } from "../services/instant-profiles.ts";
import { generateText, stepCountIs } from "ai";
import { addLog } from "../services/ticket-logs.ts";
import { matchKnowledgeForPrompt } from "../ai/knowledge/matcher.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { logActivity } from "../services/activity-log.ts";
import { ACTIVITY_TYPES } from "../db/schema/activities.ts";
import { eq, and } from "drizzle-orm";

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

function buildPiTicketPrompt(args: {
  ticket: { name: string; description: string | null; notes?: string | null; acceptanceCriteria?: string[] | null };
  techStack?: { language?: string; framework?: string; packageManager?: string; port?: number } | null;
  projectDir: string;
  /** True when the project is already scaffolded (boilerplate or server-side scaffold). */
  prescaffolded?: boolean;
  /** How to build/run this project (from the preview setup manifest, if any). */
  runInfo?: { installCmd?: string; buildCmd?: string; runCmd?: string; port?: number } | null;
}): string {
  const t = args.ticket;
  const ac = (t.acceptanceCriteria ?? []).map((c, i) => `${i + 1}. ${c}`).join("\n") || "Not specified.";
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

## Project setup
${setup}

## Ticket
${t.name}

## Description
${t.description ?? ""}
${t.notes ? `\n## Notes\n${t.notes}` : ""}

## Acceptance Criteria
${ac}

## Tech stack
${stack}
${runBlock}
## Instructions
- Explore the project first; reuse existing patterns, dependencies, and files.
- Implement the ticket end to end so every acceptance criterion is met.
- Make the app runnable: bind the dev server to 0.0.0.0 on port ${port}.
- Do NOT run 'git commit', 'git push', or switch git branches — commit/push/merge is handled automatically after you finish.
- Before finishing, make sure the project builds/compiles.`;
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
  setTimeout(() => recoverUnpushedTickets(), 5_000);

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

    if (useApiMode) {
      // API mode: parallel across DIFFERENT tickets is fine; the executingTickets
      // guard above prevents the SAME ticket from running twice.
      console.log(`[ticket-executor] API mode — executing ticket ${ticketId}`);
      try {
        await executeTicketApi(ticketId);
      } catch (err) {
        console.error(`[ticket-executor] API mode failed for ticket ${ticketId}:`, err);
        await markTicketFailed(ticketId, String(err));
      }
    } else {
      // CLI mode. Claude Code CLI only works with Claude models — route any
      // non-Anthropic builder model to the Pi in-sandbox agent instead
      // (executeTicketApi runs Pi). Mirrors the instant-mode routing.
      const builderProvider = await getBuilderProvider(projectId);
      if (builderProvider && builderProvider !== "anthropic") {
        console.log(`[ticket-executor] CLI mode + ${builderProvider} — using Pi (Claude Code is Claude-only)`);
        try {
          await executeTicketApi(ticketId);
        } catch (err) {
          console.error(`[ticket-executor] Pi (CLI-routed) failed for ticket ${ticketId}:`, err);
          await markTicketFailed(ticketId, String(err));
        }
      } else {
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
            await executeTicket(ticketId);
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
      executingTickets.delete(ticketId);
    }
  });

  bus.on("ticket.chat_message", async (event) => {
    const { ticketId, message, sender } = event.payload;
    try {
      await executeTicketChat(ticketId, message, sender);
    } catch (err) {
      console.error(`[ticket-executor] Chat failed for ticket ${ticketId}:`, err);
    }
  });

  console.log("[ticket-executor] Worker started");
}

// ── Main Executor ─────────────────────────────────────────────────────

async function executeTicket(ticketId: string): Promise<void> {
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

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, ownerId))
    .limit(1);

  const [ghToken] = await db
    .select()
    .from(githubTokens)
    .where(eq(githubTokens.userId, ownerId))
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

  // Warn if no GitHub — code will be lost on VM restart
  if (!githubToken) {
    console.warn(`[ticket-executor] ⚠️ No GitHub token for user ${ownerId} — code won't be persisted!`);
    await addLog(ticketId, "⚠️ GitHub not connected — code will NOT be saved to a repository. Connect GitHub in Settings to persist your work.", "command", ownerId);
  }

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

  // Project dir name (relative, e.g. "project")
  const projectDirName = "project"; // Default, matching Django stack_config

  // Feature branch name matching Django
  const featureBranch = `feature/ticket-${ticketId}`;

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

    const { jobId, workspaceId: wsId } = await newWorkspace(workspaceName, { diskGb: parseInt(process.env.INSTANT_DISK_GB || "8", 10) });
    workspaceId = wsId;

    // Wait for VM to boot
    await sleep(8_000);

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
    git fetch origin
    git reset --hard HEAD 2>/dev/null || true
    git clean -fd 2>/dev/null || true
elif [ -d "${projectDirName}" ] && [ "$(ls -A ${projectDirName} 2>/dev/null)" ]; then
    echo "INIT_EXISTING_DIR"
    cd ${projectDirName}
    git init
    git remote add origin https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git 2>/dev/null || \
        git remote set-url origin https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git
    git fetch origin
else
    echo "CLONING_REPO"
    rm -rf ${projectDirName}
    git clone https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git ${projectDirName} 2>&1
    # A failed clone (TLS/network/auth) leaves no dir — do NOT fall through and run
    # git ops in the parent (WORKING_DIR); fail loudly so the caller aborts.
    cd ${projectDirName} 2>/dev/null || { echo "GIT_CLONE_FAILED"; exit 1; }
    [ -d ".git" ] || { echo "GIT_CLONE_FAILED"; exit 1; }
fi

# Ensure lfg-agent branch exists (create from main/default if not)
if ! git rev-parse --verify origin/lfg-agent 2>/dev/null; then
    echo "CREATING_LFG_AGENT_BRANCH"
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
    git checkout "$DEFAULT_BRANCH" 2>/dev/null || git checkout main 2>/dev/null || true
    git checkout -b lfg-agent
    git push -u origin lfg-agent 2>&1
fi

# Checkout feature branch — always branch from lfg-agent if creating new
if git rev-parse --verify origin/${featureBranch} 2>/dev/null; then
    echo "FEATURE_BRANCH_EXISTS_REMOTE"
    git checkout ${featureBranch} 2>/dev/null || git checkout -b ${featureBranch} origin/${featureBranch}
    git reset --hard origin/${featureBranch}
elif git rev-parse --verify ${featureBranch} 2>/dev/null; then
    echo "FEATURE_BRANCH_EXISTS_LOCAL"
    git checkout ${featureBranch}
else
    echo "CREATING_FEATURE_BRANCH"
    git checkout origin/lfg-agent 2>/dev/null || git checkout lfg-agent 2>/dev/null || true
    git checkout -b ${featureBranch}
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
      const gitScriptB64 = Buffer.from(gitSetupScript).toString("base64");
      const gitResult = await execOnWorkspace(workspaceId, `echo ${gitScriptB64} | base64 -d | sh`, { timeout: 120_000 });
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
      } else if (gitResult.output.includes("GIT_CLONE_FAILED") || gitResult.output.includes("GIT_SETUP_FAILED_NO_GIT")) {
        // The clone genuinely failed — no code in the VM. Running the agent
        // against an empty dir is the "round and round" flailing; fail cleanly.
        const reason = `repository clone failed (network/TLS/auth) — no code in the build VM for ${githubOwner}/${githubRepo}`;
        console.error(`[ticket-executor] ${reason}`);
        await markTicketFailed(ticketId, `Git setup failed — ${reason}`, ownerId, { emitEvent: false });
        return;
      } else {
        gitSetupError = `Git setup issue: ${gitResult.output.slice(0, 200)}`;
        console.warn(`[ticket-executor] ${gitSetupError}`);
      }
    } catch (err) {
      gitSetupError = `Git setup failed: ${err}`;
      console.error(`[ticket-executor] ${gitSetupError}`);
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

      // Create the feature branch from lfg-agent (initAndPushRepo leaves us on lfg-agent)
      const branchScript = `
cd "${WORKING_DIR}/${projectDirName}"
git checkout lfg-agent 2>/dev/null || true
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
  console.log(`[ticket-executor] Step 4: Refreshing credentials from auth sandbox`);
  await refreshCredentialsFromAuthSandbox(ownerId);
  console.log(`[ticket-executor] Step 4: Credentials will be injected by CLI launcher`);
  await addLog(ticketId, "Injecting Claude credentials...", "command", ownerId);

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

    // Inject relevant knowledge base patterns into the prompt
    const knowledgeSection = matchKnowledgeForPrompt(
      `${ticket.name} ${ticket.description ?? ""}`
    );
    if (knowledgeSection) prompt += knowledgeSection;

    // Append git error context and project path info
    prompt += `\n\nPROJECT PATH: ${WORKING_DIR}/${projectDirName}\n`;
    if (gitErrorContext) prompt += gitErrorContext;
  }

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

  let cliResult;
  try {
    cliResult = await startClaudeCli({
      workspaceId,
      prompt,
      projectDir: projectDirName,
      sessionId: existingSessionId,
      userId: ownerId,
      envVars,
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
  // The executor just waits for the ticket.execution_finished event.
  console.log(`[ticket-executor] Waiting for VM to push output via callback API...`);

  const waitResult = await waitForCompletion(ticketId, MAX_WAIT_DURATION_MS);

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

  if (implementationStatus === "complete" && githubOwner && githubRepo && githubToken) {
    try {
      await addLog(ticketId, "Committing changes...", "command", ownerId);
      const { sha } = await commitAndPush({
        workspaceId,
        projectDir: `${WORKING_DIR}/${projectDirName}`,
        commitMessage: `feat: ${ticket.name}`,
        featureBranch,
        repoUrl: `https://github.com/${githubOwner}/${githubRepo}.git`,
        githubToken,
      });

      await db
        .update(projectTickets)
        .set({
          githubBranch: featureBranch,
          githubCommitSha: sha,
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

      // Merge feature branch → lfg-agent (direct push, no PR)
      try {
        await addLog(ticketId, "Merging to lfg-agent...", "command", ownerId);
        const { sha: mergeSha } = await mergeToLfgAgent({
          workspaceId,
          projectDir: `${WORKING_DIR}/${projectDirName}`,
          featureBranch,
          repoUrl: `https://github.com/${githubOwner}/${githubRepo}.git`,
          githubToken,
        });
        await db
          .update(projectTickets)
          .set({
            githubMergeStatus: "merged",
            updatedAt: new Date(),
          })
          .where(eq(projectTickets.id, ticketId));
        await addLog(ticketId, `Merged to lfg-agent (${mergeSha.slice(0, 7)})`, "command", ownerId);

        await logActivity({
          projectId: project.id,
          ticketId,
          actorType: "system",
          activityType: ACTIVITY_TYPES.GIT_MERGED,
          title: `Merged to lfg-agent`,
          description: `Feature branch ${featureBranch} merged (${mergeSha.slice(0, 7)}).`,
          metadata: { mergeSha, branch: featureBranch },
        });
      } catch (mergeErr) {
        console.warn(`[ticket-executor] Merge to lfg-agent failed:`, mergeErr);
        await addLog(ticketId, `Merge to lfg-agent failed: ${mergeErr}`, "command", ownerId);
      }
    } catch (err) {
      await addLog(ticketId, `Git commit failed: ${err}`, "command", ownerId);
    }
  }

  if (implementationStatus === "complete") {
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
    await addLog(ticketId, "Ticket implementation complete!", "command", ownerId);
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "review", queueStatus: "none", stageId: reviewStageId });
  } else {
    await markTicketFailed(ticketId, "Implementation did not complete", ownerId, { emitEvent: false });
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "failed", queueStatus: "none" });
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
}

// ── Chat Resume Executor ──────────────────────────────────────────────

async function executeTicketChat(
  ticketId: string,
  message: string,
  sender: string
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

  const sandbox = await findExistingSandbox(ticketId);
  if (!sandbox?.magsWorkspaceId) {
    await addLog(ticketId, "No active workspace for this ticket. Please build the ticket first.", "command", ownerId);
    return;
  }

  const workspaceId = sandbox.magsWorkspaceId;
  const projectDirName = "project";
  let sessionId = sandbox.cliSessionId ?? undefined;

  // Refresh credentials from auth sandbox (may have been auto-refreshed)
  await refreshCredentialsFromAuthSandbox(ownerId);

  await logActivity({
    projectId: project!.id,
    ticketId,
    actorType: "system",
    activityType: ACTIVITY_TYPES.CREDENTIALS_INJECTED,
    title: "Claude credentials injected",
    description: `Loaded credentials from DB and injected into workspace for chat session.`,
    metadata: { workspaceId },
  });

  // Pre-flight: verify Claude CLI is working
  console.log(`[ticket-executor] Chat: running pre-flight check on workspace ${workspaceId}`);
  const preflight = await preflightCheck(workspaceId, ownerId);
  if (!preflight.ok) {
    console.error(`[ticket-executor] Chat: pre-flight failed:`, preflight.error);
    const errorMsg = preflight.error ?? "Claude CLI is not connected. Please connect Claude Code in Settings.";
    // Mark as disconnected in DB so Settings page shows correct status
    if (preflight.needsReconnect) {
      await markClaudeDisconnected(ownerId);
    }
    // Log as cli_error type so frontend can style it differently
    await addLog(ticketId, errorMsg, "cli_error", ownerId);
    return;
  }
  console.log(`[ticket-executor] Chat: pre-flight passed`);

  const prompt = buildTicketChatPrompt(
    {
      ticket: { id: ticket.id, name: ticket.name, description: ticket.description },
      project: { id: project!.id, name: project!.name },
      callbackBaseUrl: CALLBACK_BASE_URL,
      cliApiKey,
    },
    message
  );

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
  });

  console.log(`[ticket-executor] Chat: CLI started, pid=${chatResult.backgroundPid}, output=${chatResult.outputFile}`);

  // Wait for completion via push-based output streaming
  let waitResult = await waitForCompletion(ticketId, CHAT_MAX_WAIT_DURATION_MS);
  console.log(`[ticket-executor] Chat: wait finished, status=${waitResult.status}, exitCode=${waitResult.exitCode}`);

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
    });

    console.log(`[ticket-executor] Chat: fresh CLI started, pid=${chatResult.backgroundPid}`);
    waitResult = await waitForCompletion(ticketId, CHAT_MAX_WAIT_DURATION_MS);
    console.log(`[ticket-executor] Chat: fresh wait finished, status=${waitResult.status}, exitCode=${waitResult.exitCode}`);
  }

  // ── Commit + push changes made during chat (only if agent succeeded) ─
  // Only attempt git push if the agent exited successfully (exit code 0).
  // A simple Q&A or a failed chat should not trigger commit/push.
  if (waitResult.status === "complete") {
    const [ghToken] = await db
      .select()
      .from(githubTokens)
      .where(eq(githubTokens.userId, ownerId))
      .limit(1);

    const githubToken = ghToken?.accessToken;

    let chatGhOwner: string | null = project!.repoOwner ?? null;
    let chatGhRepo: string | null = project!.repoName ?? null;
    const chatRepoUrl = project!.repoUrl ?? extractRepoUrl(project!.stack ?? "");

    if (!chatGhOwner || !chatGhRepo) {
      if (chatRepoUrl) {
        const ghMatch = chatRepoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
        if (ghMatch) {
          chatGhOwner = ghMatch[1] ?? null;
          chatGhRepo = ghMatch[2] ?? null;
        }
      }
    }

    if (chatGhOwner && chatGhRepo && githubToken) {
      const featureBranch = ticket.githubBranch ?? `feature/ticket-${ticketId}`;
      try {
        await addLog(ticketId, "Checking for code changes...", "command", ownerId);
        const { sha } = await commitAndPush({
          workspaceId,
          projectDir: `${WORKING_DIR}/${projectDirName}`,
          commitMessage: `update: ${ticket.name} (chat)`,
          featureBranch,
          repoUrl: `https://github.com/${chatGhOwner}/${chatGhRepo}.git`,
          githubToken,
        });

        await db
          .update(projectTickets)
          .set({
            githubBranch: featureBranch,
            githubCommitSha: sha,
            updatedAt: new Date(),
          })
          .where(eq(projectTickets.id, ticketId));

        await addLog(ticketId, `Pushed commit ${sha.slice(0, 7)} to ${featureBranch}`, "command", ownerId);

        // Merge feature branch → lfg-agent (direct push)
        try {
          const { sha: mergeSha } = await mergeToLfgAgent({
            workspaceId: sandbox.magsWorkspaceId!,
            projectDir: `${WORKING_DIR}/${projectDirName}`,
            featureBranch,
            repoUrl: `https://github.com/${chatGhOwner}/${chatGhRepo}.git`,
            githubToken,
          });
          await db
            .update(projectTickets)
            .set({ githubMergeStatus: "merged", updatedAt: new Date() })
            .where(eq(projectTickets.id, ticketId));
          await addLog(ticketId, `Merged to lfg-agent (${mergeSha.slice(0, 7)})`, "command", ownerId);
        } catch (mergeErr) {
          console.warn(`[ticket-executor] Chat: merge to lfg-agent failed:`, mergeErr);
        }
      } catch (err) {
        // commitAndPush handles NO_CHANGES gracefully, so this is a real error
        // Don't show git errors to user for chat — it's noise for Q&A interactions
        console.warn(`[ticket-executor] Chat: commit+push failed (silent):`, err);
      }
    }
  }

  // Save credentials back to DB after chat
  const chatSaved = await saveCredentialsFromVm(workspaceId, ownerId);
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
async function getBuilderProvider(projectId: string | null): Promise<ProviderName | null> {
  if (!projectId) return null;
  const [project] = await db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;
  return getProviderName(await resolveBuilderModelKey(project.ownerId));
}

/**
 * Execute a ticket using direct AI API calls (generateText with tools).
 * No Claude CLI credentials needed — calls the AI provider directly.
 */
async function executeTicketApi(ticketId: string): Promise<void> {
  const startTime = Date.now();

  // ── Load data (shared with CLI mode) ────────────────────────────────
  console.log(`[ticket-executor-api] Loading data for ticket ${ticketId}`);
  const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  const [project] = await db.select().from(projects).where(eq(projects.id, ticket.projectId)).limit(1);
  if (!project) throw new Error(`Project ${ticket.projectId} not found`);

  const ownerId = project.ownerId;

  const [ghToken] = await db.select().from(githubTokens).where(eq(githubTokens.userId, ownerId)).limit(1);
  const githubToken = ghToken?.accessToken;

  if (!githubToken) {
    console.warn(`[ticket-executor-api] No GitHub token for user ${ownerId}`);
    await addLog(ticketId, "No GitHub token — code will NOT be saved to a repository.", "command", ownerId);
  }

  const tasks = await db.select().from(projectTodoLists).where(eq(projectTodoLists.ticketId, ticketId));

  // Mark ticket as executing
  await moveTicketToStage(ticketId, project.id, "In Progress");
  await db.update(projectTickets).set({ status: "in_progress", queueStatus: "executing", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));

  let projectDirName = "project";
  const featureBranch = `feature/ticket-${ticketId}`;

  // ── Reuse the project's always-on PREVIEW sandbox via a git WORKTREE ──
  // If the project has a running preview env (env-<projectId> with the repo at
  // /data/project), run this ticket in a worktree there — same env + cached
  // toolchain, on its own branch — instead of a fresh VM + full clone. Only
  // when that sandbox exists; otherwise fall back to the fresh-VM path.
  // Build isolation: "isolated" (default) → a FRESH throwaway pi VM per ticket
  // (build → commit → push → destroy), so a bad build can never disrupt the
  // always-on preview VM (which reconstructs the branch worktree from the remote
  // on demand). "shared" → reuse the preview VM via a git worktree (warm caches).
  const isolatedBuild = ((project as { ticketBuildIsolation?: string }).ticketBuildIsolation ?? "isolated") !== "shared";
  const sharedWorkspaceId = isolatedBuild ? null : await resolvePreviewSandbox(project.id);
  const useWorktree = !!sharedWorkspaceId;
  if (useWorktree) {
    projectDirName = `wt-ticket-${ticketId.slice(0, 12)}`;
    await addLog(ticketId, `Reusing the project's preview sandbox (git worktree ${projectDirName})...`, "command", ownerId);
  } else if (isolatedBuild) {
    await addLog(ticketId, `Isolated build: spinning up a fresh sandbox for this ticket (it's destroyed after the branch is pushed).`, "command", ownerId);
  }

  // ── Resolve builder model early (needed to choose the VM rootfs) ─────
  // Follows the user's chat selection (e.g. DeepSeek) when no explicit builder
  // model is set — NOT a hardcoded Claude.
  const modelKey = await resolveBuilderModelKey(ownerId);
  const [userKeys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, ownerId)).limit(1);
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

  // ── Setup workspace (shared logic) ──────────────────────────────────
  console.log(`[ticket-executor-api] Setting up workspace`);
  let sandboxRow = await findExistingSandbox(ticketId);
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

  if (!useWorktree && workspaceId) {
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
    const { jobId, workspaceId: wsId } = await newWorkspace(workspaceName, {
      diskGb: parseInt(process.env.INSTANT_DISK_GB || "8", 10),
      memGb: parseInt(process.env.INSTANT_MEM_GB || "4", 10),
      // Empty projects → the pre-scaffolded boilerplate rootfs; everything else →
      // the "pi" rootfs (node 22 + Pi preinstalled), same base as the preview VM,
      // so Pi runs without an old-node bootstrap.
      rootfsType: useBoilerplate ? BOILERPLATE_ROOTFS : (process.env.PREVIEW_ROOTFS || "pi"),
    });
    workspaceId = wsId;
    await sleep(8_000);

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
  const auth = await resolveRepoAuth(project, ownerId);
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
git fetch origin 2>&1 || true
if ! git rev-parse --verify origin/lfg-agent 2>/dev/null; then
    echo "CREATING_LFG_AGENT_BRANCH"
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
    git branch lfg-agent origin/$DEFAULT_BRANCH 2>/dev/null || git branch lfg-agent 2>/dev/null || true
    git push -u origin lfg-agent 2>&1 || true
fi
git worktree remove --force ${WORKING_DIR}/${projectDirName} 2>/dev/null || true
rm -rf ${WORKING_DIR}/${projectDirName} 2>/dev/null || true
git worktree prune 2>/dev/null || true
if git rev-parse --verify origin/${featureBranch} 2>/dev/null; then
    git worktree add --force -B ${featureBranch} ${WORKING_DIR}/${projectDirName} origin/${featureBranch} 2>&1
else
    git worktree add --force -B ${featureBranch} ${WORKING_DIR}/${projectDirName} origin/lfg-agent 2>&1 || git worktree add --force -B ${featureBranch} ${WORKING_DIR}/${projectDirName} lfg-agent 2>&1
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
    git fetch origin
    git reset --hard HEAD 2>/dev/null || true
    git clean -fd 2>/dev/null || true
elif [ -d "${projectDirName}" ] && [ "$(ls -A ${projectDirName} 2>/dev/null)" ]; then
    echo "INIT_EXISTING_DIR"
    cd ${projectDirName}
    git init
    git remote add origin "${auth.authUrl}" 2>/dev/null || \\
        git remote set-url origin "${auth.authUrl}"
    git fetch origin
else
    echo "CLONING_REPO"
    rm -rf ${projectDirName}
    git clone "${auth.authUrl}" ${projectDirName} 2>&1
    # A failed clone (TLS/network/auth) leaves no dir — do NOT fall through and run
    # git ops in the parent (WORKING_DIR); fail loudly so the caller aborts.
    cd ${projectDirName} 2>/dev/null || { echo "GIT_CLONE_FAILED"; exit 1; }
    [ -d ".git" ] || { echo "GIT_CLONE_FAILED"; exit 1; }
fi

if ! git rev-parse --verify origin/lfg-agent 2>/dev/null; then
    echo "CREATING_LFG_AGENT_BRANCH"
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
    git checkout "$DEFAULT_BRANCH" 2>/dev/null || git checkout main 2>/dev/null || true
    git checkout -b lfg-agent
    git push -u origin lfg-agent 2>&1
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
    git checkout origin/lfg-agent 2>/dev/null || git checkout lfg-agent 2>/dev/null || true
    git checkout -b ${featureBranch}
fi

git config user.email "ai@lfg.dev"
git config user.name "LFG AI"

# Verify we actually have a repo — a failed clone (TLS/network) leaves no .git,
# and without this the script would report success against an empty dir.
if [ -d ".git" ]; then echo "GIT_SETUP_COMPLETE"; else echo "GIT_SETUP_FAILED_NO_GIT"; fi
pwd
git branch --show-current
`.trim();

    const gitSetupScript = useWorktree ? worktreeScript : cloneScript;

    try {
      const gitScriptB64 = Buffer.from(gitSetupScript).toString("base64");
      const gitResult = await execOnWorkspace(workspaceId, `echo ${gitScriptB64} | base64 -d | sh`, { timeout: 120_000 });

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
      await markTicketFailed(ticketId, `Git setup failed — ${(err as Error).message}`, ownerId, { emitEvent: false });
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

      const branchScript = `cd "${WORKING_DIR}/${projectDirName}" && git checkout lfg-agent 2>/dev/null || true && git checkout -b ${featureBranch} && echo "BRANCH_CREATED"`;
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

  if (projectEnvRows.length > 0) {
    const envExports = projectEnvRows.map(r => `export ${r.key}="${decrypt(r.encryptedValue).replace(/"/g, '\\"')}"`).join("\n");
    const envB64 = Buffer.from(envExports).toString("base64");
    // Write to /etc/profile.d so all shells get them
    await execOnWorkspace(workspaceId, `echo ${envB64} | base64 -d > /etc/profile.d/lfg_env.sh && source /etc/profile.d/lfg_env.sh`, { timeout: 15_000 });
    console.log(`[ticket-executor-api] Injected ${projectEnvRows.length} env vars`);
  }

  // ── Build prompt + tools ────────────────────────────────────────────
  console.log(`[ticket-executor-api] Building prompt and tools`);

  const savedTechStack = sandboxRow.techStack as { language?: string; framework?: string; packageManager?: string; startCommand?: string; buildCommand?: string; port?: number; } | null;

  const systemPrompt = buildApiBuilderPrompt({
    ticket: {
      id: ticket.id,
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
  });

  const projectDir = `${WORKING_DIR}/${projectDirName}`;

  const tools = createBuilderTools({
    workspaceId,
    ticketId,
    projectId: project.id,
    userId: ownerId,
    projectDir,
  });

  // ── Model resolved early (appState/modelKey/userKeys/provider up top) ──
  const model = getModel(modelKey, {
    anthropic: userKeys?.anthropicApiKey ?? undefined,
    openai: userKeys?.openaiApiKey ?? undefined,
    google: userKeys?.googleApiKey ?? undefined,
    kimi: userKeys?.kimiApiKey ?? undefined,
    deepseek: userKeys?.deepseekApiKey ?? undefined,
    glm: userKeys?.glmApiKey ?? undefined,
  });

  console.log(`[ticket-executor-api] Using model: ${modelKey}`);

  let implementationStatus = "failed" as "complete" | "failed";

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
  const usePi = USE_PI_TICKET_BUILDER && !!provider && isPiSupportedProvider(provider) && !!providerApiKey;

  if (usePi && provider && providerApiKey) {
    // ── Pi coding agent inside the VM (model-agnostic, robust) ──────────
    await addLog(ticketId, `Starting Pi build (${provider}/${piModelId})...`, "command", ownerId);
    console.log(`[ticket-executor-api] Using Pi in-sandbox agent: ${provider}/${piModelId}`);
    const piEnvVars: Record<string, string> = {};
    for (const r of projectEnvRows) piEnvVars[r.key] = decrypt(r.encryptedValue);
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
    });
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
      const pi = await startPiCli({
        workspaceId,
        prompt: piPrompt,
        projectDir: projectDirName,
        provider,
        modelId: piModelId,
        apiKey: providerApiKey,
        envVars: piEnvVars,
        forward: webhookReachable ? { apiUrl: CALLBACK_BASE_URL, apiKey: cliApiKey, mode: "ticket" as const, ticketId } : undefined,
      });
      if (webhookReachable) await addLog(ticketId, "Streaming build logs via webhook…", "command", ownerId);
      let lastPiLog = 0;
      const piResult = await streamPiToCompletion({
        workspaceId,
        outputFile: pi.outputFile,
        backgroundPid: pi.backgroundPid,
        timeoutMs: 30 * 60 * 1000,
        // Webhook active → poll is completion-only. Otherwise poll → logs.
        onProgress: webhookReachable ? undefined : (msg) => {
          const now = Date.now();
          if (now - lastPiLog < 4_000) return;
          lastPiLog = now;
          void addLog(ticketId, msg, "command", ownerId).catch(() => {});
        },
      });
      const piOk = (piResult.exitCode === null || piResult.exitCode === 0) && !piResult.fatalError && piResult.didWork;
      if (piOk) {
        implementationStatus = "complete";
      } else {
        const reason = piResult.fatalError
          ?? (piResult.exitCode ? `exit code ${piResult.exitCode}` : (!piResult.didWork ? "no changes were made" : "unknown error"));
        await addLog(ticketId, `Pi build failed: ${reason}`, "command", ownerId);
        console.error(`[ticket-executor-api] Pi failed (${reason}). Output tail:\n${piResult.tail.slice(-2000)}`);
      }
    } catch (err) {
      await addLog(ticketId, `Pi build error: ${(err as Error).message}`, "command", ownerId);
      console.error(`[ticket-executor-api] Pi error:`, err);
    }

  } else {
  await addLog(ticketId, `Starting AI execution (${modelKey})...`, "command", ownerId);

  // ── Run generateText with tools (fallback / TICKET_BUILDER=agent) ────
  const abortController = new AbortController();
  const abortTimeout = setTimeout(() => abortController.abort(), 30 * 60 * 1000); // 30 min

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
  if (implementationStatus === "complete" && pushAuth) {
    try {
      await addLog(ticketId, "Committing changes...", "command", ownerId);
      const { sha } = await commitAndPush({
        workspaceId,
        projectDir,
        commitMessage: `feat: ${ticket.name}`,
        featureBranch,
        repoUrl: pushAuth.repoUrl,
        githubToken: pushAuth.token,
        tokenUser: pushAuth.tokenUser,
      });

      await db.update(projectTickets).set({ githubBranch: featureBranch, githubCommitSha: sha, updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));

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
        await addLog(ticketId, "Merging to lfg-agent...", "command", ownerId);
        const { sha: mergeSha } = await mergeToLfgAgent({
          workspaceId,
          projectDir,
          featureBranch,
          repoUrl: pushAuth.repoUrl,
          githubToken: pushAuth.token,
          tokenUser: pushAuth.tokenUser,
        });
        await db.update(projectTickets).set({ githubMergeStatus: "merged", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
        await addLog(ticketId, `Merged to lfg-agent (${mergeSha.slice(0, 7)})`, "command", ownerId);
      } catch (mergeErr) {
        console.warn(`[ticket-executor-api] Merge to lfg-agent failed:`, mergeErr);
      }
    } catch (err) {
      // A failed commit/push means the work is NOT saved — do NOT report success.
      commitFailed = true;
      const msg = (err as Error).message?.slice(0, 400) ?? String(err);
      await addLog(ticketId, `Git commit/push FAILED — changes were NOT saved: ${msg}`, "command", ownerId);
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
    await addLog(ticketId, "Ticket implementation complete!", "command", ownerId);
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "review", queueStatus: "none", stageId: reviewStageId });
  } else {
    const reason = commitFailed
      ? "the changes were built but the commit/push failed — the work is preserved in the ticket's worktree; fix the cause and retry"
      : "Implementation did not complete";
    await markTicketFailed(ticketId, reason, ownerId, { emitEvent: false });
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "failed", queueStatus: "none" });
  }

  // ISOLATED build: the throwaway pi VM has done its job — the branch is on the
  // remote (on success) and the logs are persisted. Destroy it so it can't
  // accumulate cost or disrupt anything; previewing the ticket reconstructs the
  // branch worktree in the always-on preview VM from the remote.
  if (isolatedBuild && !useWorktree && workspaceId) {
    await addLog(ticketId, "Isolated build finished — destroying the throwaway build sandbox…", "command", ownerId);
    await deleteWorkspace(workspaceId).catch((e) => console.warn(`[ticket-executor-api] destroy build VM failed:`, e));
    await db.update(sandboxes).set({ status: "destroyed", updatedAt: new Date() }).where(eq(sandboxes.ticketId, ticketId)).catch(() => {});
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
 * ticket.execution_finished when done=true is received.
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
      bus.off("ticket.execution_finished", handler);
    };

    bus.on("ticket.execution_finished", handler);
  });
}

async function findExistingSandbox(ticketId: string) {
  // Match the ticket's sandbox regardless of workspaceType — worktree runs store
  // "ticket-worktree", so restricting to "ticket" meant retries never found the
  // existing row and re-inserted (→ unique-constraint clash on the shared
  // preview workspace).
  const result = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.ticketId, ticketId))
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

async function markTicketFailed(ticketId: string, reason: string, userId?: string, opts?: { emitEvent?: boolean }) {
  await db
    .update(projectTickets)
    .set({
      status: "failed",
      queueStatus: "none",
      updatedAt: new Date(),
    })
    .where(eq(projectTickets.id, ticketId));

  await addLog(ticketId, `Execution failed: ${reason}`, "command", userId);

  // Emit execution_finished so the handler chain continues (auto-queue next ticket).
  // Only emit when the caller hasn't already triggered this event (e.g., early failures
  // before the CLI starts). Normal-flow failures already have the event from the CLI callback.
  if (opts?.emitEvent !== false) {
    const projectId = await resolveProjectIdForTicket(ticketId);
    emit({
      type: "ticket.execution_finished",
      ticketId,
      projectId: projectId ?? undefined,
      status: "failed",
      exitCode: 1,
    });
  }
}

function extractRepoUrl(stack: string): string | null {
  const match = stack.match(/https?:\/\/[^\s]+\.git|https?:\/\/github\.com\/[^\s]+/);
  return match?.[0] ?? null;
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
        .select({ magsWorkspaceId: sandboxes.magsWorkspaceId })
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
        })
        .from(projects)
        .where(eq(projects.id, ticket.projectId))
        .limit(1);

      if (!project?.repoOwner || !project?.repoName) continue;

      const [ghToken] = await db
        .select({ accessToken: githubTokens.accessToken })
        .from(githubTokens)
        .where(eq(githubTokens.userId, project.ownerId))
        .limit(1);

      if (!ghToken?.accessToken) continue;

      console.log(`[ticket-executor] Recovery: pushing unpushed ticket "${ticket.name}" (${ticket.id})`);

      const workspaceId = sandbox.magsWorkspaceId;
      const featureBranch = ticket.githubBranch ?? `feature/ticket-${ticket.id}`;
      const projectDirName = "project";

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

      try {
        const { sha } = await commitAndPush({
          workspaceId,
          projectDir: `${WORKING_DIR}/${projectDirName}`,
          commitMessage: `feat: ${ticket.name}`,
          featureBranch,
          repoUrl: `https://github.com/${project.repoOwner}/${project.repoName}.git`,
          githubToken: ghToken.accessToken,
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
          const { sha: mergeSha } = await mergeToLfgAgent({
            workspaceId,
            projectDir: `${WORKING_DIR}/${projectDirName}`,
            featureBranch,
            repoUrl: `https://github.com/${project.repoOwner}/${project.repoName}.git`,
            githubToken: ghToken.accessToken,
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
            title: `Merged to lfg-agent (recovered)`,
            description: `Feature branch ${featureBranch} merged (${mergeSha.slice(0, 7)}).`,
            metadata: { mergeSha, branch: featureBranch, recovered: true },
          });
        } catch (mergeErr) {
          console.warn(`[ticket-executor] Recovery merge failed for ${ticket.id}:`, mergeErr);
        }

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
