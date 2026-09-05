import { describe, test, expect } from "bun:test";
import { generateText, streamText, generateObject, stepCountIs, tool } from "ai";
import { z } from "zod";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createPiSubscriptionModel, toPiContext } from "../src/ai/pi-subscription-model.ts";
import { currentSubscription, withSubscription } from "../src/ai/subscription-context.ts";
import { withoutSubscription } from "../src/ai/subscription-context.ts";
import { stream as realCodexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel, getModelWithSearch, getLiteModel, listModels, listChatModels } from "../src/ai/provider.ts";
import { ChatInput } from "../src/templates/components/chat-input.tsx";

const modelId = "gpt-5.6-luna";
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: "openai-codex-responses", provider: "openai-codex", model: modelId, stopReason, timestamp: 0,
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function textEvents(text: string): AssistantMessageEventStream {
  const s = new AssistantMessageEventStream();
  const partial = message([{ type: "text", text }]);
  s.push({ type: "start", partial });
  s.push({ type: "text_start", contentIndex: 0, partial });
  s.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
  s.push({ type: "text_end", contentIndex: 0, content: text, partial });
  s.push({ type: "done", reason: "stop", message: partial });
  return s;
}
function toolEvents(name: string, args: Record<string, unknown>): AssistantMessageEventStream {
  const s = new AssistantMessageEventStream();
  const call = { type: "toolCall" as const, id: "call-1", name, arguments: args };
  const partial = message([call], "toolUse");
  const json = JSON.stringify(args);
  s.push({ type: "start", partial });
  s.push({ type: "toolcall_start", contentIndex: 0, partial });
  s.push({ type: "toolcall_delta", contentIndex: 0, delta: json.slice(0, 12), partial });
  s.push({ type: "toolcall_delta", contentIndex: 0, delta: json.slice(12), partial });
  s.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
  s.push({ type: "done", reason: "toolUse", message: partial });
  return s;
}

