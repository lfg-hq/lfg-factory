/**
 * Agent Runner — non-chat entry point for autonomous agent runs.
 *
 * Used by cron / webhook / manual / start triggers. Routes through the SAME
 * tool surface the chat-side LLM uses (Composio toolrouter + web search +
 * agent self-config tools + runInSandbox), so a "summarize my Gmail" cron
 * fire is one Composio API call + one LLM call — no sandbox provisioning,
 * no Mags workspace overhead.
 *
 * When a task genuinely needs compute (ffmpeg, headless browser, large data),
 * the LLM escalates by calling `runInSandbox` which lazy-fires a Mags VM.
 *
 * Persisted side-effects per run:
 *   - agent_task_run row: lifecycle for the Runs tab (queued → running → success/error)
 *   - messages rows (in the agent's chat conversation): user message = the scheduled
 *     prompt, assistant message = the run's output. So users see the scheduled
 *     activity inline in the agent's chat tab.
 *   - WS broadcast: live update for any open agent tab.
 *   - agentBus 'agent.command_completed' emit: triggers the reflection loop.
 */

import { generateText, stepCountIs } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { agents } from "../db/schema/agents.ts";
import { messages, conversations, modelSelections } from "../db/schema/chat.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { getModelWithSearch, DEFAULT_MODEL_KEY, getProviderName } from "../ai/provider.ts";
import { getAgentSystemPrompt } from "../ai/prompts/agent.ts";
import { createAgentTools } from "../ai/tools/agent-tools.ts";
import { getComposioTools, listConnectors } from "./composio-manager.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { agentBus } from "../events/agent-bus.ts";
import {
  createRun,
  markRunStarted,
  finishRun,
  getActiveRunForAgent,
  type RunTrigger,
} from "./agent-runs.ts";

const HISTORY_LIMIT = 20;
const TOOL_STEP_CAP = 12;

