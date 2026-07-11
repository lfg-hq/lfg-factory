/**
 * Preview service — manages the dev server running inside a Mags sandbox.
 *
 * Flow:
 *  1. Read tech_stack from sandbox (startCommand, port)
 *  2. Kill any existing dev server process
 *  3. Start the dev server in background, piping output to /tmp/devserver.log
 *  4. Enable HTTP access via Mags for that port
 *  5. Return the proxy URL
 *
 * Logs are polled from /tmp/devserver.log using tail.
 */

import { db } from "../config/db.ts";
import { sandboxes, serverLogs } from "../db/schema/sandbox.ts";
import { projectEnvironmentVariables } from "../db/schema/projects.ts";
import { execOnWorkspace, enableHttpAccess } from "./mags.ts";
import { decrypt } from "../ai/tools/env-tools.ts";
import { eq, and } from "drizzle-orm";

const DEV_LOG_FILE = "/tmp/devserver.log";
const PID_FILE = "/tmp/devserver.pid";

export interface StartDevServerResult {
  previewUrl: string;
  port: number;
}

/**
 * Start (or restart) the dev server inside the sandbox.
 * Kills any running instance first, then starts fresh.
 */
export async function startDevServer(sandboxId: string): Promise<StartDevServerResult> {
  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .limit(1);

  if (!sandbox?.magsWorkspaceId) {
    throw new Error(`Sandbox ${sandboxId} has no active workspace`);
  }

  const techStack = sandbox.techStack;
  const startCmd = techStack?.startCommand ?? detectStartCommand(techStack);
  const port = techStack?.port ?? 8080;
  const workspaceId = sandbox.magsWorkspaceId;

  // Kill existing dev server
  await killDevServer(workspaceId);

  // Load project environment variables so the dev server has access to them
  const envRows = sandbox.projectId
    ? await db
        .select({ key: projectEnvironmentVariables.key, encryptedValue: projectEnvironmentVariables.encryptedValue })
        .from(projectEnvironmentVariables)
        .where(and(
          eq(projectEnvironmentVariables.projectId, sandbox.projectId),
          eq(projectEnvironmentVariables.hasValue, true)
        ))
    : [];

  // Build env export lines (shell-escaped)
  const envExports = envRows
    .map((r) => {
      const val = decrypt(r.encryptedValue).replace(/'/g, "'\\''");
      return `export ${r.key}='${val}'`;
    })
    .join("\n");

  // Start new dev server in background
  // Project lives at /data/project
  const CLAUDE_HOME = "/root";
  // Build a launcher script that will be written to the VM via heredoc.
  // Using single-quoted heredoc delimiter ('LAUNCHER_EOF') means NO shell
  // expansion — the text is written verbatim. Shell variables like $(pwd)
  // and $PATH will be expanded when the script runs, not when it's written.
  const envExportLines = envRows
    .map((r) => {
      // Single-quote the value; escape any embedded single quotes
      const val = decrypt(r.encryptedValue).replace(/'/g, "'\\''");
      return `export ${r.key}='${val}'`;
    })
    .join("\n");

  const launcherScript = [
    `#!/bin/bash`,
    `cd /data/project`,
    `export PATH="$(pwd)/node_modules/.bin:$PATH"`,
    envExportLines,
    `exec ${startCmd}`,
  ].filter(Boolean).join("\n");

  const startScript = `
cd ${CLAUDE_HOME}/project 2>/dev/null || cd /data/project 2>/dev/null || true

cat > /tmp/devserver_run.sh << 'LAUNCHER_EOF'
${launcherScript}
LAUNCHER_EOF
chmod +x /tmp/devserver_run.sh

echo "Starting dev server: ${startCmd}"
nohup /tmp/devserver_run.sh > ${DEV_LOG_FILE} 2>&1 &
echo $! > ${PID_FILE}
echo "STARTED:$(cat ${PID_FILE})"
`.trim();

  // exec() breaks with multi-line commands — base64-encode
  const scriptB64 = Buffer.from(startScript).toString("base64");
  const result = await execOnWorkspace(workspaceId, `echo ${scriptB64} | base64 -d | sh`, {
    timeout: 30_000,
  });

  if (!result.output.includes("STARTED:")) {
    throw new Error(`Dev server failed to start:\n${result.output}`);
  }

  // Wait a moment for server to bind port
  await sleep(3_000);

  // Enable HTTP proxy access via Mags
  const proxyUrl = await enableHttpAccess(sandbox.magsWorkspaceId, port);

  // Persist to DB
  await db
    .update(sandboxes)
    .set({ previewUrl: proxyUrl, previewPort: port, updatedAt: new Date() })
    .where(eq(sandboxes.id, sandboxId));

  return { previewUrl: proxyUrl, port };
}

/**
 * Stop the running dev server.
 */
export async function stopDevServer(sandboxId: string): Promise<void> {
  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .limit(1);

  if (!sandbox?.magsWorkspaceId) return;

  await killDevServer(sandbox.magsWorkspaceId);

  await db
    .update(sandboxes)
    .set({ previewUrl: null, updatedAt: new Date() })
    .where(eq(sandboxes.id, sandboxId));
}

/**
 * Restart the dev server (stop then start).
 */
export async function restartDevServer(sandboxId: string): Promise<StartDevServerResult> {
  await stopDevServer(sandboxId);
  await sleep(1_000);
  return startDevServer(sandboxId);
}

/**
 * Poll new log lines from the dev server log file.
 * Returns lines since the given byte offset.
 */
export async function getDevServerLogs(
  sandboxId: string,
  offset: number = 0
): Promise<{ lines: string[]; newOffset: number }> {
  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, sandboxId))
    .limit(1);

  if (!sandbox?.magsWorkspaceId) return { lines: [], newOffset: 0 };

  const result = await execOnWorkspace(
    sandbox.magsWorkspaceId,
    `tail -c +${offset + 1} ${DEV_LOG_FILE} 2>/dev/null || echo ""`,
    { timeout: 10_000 }
  );

  const raw = result.output;
  const newOffset = offset + Buffer.byteLength(raw, "utf8");
  const lines = raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

  // Persist interesting log lines to DB
  if (lines.length > 0 && sandbox.ticketId) {
    const logsToInsert = lines.slice(-50).map((line) => ({
      sandboxId,
      ticketId: sandbox.ticketId!,
      level: classifyLogLevel(line),
      message: line,
    }));
    await db.insert(serverLogs).values(logsToInsert);
  }

  return { lines, newOffset };
}

