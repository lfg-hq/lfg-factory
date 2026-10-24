import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import modelsConfig from "../config/llm-models.json";
import { subscriptionCatalog, SUBSCRIPTION_PREFIX } from "./pi-subscription-model.ts";
import { getProviderModel } from "./provider.ts";

/**
 * How much context a chat turn may send, per model and per connection type.
 *
 * One flow for every model; only the numbers differ. The window comes from the model
 * catalog. We use at most ~93% of it (room for the reply), and condensing starts at 75%
 * of that (~70% of the window). A ceiling caps it: API keys pay per input token on every
 * step, so their ceiling is a cost choice; a ChatGPT subscription has no per-token bill,
 * but large prompts use up the plan's limits faster, so its ceiling is higher.
 */
export type ContextProfile = { route: "subscription" | "api"; window: number; budget: number };

const DEFAULT_WINDOW = 128_000;
const WINDOW_SHARE = 0.93;
const envNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 16_000 ? Math.floor(value) : fallback;
};

let windows: Map<string, number> | null = null;
function catalogWindows(): Map<string, number> {
  if (windows) return windows;
  windows = new Map();
  for (const provider of [openaiProvider, anthropicProvider, deepseekProvider, googleProvider]) {
    try { for (const m of provider().getModels()) if (m.contextWindow) windows.set(m.id, m.contextWindow); } catch { /* catalog optional */ }
  }
  // Explicit per-model values in llm-models.json win (models newer than the catalog).
  for (const p of Object.values((modelsConfig as any).providers ?? {}) as any[]) {
    for (const m of p.models ?? []) if (Number(m.context_window) > 0) windows.set(String(m.provider_model).replace(/^models\//, ""), Number(m.context_window));
  }
  return windows;
}

export function contextWindowFor(modelKey: string): number {
  if (modelKey.startsWith(SUBSCRIPTION_PREFIX)) {
    const id = modelKey.slice(SUBSCRIPTION_PREFIX.length);
    return subscriptionCatalog().find(m => m.id === id)?.contextWindow || DEFAULT_WINDOW;
  }
  const providerModel = (getProviderModel(modelKey) ?? modelKey).replace(/^models\//, "");
  return catalogWindows().get(providerModel) ?? DEFAULT_WINDOW;
}

export function contextProfile(modelKey: string): ContextProfile {
  const route = modelKey.startsWith(SUBSCRIPTION_PREFIX) ? "subscription" : "api";
  const window = contextWindowFor(modelKey);
  // A fixed budget, when an operator sets one, still applies to every model.
  const fixed = Number(process.env.CHAT_CONTEXT_BUDGET_TOKENS);
  const ceiling = Number.isFinite(fixed) && fixed >= 16_000 ? Math.floor(fixed)
    : route === "subscription" ? envNumber("CHAT_CONTEXT_CEILING_SUBSCRIPTION", 400_000) : envNumber("CHAT_CONTEXT_CEILING_API", 200_000);
  return { route, window, budget: Math.max(16_000, Math.min(Math.floor(window * WINDOW_SHARE), ceiling)) };
}

/**
 * Real token counts calibrate our estimate. The estimate (bytes/3, 4,096 per image)
 * overcounts by roughly half; after each step the provider reports the true input size,
 * and the ratio is reused for the rest of the turn and for this conversation's next turn.
 */
const calibration = new Map<string, number>();
export function tokenScale(conversationId: string | null | undefined): number {
  return (conversationId && calibration.get(conversationId)) || 1;
}
export function recordTokenScale(conversationId: string | null | undefined, measured: number | undefined, estimated: number): number | null {
  if (!conversationId || !measured || measured <= 0 || estimated <= 0) return null;
  // Bounded: a single odd step (e.g. a huge image) must not make the estimate reckless.
  const scale = Math.min(1, Math.max(0.35, measured / estimated));
  calibration.delete(conversationId);
  calibration.set(conversationId, scale);
  if (calibration.size > 2000) calibration.delete(calibration.keys().next().value!);
  return scale;
}
