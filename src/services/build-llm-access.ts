import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projects } from "../db/schema/projects.ts";
import { applicationState } from "../db/schema/users.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { DEFAULT_MODEL_KEY, getProviderName, getProviderModel, listModels } from "../ai/provider.ts";
import { resolveLlmGrants, teamApiKeys, NO_LLM_ACCESS_MESSAGE } from "./llm-access.ts";
import { hasOpenAICodexCredentials } from "./openai-codex-auth.ts";

// The old schema DEFAULT wrote this into builderModelKey for every row, so a
// stored value equal to it is indistinguishable from "never chose a builder
// model" — treat it as unset so those users follow their chat pick.
const LEGACY_BUILDER_DEFAULT = "claude_4.5_sonnet";
export async function resolveBuilderModelKey(ownerId: string, projectId?: string | null): Promise<string> {
  // A project can PIN the builder model for everyone (Config tab). That beats any
  // individual's account setting — the point of the pin is that a project builds the
  // same way no matter who triggered it.
  if (projectId) {
    const [p] = await db.select({ locked: projects.lockedBuilderModel }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (p?.locked) return p.locked;
  }
  const [appState] = await db.select({ k: applicationState.builderModelKey }).from(applicationState).where(eq(applicationState.userId, ownerId)).limit(1);
  if (appState?.k && appState.k !== LEGACY_BUILDER_DEFAULT) return appState.k; // explicit, non-legacy pick
  const [sel] = await db.select({ m: modelSelections.selectedModel }).from(modelSelections).where(eq(modelSelections.userId, ownerId)).limit(1);
  return sel?.m || DEFAULT_MODEL_KEY;
}

type BuilderAuthMode = "subscription" | "api_key";

/** Explicit credential source selected beside the Coding Agent model picker. */
export async function resolveBuilderAuthMode(ownerId: string, projectId?: string | null): Promise<BuilderAuthMode> {
  if (projectId) {
    const [p] = await db.select({ locked: projects.lockedBuilderAuthMode }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (p?.locked === "api_key" || p?.locked === "subscription") return p.locked;
  }
  const [appState] = await db
    .select({ mode: applicationState.builderAuthMode })
    .from(applicationState)
    .where(eq(applicationState.userId, ownerId))
    .limit(1);
  return appState?.mode === "api_key" ? "api_key" : "subscription";
}
/** Resolve the actor's model and credential source before allocating a sandbox. */
export async function resolveBuildLlm(project: { id: string; ownerId: string }, actorId: string) {
  const grants = await resolveLlmGrants(project, actorId);
  let mode = await resolveBuilderAuthMode(actorId, project.id);
  if (!grants.canUseKey && grants.canUsePersonalSubscription) mode = "subscription";
  if (!grants.canUsePersonalSubscription && grants.canUseKey) mode = "api_key";
  if (mode === "api_key" ? !grants.canUseKey : !grants.canUsePersonalSubscription) throw new Error(NO_LLM_ACCESS_MESSAGE);
  let model = await resolveBuilderModelKey(actorId, project.id);
  if (mode === "api_key") {
    const keys = await teamApiKeys(actorId, project.id);
    const enabled: Record<string, boolean> = { openai: !!keys?.openaiApiKey, anthropic: !!keys?.anthropicApiKey, google: !!keys?.googleApiKey, kimi: !!keys?.kimiApiKey, deepseek: !!keys?.deepseekApiKey, glm: !!keys?.glmApiKey };
    const allowed = listModels().filter(m => enabled[m.provider]);
    const choice = allowed.find(m => m.key === model || m.providerModel === getProviderModel(model)) ?? allowed[0];
    if (!choice) throw new Error("No team API tokens configured. Ask an admin to add tokens in Settings → LLM Keys");
    model = choice.key;
  }
  // ChatGPT's model IDs also resolve through the provider catalog.
  if (mode === "subscription" && getProviderName(model) !== "openai") {
    model = DEFAULT_MODEL_KEY;
    if (getProviderName(model) !== "openai") throw new Error("Choose an OpenAI model for your personal ChatGPT subscription");
  }
  if (mode === "subscription" && !await hasOpenAICodexCredentials(actorId)) throw new Error("Connect your personal ChatGPT subscription in Settings → Integrations");
  return { mode, model, actorId, keyUserId: grants.keyUserId };
}

