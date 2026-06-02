/**
 * Agent Sandbox Helpers
 *
 * Handles MCP config injection, memory injection, data file management,
 * secret injection, capability index, and prompt construction for agent
 * sandboxes.
 */

import { eq } from "drizzle-orm";
import * as fs from "node:fs/promises";
import { db } from "../config/db.ts";
import { agentDataFiles, agents } from "../db/schema/agents.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { execOnWorkspace } from "./mags.ts";
import { getComposioMcpConfig } from "./composio-manager.ts";
import { loadDecryptedSecretsByRowId, type DecryptedSecret } from "./agent-secrets.ts";
import {
  isS3Enabled,
  uploadBinary,
  downloadBinary,
  buildAgentDataRoomKey,
  guessContentType,
  getPresignedGetUrl,
} from "./s3.ts";

// ── Utility: run a shell script on the workspace via base64 ──────────

async function runScript(workspaceId: string, script: string): Promise<string> {
  const b64 = Buffer.from(script).toString("base64");
  const result = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | sh`);
  return result.output;
}

/**
 * Load Composio MCP endpoint and write Claude Code settings.json
 * into the sandbox so Claude CLI has native integration access.
 */
export async function injectComposioConfig(
  workspaceId: string,
  composioToolkitSlugs: string[],
  userId: string
): Promise<void> {
  if (!composioToolkitSlugs.length) return;

  const mcpConfig = await getComposioMcpConfig(userId, composioToolkitSlugs);
  if (!mcpConfig) return;

  const config: Record<string, { type: string; url: string; headers?: Record<string, string> }> = {
    composio: {
      type: "sse",
      url: mcpConfig.url,
      ...(Object.keys(mcpConfig.headers).length ? { headers: mcpConfig.headers } : {}),
    },
  };

  const settings = JSON.stringify({ mcpServers: config }, null, 2);
  const b64 = Buffer.from(settings).toString("base64");

  const script = `
mkdir -p /root/.claude
echo '${b64}' | base64 -d > /root/.claude/settings.json
chmod 600 /root/.claude/settings.json
echo "composio_config_injected"
`.trim();

  const out = await runScript(workspaceId, script);
  console.log("[agent-sandbox] Composio config injection:", out.includes("composio_config_injected") ? "OK" : "FAILED");
}

/**
 * Write /root/.env and /root/.env.agent with decrypted secrets.
 * The agent CLI is also launched with these as exported env vars (via
 * agent-manager), so scripts can read them either way.
 *
 * Returns the list of secret keys injected (for the capabilities index).
 */
export async function injectSecrets(
  workspaceId: string,
  agentRowId: string
): Promise<string[]> {
  const secrets = await loadDecryptedSecretsByRowId(agentRowId);
  if (!secrets.length) {
    // Still create an empty .env so scripts that source it don't fail
    await runScript(workspaceId, `touch /root/.env && chmod 600 /root/.env && echo "empty_env_created"`);
    return [];
  }

  const envLines = secrets
    .map((s) => {
      // Escape single quotes for bash single-quoted strings
      const escaped = s.value.replace(/'/g, `'\\''`);
      return `export ${s.key}='${escaped}'`;
    })
    .join("\n");

  const envB64 = Buffer.from(envLines + "\n").toString("base64");

  const script = `
echo '${envB64}' | base64 -d > /root/.env
chmod 600 /root/.env
# Also append to bashrc so interactive shells pick them up
grep -q 'source /root/.env' /root/.bashrc 2>/dev/null || echo 'source /root/.env' >> /root/.bashrc
echo "secrets_injected_${secrets.length}"
`.trim();

  const out = await runScript(workspaceId, script);
  const ok = out.includes(`secrets_injected_${secrets.length}`);
  console.log(`[agent-sandbox] Secrets injection: ${ok ? "OK" : "FAILED"} (${secrets.length} secrets)`);

  return secrets.map((s) => s.key);
}

/**
 * Load secrets (decrypted) for passing as envVars to the Claude CLI runner.
 * This is the other half of the two-pronged injection: the .env file is
 * there for scripts, the envVars are there for the CLI itself.
 */
export async function loadSecretsForCli(
  agentRowId: string
): Promise<Record<string, string>> {
  const secrets = await loadDecryptedSecretsByRowId(agentRowId);
  const map: Record<string, string> = {};
  for (const s of secrets) {
    map[s.key] = s.value;
  }
  return map;
}

