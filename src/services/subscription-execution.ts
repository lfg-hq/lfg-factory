import { availableChatModels } from "./available-models.ts";
import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { projects } from "../db/schema/projects.ts";
import { resolveLlmGrants, userLlmAccess } from "./llm-access.ts";
import { getOpenAICodexAccessToken } from "./openai-codex-auth.ts";
import { createPiSubscriptionModel, isSubscriptionModel, SUBSCRIPTION_PREFIX } from "../ai/pi-subscription-model.ts";
import { currentSubscription, withSubscription, withoutSubscription } from "../ai/subscription-context.ts";

export async function subscriptionOwner(userId: string, projectId?: string | null): Promise<string> {
  const access = await userLlmAccess(userId, projectId);
  if (!access.canUseSubscription) throw new Error("Personal ChatGPT subscriptions are disabled for this team or project");
  return userId;
}

/** New background runs re-resolve the acting user's persisted choice. */
export async function withUserSubscription<T>(userId: string, projectId: string | null | undefined, run: () => Promise<T>): Promise<T> {
  const [selection] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId)).limit(1);
  const allowed = await availableChatModels(userId, projectId);
  let selected = selection?.selectedModel;
  if (projectId) {
    const [project] = await db.select({ model: projects.lockedChatModel }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (project?.model) selected = project.model;
  }
  const model = allowed.find(m => m.key === selected) ?? allowed[0];
  if (!model) throw new Error("No models enabled. Ask your team admin to enable tokens or personal ChatGPT subscriptions.");
  if (!isSubscriptionModel(model.key)) return withoutSubscription(run);
  if (!model.available) throw new Error("Connect your personal ChatGPT subscription in Settings → Integrations.");
  return withSubscription({
    modelId: model.key.slice(SUBSCRIPTION_PREFIX.length),
    getAccessToken: async () => getOpenAICodexAccessToken(await subscriptionOwner(userId, projectId)),
  }, run);
}

/** For standalone evaluators/preview jobs that are not children of a chat turn. */
export async function selectedSubscriptionModel(userId: string, internalProjectId?: string) {
  const inherited = currentSubscription();
  if (inherited) return createPiSubscriptionModel(inherited.modelId, inherited.getAccessToken);
  let publicProjectId: string | undefined;
  if (internalProjectId) {
    const [project] = await db.select({ publicId: projects.projectId }).from(projects).where(eq(projects.id, internalProjectId)).limit(1);
    if (!project) throw new Error("Project not found");
    publicProjectId = project.publicId;
  }
  const allowed = await availableChatModels(userId, publicProjectId);
  const [selection] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId)).limit(1);
  const model = allowed.find(m => m.key === selection?.selectedModel) ?? allowed[0];
  if (!model) throw new Error("No models enabled for this account or project");
  if (!isSubscriptionModel(model.key)) return null;
  if (!model.available) throw new Error("Connect your personal ChatGPT subscription in Settings → Integrations");
  return createPiSubscriptionModel(model.key.slice(SUBSCRIPTION_PREFIX.length), async () => getOpenAICodexAccessToken(await subscriptionOwner(userId, publicProjectId)));
}
