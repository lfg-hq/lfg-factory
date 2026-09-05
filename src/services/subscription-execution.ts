import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { projects } from "../db/schema/projects.ts";
import { resolveLlmGrants } from "./llm-access.ts";
import { getOpenAICodexAccessToken } from "./openai-codex-auth.ts";
import { createPiSubscriptionModel, isSubscriptionModel, SUBSCRIPTION_PREFIX } from "../ai/pi-subscription-model.ts";
import { currentSubscription, withSubscription, withoutSubscription } from "../ai/subscription-context.ts";

export async function subscriptionOwner(userId: string, projectId?: string | null): Promise<string> {
  if (!projectId) return userId;
  const [project] = await db.select({ id: projects.id, ownerId: projects.ownerId }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!project) return userId;
  const grants = await resolveLlmGrants(project, userId);
  return grants.canUseSub ? grants.ownerId : userId;
}

/** New background runs re-resolve the acting user's persisted choice. */
export async function withUserSubscription<T>(userId: string, projectId: string | null | undefined, run: () => Promise<T>): Promise<T> {
  const [selection] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId)).limit(1);
  if (!selection || !isSubscriptionModel(selection.selectedModel)) return withoutSubscription(run);
  return withSubscription({
    modelId: selection.selectedModel.slice(SUBSCRIPTION_PREFIX.length),
    getAccessToken: async () => getOpenAICodexAccessToken(await subscriptionOwner(userId, projectId)),
  }, run);
}

/** For standalone evaluators/preview jobs that are not children of a chat turn. */
export async function selectedSubscriptionModel(userId: string, internalProjectId?: string) {
  const inherited = currentSubscription();
  if (inherited) return createPiSubscriptionModel(inherited.modelId, inherited.getAccessToken);
  const [selection] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId)).limit(1);
  if (!selection || !isSubscriptionModel(selection.selectedModel)) return null;
  return createPiSubscriptionModel(selection.selectedModel.slice(SUBSCRIPTION_PREFIX.length), async () => {
    let ownerId = userId;
    if (internalProjectId) {
      const [project] = await db.select({ id: projects.id, ownerId: projects.ownerId }).from(projects).where(eq(projects.id, internalProjectId)).limit(1);
      if (project && (await resolveLlmGrants(project, userId)).canUseSub) ownerId = project.ownerId;
    }
    return getOpenAICodexAccessToken(ownerId);
  });
}
