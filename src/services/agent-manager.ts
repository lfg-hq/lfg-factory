/**
 * Agent Manager — Core lifecycle management for autonomous agents
 *
 * Handles creating, starting, stopping, and commanding agents.
 * Each agent runs in its own Mags sandbox with Claude CLI.
 *
 * Every task execution is represented by an agentRuns row. The scheduler,
 * webhook endpoint, "Run Now" button, and chat all converge on runCommand()
 * which is the single entry point for dispatching work to an agent.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { agents, agentMessages, agentTaskRuns } from "../db/schema/agents.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { profiles } from "../db/schema/users.ts";
import { conversations } from "../db/schema/chat.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { newWorkspace, execOnWorkspace, enableHttpAccess, stopWorkspace, findJob } from "./mags.ts";
import {
  injectCredentials,
  startClaudeCliChat,
  saveCredentialsFromVm,
} from "./claude-cli.ts";
import {
  injectComposioConfig,
  injectMemory,
  injectDataFiles,
  buildAgentPrompt,
  injectClaudeMd,
  injectSecrets,
  loadSecretsForCli,
  buildCapabilitiesIndex,
  injectCapabilities,
} from "./agent-sandbox.ts";
import { loadDecryptedSecretsByRowId } from "./agent-secrets.ts";
import { agentBus } from "../events/agent-bus.ts";
import { generateToken } from "../utils/crypto.ts";
import {
  createRun,
  markRunStarted,
  finishRun,
  getActiveRunForAgent,
  cancelActiveRuns,
  type RunTrigger,
} from "./agent-runs.ts";

export interface CreateAgentInput {
  userId: string;
  name?: string;
  personality?: string;
  instructions?: string;
  composioToolkits?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentRecord {
  id: string;
  agentId: string;
  name: string;
  status: string;
  personality: string | null;
  instructions: string | null;
  sandboxUrl: string | null;
  composioToolkits: string[] | null;
  memoryContent: string | null;
  conversationId: string | null;
  webhookToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function sanitizeAgentName(name: string): string {
  return (name || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "agent";
}

/**
 * Create a new agent record in the DB.
 */
