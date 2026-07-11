import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { env } from "../config/env.ts";
import modelsConfig from "../config/llm-models.json" with { type: "json" };
import type { LanguageModel } from "ai";

export type ProviderName = "anthropic" | "openai" | "google" | "kimi" | "deepseek" | "glm";

/**
 * Custom fetch wrapper for Kimi K2.5.
 * Kimi auto-enables thinking mode and requires `reasoning_content` on every
 * assistant message that contains `tool_calls`. The AI SDK doesn't add this
 * field, so we patch the request body before it hits the API.
 */
async function kimiFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  console.log(`[kimi-fetch] Called! url=${typeof url === 'string' ? url : 'non-string'}, hasBody=${!!init?.body}, bodyType=${typeof init?.body}`);
  if (init?.body) {
    // Handle both string bodies and other types (Bun may pass different types)
    let raw: string | null = null;
    if (typeof init.body === "string") {
      raw = init.body;
    } else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(init.body);
    } else if (Buffer.isBuffer(init.body)) {
      raw = (init.body as Buffer).toString("utf-8");
    }
    if (raw) {
      try {
        const body = JSON.parse(raw);
        if (Array.isArray(body.messages)) {
          let patched = 0;
          for (let i = 0; i < body.messages.length; i++) {
            const msg = body.messages[i];
            if (msg.role === "assistant" && msg.tool_calls) {
              msg.reasoning_content = msg.reasoning_content || "";
              patched++;
            }
          }
          if (patched > 0) {
            console.log(`[kimi] Patched ${patched} assistant msgs with reasoning_content. Total msgs: ${body.messages.length}`);
          }
        }
        init = { ...init, body: JSON.stringify(body) };
      } catch (e) {
        console.error(`[kimi] Failed to patch body:`, e);
      }
    } else {
      console.warn(`[kimi] Body is not a string, type: ${typeof init.body}, constructor: ${init.body?.constructor?.name}`);
    }
  }
  return globalThis.fetch(url, init);
}

interface ModelEntry {
  key: string;
  label: string;
  provider_model: string;
  requires_pro: boolean;
}

interface ProviderConfig {
  label: string;
  default_model: string;
  models: ModelEntry[];
}

// Flat map: modelKey → { providerName, providerModel }
const modelIndex = new Map<string, { provider: ProviderName; model: string }>();
for (const [providerName, cfg] of Object.entries(
  modelsConfig.providers as Record<string, ProviderConfig>
)) {
  for (const m of cfg.models) {
    modelIndex.set(m.key, {
      provider: providerName as ProviderName,
      model: m.provider_model,
    });
  }
}

export const DEFAULT_MODEL_KEY = modelsConfig.default_model;

/**
 * Get a LanguageModelV1 instance from a model key (e.g. "claude_4.5_sonnet").
 * Optionally supply per-user API keys.
 * When allowEnvFallback is false (default), user must provide their own key.
 * When true (instant mode), falls back to server env vars.
 */
