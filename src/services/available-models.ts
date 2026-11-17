import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { listChatModels } from "../ai/provider.ts";
import { isSubscriptionModel } from "../ai/pi-subscription-model.ts";
import { hasOpenAICodexCredentials } from "./openai-codex-auth.ts";
import { userLlmAccess } from "./llm-access.ts";

export async function availableChatModels(userId: string, projectId?: string | null) {
  const access = await userLlmAccess(userId, projectId);
  const [keys] = access.canUseKey ? await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, access.keyUserId)).limit(1) : [];
  const providers: Record<string, boolean> = { openai: !!keys?.openaiApiKey, anthropic: !!keys?.anthropicApiKey, google: !!keys?.googleApiKey, kimi: !!keys?.kimiApiKey, deepseek: !!keys?.deepseekApiKey, glm: !!keys?.glmApiKey };
  const connected = access.canUseSubscription && await hasOpenAICodexCredentials(userId);
  return listChatModels().filter(m => isSubscriptionModel(m.key) ? access.canUseSubscription : access.canUseKey && providers[m.provider]).map(m => ({ ...m, available: isSubscriptionModel(m.key) ? connected : true }));
}

/**
 * What the chat's model picker offers. With "Use my computer for AI" on, the choices are
 * the agent on the person's computer: its own default, or one of its models (Claude Code:
 * Opus, Sonnet, Haiku, Fable). The server's models aren't used for their chats.
 */
export async function chatPickerModels(userId: string, projectId?: string | null) {
  const { localAiSettings, LOCAL_AGENT_MODELS, LOCAL_AGENT_EFFORTS } = await import("./runner/opt-in.ts");
  const { AGENT_LABELS } = await import("./runner/protocol.ts");
  const local = await localAiSettings(userId);
  if (local.enabled) {
    const agentLabel = AGENT_LABELS[local.agent];
    const providerLabel = `${agentLabel} · on my computer`;
    const base = { providerLabel, requiresPro: false, available: true };
    const models = [
      { ...base, key: `local/${local.agent}`, label: `${agentLabel} · default model`, optionLabel: "Default (as set on your computer)" },
      ...LOCAL_AGENT_MODELS[local.agent].map(m => ({ ...base, key: `local/${local.agent}/${m.id}`, label: `${agentLabel} · ${m.label}`, optionLabel: m.label })),
    ];
    const selectedKey = local.model ? `local/${local.agent}/${local.model}` : `local/${local.agent}`;
    return { models, local: true as const, selectedKey, agent: local.agent, efforts: LOCAL_AGENT_EFFORTS[local.agent], effort: local.effort };
  }
  return { models: await availableChatModels(userId, projectId), local: false as const };
}