export async function createAgent(input: CreateAgentInput): Promise<AgentRecord> {
  const name = (input.name && input.name.trim()) || "New Agent";

  // Create a conversation for the agent
  const convRows = await db
    .insert(conversations)
    .values({
      userId: input.userId,
      title: `Agent: ${name}`,
    })
    .returning();
  const conv = convRows[0]!;

  const agentRows = await db
    .insert(agents)
    .values({
      userId: input.userId,
      name,
      personality: input.personality ?? null,
      instructions: input.instructions ?? null,
      composioToolkits: input.composioToolkits ?? [],
      conversationId: conv.id,
      webhookToken: generateToken(24),
      metadata: input.metadata ?? {},
      status: "idle",
    })
    .returning();
  const agent = agentRows[0]!;

  console.log(`[agent-manager] Created agent ${agent.agentId} (${name}) for user ${input.userId}`);

  return {
    id: agent.id,
    agentId: agent.agentId,
    name: agent.name,
    status: agent.status,
    personality: agent.personality,
    instructions: agent.instructions,
    sandboxUrl: agent.sandboxUrl,
    composioToolkits: agent.composioToolkits as string[] | null,
    memoryContent: agent.memoryContent,
    conversationId: agent.conversationId,
    webhookToken: agent.webhookToken,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

// ── Internal: provision sandbox & inject all state ────────────────────
//
// Extracted from startAgent so it can be reused when the scheduler needs to
// auto-start an agent. Returns the workspaceId + injected context so callers
// can launch a CLI without re-doing the work.

interface ProvisionedSandbox {
  workspaceId: string;
  secretKeys: string[];
  secretsAsEnv: Record<string, string>;
}

async function provisionAndInject(
  agent: typeof agents.$inferSelect,
  userId: string
): Promise<ProvisionedSandbox> {
  const workspaceName = `agent-${sanitizeAgentName(agent.name)}-${agent.agentId.slice(0, 8)}`;
  let sandboxRecord = agent.sandboxId
    ? await db.select().from(sandboxes).where(eq(sandboxes.id, agent.sandboxId)).then((r) => r[0])
    : null;

  let workspaceId: string;

  if (sandboxRecord?.magsWorkspaceId) {
    const existing = await findJob(sandboxRecord.magsWorkspaceId);
    if (existing && (existing.status === "running" || existing.status === "sleeping")) {
      workspaceId = sandboxRecord.magsWorkspaceId;
      console.log(`[agent-manager] Reusing existing workspace ${workspaceId}`);
    } else {
      const ws = await newWorkspace(workspaceName);
      workspaceId = ws.workspaceId;
      await db
        .update(sandboxes)
        .set({ magsWorkspaceId: workspaceId, magsJobId: ws.jobId, status: "ready", updatedAt: new Date() })
        .where(eq(sandboxes.id, sandboxRecord.id));
    }
  } else {
    const ws = await newWorkspace(workspaceName);
    workspaceId = ws.workspaceId;

    const sbRows = await db
      .insert(sandboxes)
      .values({
        userId,
        magsWorkspaceId: workspaceId,
        magsJobId: ws.jobId,
        workspaceType: "agent",
        status: "ready",
      })
      .returning();
    const sb = sbRows[0]!;

    sandboxRecord = sb;
    await db
      .update(agents)
      .set({ sandboxId: sb.id, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
  }

  // Inject credentials (Claude OAuth)
  await injectCredentials(workspaceId, userId);

  // Inject Composio config
  const toolkitSlugs = (agent.composioToolkits as string[] | null) ?? [];
  if (toolkitSlugs.length) {
    await injectComposioConfig(workspaceId, toolkitSlugs, userId);
  }

  // Inject secrets (/root/.env) and load for CLI envVars
  const secretKeys = await injectSecrets(workspaceId, agent.id);
  const secretsAsEnv = await loadSecretsForCli(agent.id);

  // Inject capabilities index (/root/capabilities.json)
  const decryptedSecrets = await loadDecryptedSecretsByRowId(agent.id);
  const capabilities = buildCapabilitiesIndex({
    composioToolkits: toolkitSlugs,
    secrets: decryptedSecrets,
  });
  await injectCapabilities(workspaceId, capabilities);

  // Inject memory
  await injectMemory(workspaceId, agent.memoryContent);

  // Inject data files
  await injectDataFiles(workspaceId, agent.id);

  // Build & inject CLAUDE.md
  const apiUrl = process.env.LFG_API_URL || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  const claudeMd = buildAgentPrompt({
    name: agent.name,
    personality: agent.personality,
    instructions: agent.instructions,
    composioToolkits: toolkitSlugs,
    secretKeys,
    callbackUrl: `${apiUrl}/api/v1/cli/agent-output`,
    stateApiUrl: `${apiUrl}/api/v1/cli/agent-state`,
    agentId: agent.agentId,
  });
  await injectClaudeMd(workspaceId, claudeMd);

  // Enable HTTP access
  try {
    const url = await enableHttpAccess(workspaceId);
    await db
      .update(agents)
      .set({ sandboxUrl: url, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
  } catch {
    console.log("[agent-manager] HTTP access not available for this workspace");
  }

  return { workspaceId, secretKeys, secretsAsEnv };
}

/**
 * Lightweight workspace provisioner for the new "mags run" model.
 *
 * Unlike provisionAndInject which boots a persistent Claude CLI session +
 * registers callback URLs + injects CLAUDE.md, this just ensures a Mags
 * workspace exists for the agent. Each compute task is then dispatched
 * synchronously via execOnWorkspace. No long-lived process, no callbacks.
 *
 * Injects the bare minimum the LLM-written commands might need:
 *   - /root/.env with the agent's secrets (so commands can `source .env`)
 *   - /root/data/ restored from S3 (so files persist across runs)
 */
export async function ensureWorkspace(
  agentId: string,
  userId: string
): Promise<{ workspaceId: string }> {
  const tag = `[ensureWorkspace ${agentId.slice(0, 8)}]`;
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, userId)))
    .limit(1);
  if (!agent) throw new Error("Agent not found");

  const workspaceName = `agent-${sanitizeAgentName(agent.name)}-${agent.agentId.slice(0, 8)}`;
  let sandboxRecord = agent.sandboxId
    ? await db.select().from(sandboxes).where(eq(sandboxes.id, agent.sandboxId)).then((r) => r[0])
    : null;

  let workspaceId: string;

  if (sandboxRecord?.magsWorkspaceId) {
    const existing = await findJob(sandboxRecord.magsWorkspaceId);
    if (existing && (existing.status === "running" || existing.status === "sleeping")) {
      workspaceId = sandboxRecord.magsWorkspaceId;
      console.log(`${tag} reusing workspace=${workspaceId} (mags status=${existing.status})`);
    } else {
      console.log(`${tag} prior workspace gone (status=${existing?.status ?? "none"}), creating new "${workspaceName}"`);
      const t0 = Date.now();
      const ws = await newWorkspace(workspaceName);
      workspaceId = ws.workspaceId;
      console.log(`${tag} created workspace=${workspaceId} in ${Date.now() - t0}ms`);
      await db
        .update(sandboxes)
        .set({ magsWorkspaceId: workspaceId, magsJobId: ws.jobId, status: "ready", updatedAt: new Date() })
        .where(eq(sandboxes.id, sandboxRecord.id));
    }
  } else {
    console.log(`${tag} no sandbox record, creating fresh workspace "${workspaceName}"`);
    const t0 = Date.now();
    const ws = await newWorkspace(workspaceName);
    workspaceId = ws.workspaceId;
    console.log(`${tag} created workspace=${workspaceId} in ${Date.now() - t0}ms`);
    const sbRows = await db
      .insert(sandboxes)
      .values({
        userId,
        magsWorkspaceId: workspaceId,
        magsJobId: ws.jobId,
        workspaceType: "agent",
        status: "ready",
      })
      .returning();
    await db
      .update(agents)
      .set({ sandboxId: sbRows[0]!.id, status: "running", updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
  }

  // Always inject secrets + restore data files. Cheap on a warm workspace,
  // required on a cold one. injectSecrets is idempotent.
  try {
    const t0 = Date.now();
    await injectSecrets(workspaceId, agent.id);
    console.log(`${tag} injectSecrets ok in ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`${tag} injectSecrets failed:`, (err as Error).message);
  }
  try {
    const t0 = Date.now();
    await injectDataFiles(workspaceId, agent.id);
    console.log(`${tag} injectDataFiles ok in ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`${tag} injectDataFiles failed:`, (err as Error).message);
  }

  // Bootstrap the persistent Python kernel server if not already running.
  // Idempotent — fast no-op on a warm workspace where the process is already
  // alive, ~30-60s cold (pip install). Subsequent runPython calls hit the
  // server's persistent namespace so df survives across turns.
  try {
    const t0 = Date.now();
    await ensurePythonKernel(workspaceId);
    console.log(`${tag} ensurePythonKernel ok in ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`${tag} ensurePythonKernel failed:`, (err as Error).message);
  }

  return { workspaceId };
}

// ── Persistent Python kernel inside the sandbox ──────────────────────
// A tiny Flask server holding a single Python interpreter namespace. The
// sandbox CLI doesn't run on every turn; instead the host POSTs code to
// http://127.0.0.1:8765/exec via SSH+curl. df, imports, plot figures all
// survive between turns because the process is long-lived.
//
// The Mags VM idle-reaper checks for "user processes other than system
// daemons" — our Flask server counts, so the VM stays awake as long as it
// runs. If the VM does get parked (no SSH in 10min), the kernel dies; the
// next ensurePythonKernel call restarts it (data in /root/data persists
// via S3 sync; data in the kernel's RAM does not — that's expected).

const KERNEL_SERVER_SCRIPT = `\
import io, sys, traceback, contextlib, json
from flask import Flask, request, jsonify

app = Flask(__name__)
NS = {"__name__": "__main__"}

@app.route("/health")
def health():
    return "ok"

@app.route("/exec", methods=["POST"])
def execute():
    code = request.get_data(as_text=True)
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    err_str = None
    try:
        with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
            try:
                # Try as expression first so single-expr cells echo their value
                result = eval(compile(code, "<cell>", "eval"), NS)
                if result is not None:
                    print(repr(result))
            except SyntaxError:
                exec(compile(code, "<cell>", "exec"), NS)
    except BaseException:
        err_str = traceback.format_exc()
    return jsonify({
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue() + (err_str or ""),
        "ok": err_str is None,
    })

if __name__ == "__main__":
    # 127.0.0.1 only — host reaches it via SSH-tunneled curl, never publicly
    app.run(host="127.0.0.1", port=8765, debug=False, use_reloader=False)
`;

const KERNEL_PORT = 8765;

export async function ensurePythonKernel(workspaceId: string): Promise<void> {
  // Fast path: server already running?
  const health = await execOnWorkspace(
    workspaceId,
    `curl -sf -m 2 http://127.0.0.1:${KERNEL_PORT}/health || echo __NOPE__`,
    { timeout: 8_000 }
  );
  if (health.output.includes("ok") && !health.output.includes("__NOPE__")) {
    return; // already up
  }

  // Cold-path bootstrap. Idempotent.
  const scriptB64 = Buffer.from(KERNEL_SERVER_SCRIPT).toString("base64");
  const bootstrap = `\
set -e
# Write the kernel server (overwrite each time so updates land)
echo ${scriptB64} | base64 -d > /root/kernel_server.py

# Create venv once
if [ ! -x /root/venv/bin/python3 ]; then
  python3 -m venv /root/venv
fi

# Install required packages (fast no-op if already installed)
/root/venv/bin/pip install -q --disable-pip-version-check \
  flask pandas numpy matplotlib plotly seaborn openpyxl scikit-learn

# Kill any stale instance
pkill -f kernel_server.py 2>/dev/null || true
sleep 0.2

# Start in background, fully detached so SSH session closing doesn't kill it
nohup /root/venv/bin/python3 /root/kernel_server.py > /tmp/kernel.log 2>&1 &
disown

echo BOOTSTRAP_DONE
`;
  const bootstrapB64 = Buffer.from(bootstrap).toString("base64");
  await execOnWorkspace(
    workspaceId,
    `echo ${bootstrapB64} | base64 -d | bash`,
    { timeout: 180_000 } // pip install can take ~60s on cold workspace
  );

  // Wait for /health to come up (up to ~10s)
  for (let i = 0; i < 20; i++) {
    const h = await execOnWorkspace(
      workspaceId,
      `curl -sf -m 2 http://127.0.0.1:${KERNEL_PORT}/health || echo __NOPE__`,
      { timeout: 5_000 }
    );
    if (h.output.includes("ok") && !h.output.includes("__NOPE__")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Python kernel server failed to start within 10s");
}

/**
 * POST a chunk of Python code to the in-sandbox kernel server.
 * Returns { ok, stdout, stderr } — code runs in the persistent namespace
 * so variables / imports / DataFrames survive between calls.
 */
export async function runPythonInKernel(
  workspaceId: string,
  code: string,
  opts: { timeout?: number } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const codeB64 = Buffer.from(code).toString("base64");
  // Pipe the base64'd code through curl as a raw POST body.
  // --data-binary @- reads stdin as the body verbatim.
  const cmd = `echo ${codeB64} | base64 -d | curl -s -X POST --data-binary @- -H 'Content-Type: text/plain' http://127.0.0.1:${KERNEL_PORT}/exec`;
  const result = await execOnWorkspace(workspaceId, cmd, { timeout: opts.timeout ?? 300_000 });
  try {
    const parsed = JSON.parse(result.output);
    return {
      ok: !!parsed.ok,
      stdout: parsed.stdout ?? "",
      stderr: parsed.stderr ?? "",
    };
  } catch {
    return {
      ok: false,
      stdout: "",
      stderr: `Kernel server returned non-JSON response: ${result.output.slice(0, 500)}\n(SSH stderr: ${result.stderr.slice(0, 200)})`,
    };
  }
}

/**
 * Start an agent: provision sandbox, inject config, run initial instructions
 * as the first agentRun.
 */
export async function startAgent(agentId: string, userId: string): Promise<void> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, userId)))
    .limit(1);

  if (!agent) throw new Error("Agent not found");
  if (agent.status === "running" || agent.status === "starting") {
    throw new Error(`Agent is already ${agent.status}`);
  }

  await db
    .update(agents)
    .set({ status: "starting", lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(agents.id, agent.id));

  broadcastToUser(userId, {
    type: "agent_status",
    agent_id: agentId,
    status: "starting",
    message: "Provisioning sandbox...",
  });

  try {
    const { workspaceId, secretsAsEnv } = await provisionAndInject(agent, userId);

    const [profile] = await db
      .select({ cliApiKey: profiles.cliApiKey })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    const apiUrl = process.env.LFG_API_URL || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

    // Mark agent running *before* kicking off the initial run so that the
    // run record finds the agent in the right state.
    await db
      .update(agents)
      .set({ status: "running", cliSessionId: null, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

    broadcastToUser(userId, {
      type: "agent_status",
      agent_id: agentId,
      status: "running",
      message: "Agent is now running",
    });

    agentBus.emit("agent.started", { agentId, userId });
    console.log(`[agent-manager] Agent ${agentId} started successfully`);

    // Create an initial run for the startup instructions
    const initialPrompt = agent.instructions
      ? `Read /root/CLAUDE.md for your persona and instructions. Read /root/capabilities.json for your tool selection. Read /root/memory.md for persistent memory. Then: ${agent.instructions}`
      : "Read /root/CLAUDE.md, /root/capabilities.json, and /root/memory.md. Then wait for further commands.";

    const run = await createRun({
      agentRowId: agent.id,
      triggerType: "start",
      prompt: initialPrompt,
      timeoutMs: agent.runTimeoutMs ?? undefined,
    });
    await markRunStarted(run.id);

    const envVars: Record<string, string> = {
      LFG_API_URL: apiUrl,
      LFG_API_KEY: profile?.cliApiKey ?? "",
      LFG_AGENT_ID: agent.agentId,
      LFG_RUN_ID: run.id,
      ...secretsAsEnv,
    };

    await startClaudeCliChat({
      workspaceId,
      prompt: initialPrompt,
      projectDir: ".",
      userId,
      envVars,
      maxTurns: 200,
      agentMode: true,
    });
  } catch (err) {
    const errorMsg = (err as Error).message?.slice(0, 300) ?? "Unknown error";
    console.error(`[agent-manager] Failed to start agent ${agentId}:`, errorMsg);

    await db
      .update(agents)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

    broadcastToUser(userId, {
      type: "agent_status",
      agent_id: agentId,
      status: "error",
      message: `Failed to start: ${errorMsg}`,
    });

    agentBus.emit("agent.error", { agentId, userId, error: errorMsg });
  }
}

/**
 * Stop an agent: sync memory, cancel active runs, stop workspace.
 */
export async function stopAgent(agentId: string, userId: string): Promise<void> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, userId)))
    .limit(1);

  if (!agent) throw new Error("Agent not found");

  const sandbox = agent.sandboxId
    ? await db.select().from(sandboxes).where(eq(sandboxes.id, agent.sandboxId)).then((r) => r[0])
    : null;

  // Cancel any in-flight runs first so the callback doesn't race us
  await cancelActiveRuns(agent.id, "Agent stopped by user");

  if (sandbox?.magsWorkspaceId) {
    try {
      await syncMemory(agentId, agent.id, sandbox.magsWorkspaceId);
    } catch (err) {
      console.warn("[agent-manager] Memory sync failed:", (err as Error).message);
    }

    try {
      await saveCredentialsFromVm(sandbox.magsWorkspaceId, userId);
    } catch {
      // ignore
    }

    try {
      await stopWorkspace(sandbox.magsWorkspaceId);
    } catch (err) {
      console.warn("[agent-manager] Stop workspace failed:", (err as Error).message);
    }
  }

  await db
    .update(agents)
    .set({ status: "stopped", cliSessionId: null, currentRunId: null, updatedAt: new Date() })
    .where(eq(agents.id, agent.id));

  broadcastToUser(userId, {
    type: "agent_status",
    agent_id: agentId,
    status: "stopped",
    message: "Agent stopped",
  });

  agentBus.emit("agent.stopped", { agentId, userId });
  console.log(`[agent-manager] Agent ${agentId} stopped`);
}

/**
 * Core dispatch primitive. Creates a run record and fires the CLI against
 * the agent's sandbox. Everything (cron, manual "Run Now", webhook, chat)
 * eventually calls this.
 *
 * Enforces one-run-at-a-time per agent: if there is already an active run,
 * this throws unless `opts.force = true`.
 *
 * If `opts.autoStart = true` and the agent isn't running, it will be started
 * first (used by the scheduler).
 */
export async function runCommand(
  agentId: string,
  userId: string,
  opts: {
    prompt: string;
    triggerType: RunTrigger;
    scheduleId?: string | null;
    payload?: Record<string, unknown> | null;
    parentRunId?: string | null;
    retryCount?: number;
    autoStart?: boolean;
    force?: boolean;
  }
): Promise<{ runId: string }> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, userId)))
    .limit(1);

  if (!agent) throw new Error("Agent not found");

  // Concurrency lock — R1 of Phase 3
  const active = await getActiveRunForAgent(agent.id);
  if (active && !opts.force) {
    throw new Error(
      `Agent already has an active run (${active.id}, status=${active.status}). ` +
        `Wait for it to finish or pass force=true.`
    );
  }

  // Auto-start if needed (F3 — scheduler entry point)
  if (agent.status !== "running") {
    if (!opts.autoStart) {
      throw new Error("Agent is not running. Start it first or pass autoStart=true.");
    }
    console.log(`[agent-manager] runCommand: auto-starting agent ${agentId}`);

    // Mark starting
    await db
      .update(agents)
      .set({ status: "starting", lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

    broadcastToUser(userId, {
      type: "agent_status",
      agent_id: agentId,
      status: "starting",
      message: "Auto-starting for scheduled run...",
    });

    try {
      const provisioned = await provisionAndInject(agent, userId);
      await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id));

      broadcastToUser(userId, {
        type: "agent_status",
        agent_id: agentId,
        status: "running",
        message: "Agent started",
      });

      agentBus.emit("agent.started", { agentId, userId });

      // Refresh agent row (status, etc.)
      const refreshed = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      if (refreshed[0]) Object.assign(agent, refreshed[0]);

      return dispatchRun(agent, userId, provisioned.workspaceId, provisioned.secretsAsEnv, opts);
    } catch (err) {
      await db
        .update(agents)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(agents.id, agent.id));
      agentBus.emit("agent.error", {
        agentId,
        userId,
        error: `Auto-start failed: ${(err as Error).message}`,
      });
      throw err;
    }
  }

  // Already running — need the workspaceId from the sandbox record
  const sandbox = agent.sandboxId
    ? await db.select().from(sandboxes).where(eq(sandboxes.id, agent.sandboxId)).then((r) => r[0])
    : null;
  if (!sandbox?.magsWorkspaceId) {
    throw new Error("Agent has no active sandbox. Start the agent first.");
  }

  const secretsAsEnv = await loadSecretsForCli(agent.id);
  return dispatchRun(agent, userId, sandbox.magsWorkspaceId, secretsAsEnv, opts);
}