describe("ChatGPT subscription model adapter (no network)", () => {
  test("API factory stays API and subscription choices stay out of builder catalog", () => {
    expect(getModel(modelId, { openai: "not-a-real-key" }).provider).toContain("openai");
    expect(listModels().some(m => m.key.startsWith("chatgpt/"))).toBe(false);
    expect(listChatModels().some(m => m.key === `chatgpt/${modelId}`)).toBe(true);
    expect(() => getModel(`chatgpt/${modelId}`, { openai: "not-a-real-key" }, { allowEnvFallback: true })).toThrow("authorized");
  });

  test("helper models stay on subscription even when API fallback is allowed", () => {
    withSubscription({ modelId, getAccessToken: async () => "token" }, () => {
      const result = getModelWithSearch("claude_4.6_sonnet", { anthropic: "not-a-real-key" }, { allowEnvFallback: true });
      expect(result.model.provider).toBe("lfg-chatgpt-subscription");
      expect(result.searchTools).toEqual({});
      expect(getLiteModel("claude_4.6_sonnet").modelKey).toBe(`chatgpt/${modelId}`);
    });
  });

  test("disconnected subscription choices are disabled with accurate guidance", async () => {
    const rendered = String(await ChatInput({ placeholder: "Hi", selectedModelKey: modelId, models: [
      { key: modelId, label: "API model", providerLabel: "OpenAI", available: true },
      { key: `chatgpt/${modelId}`, label: "Subscription model", providerLabel: "ChatGPT subscription", available: false },
    ] }));
    expect(rendered).toContain('data-value="chatgpt/gpt-5.6-luna"');
    expect(rendered).toContain("Connect ChatGPT in Settings");
    expect(rendered).toContain("disabled");
    expect(rendered).toContain("Uses provider API tokens");
  });
  test("generateText translates text and cached usage", async () => {
    const model = createPiSubscriptionModel(modelId, async () => "user-token", (_m, _c, opts) => {
      expect(opts?.apiKey).toBe("user-token"); expect(opts?.transport).toBe("sse");
      return textEvents("Hello");
    });
    const result = await generateText({ model, prompt: "Hi" });
    expect(result.text).toBe("Hello"); expect(result.usage.inputTokens).toBe(13);
  });

  test("live document arguments survive and the tool runs once before the next step", async () => {
    let requests = 0, executed = 0, tokens = 0;
    const model = createPiSubscriptionModel(modelId, async () => `token-${++tokens}`, (_m, context, opts) => {
      requests++;
      expect(opts?.apiKey).toBe(`token-${requests}`);
      if (requests === 1) return toolEvents("streamDocumentContent", { content: "A live document" });
      expect(context.messages.some(m => m.role === "toolResult" && m.toolCallId === "call-1")).toBe(true);
      return textEvents("Saved");
    });
    const result = streamText({ model, prompt: "Write a document", stopWhen: stepCountIs(3), tools: {
      streamDocumentContent: tool({ inputSchema: z.object({ content: z.string() }), execute: async ({ content }) => { executed++; expect(content).toBe("A live document"); return { saved: true }; } }),
    } });
    let partialJson = "";
    for await (const part of result.fullStream) if (part.type === "tool-input-delta") partialJson += part.delta;
    expect(JSON.parse(partialJson)).toEqual({ content: "A live document" });
    expect(await result.text).toBe("Saved"); expect(executed).toBe(1); expect(requests).toBe(2);
  });

  test("generateObject uses a schema tool and SDK validation", async () => {
    const model = createPiSubscriptionModel(modelId, async () => "token", (_m, ctx, opts) => {
      expect(ctx.tools?.[0]?.name).toBe("__lfg_structured_output"); expect(opts?.toolChoice).toBe("required");
      return toolEvents("__lfg_structured_output", { healthy: true });
    });
    const result = await generateObject({ model, schema: z.object({ healthy: z.boolean() }), prompt: "Evaluate" });
    expect(result.object).toEqual({ healthy: true });
    const invalid = createPiSubscriptionModel(modelId, async () => "token", () => toolEvents("__lfg_structured_output", { healthy: "not a boolean" }));
    await expect(generateObject({ model: invalid, schema: z.object({ healthy: z.boolean() }), prompt: "Evaluate", maxRetries: 0 })).rejects.toThrow();
  });

  test("missing credentials never dispatch a request", async () => {
    let called = false;
    const model = createPiSubscriptionModel(modelId, async () => "", () => { called = true; return textEvents("bad"); });
    await expect(generateText({ model, prompt: "Hi", maxRetries: 0 })).rejects.toThrow("Connect ChatGPT");
    expect(called).toBe(false);
  });

  test("provider failures are sanitized and never become a success", async () => {
    const model = createPiSubscriptionModel(modelId, async () => "secret-token", () => {
      const s = new AssistantMessageEventStream();
      s.push({ type: "error", reason: "error", error: { ...message([]), errorMessage: "Authorization: secret-token" } });
      return s;
    });
    await expect(generateText({ model, prompt: "Hi", maxRetries: 0 })).rejects.toThrow("No API fallback");
  });

  test("pre-aborted requests do not fetch credentials", async () => {
    let tokenCalls = 0;
    const model = createPiSubscriptionModel(modelId, async () => { tokenCalls++; return "token"; }, () => textEvents("bad"));
    await expect(model.doStream({ prompt: [], abortSignal: AbortSignal.abort() })).rejects.toThrow();
    expect(tokenCalls).toBe(0);
  });

  test("unsupported files and hosted tools are rejected before inference", () => {
    expect(() => toPiContext({ prompt: [{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data: new Uint8Array() }] }] }, modelId)).toThrow("attachment");
    expect(() => toPiContext({ prompt: [], tools: [{ type: "provider", id: "openai.web_search", name: "web_search", args: {} }] }, modelId)).toThrow("Provider-hosted");
  });

  test("inline images and error tool results retain their meaning", () => {
    const ctx = toPiContext({ prompt: [
      { role: "user", content: [{ type: "file", mediaType: "image/png", data: new Uint8Array([1, 2]) }] },
      { role: "tool", content: [{ type: "tool-result", toolName: "test", toolCallId: "test-1", output: { type: "error-text", value: "Tests failed" } }] },
    ] }, modelId);
    expect(ctx.messages[0]?.content).toEqual([{ type: "image", mimeType: "image/png", data: "AQI=" }]);
    expect(ctx.messages[1]).toMatchObject({ role: "toolResult", isError: true, toolCallId: "test-1" });
  });

  test("concurrent execution contexts do not leak accounts", async () => {
    await Promise.all(["alice", "bob"].map(id => withSubscription({ modelId, getAccessToken: async () => id }, async () => {
      await Promise.resolve();
      expect(await currentSubscription()!.getAccessToken()).toBe(id);
    })));
    expect(currentSubscription()).toBeUndefined();
  });

  test("API work explicitly clears inherited subscription context", async () => {
    await withSubscription({ modelId, getAccessToken: async () => "owner" }, async () => {
      await withoutSubscription(async () => { await Promise.resolve(); expect(currentSubscription()).toBeUndefined(); });
      expect(currentSubscription()?.modelId).toBe(modelId);
    });
  });

  test("real Pi transport consumes Codex SSE without a network call", async () => {
    const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
    const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "Transport works", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "resp_test", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: "Transport works" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ];
    let requests = 0;
    const model = createPiSubscriptionModel(modelId, async () => jwt, (m, c, o) => realCodexStream(m, c, {
      ...o, fetch: (async (url, init) => {
        requests++;
        expect(String(url)).toStartWith("https://chatgpt.com/backend-api/");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${jwt}`);
        return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    }));
    const result = await generateText({ model, prompt: "Hi", maxRetries: 0 });
    expect(result.text).toBe("Transport works"); expect(requests).toBe(1);
  });

  test("interleaved tool arguments stay associated with the correct IDs", async () => {
    const model = createPiSubscriptionModel(modelId, async () => "token", () => {
      const s = new AssistantMessageEventStream();
      const a = { type: "toolCall" as const, id: "a", name: "doc", arguments: { content: "A" } };
      const b = { type: "toolCall" as const, id: "b", name: "ticket", arguments: { content: "B" } };
      const partial = message([a, b], "toolUse");
      s.push({ type: "start", partial });
      for (const i of [0, 1]) s.push({ type: "toolcall_start", contentIndex: i, partial });
      for (const i of [1, 0]) s.push({ type: "toolcall_delta", contentIndex: i, delta: JSON.stringify(i === 0 ? a.arguments : b.arguments), partial });
      for (const i of [0, 1]) s.push({ type: "toolcall_end", contentIndex: i, toolCall: i === 0 ? a : b, partial });
      s.push({ type: "done", reason: "toolUse", message: partial });
      return s;
    });
    const { stream } = await model.doStream({ prompt: [] });
    const deltas: Record<string, string> = {};
    for await (const p of stream) if (p.type === "tool-input-delta") deltas[p.id] = (deltas[p.id] ?? "") + p.delta;
    expect(deltas).toEqual({ a: '{"content":"A"}', b: '{"content":"B"}' });
  });

  test("cancelling the consumer aborts the upstream transport", async () => {
    let signal: AbortSignal | undefined;
    const model = createPiSubscriptionModel(modelId, async () => "token", (_m, _c, opts) => {
      signal = opts?.signal;
      const s = new AssistantMessageEventStream();
      signal?.addEventListener("abort", () => s.push({ type: "error", reason: "aborted", error: message([]) }), { once: true });
      return s;
    });
    const { stream } = await model.doStream({ prompt: [] });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(signal?.aborted).toBe(true);
  });
});