/**
 * Write memory.md into the sandbox.
 */
export async function injectMemory(
  workspaceId: string,
  memoryContent: string | null
): Promise<void> {
  const memory = memoryContent ?? "# Agent Memory\n\nNo prior memory. Start recording observations and learnings here.\n";
  const memB64 = Buffer.from(memory).toString("base64");

  const script = `
echo '${memB64}' | base64 -d > /root/memory.md
echo "memory_injected"
`.trim();

  await runScript(workspaceId, script);
}

/**
 * Inject Data Room files into the sandbox's /root/data/ directory.
 *
 * For S3-backed files: generate a short-lived presigned GET URL and have
 * the sandbox curl it directly. Streams the file inside the VM — no host
 * memory, no SSH base64 bottleneck. Works for any size up to S3's PUT limit.
 *
 * For legacy local-FS rows (pre-S3 migration): falls back to base64-over-exec.
 * That path stays size-limited but is rarely used now.
 */
export async function injectDataFiles(
  workspaceId: string,
  agentId: string
): Promise<void> {
  const files = await db
    .select()
    .from(agentDataFiles)
    .where(eq(agentDataFiles.agentId, agentId));

  await execOnWorkspace(workspaceId, "mkdir -p /root/data");
  if (!files.length) return;

  // Snapshot what's already on disk so we can skip files that are already
  // there at the expected size. Without this, re-injecting a 15 MB CSV on
  // every ensureWorkspace burns ~5-15s of presigned curl per turn.
  let existingOnDisk = new Map<string, number>();
  try {
    const ls = await execOnWorkspace(
      workspaceId,
      `cd /root/data && ls -1A 2>/dev/null | while read -r f; do printf '%s\\t%s\\n' "$f" "$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)"; done`,
      { timeout: 8_000 }
    );
    for (const line of (ls.output || "").split("\n")) {
      const [name, size] = line.split("\t");
      if (name && size) existingOnDisk.set(name, parseInt(size, 10) || 0);
    }
  } catch {
    /* listing failed — fall back to always-inject */
  }

  for (const file of files) {
    // Shell-safe filename for the curl/echo target
    const safeName = file.fileName.replace(/[^a-zA-Z0-9._\- ]/g, "_");

    // Skip if already on disk at the same size — nothing to do.
    const onDiskSize = existingOnDisk.get(safeName);
    if (file.fileSize && onDiskSize === file.fileSize) {
      console.log(
        `[agent-sandbox] inject ${file.fileName} skipped — already on disk (${file.fileSize}B)`
      );
      continue;
    }

    try {
      // PATH 1 — S3 presigned URL + curl (no size limit)
      if (file.s3Key && isS3Enabled) {
        try {
          const t0 = Date.now();
          const url = await getPresignedGetUrl(file.s3Key, 600);
          // Base64-encode the URL itself so no shell-special chars (& = ? %)
          // can break tokenization across the SSH/exec layer. The sandbox
          // decodes inline via `$(echo <b64> | base64 -d)`. base64 alphabet
          // (A-Z a-z 0-9 + / =) is shell-safe in any context.
          const urlB64 = Buffer.from(url).toString("base64");
          // safeName is already restricted to /^a-zA-Z0-9._\- /; double-
          // quote anyway so spaces survive.
          const cmd =
            `curl -fsSL --retry 2 --max-time 120 ` +
            `"$(echo ${urlB64} | base64 -d)" ` +
            `-o "/root/data/${safeName}"`;
          const result = await execOnWorkspace(workspaceId, cmd, { timeout: 150_000 });
          if (result.exitCode === 0) {
            console.log(
              `[agent-sandbox] inject ${file.fileName} via presigned curl ok in ${Date.now() - t0}ms`
            );
            continue;
          }
          console.error(
            `[agent-sandbox] curl failed for ${file.fileName} exitCode=${result.exitCode} stderr=${(result.stderr || "").slice(0, 200)} — falling back to base64`
          );
        } catch (err) {
          console.error(`[agent-sandbox] presigned-URL inject failed for ${file.fileName}:`, (err as Error).message);
        }
      }

      // PATH 2 — base64 over exec (legacy local rows; size-limited)
      let content: Buffer | null = null;
      if (file.s3Key && isS3Enabled) {
        // Fallback if presigned curl failed
        try {
          const { body } = await downloadBinary(file.s3Key);
          content = body;
        } catch { /* will try local next */ }
      }
      if (!content && file.filePath) {
        const exists = await fs.access(file.filePath).then(() => true).catch(() => false);
        if (exists) content = await fs.readFile(file.filePath);
      }
      if (!content) {
        console.warn(`[agent-sandbox] Skipping ${file.fileName} — no readable source`);
        continue;
      }
      const b64 = content.toString("base64");
      await execOnWorkspace(
        workspaceId,
        `echo '${b64}' | base64 -d > '/root/data/${safeName}'`,
        { timeout: 30_000 }
      );
      console.log(`[agent-sandbox] inject ${file.fileName} via base64 ok (${content.length}B)`);
    } catch (err) {
      console.error(`[agent-sandbox] Failed to inject file ${file.fileName}:`, (err as Error).message);
    }
  }
}