async function dispatchRun(
  agent: typeof agents.$inferSelect,
  userId: string,
  workspaceId: string,
  secretsAsEnv: Record<string, string>,
  opts: {
    prompt: string;
    triggerType: RunTrigger;
    scheduleId?: string | null;
    payload?: Record<string, unknown> | null;
    parentRunId?: string | null;
    retryCount?: number;
  }
): Promise<{ runId: string }> {
  // Build the actual CLI prompt, prepending trigger payload if any
  let cliPrompt = opts.prompt;
  if (opts.payload && Object.keys(opts.payload).length) {
    cliPrompt = `Trigger payload: ${JSON.stringify(opts.payload)}\n\n${cliPrompt}`;
  }

  const run = await createRun({
    agentRowId: agent.id,
    scheduleId: opts.scheduleId ?? null,
    triggerType: opts.triggerType,
    prompt: cliPrompt,
    payload: opts.payload ?? null,
    parentRunId: opts.parentRunId ?? null,
    retryCount: opts.retryCount ?? 0,
    timeoutMs: agent.runTimeoutMs ?? undefined,
  });
  await markRunStarted(run.id);

  // Store the user message so the chat UI shows the command too
  if (opts.triggerType === "chat" || opts.triggerType === "manual") {
    await db.insert(agentMessages).values({
      agentId: agent.id,
      conversationType: "individual",
      role: "user",
      content: opts.prompt,
    });
  }

  const [profile] = await db
    .select({ cliApiKey: profiles.cliApiKey })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  const apiUrl = process.env.LFG_API_URL || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

  const envVars: Record<string, string> = {
    LFG_API_URL: apiUrl,
    LFG_API_KEY: profile?.cliApiKey ?? "",
    LFG_AGENT_ID: agent.agentId,
    LFG_RUN_ID: run.id,
    ...secretsAsEnv,
  };

  await startClaudeCliChat({
    workspaceId,
    prompt: cliPrompt,
    projectDir: ".",
    userId,
    sessionId: agent.cliSessionId ?? undefined,
    envVars,
    maxTurns: 200,
    agentMode: true,
  });

  agentBus.emit("agent.command_sent", {
    agentId: agent.agentId,
    userId,
    prompt: opts.prompt.slice(0, 200),
  });
  console.log(`[agent-manager] Dispatched run ${run.id} for agent ${agent.agentId} (trigger=${opts.triggerType})`);

  return { runId: run.id };
}

