/**
 * A small model for naming a chat when the chat itself ran on the user's computer
 * ("Use my computer for AI"), where there is no server model to ask.
 *
 * Only models the user already pays for: their connected ChatGPT subscription first,
 * then any API key they saved. Never LFG's own keys. Null when there is none, and the
 * caller keeps the first words of the request.
 */
import type { LanguageModel } from "ai";
import { getLiteModelKeyFor, getModel, type ProviderName } from "./provider.ts";
import { createPiSubscriptionModel } from "./pi-subscription-model.ts";

type Keys = Partial<Record<ProviderName, string>>;

export async function localTitleModel(userId: string, publicProjectId: string | null | undefined, keys?: Keys): Promise<LanguageModel | null> {
  try {
    const { userLlmAccess } = await import("../services/llm-access.ts");
    const access = await userLlmAccess(userId, publicProjectId);
    if (access.canUseSubscription) {
      const { getOpenAICodexAccessToken } = await import("../services/openai-codex-auth.ts");
      // Throws when no subscription is connected; then fall through to API keys.
      await getOpenAICodexAccessToken(userId);
      return createPiSubscriptionModel(getLiteModelKeyFor("openai") ?? "gpt-5.6-luna", () => getOpenAICodexAccessToken(userId));
    }
  } catch { /* no subscription */ }
  for (const provider of ["anthropic", "openai", "google", "deepseek", "kimi", "glm"] as ProviderName[]) {
    const lite = keys?.[provider] ? getLiteModelKeyFor(provider) : null;
    if (!lite) continue;
    try { return getModel(lite, keys); } catch { /* try the next provider */ }
  }
  return null;
}
