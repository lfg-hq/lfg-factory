/**
 * Codebase Query Service
 *
 * Uses a "preview" sandbox (persistent Mags VM with the repo cloned)
 * and Claude Code CLI to answer questions about the user's codebase.
 *
 * Runs as claudeuser with --dangerously-skip-permissions (Claude CLI
 * refuses this flag as root). Credentials pulled from DB and injected
 * into the VM before each query.
 *
 * Flow:
 *  1. Find or create a preview sandbox for the project
 *  2. Clone repo (all branches) into /opt/git-review/
 *  3. Inject credentials from DB into preview VM
 *  4. Launch `claude -p "<question>" --output-format stream-json --verbose`
 *     in background as claudeuser
 *  5. Poll output file every 2s, broadcast chunks to user via WebSocket
 *  6. Extract final answer + session_id, return to tool caller
 */

import { db } from "../config/db.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import {
  newWorkspace,
  execOnWorkspace,
  stopWorkspace,
} from "./mags.ts";
import {
  injectCredentials,
  parseJsonlEvents,
  extractSessionId,
  isStreamComplete,
  type ClaudeJsonEvent,
} from "./claude-cli.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { eq, and } from "drizzle-orm";

const REVIEW_DIR = "/opt/git-review";
const CLAUDE_BIN = "/usr/local/bin/claude";
const DEFAULT_MAX_TURNS = 5;
const QUERY_TIMEOUT_MS = 60_000; // 60s max
const POLL_INTERVAL_MS = 2_000;

export interface QueryCodebaseResult {
  answer: string;
  sessionId?: string;
  branch?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function b64script(script: string): string {
  return `echo ${Buffer.from(script).toString("base64")} | base64 -d | sh`;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Get or Create Preview Sandbox ─────────────────────────────────────

export async function getOrCreatePreviewSandbox(
  projectId: string,
  userId: string,
  repoUrl: string,
  githubToken: string
): Promise<typeof sandboxes.$inferSelect> {
  // 1. Check for existing preview sandbox
  const [existing] = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.projectId, projectId),
        eq(sandboxes.workspaceType, "preview")
      )
    )
    .limit(1);

  if (existing?.magsWorkspaceId) {
    // Probe VM: must be alive AND have the repo at the expected path
    try {
      const probe = await execOnWorkspace(
        existing.magsWorkspaceId,
        `if [ -d "${REVIEW_DIR}/.git" ]; then echo REPO_OK; else echo NO_REPO; fi; echo ALIVE`,
        { timeout: 15_000 }
      );
      if (probe.output.includes("ALIVE") && probe.output.includes("REPO_OK")) {
        console.log(`[codebase-query] Existing preview sandbox alive: ${existing.magsWorkspaceId}`);
        refreshPreviewRepo(existing.magsWorkspaceId).catch(() => {});
        return existing;
      }
      console.log(`[codebase-query] Preview sandbox alive but repo missing at ${REVIEW_DIR}, recreating`);
    } catch {
      console.log(`[codebase-query] Preview sandbox dead, will recreate: ${existing.magsWorkspaceId}`);
    }

    // Clean up stale sandbox
    stopWorkspace(existing.magsWorkspaceId).catch(() => {});
    await db.delete(sandboxes).where(eq(sandboxes.id, existing.id));
  }

  // 2. Create new preview sandbox
  const workspaceName = `preview-${projectId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`[codebase-query] Creating preview sandbox: ${workspaceName}`);

  const { jobId, workspaceId } = await newWorkspace(workspaceName);
  await sleep(10_000);

  // 3. Init: install packages + Node + Claude CLI + clone repo
  const authUrl = repoUrl.replace(
    "https://",
    `https://x-access-token:${githubToken}@`
  );

  const initScript = `
set -e

# System packages
apk update && apk add --no-cache curl xz git bash openssh-client

# Node.js
cd /root && mkdir -p node && cd node
if [ ! -d node-v20.18.0-linux-x64 ]; then
    curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz -o node.tar.xz
    tar -xf node.tar.xz && rm node.tar.xz
    ln -sfn node-v20.18.0-linux-x64 current
fi
export PATH=/root/node/current/bin:$PATH
mkdir -p /root/.npm-global /root/.npm-cache
npm config set prefix /root/.npm-global
npm config set cache /root/.npm-cache

# Claude CLI
npm install -g @anthropic-ai/claude-code

# Non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
adduser -D -h /home/claudeuser -s /bin/bash claudeuser 2>/dev/null || true

# Clone repo into /opt (accessible to all users)
mkdir -p ${REVIEW_DIR}
git clone "${authUrl}" ${REVIEW_DIR}
cd ${REVIEW_DIR}
git fetch --all

# Give claudeuser ownership of the repo
chown -R claudeuser:claudeuser ${REVIEW_DIR}
git config --global --add safe.directory ${REVIEW_DIR}

echo "PREVIEW_INIT_COMPLETE"
`.trim();

  const initResult = await execOnWorkspace(
    workspaceId,
    b64script(initScript),
    { timeout: 300_000 }
  );

  if (!initResult.output.includes("PREVIEW_INIT_COMPLETE")) {
    throw new Error(`Preview sandbox init failed: ${initResult.output.slice(0, 500)}`);
  }

  console.log(`[codebase-query] Preview sandbox initialized: ${workspaceId}`);

  // 4. Inject Claude credentials from DB
  const injected = await injectCredentials(workspaceId, userId);
  if (!injected) {
    console.warn(`[codebase-query] Could not inject credentials — queries may fail`);
  }

  // 5. Insert sandbox record
  const [row] = await db
    .insert(sandboxes)
    .values({
      projectId,
      userId,
      magsWorkspaceId: workspaceId,
      magsJobId: jobId,
      workspaceType: "preview",
      status: "ready",
    })
    .returning();

  return row!;
}

