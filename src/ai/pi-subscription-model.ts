import { trackModel } from "./usage-model.ts";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { AssistantMessage, Context, TextContent, ImageContent, Usage, TSchema } from "@earendil-works/pi-ai";

// This provider object contains a static catalog, never a user's credentials.
const catalog = openaiCodexProvider().getModels();
export const SUBSCRIPTION_PREFIX = "chatgpt/";
export const isSubscriptionModel = (key: string) => key.startsWith(SUBSCRIPTION_PREFIX);
export const subscriptionCatalog = () => catalog;
const emptyUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function usage(u: Usage): LanguageModelV3Usage {
  return {
    inputTokens: { total: u.input + u.cacheRead + u.cacheWrite, noCache: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
    outputTokens: { total: u.output, text: u.reasoning === undefined ? undefined : u.output - u.reasoning, reasoning: u.reasoning },
  };
}

/** Reject unsupported inputs rather than silently removing evidence from a turn. */
export function toPiContext(options: LanguageModelV3CallOptions, modelId: string): Context {
  const context: Context = { messages: [], tools: [] };
  const systems: string[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") { systems.push(message.content); continue; }
    if (message.role === "user") {
      const content: (TextContent | ImageContent)[] = message.content.map(part => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (!part.mediaType.startsWith("image/") || part.data instanceof URL) {
          throw new Error("ChatGPT subscription supports text and inline images here. Convert this attachment to text first.");
        }
        return { type: "image", mimeType: part.mediaType, data: typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64") };
      });
      context.messages.push({ role: "user", content, timestamp: 0 });
    } else if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          const signature = part.providerOptions?.["lfgCodex"]?.textSignature;
          content.push({ type: "text", text: part.text, ...(typeof signature === "string" ? { textSignature: signature } : {}) });
        }
        else if (part.type === "reasoning") {
          // Only replay encrypted reasoning from this adapter, not another provider.
          const signature = part.providerOptions?.["lfgCodex"]?.signature;
          if (typeof signature === "string") content.push({ type: "thinking", thinking: part.text, thinkingSignature: signature });
        } else if (part.type === "tool-call") {
          if (part.providerExecuted) throw new Error("Start a new conversation when switching from provider-hosted tools to ChatGPT subscription.");
          content.push({ type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: part.input as Record<string, unknown> });
        } else throw new Error(`Unsupported subscription assistant content: ${part.type}`);
      }
      context.messages.push({ role: "assistant", content, api: "openai-codex-responses", provider: "openai-codex", model: modelId, usage: emptyUsage, stopReason: content.some(p => p.type === "toolCall") ? "toolUse" : "stop", timestamp: 0 });
    } else {
      for (const part of message.content) {
        if (part.type !== "tool-result") throw new Error("Provider-hosted approval history is not supported by the subscription adapter.");
        const output = part.output;
        let content: (TextContent | ImageContent)[];
        if (output.type === "content") {
          content = output.value.map(p => {
            if (p.type === "text") return { type: "text", text: p.text };
            if (p.type === "file-data" && p.mediaType.startsWith("image/")) return { type: "image", data: p.data, mimeType: p.mediaType };
            throw new Error(`Unsupported subscription tool result: ${p.type}`);
          });
        } else {
          content = [{ type: "text", text: output.type === "execution-denied" ? output.reason ?? "Execution denied" : typeof output.value === "string" ? output.value : JSON.stringify(output.value) }];
        }
        context.messages.push({ role: "toolResult", toolCallId: part.toolCallId, toolName: part.toolName, content, isError: output.type.startsWith("error") || output.type === "execution-denied", timestamp: 0 });
      }
    }
  }
  if (options.responseFormat?.type === "json") {
    if (options.tools?.length) throw new Error("Subscription structured output cannot be combined with other tools in the same generation.");
    context.tools = [{ name: "__lfg_structured_output", description: "Return the requested structured result.", parameters: (options.responseFormat.schema ?? { type: "object", additionalProperties: true }) as TSchema }];
  }
  for (const tool of options.tools ?? []) {
    if (tool.type !== "function") throw new Error("Provider-hosted tools are unavailable with ChatGPT subscription. Use LFG tools instead.");
    context.tools!.push({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema as TSchema });
  }
  context.systemPrompt = systems.join("\n\n");
  return context;
}