/**
 * Legacy entry point — kept for back-compat with older call sites that
 * expect fire-and-forget "send this prompt" semantics. Creates a chat-type
 * run and swallows concurrency errors.
 */
export async function sendCommand(
  agentId: string,
  prompt: string,
  userId: string
): Promise<void> {
  try {
    await runCommand(agentId, userId, {
      prompt,
      triggerType: "chat",
    });
  } catch (err) {
    console.warn(`[agent-manager] sendCommand skipped:`, (err as Error).message);
  }
}

/**
 * Sync memory.md from sandbox to DB.
 */
export async function syncMemory(
  agentId: string,
  internalId?: string,
  workspaceId?: string
): Promise<string | null> {
  let agent;
  if (internalId && workspaceId) {
    agent = { id: internalId };
  } else {
    const [row] = await db
      .select()
      .from(agents)
      .where(eq(agents.agentId, agentId))
      .limit(1);
    if (!row) return null;
    agent = row;

    const sandbox = row.sandboxId
      ? await db.select().from(sandboxes).where(eq(sandboxes.id, row.sandboxId)).then((r) => r[0])
      : null;
    workspaceId = sandbox?.magsWorkspaceId ?? undefined;
  }

  if (!workspaceId) return null;

  try {
    const result = await execOnWorkspace(
      workspaceId,
      `cat /root/memory.md 2>/dev/null || echo "__NO_MEMORY__"`,
      { timeout: 15_000 }
    );

    if (result.output.includes("__NO_MEMORY__")) return null;

    const memoryContent = result.output.trim();
    await db
      .update(agents)
      .set({
        memoryContent,
        memoryLastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agent.id));

    agentBus.emit("agent.memory_synced", { agentId });
    return memoryContent;
  } catch (err) {
    console.error("[agent-manager] syncMemory error:", (err as Error).message);
    return null;
  }
}