// ── Query Codebase ────────────────────────────────────────────────────

export async function queryCodebase(
  workspaceId: string,
  question: string,
  opts?: {
    branch?: string;
    sessionId?: string;
    maxTurns?: number;
    userId?: string;
  }
): Promise<QueryCodebaseResult> {
  const branch = opts?.branch;
  const sessionId = opts?.sessionId;
  const maxTurns = opts?.maxTurns ?? DEFAULT_MAX_TURNS;
  const userId = opts?.userId;

  // Checkout branch if specified
  if (branch) {
    const checkoutScript = `
cd ${REVIEW_DIR}
git checkout ${branch} 2>/dev/null || git checkout -b ${branch} origin/${branch} 2>/dev/null || echo "BRANCH_CHECKOUT_FAILED"
echo "BRANCH_READY"
`.trim();
    await execOnWorkspace(workspaceId, b64script(checkoutScript), { timeout: 30_000 });
  }

  // Re-inject credentials from DB (token may have been refreshed since sandbox was created)
  if (userId) {
    await injectCredentials(workspaceId, userId);
  }

  // Launch CLI in background as claudeuser
  // Needs --dangerously-skip-permissions for non-interactive tool use (Grep/Read/Glob)
  const ts = Date.now();
  const outputFile = `/tmp/cq_output_${ts}.jsonl`;
  const questionFile = `/tmp/cq_question_${ts}.txt`;
  const runnerFile = `/tmp/cq_runner_${ts}.sh`;
  const questionB64 = Buffer.from(question).toString("base64");

  // Runner script — executed as claudeuser via su
  const runner = `#!/bin/bash
export HOME=/home/claudeuser
export PATH=/root/node/current/bin:/root/.npm-global/bin:$PATH
git config --global --add safe.directory ${REVIEW_DIR} 2>/dev/null || true
cd ${REVIEW_DIR}
${CLAUDE_BIN} -p "$(cat ${questionFile})" \\
  --output-format stream-json \\
  --verbose \\
  --max-turns ${maxTurns} \\
  --dangerously-skip-permissions \\
  ${sessionId ? `--resume "${sessionId}"` : ""} \\
  > ${outputFile} 2>&1
`;
  const runnerB64 = Buffer.from(runner).toString("base64");

  const launchScript = `
export PATH=/root/node/current/bin:/root/.npm-global/bin:$PATH

echo '${questionB64}' | base64 -d > ${questionFile}
echo '${runnerB64}' | base64 -d > ${runnerFile}
chmod 755 ${runnerFile}
chmod 644 ${questionFile}
touch ${outputFile}
chmod 666 ${outputFile}

nohup su -s /bin/bash claudeuser -c "bash ${runnerFile}" > /dev/null 2>&1 &
echo "___BG_PID=$!"
echo "QUERY_STARTED"
`.trim();

  console.log(`[codebase-query] Launching query on ${workspaceId}, branch=${branch ?? "current"}, session=${sessionId ?? "new"}`);

  const launchResult = await execOnWorkspace(
    workspaceId,
    b64script(launchScript),
    { timeout: 30_000 }
  );

  if (!launchResult.output.includes("QUERY_STARTED")) {
    throw new Error(`Failed to launch query: ${launchResult.output.slice(0, 300)}`);
  }

  const pidMatch = launchResult.output.match(/___BG_PID=(\d+)/);
  const bgPid = pidMatch?.[1];

  console.log(`[codebase-query] Query launched, pid=${bgPid}, output=${outputFile}`);

  if (userId) {
    broadcastToUser(userId, {
      type: "codebase_query_status",
      status: "searching",
      message: "Searching codebase...",
    });
  }

  // Poll output file, stream chunks to user via WS
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  let offset = 0;
  let allOutput = "";
  let allEvents: ClaudeJsonEvent[] = [];

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const pollScript = `
CURSIZE=$(wc -c < "${outputFile}" 2>/dev/null || echo 0)
NEWBYTES=$((CURSIZE - ${offset}))
if [ "$NEWBYTES" -gt 0 ]; then
    tail -c +$((${offset}+1)) "${outputFile}" | head -c $NEWBYTES
fi
${bgPid ? `ALIVE=$(kill -0 ${bgPid} 2>/dev/null && echo "yes" || echo "no")` : 'ALIVE="unknown"'}
printf '\\n__POLL_BOUNDARY__\\nSIZE=%s ALIVE=%s\\n' "$CURSIZE" "$ALIVE"
`.trim();

    let pollResult;
    try {
      pollResult = await execOnWorkspace(workspaceId, b64script(pollScript), { timeout: 15_000 });
    } catch {
      continue; // transient SSH error
    }

    const raw = pollResult.output;
    const boundaryIdx = raw.indexOf("__POLL_BOUNDARY__");

    let chunk = "";
    let alive = true;

    if (boundaryIdx >= 0) {
      chunk = raw.slice(0, boundaryIdx).replace(/\n$/, "");
      const meta = raw.slice(boundaryIdx);
      const sizeMatch = meta.match(/SIZE=(\d+)/);
      const aliveMatch = meta.match(/ALIVE=(\w+)/);
      if (sizeMatch?.[1]) offset = parseInt(sizeMatch[1], 10);
      if (aliveMatch?.[1]) alive = aliveMatch[1] !== "no";
    }

    if (chunk) {
      allOutput += chunk + "\n";
      const newEvents = parseJsonlEvents(chunk);
      allEvents.push(...newEvents);

      // Stream assistant text chunks to user
      if (userId) {
        for (const ev of newEvents) {
          if (ev.type === "assistant") {
            const content = (ev as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text?.trim()) {
                  broadcastToUser(userId, {
                    type: "codebase_query_chunk",
                    text: block.text,
                  });
                }
              }
            }
          }
        }
      }
    }

    if (!alive || isStreamComplete(allEvents)) {
      console.log(`[codebase-query] Query finished: alive=${alive}, events=${allEvents.length}`);
      break;
    }
  }

  const newSessionId = extractSessionId(allEvents) ?? undefined;
  const answer = extractAnswer(allEvents, allOutput);

  if (userId) {
    broadcastToUser(userId, { type: "codebase_query_status", status: "complete" });
  }

  console.log(`[codebase-query] Answer length=${answer.length}, sessionId=${newSessionId ?? "none"}`);
  return { answer, sessionId: newSessionId, branch };
}

