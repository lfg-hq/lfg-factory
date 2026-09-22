import type { LanguageModelV3 } from "@ai-sdk/provider";
import { currentUsage } from "./usage-context.ts";
import { recordUsage } from "../services/token-usage.ts";

/** Wrap each provider request, not SDK totals, so multi-step loops/retries count once. */
export function trackModel(model: LanguageModelV3, metadata: { modelTier?: string; billingMode?: string; provider?: string } = {}): LanguageModelV3 {
  return new Proxy(model, {
    get(target, key, receiver) {
      if (key !== "doGenerate" && key !== "doStream") return Reflect.get(target, key, receiver);
      return async (options: any) => {
        const context = currentUsage();
        const requestId = crypto.randomUUID();
        const toolCallIds: string[] = [];
        const save = (usage: any) => recordUsage(context, {
          requestId, provider: metadata.provider ?? target.provider, model: target.modelId, billingMode: "api", ...metadata, usage, toolCallIds,
        });
        if (key === "doGenerate") {
          const result = await target.doGenerate(options);
          for (const part of result.content) if (part.type === "tool-call") toolCallIds.push(part.toolCallId);
          await save(result.usage);
          return result;
        }
        const result = await target.doStream(options);
        const reader = result.stream.getReader();
        return { ...result, stream: new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { controller.close(); reader.releaseLock(); return; }
              const part = next.value;
              if (part.type === "tool-call") toolCallIds.push(part.toolCallId);
              if (part.type === "finish") await save(part.usage);
              controller.enqueue(part);
            } catch (error) { controller.error(error); }
          },
          // Await cancellation of the actual provider stream. pipeThrough's cancel
          // can resolve before the subscription transport has received its abort.
          async cancel(reason) { await reader.cancel(reason); },
        }, { highWaterMark: 0 }) };
      };
    },
  });
}