/**
 * Delete an agent and its associated resources.
 */
export async function deleteAgent(
  agentId: string,
  userId: string
): Promise<{ deleted: boolean; message: string }> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, userId)))
    .limit(1);

  if (!agent) return { deleted: false, message: "Agent not found" };

  if (agent.status === "running" || agent.status === "starting") {
    try {
      await stopAgent(agentId, userId);
    } catch {
      // Continue with deletion
    }
  }

  await db.delete(agents).where(eq(agents.id, agent.id));

  console.log(`[agent-manager] Deleted agent ${agentId}`);
  return { deleted: true, message: "Agent deleted" };
}

/**
 * Look up an agent by its conversationId (used by stream-handler to detect agent conversations).
 */
export async function getAgentByConversation(
  conversationId: string
): Promise<{
  id: string;
  agentId: string;
  userId: string;
  name: string;
  status: string;
  personality: string | null;
  instructions: string | null;
  composioToolkits: string[] | null;
  memoryContent: string | null;
} | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      agentId: agents.agentId,
      userId: agents.userId,
      name: agents.name,
      status: agents.status,
      personality: agents.personality,
      instructions: agents.instructions,
      composioToolkits: agents.composioToolkits,
      memoryContent: agents.memoryContent,
    })
    .from(agents)
    .where(eq(agents.conversationId, conversationId))
    .limit(1);

  return agent
    ? { ...agent, composioToolkits: (agent.composioToolkits as string[] | null) ?? [] }
    : null;
}

