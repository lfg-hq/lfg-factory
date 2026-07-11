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
        deepseek: apiKeys.deepseekApiKey ?? undefined,
        glm: apiKeys.glmApiKey ?? undefined,
      }
    : undefined;

  const providerName = getProviderName(modelKey);
  const keyMap: Record<string, string | undefined> = {
    openai: userApiKeys?.openai,
    anthropic: userApiKeys?.anthropic,
    google: userApiKeys?.google,
    kimi: userApiKeys?.kimi,
    deepseek: userApiKeys?.deepseek,
    glm: userApiKeys?.glm,
  };
  if (providerName && !keyMap[providerName]) {
    const errMsg = `No ${providerName} API key — scheduled run cannot execute. Add a key in Settings → LLM Keys.`;
    await persistAndFinish(agent, agentId, userId, run.id, errMsg, "error", null);
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
    await persistAndFinish(agent, agentId, userId, run.id, errMsg, "error", null);
    return { runId: run.id, output: errMsg, status: "error", errorMessage: errMsg };
  }

  // ── 4. Load history (recent messages from the agent's chat) ───────────────
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, agent.conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT);

  // Expand assistant rows that have stored tool_steps into the full AI SDK
  // message sequence so the next turn replays the LLM's prior tool context
  // (same fix as the chat-side stream-handler).
  const contextMessages: any[] = [];
  for (const m of history.reverse()) {
    const steps = (m as any).toolSteps as any[] | null | undefined;
    if (m.role === "assistant" && Array.isArray(steps) && steps.length > 0) {
      for (const step of steps) contextMessages.push(step);
    } else {
      contextMessages.push({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      });
    }
  }

  // ── 5. Tools: same shape as chat-side agent ───────────────────────────────
  let tools: Record<string, any> = {};

  // Per-agent toolkit gating — same rules as stream-handler.ts. Empty
  // composioToolkits means no Composio tools at all (strict opt-in).
  const composioTools = await Promise.race([
    getComposioTools(userId, agent.composioToolkits ?? []),
    new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 10_000)),
  ]);
  if (Object.keys(composioTools).length > 0) tools = { ...tools, ...composioTools };

  // Web search is now the provider-agnostic Exa `webSearch`/`readUrl` tools (in
  // createAgentTools), available on EVERY model. We intentionally do NOT add the
  // provider-native search here — it only exists for Anthropic/OpenAI/Google and would
  // be a confusing duplicate, while leaving DeepSeek/Kimi/GLM with no search at all.
  void searchTools;

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
    enabledToolkits: agent.composioToolkits ?? [],
  });

  // ── 7. Run the LLM (non-streaming — we want the final text only) ──────────
  let output = "";
  let savedSteps: any[] | null = null;
  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: contextMessages,
      tools: tools as Record<string, any>,
      stopWhen: stepCountIs(TOOL_STEP_CAP),
    });
    // result.text concatenates each step's text with NO separator, so a preamble
    // ("…investing in AI.") runs straight into the next step's ("Let me dig deeper…").
    // Rebuild from per-step text joined by blank lines so each renders as its own
    // paragraph instead of one run-on blob.
    const stepTexts = (result.steps ?? [])
      .map((s: any) => (s.text || "").trim())
      .filter(Boolean);
    output = (stepTexts.length ? stepTexts.join("\n\n") : (result.text || "")).trim();
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
    // Capture the full AI SDK response sequence (tool-call + tool-result
    // pairs) so the next turn can replay the LLM's prior context.
    try {
      const rawMessages: any[] = (result.response as any)?.messages ?? [];
      const serialized = JSON.stringify(rawMessages);
      if (serialized.length <= 200_000) savedSteps = rawMessages;
      else console.warn(`[agent-runner] toolSteps too large (${serialized.length}B), dropping`);
    } catch (err) {
      console.warn("[agent-runner] failed to capture response.messages:", (err as Error).message);
    }
  } catch (err) {
    const errMsg = `LLM call failed: ${(err as Error).message}`;
    await persistAndFinish(agent, agentId, userId, run.id, errMsg, "error", null);
    return { runId: run.id, output: errMsg, status: "error", errorMessage: errMsg };
  }

  // ── 8. Persist assistant message + broadcast + finish run ─────────────────
  await persistAndFinish(agent, agentId, userId, run.id, output, "success", savedSteps);

  return { runId: run.id, output, status: "success" };
}

// Postgres rejects JSON/text containing a NUL byte (\u0000) with error 22P05. Any tool
// result (e.g. a binary/gzip web-search snippet) can carry one and break the whole insert.
// Scrub NUL from the assistant content + the entire toolSteps tree before persisting.
function deepStripNul<T>(v: T): T {
  if (typeof v === "string") return v.replace(/\u0000/g, "") as unknown as T;
  if (Array.isArray(v)) return v.map((x) => deepStripNul(x)) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) out[k] = deepStripNul((v as Record<string, unknown>)[k]);
    return out as unknown as T;
  }
  return v;
}

async function persistAndFinish(
  agent: typeof agents.$inferSelect,
  agentId: string,
  userId: string,
  runId: string,
  output: string,
  status: "success" | "error",
  toolSteps: any[] | null
): Promise<void> {
  if (agent.conversationId) {
    await db.insert(messages).values({
      conversationId: agent.conversationId,
      role: "assistant",
      content: output.replace(/\u0000/g, ""),
      toolSteps: toolSteps ? deepStripNul(toolSteps) : toolSteps,
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