export function createPiSubscriptionModel(
  modelId: string,
  getAccessToken: () => Promise<string>,
  transport: typeof codexStream = codexStream,
): LanguageModelV3 {
  const piModel = catalog.find(m => m.id === modelId);
  if (!piModel) throw new Error(`Unsupported ChatGPT subscription model: ${modelId}`);
  const model: LanguageModelV3 = {
    specificationVersion: "v3", provider: "lfg-chatgpt-subscription", modelId,
    supportedUrls: {},
    async doStream(options) {
      const context = toPiContext(options, modelId);
      if (!piModel.input.includes("image") && context.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image"))) {
        throw new Error("This subscription model cannot read images. Select an image-capable model.");
      }
      const structured = options.responseFormat?.type === "json";
      if (options.toolChoice?.type === "tool") {
        context.tools = context.tools!.filter(t => t.name === (options.toolChoice as { toolName: string }).toolName);
        if (!context.tools.length) throw new Error("Requested subscription tool was not provided.");
      }
      options.abortSignal?.throwIfAborted();
      // Resolve per generation: no refresh token in this adapter, no global auth state.
      const token = await getAccessToken();
      if (!token) throw new Error("Connect ChatGPT in Settings before selecting subscription models.");
      options.abortSignal?.throwIfAborted();
      const abort = new AbortController();
      const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, abort.signal]) : abort.signal;
      const events = transport(piModel, context, {
        apiKey: token, signal, transport: "sse", maxRetries: 0,
        fetch: ((url, init) => globalThis.fetch(url, { ...init, timeout: false } as unknown as RequestInit)) as typeof fetch,
        toolChoice: structured || options.toolChoice?.type === "tool" ? "required" : options.toolChoice?.type,
        // The Codex backend does not accept max_output_tokens. Report this below.
        temperature: options.temperature,
        reasoningEffort: options.providerOptions?.openai?.reasoningEffort as NonNullable<Parameters<typeof codexStream>[2]>['reasoningEffort'],
      });
      const warnings = ["maxOutputTokens", "topP", "topK", "presencePenalty", "frequencyPenalty", "seed", "stopSequences"].filter(k => options[k as keyof typeof options] !== undefined).map(feature => ({ type: "unsupported" as const, feature }));
      const ids = new Map<number, string>();
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          try {
            let finished = false;
            for await (const event of events) {
              signal.throwIfAborted();
              if (event.type === "error") {
                // Upstream error payloads can echo request data. Do not forward them.
                throw new Error(event.reason === "aborted" ? "ChatGPT subscription request cancelled." : "ChatGPT subscription request failed. Check account connection, model access, and usage limits. No API fallback was used.");
              }
              if (event.type === "done") {
                if (structured && ids.size !== 1) throw new Error("ChatGPT did not return the requested structured result.");
                controller.enqueue({ type: "finish", usage: usage(event.message.usage), finishReason: { unified: event.reason === "toolUse" && !structured ? "tool-calls" : event.reason === "length" ? "length" : "stop", raw: event.reason } });
                finished = true;
                break;
              }
              if (!structured && event.type === "text_start") controller.enqueue({ type: "text-start", id: `text-${event.contentIndex}` });
              if (!structured && event.type === "text_delta") controller.enqueue({ type: "text-delta", id: `text-${event.contentIndex}`, delta: event.delta });
              if (!structured && event.type === "text_end") {
                const part = event.partial.content[event.contentIndex];
                controller.enqueue({ type: "text-end", id: `text-${event.contentIndex}`, ...(part?.type === "text" && part.textSignature ? { providerMetadata: { lfgCodex: { textSignature: part.textSignature } } } : {}) });
              }
              if (event.type === "thinking_start") controller.enqueue({ type: "reasoning-start", id: `thinking-${event.contentIndex}` });
              if (event.type === "thinking_delta") controller.enqueue({ type: "reasoning-delta", id: `thinking-${event.contentIndex}`, delta: event.delta });
              if (event.type === "thinking_end") {
                const part = event.partial.content[event.contentIndex];
                controller.enqueue({ type: "reasoning-end", id: `thinking-${event.contentIndex}`, ...(part?.type === "thinking" && part.thinkingSignature ? { providerMetadata: { lfgCodex: { signature: part.thinkingSignature } } } : {}) });
              }
              if (event.type === "toolcall_start") {
                const part = event.partial.content[event.contentIndex];
                if (part?.type !== "toolCall") throw new Error("Invalid subscription tool stream.");
                if (structured && (part.name !== "__lfg_structured_output" || ids.size)) throw new Error("Unexpected structured output tool.");
                ids.set(event.contentIndex, part.id);
                controller.enqueue(structured ? { type: "text-start", id: part.id } : { type: "tool-input-start", id: part.id, toolName: part.name });
              }
              if (event.type === "toolcall_delta") {
                const id = ids.get(event.contentIndex);
                if (!id) throw new Error("Subscription tool delta arrived without a start.");
                controller.enqueue({ type: structured ? "text-delta" : "tool-input-delta", id, delta: event.delta });
              }
              if (event.type === "toolcall_end") {
                const id = ids.get(event.contentIndex);
                if (!id || id !== event.toolCall.id) throw new Error("Subscription tool ID changed during streaming.");
                controller.enqueue({ type: structured ? "text-end" : "tool-input-end", id });
                if (!structured) controller.enqueue({ type: "tool-call", toolCallId: id, toolName: event.toolCall.name, input: JSON.stringify(event.toolCall.arguments) });
              }
            }
            if (!finished) throw new Error("ChatGPT subscription stream ended before completion.");
            controller.close();
          } catch (error) {
            abort.abort();
            try { controller.error(error); } catch { /* Consumer already cancelled. */ }
          }
        },
        cancel() { abort.abort(); },
      });
      return { stream };
    },
    async doGenerate(options) {
      const { stream } = await model.doStream(options);
      const reader = stream.getReader();
      const content: LanguageModelV3Content[] = [];
      const blocks = new Map<string, { type: "text" | "reasoning"; text: string; providerMetadata?: any }>();
      let finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined;
      let warnings: Awaited<ReturnType<LanguageModelV3["doGenerate"]>>["warnings"] = [];
      try {
        for (;;) {
          const { value: part, done } = await reader.read();
          if (done) break;
          if (part.type === "stream-start") warnings = part.warnings;
          if (part.type === "text-start" || part.type === "reasoning-start") {
            const block = { type: part.type === "text-start" ? "text" as const : "reasoning" as const, text: "" };
            blocks.set(part.id, block); content.push(block);
          }
          if (part.type === "text-delta" || part.type === "reasoning-delta") { const block = blocks.get(part.id); if (block) block.text += part.delta; }
          if (part.type === "reasoning-end" || part.type === "text-end") { const block = blocks.get(part.id); if (block) block.providerMetadata = part.providerMetadata; }
          if (part.type === "tool-call") content.push(part);
          if (part.type === "finish") finish = part;
          if (part.type === "error") throw part.error;
        }
      } finally { reader.releaseLock(); }
      if (!finish) throw new Error("ChatGPT subscription response was incomplete.");
      return { content, finishReason: finish.finishReason, usage: finish.usage, warnings };
    },
  };
  return trackModel(model, { provider: "openai", billingMode: "subscription", modelTier: /luna|haiku|mini|flash/i.test(modelId) ? "lite" : "pro" });
}