// ── Refresh Preview Repo ──────────────────────────────────────────────

export async function refreshPreviewRepo(workspaceId: string): Promise<void> {
  const result = await execOnWorkspace(
    workspaceId,
    `cd ${REVIEW_DIR} && git fetch --all 2>&1 && echo FETCH_OK`,
    { timeout: 60_000 }
  );
  if (!result.output.includes("FETCH_OK")) {
    console.warn(`[codebase-query] git fetch issue: ${result.output.slice(0, 200)}`);
  }
}

// ── Extract Answer ────────────────────────────────────────────────────

function extractAnswer(events: ClaudeJsonEvent[], rawOutput: string): string {
  // Prefer the result event
  for (const ev of events) {
    if (ev.type === "result") {
      const result = (ev as any).result;
      if (result) return result;
    }
  }

  // Fallback: last assistant text block
  let lastText = "";
  for (const ev of events) {
    if (ev.type === "assistant") {
      const content = (ev as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            lastText = block.text;
          }
        }
      }
    }
  }
  if (lastText) return lastText;

  // Last resort: raw output
  const lines = rawOutput.split("\n").filter((l) => {
    const t = l.trim();
    return t && !t.startsWith("{") && !t.startsWith("╭") && !t.startsWith("╰") && !t.startsWith("│");
  });
  return lines.join("\n").trim().slice(0, 5000) || "No answer returned from codebase query.";
}