export interface RunAgentTaskInput {
  agentId: string;
  userId: string;
  prompt: string;
  triggerType: RunTrigger;
  scheduleId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface RunAgentTaskResult {
  runId: string;
  output: string;
  status: "success" | "error";
  errorMessage?: string;
}

export async function runAgentTask(input: RunAgentTaskInput): Promise<RunAgentTaskResult> {
  const { agentId, userId, prompt, triggerType, scheduleId, payload } = input;

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, userId)))
    .limit(1);
  if (!agent) throw new Error(`Agent ${agentId} not found for user ${userId}`);
  if (!agent.conversationId) throw new Error(`Agent ${agentId} has no conversation thread`);

  // Concurrency lock — one run at a time per agent
  const active = await getActiveRunForAgent(agent.id);
  if (active) {
    throw new Error(
      `Agent already has an active run (${active.id}, status=${active.status}). Skipping fire.`
    );
  }

  // ── 1. Create run row ──────────────────────────────────────────────────────
  // Prefix non-chat triggers with a marker so the LLM recognizes this as an
  // execution trigger (not a fresh user request) and doesn't, e.g., re-create
  // a schedule on every cron fire. The agent prompt knows to act on this
  // prefix without spawning meta-tools.
  const triggerPrefix = triggerType === "chat"
    ? ""
    : `[Scheduled run · ${triggerType} · ${new Date().toISOString()}] `;
  const basePrompt = payload && Object.keys(payload).length
    ? `Trigger payload: ${JSON.stringify(payload)}\n\n${prompt}`
    : prompt;
  const cliPrompt = `${triggerPrefix}${basePrompt}`;

  const run = await createRun({
    agentRowId: agent.id,
    scheduleId: scheduleId ?? null,
    triggerType,
    prompt: cliPrompt,
    payload: payload ?? null,
    timeoutMs: agent.runTimeoutMs ?? undefined,
  });
  await markRunStarted(run.id);

  // ── 2. Persist the trigger as a user message in the chat thread ───────────
  // Cron/webhook fires appear inline in the agent's chat so the user sees
  // exactly what was asked and the response.
  await db.insert(messages).values({
    conversationId: agent.conversationId,
    role: "user",
    content: cliPrompt,
  });

  broadcastToUser(userId, {
    type: "agent_message",
    agent_id: agentId,
    agent_name: agent.name,
    role: "user",
    content: cliPrompt,
    trigger_type: triggerType,
  });

  // ── 3. Resolve model + API keys (mirrors stream-handler) ──────────────────
  const [modelSel] = await db
    .select()
    .from(modelSelections)
    .where(eq(modelSelections.userId, userId));
  const [apiKeys] = await db
    .select()
    .from(llmApiKeys)
    .where(eq(llmApiKeys.userId, userId));

  const modelKey = modelSel?.selectedModel ?? DEFAULT_MODEL_KEY;
  const userApiKeys = apiKeys
    ? {
        anthropic: apiKeys.anthropicApiKey ?? undefined,
        openai: apiKeys.openaiApiKey ?? undefined,
        google: apiKeys.googleApiKey ?? undefined,
        kimi: apiKeys.kimiApiKey ?? undefined,
      }
    : undefined;

  const providerName = getProviderName(modelKey);
  const keyMap: Record<string, string | undefined> = {
    openai: userApiKeys?.openai,
    anthropic: userApiKeys?.anthropic,
    google: userApiKeys?.google,
    kimi: userApiKeys?.kimi,
  };
  if (providerName && !keyMap[providerName]) {
    const errMsg = `No ${providerName} API key — scheduled run cannot execute. Add a key in Settings → LLM Keys.`;
    await persistAndFinish(agent, agentId, userId, run.id, errMsg, "error");
    return { runId: run.id, output: errMsg, status: "error", errorMessage: errMsg };
  }

  let model;
  let searchTools: Record<string, unknown> = {};
  try {
    const result = getModelWithSearch(modelKey, userApiKeys, { allowEnvFallback: false });
    model = result.model;
    searchTools = result.searchTools;
  } catch (err) {
    const errMsg = `Failed to initialize model "${modelKey}": ${(err as Error).message}`;
    await persistAndFinish(agent, agentId, userId, run.id, errMsg, "error");
    return { runId: run.id, output: errMsg, status: "error", errorMessage: errMsg };
  }

  // ── 4. Load history (recent messages from the agent's chat) ───────────────
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, agent.conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT);

  const contextMessages = history
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content }));

  // ── 5. Tools: same shape as chat-side agent ───────────────────────────────
  let tools: Record<string, any> = {};

  // Per-agent toolkit gating — same rules as stream-handler.ts. Empty
  // composioToolkits means no Composio tools at all (strict opt-in).
  const composioTools = await Promise.race([
    getComposioTools(userId, agent.composioToolkits ?? []),
    new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 10_000)),
  ]);
  if (Object.keys(composioTools).length > 0) tools = { ...tools, ...composioTools };

  if (Object.keys(searchTools).length > 0) tools = { ...tools, ...searchTools };

  const agentTools = createAgentTools({ agentId, userId });
  tools = { ...tools, ...agentTools };

  // ── 6. System prompt (identical to chat-side agent) ───────────────────────
  // filter='connected' on session-scoped endpoint returns 0 for manageConnections
  // sessions — use filter='all' and post-filter by isConnected instead.
  // limit hard-capped at 50 by Composio.
  const connectorList = await Promise.race([
    listConnectors(userId, { filter: "all", limit: 50 }),
    new Promise<{ items: [] }>((resolve) => setTimeout(() => resolve({ items: [] }), 5_000)),
  ]);
  const systemPrompt = getAgentSystemPrompt({
    name: agent.name,
    personality: agent.personality,
    instructions: agent.instructions,
    memoryContent: agent.memoryContent,
    connectedToolkits: connectorList.items.filter((t: any) => t.isConnected).map((t: any) => t.slug),
  });

  // ── 7. Run the LLM (non-streaming — we want the final text only) ──────────
  let output = "";
  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: contextMessages,
      tools: tools as Record<string, any>,
      stopWhen: stepCountIs(TOOL_STEP_CAP),
    });
    output = (result.text || "").trim();
    if (!output) {
      // Some tool-loop runs end without a text response (just tool calls).
      // Surface something useful instead of an empty bubble.
      const toolNames = result.steps
        .flatMap((s: any) => s.toolCalls || [])
        .map((tc: any) => tc.toolName);
      output = toolNames.length
        ? `(no text response — tools called: ${Array.from(new Set(toolNames)).join(", ")})`
        : "(no response generated)";
    }
  } catch (err) {
    const errMsg = `LLM call failed: ${(err as Error).message}`;
    await persistAndFinish(agent, agentId, userId, run.id, errMsg, "error");
    return { runId: run.id, output: errMsg, status: "error", errorMessage: errMsg };
  }

  // ── 8. Persist assistant message + broadcast + finish run ─────────────────
  await persistAndFinish(agent, agentId, userId, run.id, output, "success");

  return { runId: run.id, output, status: "success" };
}

async function persistAndFinish(
  agent: typeof agents.$inferSelect,
  agentId: string,
  userId: string,
  runId: string,
  output: string,
  status: "success" | "error"
): Promise<void> {
  if (agent.conversationId) {
    await db.insert(messages).values({
      conversationId: agent.conversationId,
      role: "assistant",
      content: output,
    });
  }

  broadcastToUser(userId, {
    type: "agent_message",
    agent_id: agentId,
    agent_name: agent.name,
    role: "assistant",
    content: output,
  });

  await finishRun(runId, {
    status,
    outputSummary: output.slice(0, 4000),
    errorMessage: status === "error" ? output : null,
  });

  // agent.command_completed event (fired by finishRun on success) triggers
  // the reflection loop registered in src/services/agent-reflector.ts.
}
