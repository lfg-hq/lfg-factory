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
import { profiles, githubTokens, applicationState, llmApiKeys } from "../db/schema/users.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { decrypt } from "../ai/tools/env-tools.ts";
import { bus, emit } from "../events/bus.ts";
import {
  newWorkspace,
  execOnWorkspace,
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
import { getModel } from "../ai/provider.ts";
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
const MAX_WAIT_DURATION_MS = 45 * 60 * 1000; // 45 minutes
const CHAT_MAX_WAIT_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const WORKING_DIR = "/root";

// Concurrency guard: only one ticket per project at a time
const executingProjects = new Set<string>();

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
    const projectId = event.payload.projectId ?? await resolveProjectIdForTicket(ticketId);

    // Determine execution mode from user's applicationState
    const useApiMode = await isApiMode(projectId);

    if (useApiMode) {
      // API mode: no per-project concurrency guard — parallel execution allowed
      console.log(`[ticket-executor] API mode — executing ticket ${ticketId} (parallel OK)`);
      try {
        await executeTicketApi(ticketId);
      } catch (err) {
        console.error(`[ticket-executor] API mode failed for ticket ${ticketId}:`, err);
        await markTicketFailed(ticketId, String(err));
      }
    } else {
      // CLI mode: only one ticket per project at a time
      if (projectId && executingProjects.has(projectId)) {
        console.log(`[ticket-executor] Project ${projectId} already executing — deferring ticket ${ticketId}`);
        await db
          .update(projectTickets)
          .set({ queueStatus: "none", updatedAt: new Date() })
          .where(eq(projectTickets.id, ticketId));
        return;
      }

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
    await addLog(ticketId, "Reconnecting to existing sandbox...", "command", ownerId);
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

    const { jobId, workspaceId: wsId } = await newWorkspace(workspaceName);
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
    git clone https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git ${projectDirName}
    cd ${projectDirName}
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

echo "GIT_SETUP_COMPLETE"
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
    description: `Loaded credentials from DB and injected into sandbox for ticket execution.`,
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
    await addLog(ticketId, "No active sandbox for this ticket. Please build the ticket first.", "command", ownerId);
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
    description: `Loaded credentials from DB and injected into sandbox for chat session.`,
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

  const projectDirName = "project";
  const featureBranch = `feature/ticket-${ticketId}`;

  // ── Setup workspace (shared logic) ──────────────────────────────────
  console.log(`[ticket-executor-api] Setting up workspace`);
  let sandboxRow = await findExistingSandbox(ticketId);
  let workspaceId = sandboxRow?.magsWorkspaceId ?? null;

  if (workspaceId) {
    await addLog(ticketId, "Reconnecting to existing sandbox...", "command", ownerId);
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
    await addLog(ticketId, "Creating VM workspace...", "command", ownerId);
    const { jobId, workspaceId: wsId } = await newWorkspace(workspaceName);
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

  // ── Git setup (same as CLI mode) ────────────────────────────────────
  console.log(`[ticket-executor-api] Setting up git`);
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
    git remote add origin https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git 2>/dev/null || \\
        git remote set-url origin https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git
    git fetch origin
else
    echo "CLONING_REPO"
    rm -rf ${projectDirName}
    git clone https://${githubToken}@github.com/${githubOwner}/${githubRepo}.git ${projectDirName}
    cd ${projectDirName}
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

echo "GIT_SETUP_COMPLETE"
pwd
git branch --show-current
`.trim();

    try {
      const gitScriptB64 = Buffer.from(gitSetupScript).toString("base64");
      const gitResult = await execOnWorkspace(workspaceId, `echo ${gitScriptB64} | base64 -d | sh`, { timeout: 120_000 });

      if (gitResult.output.includes("GIT_SETUP_COMPLETE")) {
        if (!ticket.githubBranch) {
          await db.update(projectTickets).set({ githubBranch: featureBranch, githubMergeStatus: "pending", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
        }
      }
    } catch (err) {
      console.error(`[ticket-executor-api] Git setup failed:`, err);
    }
  } else if (githubToken) {
    // Auto-create repo
    const repoName = project.providedName || project.name;
    await addLog(ticketId, `Creating GitHub repository: ${repoName}...`, "command", ownerId);
    try {
      const repoResult = await createGitHubRepo({ repoName, description: `LFG Project: ${project.name}`, isPrivate: true, githubToken });
      githubOwner = repoResult.owner;
      githubRepo = repoResult.repoName;

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

  // ── Get model from user's settings ──────────────────────────────────
  const [appState] = await db.select().from(applicationState).where(eq(applicationState.userId, ownerId)).limit(1);
  const modelKey = appState?.builderModelKey ?? "claude_4.5_sonnet";

  const [userKeys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, ownerId)).limit(1);
  const model = getModel(modelKey, {
    anthropic: userKeys?.anthropicApiKey ?? undefined,
    openai: userKeys?.openaiApiKey ?? undefined,
    google: userKeys?.googleApiKey ?? undefined,
  });

  console.log(`[ticket-executor-api] Using model: ${modelKey}`);
  await addLog(ticketId, `Starting AI execution (${modelKey})...`, "command", ownerId);

  // ── Run generateText with tools ─────────────────────────────────────
  const abortController = new AbortController();
  const abortTimeout = setTimeout(() => abortController.abort(), 30 * 60 * 1000); // 30 min

  let implementationStatus = "failed" as "complete" | "failed";

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

  // ── Finalize: commit, push, merge ───────────────────────────────────
  const durationMs = Date.now() - startTime;

  if (implementationStatus === "complete" && githubOwner && githubRepo && githubToken) {
    try {
      await addLog(ticketId, "Committing changes...", "command", ownerId);
      const { sha } = await commitAndPush({
        workspaceId,
        projectDir,
        commitMessage: `feat: ${ticket.name}`,
        featureBranch,
        repoUrl: `https://github.com/${githubOwner}/${githubRepo}.git`,
        githubToken,
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
          repoUrl: `https://github.com/${githubOwner}/${githubRepo}.git`,
          githubToken,
        });
        await db.update(projectTickets).set({ githubMergeStatus: "merged", updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
        await addLog(ticketId, `Merged to lfg-agent (${mergeSha.slice(0, 7)})`, "command", ownerId);
      } catch (mergeErr) {
        console.warn(`[ticket-executor-api] Merge to lfg-agent failed:`, mergeErr);
      }
    } catch (err) {
      await addLog(ticketId, `Git commit failed: ${err}`, "command", ownerId);
    }
  }

  if (implementationStatus === "complete") {
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
    await markTicketFailed(ticketId, "Implementation did not complete", ownerId, { emitEvent: false });
    broadcastToUser(ownerId, { type: "ticket_status", ticketId, status: "failed", queueStatus: "none" });
  }
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
  const result = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.ticketId, ticketId),
        eq(sandboxes.workspaceType, "ticket")
      )
    )
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
        console.warn(`[ticket-executor] Recovery git push failed for ${ticket.id}:`, err);
        await addLog(ticket.id, `Recovery: git push failed — ${err}`, "command", project.ownerId);
      }
    }
  } catch (err) {
    console.error("[ticket-executor] recoverUnpushedTickets error:", err);
  }
}
