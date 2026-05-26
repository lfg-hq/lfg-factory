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
import { sendCommand, startAgent } from "../../services/agent-manager.ts";
import { listConnectors, connectToolkit } from "../../services/composio-manager.ts";
import { addSchedule, removeSchedule } from "../../services/agent-scheduler.ts";
import { broadcastToUser } from "../../ws/connection-manager.ts";
import { env } from "../../config/env.ts";

export function createAgentTools(params: {
  agentId: string;
  userId: string;
}) {
  const { agentId, userId } = params;

  const runInSandbox = tool({
    description:
      "Dispatch a compute task to your dedicated sandbox VM (Alpine Linux with Node.js, Python, Claude CLI). " +
      "Use this for: running code, building web apps or interactive charts, scraping/processing data, " +
      "installing packages, executing multi-step CLI workflows. The sandbox can build interactive web apps " +
      "on port 8080 (visible via the Sandbox URL). Results/files are saved to /root/data/ and appear in the " +
      "Data Room. Tasks run asynchronously — you'll see sandbox messages arrive as the work progresses. " +
      "The sandbox starts on demand the first time you call this; the user does not need to start anything.",
    inputSchema: zodSchema(
      z.object({
        task: z
          .string()
          .describe(
            "Detailed task description for the sandbox agent. Include: what to build/run/analyze, " +
              "what data to use, expected outputs (files, ports, visualizations), and any context from " +
              "the conversation. Be specific — the sandbox agent only knows what you tell it."
          ),
      })
    ),
    execute: async ({ task }) => {
      const [agentRow] = await db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.agentId, agentId))
        .limit(1);

      if (!agentRow) return "Error: Agent record not found.";

      if (agentRow.status !== "running" && agentRow.status !== "starting") {
        startAgent(agentId, userId).catch((err) => {
          console.error(`[agent-tools] lazy-start failed:`, (err as Error).message);
        });
        return (
          `The sandbox is starting up now. Tell the user one short sentence that you're spinning up the sandbox, ` +
          `then re-call \`runInSandbox\` after a brief pause to dispatch this task: "${task.slice(0, 120)}${task.length > 120 ? "..." : ""}"`
        );
      }

      if (agentRow.status === "starting") {
        return (
          "The sandbox is still starting. Wait a few seconds and call `runInSandbox` again with the same task."
        );
      }

      try {
        await sendCommand(agentId, task, userId);
        return (
          `Task dispatched to sandbox: "${task.slice(0, 120)}${task.length > 120 ? "..." : ""}". ` +
          `The sandbox is now executing. Watch for sandbox messages below — results and files will appear in the Data Room when complete.`
        );
      } catch (err) {
        return `Failed to dispatch to sandbox: ${(err as Error).message}`;
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
      "Surface an inline 'Connect [Service]' button in the chat for an integration the user hasn't connected yet. " +
      "After the user clicks and completes OAuth, the chat AUTOMATICALLY resends their last message so you can " +
      "fulfill the original task — you don't need to ask them to retry. Call this instead of telling the user to " +
      "'go to Settings and come back.' Verify the slug exists first via lookupComposioToolkits.",
    inputSchema: zodSchema(
      z.object({
        toolkit: z
          .string()
          .describe("Composio toolkit slug to connect — e.g. 'GMAIL', 'SLACK', 'GITHUB', 'APOLLO'. Use the exact slug from lookupComposioToolkits."),
      })
    ),
    execute: async ({ toolkit }) => {
      try {
        const callbackUrl =
          `${env.BETTER_AUTH_URL}/api/composio/callback` +
          `?popup=1&toolkit=${encodeURIComponent(toolkit)}&agent_id=${encodeURIComponent(agentId)}`;
        const result = await connectToolkit(userId, toolkit, callbackUrl);

        if ("error" in result) {
          return `Failed to initiate connection: ${result.error}. Confirm the slug is correct (use lookupComposioToolkits) or ask the user to connect manually.`;
        }

        // No-auth toolkit — already saved
        if (!result.redirectUrl) {
          broadcastToUser(userId, {
            type: "connector_connected",
            agent_id: agentId,
            toolkit,
          });
          return `Connected ${toolkit} (no-auth). The user's last message will be auto-retried — proceed with the task.`;
        }

        // Broadcast inline Connect CTA — frontend renders a button that opens redirectUrl
        broadcastToUser(userId, {
          type: "connector_required",
          agent_id: agentId,
          toolkit,
          redirect_url: result.redirectUrl,
        });

        return (
          `Surfaced a 'Connect ${toolkit}' button in the chat. ` +
          `Tell the user briefly: "I need ${toolkit} to do that — click the Connect button above. " ` +
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

  return {
    runInSandbox,
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