export async function getAgentStatus(
  agentId: string,
  userId: string
): Promise<{ status: string; sandboxUrl: string | null; message: string } | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, userId)))
    .limit(1);

  if (!agent) return null;

  if (agent.status === "running" && agent.sandboxId) {
    const sandbox = await db
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.id, agent.sandboxId))
      .then((r) => r[0]);

    if (sandbox?.magsWorkspaceId) {
      const job = await findJob(sandbox.magsWorkspaceId).catch(() => null);
      if (!job || (job.status !== "running" && job.status !== "sleeping")) {
        await db
          .update(agents)
          .set({ status: "stopped", updatedAt: new Date() })
          .where(eq(agents.id, agent.id));
        return { status: "stopped", sandboxUrl: agent.sandboxUrl, message: "Sandbox is no longer running" };
      }
    }
  }

  return {
    status: agent.status,
    sandboxUrl: agent.sandboxUrl,
    message: `Agent is ${agent.status}`,
  };
}

/**
 * Look up an agent by its public webhookToken (used by the webhook trigger
 * endpoint — runs unauthenticated except for the token itself).
 */
export async function getAgentByWebhookToken(
  token: string
): Promise<typeof agents.$inferSelect | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.webhookToken, token))
    .limit(1);
  return agent ?? null;
}

/**
 * Look up the agent row that owns a given run. Used by the CLI callback to
 * auth-check + route run completion events.
 */
export async function getAgentByRunId(
  runId: string
): Promise<{ agentRow: typeof agents.$inferSelect; run: typeof agentTaskRuns.$inferSelect } | null> {
  const [run] = await db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).limit(1);
  if (!run) return null;
  const [agentRow] = await db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1);
  if (!agentRow) return null;
  return { agentRow, run };
}
