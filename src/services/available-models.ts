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
 * What the chat's model picker offers. With "Use my computer for AI" on, the one choice is
 * the agent on the person's computer; the server's models aren't used for their chats.
 */
export async function chatPickerModels(userId: string, projectId?: string | null) {
  const { localAiSettings } = await import("./runner/opt-in.ts");
  const { AGENT_LABELS } = await import("./runner/protocol.ts");
  const local = await localAiSettings(userId);
  if (local.enabled) {
    return { models: [{ key: `local/${local.agent}`, label: `${AGENT_LABELS[local.agent]} · on my computer`, providerLabel: "On my computer", requiresPro: false, available: true }], local: true };
  }
  return { models: await availableChatModels(userId, projectId), local: false };
}
