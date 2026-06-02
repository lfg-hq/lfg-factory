/**
 * Agent-specific tools available to a live agent:
 *   - runInSandbox: dispatch compute tasks
 *   - updateMemory: persist long-term context
 *   - proposeAgentConfig: update the agent's own name/personality/instructions
 *   - lookupComposioToolkits: discover what services are in the catalog
 *   - requestConnectorAuth: surface an inline Connect button for a missing integration
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { agents, agentSchedules } from "../../db/schema/agents.ts";
import { eq } from "drizzle-orm";
import { ensureWorkspace, runPythonInKernel } from "../../services/agent-manager.ts";
import { execOnWorkspace } from "../../services/mags.ts";
import { syncDataRoom } from "../../services/agent-sandbox.ts";
import { listConnectors, connectToolkit } from "../../services/composio-manager.ts";
import { addSchedule, removeSchedule } from "../../services/agent-scheduler.ts";
import { broadcastToUser } from "../../ws/connection-manager.ts";
import { env } from "../../config/env.ts";

/**
 * Build a progress callback that broadcasts in-flight status updates over
 * the user's WS so the chat UI can show "Provisioning sandbox…",
 * "Installing libs…", etc. while a tool call is mid-flight.
 *
 * Stages are free-form strings; the message is what the user sees.
 */
function makeProgress(agentId: string, userId: string) {
  return (stage: string, message: string) => {
    try {
      broadcastToUser(userId, {
        type: "agent_progress",
        agent_id: agentId,
        stage,
        message,
        ts: Date.now(),
      });
    } catch (err) {
      console.warn(`[agent-progress] broadcast failed:`, (err as Error).message);
    }
  };
}