export function getModel(
  modelKey: string,
  userApiKeys?: { anthropic?: string; openai?: string; google?: string; kimi?: string; deepseek?: string; glm?: string },
  { allowEnvFallback = false }: { allowEnvFallback?: boolean } = {}
): LanguageModel {
  const entry = modelIndex.get(modelKey);
  if (!entry) {
    throw new Error(`Unknown model key: ${modelKey}`);
  }

  const { provider, model } = entry;
  const noKeyMsg = "Please add your API key in Settings → LLM Keys to use this model.";

  switch (provider) {
    case "anthropic": {
      const apiKey = userApiKeys?.anthropic || (allowEnvFallback ? env.ANTHROPIC_API_KEY : "");
      if (!apiKey) throw new Error(`No Anthropic API key configured. ${noKeyMsg}`);
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model);
    }
    case "openai": {
      const apiKey = userApiKeys?.openai || (allowEnvFallback ? env.OPENAI_API_KEY : "");
      if (!apiKey) throw new Error(`No OpenAI API key configured. ${noKeyMsg}`);
      const openai = createOpenAI({ apiKey });
      return openai(model);
    }
    case "google": {
      const apiKey = userApiKeys?.google || (allowEnvFallback ? env.GOOGLE_AI_API_KEY : "");
      if (!apiKey) throw new Error(`No Google AI API key configured. ${noKeyMsg}`);
      const google = createGoogleGenerativeAI({ apiKey });
      return google(model);
    }
    case "kimi": {
      const apiKey = userApiKeys?.kimi;
      if (!apiKey) throw new Error(`No Kimi API key configured. ${noKeyMsg}`);
      const kimi = createOpenAI({
        apiKey,
        baseURL: "https://api.moonshot.ai/v1",
        fetch: kimiFetch,
      });
      return kimi.chat(model);
    }
    case "deepseek": {
      const apiKey = userApiKeys?.deepseek;
      if (!apiKey) throw new Error(`No DeepSeek API key configured. ${noKeyMsg}`);
      const deepseek = createOpenAI({
        apiKey,
        baseURL: "https://api.deepseek.com/v1",
      });
      return deepseek.chat(model);
    }
    case "glm": {
      const apiKey = userApiKeys?.glm;
      if (!apiKey) throw new Error(`No GLM (Z.ai) API key configured. ${noKeyMsg}`);
      const glm = createOpenAI({
        apiKey,
        baseURL: "https://api.z.ai/api/paas/v4",
      });
      return glm.chat(model);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/** Get the provider name for a given model key */
export function getProviderName(modelKey: string): ProviderName | null {
  return modelIndex.get(modelKey)?.provider ?? null;
}

/** Get the provider-native model id (e.g. "deepseek-v4-pro") for a model key. */
export function getProviderModel(modelKey: string): string | null {
  return modelIndex.get(modelKey)?.model ?? null;
}

/**
 * Get a model + provider-specific web search tools.
 * Returns the search tools as a Record that can be spread into the tools object.
 */
export function getModelWithSearch(
  modelKey: string,
  userApiKeys?: { anthropic?: string; openai?: string; google?: string; kimi?: string; deepseek?: string; glm?: string },
  { allowEnvFallback = false }: { allowEnvFallback?: boolean } = {}
): { model: LanguageModel; searchTools: Record<string, unknown> } {
  const entry = modelIndex.get(modelKey);
  if (!entry) throw new Error(`Unknown model key: ${modelKey}`);

  const { provider, model: modelId } = entry;
  const noKeyMsg = "Please add your API key in Settings → LLM Keys to use this model.";

  switch (provider) {
    case "openai": {
      const apiKey = userApiKeys?.openai || (allowEnvFallback ? env.OPENAI_API_KEY : "");
      if (!apiKey) throw new Error(`No OpenAI API key configured. ${noKeyMsg}`);
      const openai = createOpenAI({ apiKey });
      return {
        model: openai(modelId),
        searchTools: { web_search: openai.tools.webSearch({ searchContextSize: "medium" }) },
      };
    }
    case "anthropic": {
      const apiKey = userApiKeys?.anthropic || (allowEnvFallback ? env.ANTHROPIC_API_KEY : "");
      if (!apiKey) throw new Error(`No Anthropic API key configured. ${noKeyMsg}`);
      const anthropic = createAnthropic({ apiKey });
      return {
        model: anthropic(modelId),
        searchTools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }) },
      };
    }
    case "google": {
      const apiKey = userApiKeys?.google || (allowEnvFallback ? env.GOOGLE_AI_API_KEY : "");
      if (!apiKey) throw new Error(`No Google AI API key configured. ${noKeyMsg}`);
      const google = createGoogleGenerativeAI({ apiKey });
      return {
        model: google(modelId),
        searchTools: { google_search: google.tools.googleSearch({}) },
      };
    }
    case "kimi": {
      const apiKey = userApiKeys?.kimi;
      if (!apiKey) throw new Error(`No Kimi API key configured. ${noKeyMsg}`);
      const kimi = createOpenAI({
        apiKey,
        baseURL: "https://api.moonshot.ai/v1",
        fetch: kimiFetch,
      });
      return {
        model: kimi.chat(modelId),
        searchTools: {},
      };
    }
    case "deepseek": {
      const apiKey = userApiKeys?.deepseek;
      if (!apiKey) throw new Error(`No DeepSeek API key configured. ${noKeyMsg}`);
      const deepseek = createOpenAI({
        apiKey,
        baseURL: "https://api.deepseek.com/v1",
      });
      return {
        model: deepseek.chat(modelId),
        searchTools: {},
      };
    }
    case "glm": {
      const apiKey = userApiKeys?.glm;
      if (!apiKey) throw new Error(`No GLM (Z.ai) API key configured. ${noKeyMsg}`);
      const glm = createOpenAI({
        apiKey,
        baseURL: "https://api.z.ai/api/paas/v4",
      });
      return {
        model: glm.chat(modelId),
        searchTools: {},
      };
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/** List all available models with metadata */
export function listModels() {
  const result: Array<{
    key: string;
    label: string;
    provider: ProviderName;
    providerModel: string;
    requiresPro: boolean;
    providerLabel: string;
  }> = [];

  for (const [providerName, cfg] of Object.entries(
    modelsConfig.providers as Record<string, ProviderConfig>
  )) {
    for (const m of cfg.models) {
      result.push({
        key: m.key,
        label: m.label,
        provider: providerName as ProviderName,
        providerModel: m.provider_model,
        requiresPro: m.requires_pro,
        providerLabel: cfg.label,
      });
    }
  }
  return result;
}
