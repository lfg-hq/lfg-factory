/**
 * The models a person can run evals with: the same ones their chat can use, through the
 * project's API keys or their own ChatGPT subscription.
 */
import { eq } from "drizzle-orm";
import type { LanguageModel } from "ai";
import { db } from "../../config/db.ts";
import { modelSelections } from "../../db/schema/chat.ts";
import { getModel, getProviderName } from "../../ai/provider.ts";
import { SUBSCRIPTION_PREFIX, createPiSubscriptionModel, isSubscriptionModel } from "../../ai/pi-subscription-model.ts";
import { availableChatModels } from "../available-models.ts";
import { teamApiKeys } from "../llm-access.ts";

export interface EvalModelOption { key: string; label: string; provider: string }

/** Models this person can use in this project, and the one their chat is set to. */
export async function evalModelOptions(userId: string, publicProjectId: string): Promise<{ models: EvalModelOption[]; selected: string | null }> {
  const usable = (await availableChatModels(userId, publicProjectId).catch(() => [])).filter((m) => m.available);
  const [selection] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId)).limit(1);
  return {
    models: usable.map((m) => ({ key: m.key, label: m.label, provider: m.providerLabel })),
    selected: usable.find((m) => m.key === selection?.selectedModel)?.key ?? usable[0]?.key ?? null,
  };
}

export type ModelResolver = (key: string) => Promise<{ model: LanguageModel; provider: string | null }>;

/** Turns a model key into a model that spends this person's access to the project. Keys are read once per run. */
export function modelResolver(userId: string, project: { id: string; projectId: string }): ModelResolver {
  let keys: ReturnType<typeof teamApiKeys> | null = null;
  return async (key) => {
    if (isSubscriptionModel(key)) {
      const { subscriptionOwner } = await import("../subscription-execution.ts");
      const { getOpenAICodexAccessToken } = await import("../openai-codex-auth.ts");
      return { provider: "openai", model: createPiSubscriptionModel(key.slice(SUBSCRIPTION_PREFIX.length), async () => getOpenAICodexAccessToken(await subscriptionOwner(userId, project.projectId))) };
    }
    const stored = await (keys ??= teamApiKeys(userId, project.id));
    return {
      provider: getProviderName(key),
      model: getModel(key, {
        anthropic: stored?.anthropicApiKey ?? undefined, openai: stored?.openaiApiKey ?? undefined, google: stored?.googleApiKey ?? undefined,
        kimi: stored?.kimiApiKey ?? undefined, deepseek: stored?.deepseekApiKey ?? undefined, glm: stored?.glmApiKey ?? undefined,
      }),
    };
  };
}