export function createAgentTools(params: {
  agentId: string;
  userId: string;
}) {
  const { agentId, userId } = params;

  const runInSandbox = tool({
    description:
      "Run a shell command (bash, or any single-line invocation including python -c '...', node -e '...', " +
      "ffmpeg, curl, etc.) in a persistent Linux sandbox dedicated to this agent. Synchronous — returns " +
      "stdout, stderr, and exit code when the command finishes.\n\n" +
      "You write the command — there is no AI inside the sandbox. The sandbox is just bash.\n\n" +
      "Persistent state across calls:\n" +
      "  - /root/.env contains the agent's secrets (source it: `source /root/.env`)\n" +
      "  - /root/data/ is the Data Room — any file written here auto-syncs to S3 after the command and\n" +
      "    becomes downloadable from the user's Data Room tab\n" +
      "  - Other paths persist across runs (it's a stateful workspace, not stateless)\n\n" +
      "Cold start ~1-3s on first call per session. After that, exec is ~SSH-fast.\n" +
      "Use this for: generating files (xlsx, pdf, video), running scrapers, ffmpeg jobs, installing/running " +
      "packages, building static sites — anything that needs real Linux. Don't use it for things a single " +
      "Composio API call can do.",
    inputSchema: zodSchema(
      z.object({
        command: z
          .string()
          .describe(
            "The exact shell command to run. Multi-line scripts: wrap in bash -c '...' or write a script " +
              "to /tmp/x.sh and execute. To generate a Data Room file, write to /root/data/<filename> — " +
              "it will be synced to S3 and become downloadable. Example: " +
              "`python3 -c 'import openpyxl; ...; wb.save(\"/root/data/prices.xlsx\")'`"
          ),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(600)
          .optional()
          .describe("Wall-clock timeout in seconds. Default 300 (5 min). Max 600."),
      })
    ),
    execute: async ({ command, timeout_seconds }) => {
      const tag = `[runInSandbox ${agentId.slice(0, 8)}]`;
      const cmdPreview = command.length > 200 ? command.slice(0, 200) + "..." : command;
      const tStart = Date.now();
      console.log(`${tag} ━━━━━━━━━ [START] command (${command.length}ch) ━━━━━━━━━`);
      console.log(`${tag} preview: ${cmdPreview}`);

      const progress = makeProgress(agentId, userId);
      try {
        const t0 = Date.now();
        console.log(`${tag} [phase 1/3] ensureWorkspace…`);
        const { workspaceId } = await ensureWorkspace(agentId, userId, progress);
        const ensureMs = Date.now() - t0;
        console.log(`${tag} [phase 1/3] ensureWorkspace done in ${ensureMs}ms — workspace=${workspaceId}`);
        progress("running_command", "Running command in sandbox…");
        console.log(`${tag} [phase 2/3] exec…`);

        // Base64-wrap the LLM's command so heredocs, nested quotes, multi-line
        // Python, and any shell-special char survive the SSH exec layer intact.
        // The wrapper itself contains nothing fancy that the SSH wrapping can
        // mangle — just `echo <b64> | base64 -d | bash`.
        const cmdB64 = Buffer.from(command).toString("base64");
        const wrapped = `echo ${cmdB64} | base64 -d | bash`;

        const timeoutMs = (timeout_seconds ?? 300) * 1000;
        const tExec = Date.now();
        const result = await execOnWorkspace(workspaceId, wrapped, { timeout: timeoutMs });
        const execMs = Date.now() - tExec;

        const stdoutLen = (result.output || "").length;
        const stderrLen = (result.stderr || "").length;
        console.log(
          `${tag} [phase 2/3] exec done in ${execMs}ms — exitCode=${result.exitCode} stdoutLen=${stdoutLen} stderrLen=${stderrLen}`
        );
        if (stdoutLen > 0) {
          console.log(`${tag} stdout: ${(result.output || "").slice(0, 500)}${stdoutLen > 500 ? "..." : ""}`);
        }
        if (stderrLen > 0) {
          console.log(`${tag} stderr: ${(result.stderr || "").slice(0, 500)}${stderrLen > 500 ? "..." : ""}`);
        }

        // Sync new files BEFORE returning to the LLM (same rationale as
        // runPython: avoid the "Rendering…" placeholder race).
        progress("syncing_outputs", "Saving outputs to Data Room…");
        console.log(`${tag} [phase 3/3] syncDataRoom (awaiting)…`);
        const tSync = Date.now();
        const [agentRow] = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentId, agentId)).limit(1);
        if (agentRow) {
          try {
            await syncDataRoom(workspaceId, agentRow.id);
            console.log(`${tag} [phase 3/3] syncDataRoom completed in ${Date.now() - tSync}ms`);
          } catch (err) {
            console.error(`${tag} [phase 3/3] syncDataRoom failed:`, (err as Error).message);
          }
        }
        console.log(`${tag} ━━━━━━━━━ [END] total ${Date.now() - tStart}ms ━━━━━━━━━`);

        // Cap output size so we don't blow the LLM's context with a runaway log.
        const CAP = 8_000;
        const stdout = (result.output || "").slice(0, CAP);
        const stderr = (result.stderr || "").slice(0, CAP);
        const truncated =
          (result.output || "").length > CAP || (result.stderr || "").length > CAP;

        const sections = [
          `exit code: ${result.exitCode}`,
          stdout ? `stdout:\n${stdout}` : null,
          stderr ? `stderr:\n${stderr}` : null,
          truncated ? "(output truncated to 8KB)" : null,
        ].filter(Boolean);

        return sections.join("\n\n");
      } catch (err) {
        console.error(`${tag} threw:`, (err as Error).message);
        return `Sandbox exec failed: ${(err as Error).message}`;
      }
    },
  });

  const updateMemory = tool({
    description:
      "Persist important information to your long-term memory. Call this after completing tasks to save " +
      "key findings, user preferences, patterns, ongoing work context, and anything you'll need in " +
      "future conversations. This overwrites the current memory — include ALL important information, " +
      "not just what's new. Write in Markdown for readability.",
    inputSchema: zodSchema(
      z.object({
        content: z
          .string()
          .describe(
            "Complete memory content in Markdown. Structure it with headers: " +
              "## User Preferences, ## Ongoing Tasks, ## Key Findings, ## Important Context, etc. " +
              "Include everything worth remembering — this is your only persistent storage across sessions."
          ),
      })
    ),
    execute: async ({ content }) => {
      try {
        await db
          .update(agents)
          .set({
            memoryContent: content,
            memoryLastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agents.agentId, agentId));
        return "Memory saved successfully.";
      } catch (err) {
        return `Failed to save memory: ${(err as Error).message}`;
      }
    },
  });

  const proposeAgentConfig = tool({
    description:
      "Update this agent's own configuration — name, personality, or standing instructions. " +
      "Call silently (no need to announce it) when you've inferred a good short name, when the user " +
      "describes a recurring job that should become your standing instructions, or when the user " +
      "tweaks tone/voice. Pass only the fields you want to change; omit the rest.",
    inputSchema: zodSchema(
      z.object({
        name: z.string().max(60).optional().describe("Short, memorable agent name. Title case, no emoji. E.g. 'Lead Finder', 'Standup Summary'."),
        personality: z
          .string()
          .max(800)
          .optional()
          .describe("Voice/tone for user-facing output (Slack, email, reports). Optional."),
        instructions: z
          .string()
          .max(2000)
          .optional()
          .describe("The agent's standing job — what it does whenever it's told to act. One paragraph max."),
      })
    ),
    execute: async ({ name, personality, instructions }) => {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (name !== undefined) updates.name = name;
      if (personality !== undefined) updates.personality = personality;
      if (instructions !== undefined) updates.instructions = instructions;

      try {
        await db.update(agents).set(updates).where(eq(agents.agentId, agentId));
        const summary = [
          name && `name → "${name}"`,
          instructions && `instructions set (${instructions.length} chars)`,
          personality && `personality set`,
        ].filter(Boolean).join(", ");
        return `Agent updated: ${summary || "(no changes)"}.`;
      } catch (err) {
        return `Failed to update agent: ${(err as Error).message}`;
      }
    },
  });

  const lookupComposioToolkits = tool({
    description:
      "Search the Composio catalog for integrations that fit a task. Returns real toolkit slugs, names, " +
      "descriptions, and whether each is connected by the user. Use BEFORE recommending a specific service " +
      "to make sure you're naming a real, currently-available toolkit (don't guess slugs from training data).",
    inputSchema: zodSchema(
      z.object({
        query: z
          .string()
          .describe("Keyword(s) describing the capability — e.g. 'leads', 'email', 'crm', 'calendar', 'github', 'payments'."),
        filter: z
          .enum(["all", "connected", "available"])
          .optional()
          .describe("'connected' = only what the user has already authorized; 'available' = only what's not yet connected; 'all' = both. Default: all."),
      })
    ),
    execute: async ({ query, filter }) => {
      try {
        const result = await listConnectors(userId, {
          search: query,
          filter: filter ?? "all",
          limit: 20,
        });
        if (!result.items.length) {
          return `No Composio toolkits matched "${query}". Suggest the user add an API key as an agent secret (Settings → Secrets) and call the service's API from the sandbox.`;
        }
        const lines = result.items.map((t) => {
          const flags = [
            t.isConnected ? "[CONNECTED]" : "[NOT-CONNECTED]",
            t.isNoAuth ? "[no-auth]" : null,
          ].filter(Boolean).join(" ");
          return `- ${t.slug} (${t.name}) ${flags}: ${(t.description || "").slice(0, 140)}`;
        });
        return (
          `Found ${result.items.length} toolkit(s) for "${query}":\n${lines.join("\n")}\n\n` +
          `If a toolkit is [CONNECTED], its tools are already available via composio_search_tools — just use them. ` +
          `If [NOT-CONNECTED], call \`requestConnectorAuth({toolkit: "SLUG"})\` to surface an inline Connect button for the user.`
        );
      } catch (err) {
        return `Toolkit lookup failed: ${(err as Error).message}. Suggest the user describe the API they want and add an API key as an agent secret.`;
      }
    },
  });

  const requestConnectorAuth = tool({
    description:
      "Enable a Composio toolkit for THIS agent. If the user has already connected the toolkit at account level " +
      "(see lookupComposioToolkits — [CONNECTED] flag), this enables it silently for this agent — no user " +
      "interaction needed — and you can immediately use its tools on the NEXT turn. If the user hasn't connected " +
      "it yet, this surfaces an inline 'Connect [Service]' button; after they finish OAuth the chat auto-resends " +
      "their last message. Verify the slug exists first via lookupComposioToolkits.",
    inputSchema: zodSchema(
      z.object({
        toolkit: z
          .string()
          .describe("Composio toolkit slug — e.g. 'GMAIL', 'SLACK', 'GITHUB', 'APOLLO'. Use the exact slug from lookupComposioToolkits."),
      })
    ),
    execute: async ({ toolkit }) => {
      try {
        const slug = toolkit.toUpperCase();

        // Fast path: if the user already has this toolkit connected at the
        // account level, skip OAuth entirely and just opt this agent in.
        // No popup, no user friction — the LLM can use the toolkit's tools
        // on the very next turn. (Per-agent gating still applies: tools are
        // loaded per agent based on agent.composioToolkits.)
        const userConns = await listConnectors(userId, { filter: "all", limit: 50 });
        const alreadyConnected = userConns.items.some(
          (t: any) => (t.slug || "").toUpperCase() === slug && t.isConnected
        );

        if (alreadyConnected) {
          const [agentRow] = await db
            .select({ id: agents.id, composioToolkits: agents.composioToolkits })
            .from(agents)
            .where(eq(agents.agentId, agentId))
            .limit(1);
          const current = agentRow?.composioToolkits ?? [];
          const wasAlreadyEnabledForAgent = current.includes(slug);

          if (agentRow && !wasAlreadyEnabledForAgent) {
            await db
              .update(agents)
              .set({ composioToolkits: [...current, slug], updatedAt: new Date() })
              .where(eq(agents.id, agentRow.id));
          }

          // Loop guard: if this toolkit was ALREADY enabled for this agent
          // (we're being called on a retry-after-resend), do NOT broadcast
          // or trigger another resubmit. The LLM clearly can't find the
          // tool by name in its loaded list — tell it to use
          // composio_search_tools to discover the right action instead of
          // looping on requestConnectorAuth.
          if (wasAlreadyEnabledForAgent) {
            return (
              `${slug} is ALREADY enabled for this agent — its tools should be in your loaded tool list. ` +
              `Do NOT call requestConnectorAuth again for ${slug}. ` +
              `If you can't find an obvious tool by name, call \`composio_search_tools\` with a plain-English ` +
              `description of what you want to do (e.g. "list files", "download file contents", "search drive") ` +
              `and it will return the exact action name to invoke. Then call that action directly.`
            );
          }

          // First-time silent enable for this agent: broadcast so the
          // frontend can auto-resend the user's last message after this
          // stream ends (queued via window.__pendingResubmit__).
          broadcastToUser(userId, {
            type: "connector_connected",
            agent_id: agentId,
            toolkit: slug,
            silent_enable: true,
          });
          return (
            `Enabled ${slug} for this agent (no OAuth needed — user had it connected at account level). ` +
            `IMPORTANT: write a single short sentence like "Connecting ${slug} and retrying…" then STOP. ` +
            `Do NOT call more tools. Do NOT try to use the toolkit on this turn (its tools aren't loaded ` +
            `until the user's message is re-processed). The chat will auto-rerun the user's request after ` +
            `you finish.`
          );
        }

        // Slow path: user hasn't connected at account level — kick off OAuth.
        const callbackUrl =
          `${env.BETTER_AUTH_URL}/api/composio/callback` +
          `?popup=1&toolkit=${encodeURIComponent(toolkit)}&agent_id=${encodeURIComponent(agentId)}`;
        const result = await connectToolkit(userId, toolkit, callbackUrl);

        if ("error" in result) {
          return `Failed to initiate connection: ${result.error}. Confirm the slug is correct (use lookupComposioToolkits) or ask the user to connect manually.`;
        }

        // No-auth toolkit — already saved at user level, also opt this agent in.
        if (!result.redirectUrl) {
          const [agentRow] = await db
            .select({ id: agents.id, composioToolkits: agents.composioToolkits })
            .from(agents)
            .where(eq(agents.agentId, agentId))
            .limit(1);
          if (agentRow) {
            const current = agentRow.composioToolkits ?? [];
            if (!current.includes(slug)) {
              await db
                .update(agents)
                .set({ composioToolkits: [...current, slug], updatedAt: new Date() })
                .where(eq(agents.id, agentRow.id));
            }
          }
          broadcastToUser(userId, {
            type: "connector_connected",
            agent_id: agentId,
            toolkit: slug,
          });
          return `Connected ${slug} (no-auth). The user's last message will be auto-retried — proceed with the task.`;
        }

        // Broadcast inline Connect CTA — frontend renders a button that opens redirectUrl
        broadcastToUser(userId, {
          type: "connector_required",
          agent_id: agentId,
          toolkit: slug,
          redirect_url: result.redirectUrl,
        });

        return (
          `Surfaced a 'Connect ${slug}' button in the chat. ` +
          `Tell the user briefly: "I need ${slug} to do that — click the Connect button above. " ` +
          `"I'll pick up where we left off automatically." Then STOP — do not retry yet; the chat will auto-resend their message after they connect.`
        );
      } catch (err) {
        return `Failed to surface connector: ${(err as Error).message}`;
      }
    },
  });

  const createSchedule = tool({
    description:
      "Set up a recurring schedule for this agent to run a task automatically. Use when the user describes " +
      "recurring work: 'every 2 hours', 'every morning at 9', 'every Monday'. Cron expression uses standard " +
      "5-field format: minute hour day-of-month month day-of-week. Examples: '0 9 * * *' = 9am daily, " +
      "'0 */2 * * *' = every 2 hours, '0 9 * * 1-5' = 9am weekdays. After creating, tell the user one short " +
      "sentence confirming what + when.",
    inputSchema: zodSchema(
      z.object({
        name: z.string().max(80).describe("Short label for this schedule. E.g. 'Morning email summary', 'Hourly lead check'."),
        cron_expression: z.string().describe("5-field cron expression. Examples: '0 9 * * *', '0 */2 * * *', '30 8 * * 1-5'."),
        command: z.string().describe("The task prompt that will be sent to the agent each time the schedule fires. Be specific — this is the standing instruction for the recurring run."),
        timezone: z.string().optional().describe("IANA timezone (e.g. 'America/Los_Angeles', 'Asia/Kolkata'). Defaults to UTC. Use the user's timezone if they've mentioned it."),
      })
    ),
    execute: async ({ name, cron_expression, command, timezone }) => {
      try {
        // Duplicate guard — if a schedule with the same cron + command (first
        // 100 chars match) already exists for this agent, refuse instead of
        // silently doubling fires. Prevents the LLM from creating duplicates
        // when it misreads a scheduled-run trigger as a setup request.
        const [agentRow] = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentId, agentId)).limit(1);
        if (agentRow) {
          const existing = await db
            .select({ id: agentSchedules.id, name: agentSchedules.name, command: agentSchedules.command, cronExpression: agentSchedules.cronExpression })
            .from(agentSchedules)
            .where(eq(agentSchedules.agentId, agentRow.id));
          const cmdKey = command.trim().slice(0, 100).toLowerCase();
          const dup = existing.find(
            (s) => s.cronExpression === cron_expression && s.command.trim().slice(0, 100).toLowerCase() === cmdKey
          );
          if (dup) {
            return `A near-identical schedule already exists ("${dup.name}", id=${dup.id}). Not creating a duplicate. If the user wants a different cadence or task, modify the existing one or remove it first.`;
          }
        }

        const row = await addSchedule(agentId, {
          name,
          cronExpression: cron_expression,
          command,
          timezone,
        });
        return `Scheduled "${name}" — runs on "${cron_expression}"${timezone ? ` (${timezone})` : ""}. Next run: ${row.nextRunAt?.toISOString() ?? "(unknown)"}.`;
      } catch (err) {
        return `Failed to create schedule: ${(err as Error).message}. Common cause: invalid cron expression.`;
      }
    },
  });

  const listSchedules = tool({
    description: "List all schedules currently set up for this agent. Use when the user asks 'what schedules do I have', or before modifying/removing one so you know its ID.",
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const [agentRow] = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentId, agentId)).limit(1);
      if (!agentRow) return "Agent not found.";
      const rows = await db.select().from(agentSchedules).where(eq(agentSchedules.agentId, agentRow.id));
      if (!rows.length) return "No schedules set up. Use createSchedule to add one.";
      return rows
        .map((r) => `- ${r.id}: "${r.name}" — cron "${r.cronExpression}" (${r.timezone}) — ${r.enabled ? "enabled" : "PAUSED"} — next: ${r.nextRunAt?.toISOString() ?? "?"}`)
        .join("\n");
    },
  });

  const deleteSchedule = tool({
    description: "Remove a schedule by its ID. Use listSchedules first if you don't know the ID.",
    inputSchema: zodSchema(z.object({ schedule_id: z.string().describe("The schedule's ID, from listSchedules.") })),
    execute: async ({ schedule_id }) => {
      try {
        await removeSchedule(schedule_id);
        return `Removed schedule ${schedule_id}.`;
      } catch (err) {
        return `Failed to remove: ${(err as Error).message}`;
      }
    },
  });

  const requestSecret = tool({
    description:
      "Surface an inline 'Set [KEY]' input bubble in the chat to collect a secret (API key, token) from the user. " +
      "After the user enters a value, the secret is encrypted, stored, and injected into the sandbox at /root/.env. " +
      "The chat then AUTOMATICALLY resends the user's last message so you can fulfill the original task using the new secret. " +
      "Use this when you need an API key Composio doesn't cover (e.g. APOLLO_API_KEY, SHOPIFY_TOKEN, GCP_SA_KEY).",
    inputSchema: zodSchema(
      z.object({
        key: z.string().describe("Environment variable name in UPPER_SNAKE_CASE. E.g. 'APOLLO_API_KEY', 'SHOPIFY_TOKEN'."),
        description: z.string().describe("Short user-facing label explaining what this secret unlocks. E.g. 'Apollo API key for B2B lead lookup'."),
        service: z.string().optional().describe("Optional service name. E.g. 'apollo', 'shopify', 'stripe'."),
      })
    ),
    execute: async ({ key, description, service }) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        return `Invalid key "${key}". Must be UPPER_SNAKE_CASE — letters, digits, underscores; starts with a letter.`;
      }
      broadcastToUser(userId, {
        type: "secret_required",
        agent_id: agentId,
        key,
        description,
        service: service ?? null,
      });
      return (
        `Surfaced a 'Set ${key}' input in the chat. ` +
        `Tell the user briefly: "I need ${key} for that — enter it above and I'll continue automatically." ` +
        `Then STOP — do not retry yet; the chat will auto-resend the user's message once they save the secret.`
      );
    },
  });

  const runPython = tool({
    description:
      "Execute Python code in a persistent Python interpreter inside the agent's sandbox. " +
      "Unlike runInSandbox (fresh shell every call), this hits a long-lived Python process — " +
      "variables, imports, loaded DataFrames, trained models all survive BETWEEN calls. " +
      "Use this for any data analysis: load the file once, then ask follow-up questions / " +
      "generate more charts without re-loading.\n\n" +
      "Pre-installed in the kernel's venv: pandas, numpy, matplotlib, plotly, seaborn, " +
      "scikit-learn, openpyxl. To add more: `import subprocess; subprocess.run(['/root/venv/bin/pip', 'install', '-q', 'PKG'])` then `import PKG`.\n\n" +
      "Charts: write to /root/data/<name>.html (Plotly interactive, DEFAULT) or .png " +
      "(matplotlib static fallback). They auto-sync to the Data Room AND render inline in " +
      "chat. Mention each chart in your response as [CHART: <name>.html] and the renderer " +
      "will embed it at that exact spot in your narrative (Julius-style interleaving).\n\n" +
      "Returns {ok, stdout, stderr}. Single expressions auto-print their repr " +
      "(`df.head()` shows the table). Use `print(...)` for side-effects in multi-statement cells.",
    inputSchema: zodSchema(
      z.object({
        code: z
          .string()
          .describe(
            "Python code to execute in the persistent kernel. Can be a single expression " +
              "(value gets repr'd to stdout) or multi-statement. Send the whole cell, not " +
              "just a one-liner."
          ),
      })
    ),
    execute: async ({ code }) => {
      const tag = `[runPython ${agentId.slice(0, 8)}]`;
      const preview = code.length > 200 ? code.slice(0, 200) + "..." : code;
      const tStart = Date.now();
      console.log(`${tag} ━━━━━━━━━ [START] code (${code.length}ch) ━━━━━━━━━`);
      console.log(`${tag} preview: ${preview}`);
      const progress = makeProgress(agentId, userId);
      try {
        const t0 = Date.now();
        console.log(`${tag} [phase 1/3] ensureWorkspace…`);
        const { workspaceId } = await ensureWorkspace(agentId, userId, progress);
        console.log(`${tag} [phase 1/3] ensureWorkspace done in ${Date.now() - t0}ms — workspace=${workspaceId}`);

        progress("running_python", "Running analysis in Python kernel…");
        console.log(`${tag} [phase 2/3] POST to kernel…`);
        const tExec = Date.now();
        const result = await runPythonInKernel(workspaceId, code);
        console.log(
          `${tag} [phase 2/3] kernel done in ${Date.now() - tExec}ms — ok=${result.ok} ` +
          `stdoutLen=${result.stdout.length} stderrLen=${result.stderr.length}`
        );
        if (!result.ok && result.stderr) {
          console.log(`${tag} kernel stderr: ${result.stderr.slice(0, 500)}`);
        }

        // Sync charts BEFORE returning to the LLM. If we let it run in the
        // background, the LLM streams `[CHART: foo.html]` while the file is
        // still mid-upload and the user stares at a "Rendering…" placeholder
        // for the full sync duration (+ forever if the WS event misses).
        // Awaiting here adds 1-3s of pre-narrative time but charts are ready
        // the instant they're referenced — no placeholder phase.
        progress("syncing_outputs", "Saving outputs to Data Room…");
        console.log(`${tag} [phase 3/3] syncDataRoom (awaiting)…`);
        const tSync = Date.now();
        const [agentRow] = await db.select({ id: agents.id }).from(agents).where(eq(agents.agentId, agentId)).limit(1);
        if (agentRow) {
          try {
            await syncDataRoom(workspaceId, agentRow.id);
            console.log(`${tag} [phase 3/3] syncDataRoom completed in ${Date.now() - tSync}ms`);
          } catch (err) {
            console.error(`${tag} [phase 3/3] syncDataRoom failed:`, (err as Error).message);
          }
        }
        console.log(`${tag} ━━━━━━━━━ [END] total ${Date.now() - tStart}ms ━━━━━━━━━`);

        const CAP = 8_000;
        const stdout = result.stdout.slice(0, CAP);
        const stderr = result.stderr.slice(0, CAP);
        const truncated = result.stdout.length > CAP || result.stderr.length > CAP;
        return [
          `ok: ${result.ok}`,
          stdout ? `stdout:\n${stdout}` : null,
          stderr ? `stderr:\n${stderr}` : null,
          truncated ? "(output truncated to 8KB)" : null,
        ].filter(Boolean).join("\n\n");
      } catch (err) {
        console.error(`${tag} threw:`, (err as Error).message);
        return `Python kernel call failed: ${(err as Error).message}`;
      }
    },
  });

  return {
    runInSandbox,
    runPython,
    updateMemory,
    proposeAgentConfig,
    lookupComposioToolkits,
    requestConnectorAuth,
    createSchedule,
    listSchedules,
    deleteSchedule,
    requestSecret,
  };
}