/**
 * Sync new files from sandbox /root/data/ back to durable storage.
 * Writes to S3 when FILE_STORAGE_TYPE=s3, else falls back to local
 * uploads/agents/{id}/ for backwards compat.
 */
export async function syncDataRoom(
  workspaceId: string,
  agentId: string
): Promise<void> {
  const tag = `[syncDataRoom ${agentId.slice(0, 8)}]`;
  try {
    // List with sizes in one call so we can skip files we already have at
    // the right size. Mags exec has a 4 MB gRPC response cap — base64-cat'ing
    // a 15 MB CSV here will hard-fail. Existing files (esp. user uploads)
    // don't need re-syncing.
    const listResult = await execOnWorkspace(
      workspaceId,
      `cd /root/data 2>/dev/null && ls -1A 2>/dev/null | while read -r f; do printf '%s\\t%s\\n' "$f" "$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)"; done || echo "__EMPTY__"`,
      { timeout: 15_000 }
    );

    if (listResult.output.includes("__EMPTY__") || !listResult.output.trim()) {
      console.log(`${tag} /root/data empty — nothing to sync`);
      return;
    }

    const sandboxFiles: Array<{ name: string; size: number }> = [];
    for (const line of listResult.output.split("\n")) {
      const [name, sizeStr] = line.split("\t");
      if (!name) continue;
      sandboxFiles.push({ name, size: parseInt(sizeStr ?? "0", 10) || 0 });
    }

    const existingRows = await db
      .select()
      .from(agentDataFiles)
      .where(eq(agentDataFiles.agentId, agentId));

    const existingByName = new Map(existingRows.map((r) => [r.fileName, r] as const));
    console.log(
      `${tag} sandbox=[${sandboxFiles.map((f) => `${f.name}(${f.size}B)`).join(", ")}] existing=${existingByName.size}`
    );

    // Hard cap on what we'll try to pull back through Mags exec — gRPC
    // message cap is ~4 MB, base64 inflates ~4/3, so anything over ~2.5 MB
    // is unsafe to cat. User-uploaded large files were already injected
    // from our S3 → no need to round-trip them.
    const MAX_SYNC_BYTES = 2_500_000;

    for (const { name: fileName, size: onDiskSize } of sandboxFiles) {
      const prior = existingByName.get(fileName);
      if (prior && prior.fileSize === onDiskSize) {
        console.log(`${tag} ${fileName} unchanged (${onDiskSize}B) — skip`);
        continue;
      }
      if (onDiskSize > MAX_SYNC_BYTES) {
        console.warn(
          `${tag} ${fileName} too large for exec channel (${onDiskSize}B > ${MAX_SYNC_BYTES}B) — skip`
        );
        continue;
      }
      try {
        // Use `base64 -w 0` (GNU) to suppress line wrapping inline — no need
        // to post-process with `tr -d '\n'` which made the prior version
        // fragile against the SSH exec channel's quirks. Pipe stderr through
        // so we can see what failed instead of silently producing empty
        // output.
        const catCmd = `base64 -w 0 < /root/data/${fileName}`;
        const catResult = await execOnWorkspace(workspaceId, catCmd, { timeout: 60_000 });

        console.log(
          `${tag} cat ${fileName}: exitCode=${catResult.exitCode} ` +
          `outLen=${(catResult.output || "").length} ` +
          `errLen=${(catResult.stderr || "").length}` +
          (catResult.stderr ? ` stderr="${catResult.stderr.slice(0, 200)}"` : "")
        );

        if (catResult.exitCode !== 0) {
          console.error(`${tag} cat failed for ${fileName} — skipping`);
          continue;
        }

        const b64 = (catResult.output || "").trim();
        if (!b64) {
          console.error(`${tag} cat returned empty output for ${fileName} — skipping (file may be too large for SSH channel)`);
          continue;
        }

        const content = Buffer.from(b64, "base64");
        const size = onDiskSize || content.length;
        console.log(
          `${tag} decoded ${fileName}: b64Len=${b64.length} decodedBytes=${content.length} expected=${onDiskSize}`
        );

        if (size > 0 && content.length === 0) {
          console.error(`${tag} sandbox file is ${size}B but decoded to 0 bytes — base64 transfer failed for ${fileName}`);
          continue;
        }

        let s3Key: string | null = null;
        let localPath: string | null = null;

        if (isS3Enabled) {
          s3Key = buildAgentDataRoomKey(agentId, fileName);
          try {
            const t0 = Date.now();
            await uploadBinary(s3Key, content, guessContentType(fileName));
            console.log(`${tag} ↑ S3 ${fileName} (${size}B) key=${s3Key} in ${Date.now() - t0}ms`);
          } catch (err) {
            console.error(`${tag} S3 upload failed for ${fileName}, falling back to local:`, (err as Error).message);
            s3Key = null;
          }
        }

        if (!s3Key) {
          // Legacy / fallback: local FS
          const localDir = `uploads/agents/${agentId}`;
          await fs.mkdir(localDir, { recursive: true });
          localPath = `${localDir}/${fileName}`;
          await fs.writeFile(localPath, content);
          console.log(`${tag} ↓ local ${fileName} (${size}B) path=${localPath}`);
        }

        // Replace-on-same-name: if a row with this filename exists,
        // drop it (S3 key was the same path so the bytes were overwritten
        // by uploadBinary above) and insert fresh. This makes re-runs of
        // the same chart command re-trigger the WS broadcast so the new
        // version renders inline in chat instead of being silently
        // skipped as 'existing'.
        const prior = existingByName.get(fileName);
        if (prior) {
          await db.delete(agentDataFiles).where(eq(agentDataFiles.id, prior.id));
          if (prior.filePath && prior.filePath !== localPath) {
            await fs.unlink(prior.filePath).catch(() => { /* missing ok */ });
          }
        }

        const fileType = fileName.split(".").pop() ?? "unknown";
        const inserted = await db.insert(agentDataFiles).values({
          agentId,
          fileName,
          fileType,
          filePath: localPath,
          s3Key,
          fileSize: size,
        }).returning();

        // Broadcast so the chat UI can render new charts / artifacts inline
        // without waiting for the user to open the Data Room tab.
        const row = inserted[0];
        if (row) {
          const [agentMeta] = await db
            .select({ userId: agents.userId, agentId: agents.agentId })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1);
          if (agentMeta) {
            broadcastToUser(agentMeta.userId, {
              type: "agent_data_file_created",
              agent_id: agentMeta.agentId,
              file_id: row.id,
              file_name: row.fileName,
              file_type: fileType,
              file_size: size,
              download_url: `/api/agents/${agentMeta.agentId}/data/${row.id}`,
            });
          }
        }
      } catch (err) {
        console.error(`${tag} failed to sync file ${fileName}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error(`${tag} syncDataRoom error:`, (err as Error).message);
  }
}

// ── Capabilities Index ──────────────────────────────────────────────

/**
 * Alpine packages pre-installed in the agent base image. The agent can
 * install more via `apk add` / `pip install` / `npm i` at runtime.
 * Keep this list in sync with the sandbox image spec.
 */
const BASE_CLIS_AVAILABLE = [
  "bash", "curl", "git", "jq", "python3", "pip", "node", "npm", "npx",
];

/**
 * Well-known mapping between secret key names and the service they belong
 * to. Used only as a hint for the capabilities index — the agent reads the
 * full description from its own record. Extend as new integrations are added.
 */
const SECRET_KEY_HINTS: Record<string, { service: string; access: string }> = {
  GCP_SA_KEY: { service: "bigquery", access: "cli (bq, gcloud) + sdk (google-cloud-bigquery)" },
  GCP_SERVICE_ACCOUNT: { service: "bigquery", access: "cli (bq, gcloud) + sdk (google-cloud-bigquery)" },
  SHOPIFY_TOKEN: { service: "shopify", access: "sdk (shopifyapi / @shopify/admin-api-client)" },
  SHOPIFY_STORE: { service: "shopify", access: "used with SHOPIFY_TOKEN" },
  STRIPE_SECRET: { service: "stripe", access: "cli (stripe) + sdk (stripe)" },
  STRIPE_KEY: { service: "stripe", access: "cli (stripe) + sdk (stripe)" },
  OPENAI_API_KEY: { service: "openai", access: "sdk (openai)" },
  AWS_ACCESS_KEY_ID: { service: "aws", access: "cli (aws) + sdk (boto3)" },
  AWS_SECRET_ACCESS_KEY: { service: "aws", access: "cli (aws) + sdk (boto3)" },
  GITHUB_TOKEN: { service: "github", access: "cli (gh) + sdk (octokit)" },
  NOTION_TOKEN: { service: "notion", access: "sdk (@notionhq/client)" },
  LINEAR_API_KEY: { service: "linear", access: "sdk (@linear/sdk)" },
  SENDGRID_API_KEY: { service: "sendgrid", access: "sdk (@sendgrid/mail)" },
  SLACK_BOT_TOKEN: { service: "slack", access: "sdk (@slack/web-api)" },
};

export interface CapabilitiesIndex {
  generatedAt: string;
  mcp: {
    composio_toolkits: string[];
    notes: string;
  };
  secrets: Array<{
    key: string;
    service: string | null;
    description: string | null;
    access_hint: string | null;
  }>;
  clis_preinstalled: string[];
  decision_rule: string;
  preferred: Record<string, string>;
}

export function buildCapabilitiesIndex(input: {
  composioToolkits: string[];
  secrets: DecryptedSecret[];
}): CapabilitiesIndex {
  const preferred: Record<string, string> = {};
  const seenServices = new Set<string>();

  // Composio toolkits → default preference for their service
  for (const slug of input.composioToolkits) {
    preferred[slug] = "mcp:composio for single operations; switch to direct sdk/cli for bulk or file-producing work";
    seenServices.add(slug);
  }

  // Secrets → default preference per known service
  for (const s of input.secrets) {
    const hint = s.service ?? SECRET_KEY_HINTS[s.key]?.service ?? null;
    if (hint && !seenServices.has(hint)) {
      const access = SECRET_KEY_HINTS[s.key]?.access ?? "direct sdk/cli using the provided secret";
      preferred[hint] = `${access} (secret: ${s.key})`;
      seenServices.add(hint);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    mcp: {
      composio_toolkits: input.composioToolkits,
      notes:
        "MCP tools are available in your tool list if any Composio toolkits are enabled. " +
        "Prefer MCP for ONE record / one action. Switch to direct SDK/CLI for bulk or file work.",
    },
    secrets: input.secrets.map((s) => ({
      key: s.key,
      service: s.service ?? SECRET_KEY_HINTS[s.key]?.service ?? null,
      description: s.description,
      access_hint: SECRET_KEY_HINTS[s.key]?.access ?? null,
    })),
    clis_preinstalled: BASE_CLIS_AVAILABLE,
    decision_rule:
      "Touching 1 record? Use MCP. Touching N records or producing a file? Use direct SDK/CLI with secrets from /root/.env.",
    preferred,
  };
}

export async function injectCapabilities(
  workspaceId: string,
  index: CapabilitiesIndex
): Promise<void> {
  const json = JSON.stringify(index, null, 2);
  const b64 = Buffer.from(json).toString("base64");
  const script = `
echo '${b64}' | base64 -d > /root/capabilities.json
chmod 644 /root/capabilities.json
echo "capabilities_injected"
`.trim();
  const out = await runScript(workspaceId, script);
  console.log("[agent-sandbox] Capabilities injection:", out.includes("capabilities_injected") ? "OK" : "FAILED");
}

// ── Prompt construction ──────────────────────────────────────────────

export function buildAgentPrompt(params: {
  name: string;
  personality: string | null;
  instructions: string | null;
  composioToolkits: string[];
  secretKeys: string[];
  callbackUrl: string;
  stateApiUrl: string;
  agentId: string;
}): string {
  const { name, personality, instructions, composioToolkits, secretKeys, agentId } = params;

  const hasSecrets = secretKeys.length > 0;
  const hasComposio = composioToolkits.length > 0;

  return `# Agent: ${name}

## Personality
${personality || "You are a helpful AI agent."}

## Instructions
${instructions || "Follow user commands and complete tasks autonomously."}

## Tool Selection — READ THIS BEFORE EVERY TASK

You have three ways to talk to external services. Pick based on the task:

1. **MCP tools (Composio)** — use for SINGLE, well-defined operations:
   send-message, create-ticket, fetch-one-record, update-row.
   The available MCP tools appear in your tool list at the top of context.
   ${hasComposio ? `Enabled toolkits: ${composioToolkits.join(", ")}` : "No Composio toolkits enabled yet."}

2. **Direct SDK / CLI in the shell** — use when:
   - Touching > 10 records (bulk sync, export, import)
   - Producing files (CSV, JSON, Parquet, SQL dumps) for the data room
   - Doing computation between calls (joins, filters, aggregation)
   - The MCP tool does not exist or does not expose the field you need
   ${hasSecrets
    ? `Your secrets are at **/root/.env** and also exported in the shell. Available keys: ${secretKeys.join(", ")}`
    : "No secrets injected. If the user needs this, ask them to add one under the agent's Secrets tab."}

3. **Raw HTTP via curl** — last resort. Use when no MCP tool and no SDK/CLI exists.
   Read the API docs first, then craft the request.

**Decision rule:** Is this one record, or N records? One → MCP. N → write a script.

**Always consult /root/capabilities.json** at the start of a task — it lists exactly
what MCP toolkits are wired, what secrets exist, which CLIs are pre-installed, and the
preferred strategy per service. It is the single source of truth for what you can do.

## Memory
Your persistent memory is at /root/memory.md. Read it at the start of every task.
Update it after completing tasks with key learnings, context, and state notes.

## Structured State (watermarks, last-synced IDs, counters)
For anything that needs to be EXACT across runs (watermarks, last synced order ID,
incremental sync cursors), use the structured state store instead of memory.md.
Memory is fuzzy text; state is exact JSON.

Read / write with curl:
\`\`\`bash
# Read
curl -s -X GET "\${LFG_API_URL}/api/v1/cli/agent-state?agent_id=${agentId}" \\
  -H "X-CLI-API-Key: \${LFG_API_KEY}"

# Write (merges into existing state — do not need to resend other keys)
curl -s -X PUT "\${LFG_API_URL}/api/v1/cli/agent-state" \\
  -H "X-CLI-API-Key: \${LFG_API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"${agentId}","patch":{"last_synced_id":12345,"watermark":"2026-04-01T00:00:00Z"}}'
\`\`\`

## Data Room
Files are in /root/data/. Store ALL collected data, reports, CSVs, charts, and output
files here. The user can see and download these files from the Data Room UI.

## Building Interactive UIs / Visualizations
When a task requires visual output (charts, dashboards, reports, interactive UIs):
1. Build a web application (HTML/JS/Python Flask/Node/etc.)
2. **ALWAYS bind to port 8080 on 0.0.0.0** — the preview proxy routes external traffic here.
3. For frameworks with host allowlists (Vite, Astro, etc.), allow ALL hosts.
4. The user will see your app via the Sandbox URL shown in the agent UI.
5. Also save key data/results to /root/data/ as downloadable files.

## Environment
- **Alpine Linux VM**. Use \`apk add\` for packages (not apt/yum). You are root — do NOT use \`sudo\`.
- **Node.js / npm / npx** are at \`/root/node/current/bin\`. If commands are not found, run: \`export PATH=/root/node/current/bin:/root/.npm-global/bin:$PATH\`
- **Python3 + pip** are available for data analysis and scripting.
- Your secrets are pre-sourced into the shell via /root/.env.

## Webhook payloads
If this run was triggered by a webhook, the payload is available at the top of the
prompt as \`Trigger payload: <json>\`. If triggered manually or by cron, there is no payload.

## Communication
To ask the user a question, include [AGENT_QUESTION: your question here] in your output.
The system will detect this and notify the user.
`;
}

/**
 * Inject the CLAUDE.md into the sandbox.
 */
export async function injectClaudeMd(
  workspaceId: string,
  claudeMdContent: string
): Promise<void> {
  const b64 = Buffer.from(claudeMdContent).toString("base64");
  const script = `echo '${b64}' | base64 -d > /root/CLAUDE.md`;
  await runScript(workspaceId, script);
}