/**
 * Get the last N persisted server log lines for a ticket.
 */
export async function getStoredServerLogs(
  sandboxId: string,
  limit = 200
): Promise<Array<{ level: string; message: string; createdAt: Date }>> {
  const rows = await db
    .select({
      level: serverLogs.level,
      message: serverLogs.message,
      createdAt: serverLogs.createdAt,
    })
    .from(serverLogs)
    .where(eq(serverLogs.sandboxId, sandboxId))
    .orderBy(serverLogs.createdAt)
    .limit(limit);

  return rows as Array<{ level: string; message: string; createdAt: Date }>;
}

// ── Helpers ───────────────────────────────────────────────────────────

async function killDevServer(workspaceId: string): Promise<void> {
  const killScript = `
if [ -f ${PID_FILE} ]; then
  PID=$(cat ${PID_FILE})
  kill "$PID" 2>/dev/null || true
  rm -f ${PID_FILE}
fi
pkill -f "next dev" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
pkill -f "npm run dev" 2>/dev/null || true
pkill -f "bun run dev" 2>/dev/null || true
true
`.trim();
  const b64 = Buffer.from(killScript).toString("base64");
  await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | sh`, { timeout: 15_000 });
}

function detectStartCommand(techStack?: typeof sandboxes.$inferSelect.techStack): string {
  if (!techStack) return "npm run dev";
  const pm = techStack.packageManager ?? "npm";
  const cmd = techStack.startCommand;
  if (cmd) return cmd;
  return `${pm} run dev`;
}

function classifyLogLevel(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("err!")) return "error";
  if (lower.includes("warn")) return "warn";
  return "stdout";
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
