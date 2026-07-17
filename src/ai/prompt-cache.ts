/**
 * Cross-provider prompt caching.
 *
 * The universal trick is prefix stability: every provider caches a common
 * PREFIX of the request, so we always assemble requests as
 *   [system] [tools] [conversation history] [new turn]
 * keeping everything before the volatile turn byte-for-byte identical.
 *
 * The only per-provider difference is who marks the cache:
 *  - "auto"  (OpenAI, DeepSeek, Kimi, GLM, Gemini 2.5): the provider detects a
 *            stable prefix automatically — we do nothing.
 *  - "explicit" (Anthropic): we must attach `cache_control: ephemeral`
 *            breakpoints ourselves.
 *  - "none": no caching.
 *
 * `withCaching()` returns `{ system, messages }` ready to spread into
 * streamText / generateText. For explicit providers it moves the system
 * prompt into a cached system message (caching system + tools) and marks the
 * last message (caching the growing history prefix across turns). For everyone
 * else it returns the inputs untouched — the ordering is already cache-friendly.
 */

import { getModelCaching } from "./provider.ts";

type AnyMessage = {
  role: string;
  content: unknown;
  providerOptions?: Record<string, unknown>;
  [k: string]: unknown;
};

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

function markCached(msg: AnyMessage): AnyMessage {
  return {
    ...msg,
    providerOptions: { ...(msg.providerOptions ?? {}), ...EPHEMERAL },
  };
}

export interface CacheableRequest {
  system?: string;
  messages: AnyMessage[];
}

/**
 * Apply provider-appropriate caching to a request.
 * `modelKey` is the LFG model key (e.g. "claude_4.6_sonnet") — NOT the
 * provider-native id — so caching mode resolves from llm-models.json.
 */
export function withCaching(
  modelKey: string,
  { system, messages }: CacheableRequest
): CacheableRequest {
  if (getModelCaching(modelKey) !== "explicit") {
    // auto / none — provider handles (or doesn't) the stable prefix itself.
    return { system, messages };
  }

  // Anthropic: set explicit breakpoints.
  const out = [...messages];

  // Breakpoint #1: last message → caches the whole prefix incl. history.
  // Anthropic reads the LONGEST matching cached prefix, so moving this marker
  // forward every turn is exactly the intended multi-turn pattern.
  if (out.length > 0) {
    out[out.length - 1] = markCached(out[out.length - 1] as AnyMessage);
  }

  if (!system) {
    return { messages: out };
  }

  // Breakpoint #2: system prompt (caches tools + system, the largest block
  // that's identical across every turn). Move it into `messages` so we can
  // attach providerOptions, and drop the top-level `system`.
  const systemMsg = markCached({ role: "system", content: system });
  return { messages: [systemMsg, ...out] };
}
