/**
 * Agent Reflector
 *
 * After a non-chat run completes (cron / webhook / manual / start), spin up a
 * lightweight LLM pass that:
 *   - Reads the run's prompt + output summary
 *   - Decides whether to update the agent's persistent memory
 *   - Decides whether to refine the agent's standing instructions
 *
 * The reflector has access ONLY to updateMemory and proposeAgentConfig —
 * no sandbox, no Composio, no web search. It's a pure "think about what
 * just happened" pass.
 *
 * This is the evolutionary layer: instructions + memory drift toward the
 * agent's actual purpose based on real outcomes, not just user edits.
 */

import { generateText, stepCountIs } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { agents, agentTaskRuns } from "../db/schema/agents.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { agentBus } from "../events/agent-bus.ts";
import { getModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { createAgentTools } from "../ai/tools/agent-tools.ts";

// Don't reflect on every chat turn — that's noise. Only the autonomous
// triggers where the agent acted on its own.
const REFLECT_TRIGGERS = new Set(["cron", "webhook", "manual", "start"]);

// Cool-down: don't reflect more than once per N minutes per agent.
const MIN_INTERVAL_MS = 5 * 60_000;
const lastReflectionAt = new Map<string, number>();

export function registerAgentReflector(): void {
  agentBus.on("agent.command_completed", async ({ agentId, userId }) => {
    try {
      await reflectOnLatestRun(agentId, userId);
    } catch (err) {
      console.error(`[agent-reflector] reflect error for ${agentId}:`, (err as Error).message);
    }
  });
  console.log("[agent-reflector] Listening for agent.command_completed");
}

async function reflectOnLatestRun(agentId: string, userId: string): Promise<void> {
  // Cool-down check
  const last = lastReflectionAt.get(agentId) ?? 0;
  if (Date.now() - last < MIN_INTERVAL_MS) return;

  // Look up the agent + the most recent finished run
  const [agentRow] = await db
    .select()
    .from(agents)
    .where(eq(agents.agentId, agentId))
    .limit(1);
  if (!agentRow) return;

  const [run] = await db
    .select()
    .from(agentTaskRuns)
    .where(and(eq(agentTaskRuns.agentId, agentRow.id), eq(agentTaskRuns.status, "success")))
    .orderBy(desc(agentTaskRuns.finishedAt))
    .limit(1);
  if (!run) return;
  if (!REFLECT_TRIGGERS.has(run.triggerType)) return;

  // Resolve the user's model + key (same pattern as stream-handler)
  const [modelSel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId));
  const [apiKeys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, userId));
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

  let model;
  try {
    model = getModel(modelKey, userApiKeys, { allowEnvFallback: false });
  } catch (err) {
    console.log(`[agent-reflector] No model available for user ${userId} — skipping reflection`);
    return;
  }

  // Reflection-only tool subset
  const allTools = createAgentTools({ agentId, userId });
  const reflectionTools = {
    updateMemory: allTools.updateMemory,
    proposeAgentConfig: allTools.proposeAgentConfig,
  };

  const systemPrompt = `You are the reflection layer for an autonomous AI agent named "${agentRow.name}".

The agent just completed an autonomous run (trigger: ${run.triggerType}). Your job is to look at what just happened and decide ONE of:

1. **Update memory** (call \`updateMemory\`) — if there's a fact, preference, or outcome worth retaining for future runs. Write the COMPLETE new memory, not just a delta.
2. **Refine instructions** (call \`proposeAgentConfig\` with \`instructions\`) — if the standing instructions should be tightened, clarified, or expanded based on what worked / didn't work this run.
3. **Do nothing** — if the run was routine and there's nothing new to learn, just respond "(no changes)".

Be conservative. Most runs don't need a memory update. Only persist when there's signal: a corrected misunderstanding, a learned user preference, a new data point that affects future behavior.

Current agent state:
- Name: ${agentRow.name}
- Standing instructions: ${agentRow.instructions || "(none)"}
- Existing memory:
${agentRow.memoryContent || "(empty)"}`;

  const userMessage = `Run that just completed:

Trigger: ${run.triggerType}${run.scheduleId ? " (scheduled)" : ""}
Prompt: ${run.prompt}
Status: ${run.status}${run.exitCode !== null ? ` (exit ${run.exitCode})` : ""}
Output summary:
${run.outputSummary || "(no output captured)"}

Reflect and decide: update memory, refine instructions, or no changes.`;

  try {
    lastReflectionAt.set(agentId, Date.now());
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: reflectionTools as Record<string, any>,
      stopWhen: stepCountIs(4),
    });
    console.log(
      `[agent-reflector] ${agentId} reflected on ${run.triggerType} run ${run.id} — ` +
      `steps=${result.steps.length} tools=${result.steps.flatMap((s: any) => s.toolCalls || []).map((tc: any) => tc.toolName).join(",") || "none"}`
    );
  } catch (err) {
    console.error(`[agent-reflector] generateText error for ${agentId}:`, (err as Error).message);
  }
}
