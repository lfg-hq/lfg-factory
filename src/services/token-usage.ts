import { createHash } from "node:crypto";
import { currentUsage, type UsageContext } from "../ai/usage-context.ts";

const count = (n: unknown): number => typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
/** Canonical input includes cache reads/writes. Cache and reasoning counts are subsets. */
export function normalizeUsage(u: any, format: "sdk" | "pi" | "claude" = "sdk") {
  if (!u || typeof u !== "object") return null;
  const fields = format === "pi" ? [u.input, u.output] : format === "claude" ? [u.input_tokens, u.output_tokens] : [u.inputTokens, u.outputTokens];
  if (fields.every(v => v == null)) return null; // Unknown is not a zero-token request.
  const cacheReadTokens = count(format === "pi" ? u.cacheRead : format === "claude" ? u.cache_read_input_tokens : u.inputTokens?.cacheRead ?? u.inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens = count(format === "pi" ? u.cacheWrite : format === "claude" ? u.cache_creation_input_tokens : u.inputTokens?.cacheWrite ?? u.inputTokenDetails?.cacheWriteTokens);
  const inputTokens = format === "sdk" ? count(typeof u.inputTokens === "object" ? u.inputTokens.total : u.inputTokens) : count(fields[0]) + cacheReadTokens + cacheWriteTokens;
  const outputTokens = count(format === "sdk" && typeof u.outputTokens === "object" ? u.outputTokens.total : fields[1]);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens, cacheWriteTokens,
    reasoningTokens: count(u.outputTokens?.reasoning ?? u.outputTokenDetails?.reasoningTokens),
  };
}

async function tables() {
  const [{ db }, schema] = await Promise.all([import("../config/db.ts"), import("../db/schema/tokens.ts")]);
  return { db, ...schema };
}
export async function recordUsage(context: UsageContext | undefined, data: {
  requestId: string; provider: string; model: string; modelTier?: string; billingMode?: string;
  usage: any; format?: "sdk" | "pi" | "claude"; cost?: number | null; toolCallIds?: string[];
}) {
  if (!context?.userId) return;
  const tokens = normalizeUsage(data.usage, data.format);
  if (!tokens) return;
  try {
    const { db, tokenUsage, tokenUsageDocuments, tokenUsageTickets } = await tables();
    const id = createHash("sha256").update(data.requestId).digest("hex");
    const billingMode = data.billingMode ?? context.billingMode ?? "api";
    await db.insert(tokenUsage).values({ id, requestId: data.requestId,
      userId: context.userId, projectId: context.projectId, conversationId: context.conversationId,
      ticketId: context.ticketId, runId: context.runId, operation: context.operation ?? "chat",
      provider: data.provider, model: data.model, modelTier: data.modelTier, billingMode,
      ...tokens,
      // Provider-reported cost only; subscription usage is not a per-token API bill.
      cost: billingMode === "api" && typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0 ? data.cost : null,
    }).onConflictDoNothing();
    for (const ticketId of new Set([...(context.ticketIds ?? []), ...(context.ticketId ? [context.ticketId] : [])])) {
      await db.insert(tokenUsageTickets).values({ usageId: id, ticketId }).onConflictDoNothing();
    }
    for (const documentId of context.documentIds ?? []) {
      await db.insert(tokenUsageDocuments).values({ usageId: id, documentId }).onConflictDoNothing();
    }
    for (const toolId of data.toolCallIds ?? []) context.toolUsage?.set(toolId, id);
    const { broadcastToUser } = await import("../ws/connection-manager.ts");
    broadcastToUser(context.userId, { type: "token_usage_updated" });
    return id;
  } catch (error) {
    console.error("[token-usage] Recording failed:", error instanceof Error ? error.message : String(error));
  }
}

/** Associate the generating call and subsequent context reads with a saved document. */
export async function associateUsageDocument(documentId: string, toolCallId?: string) {
  const context = currentUsage();
  if (!context) return;
  context.documentIds?.add(documentId);
  const usageId = toolCallId && context.toolUsage?.get(toolCallId);
  if (!usageId) return;
  try {
    const { db, tokenUsageDocuments } = await tables();
    await db.insert(tokenUsageDocuments).values({ usageId, documentId }).onConflictDoNothing();
  } catch (error) { console.error("[token-usage] Document association failed:", error); }
}

export async function associateUsageTicket(ticketId: string, toolCallId?: string) {
  const context = currentUsage();
  if (!context) return;
  context.ticketIds?.add(ticketId);
  const usageId = toolCallId && context.toolUsage?.get(toolCallId);
  if (!usageId) return;
  try {
    const { db, tokenUsageTickets } = await tables();
    await db.insert(tokenUsageTickets).values({ usageId, ticketId }).onConflictDoNothing();
  } catch (error) { console.error("[token-usage] Ticket association failed:", error); }
}

export async function recordCliUsage(context: UsageContext, events: any[]) {
  for (const event of events) {
    if (event.type === "claude_usage" && event.message?.id) {
      const m = event.message;
      await recordUsage(context, { requestId: `${context.runId}:claude-partial:${m.id}`, provider: "anthropic",
        model: m.model ?? "unknown", usage: m.usage, format: "claude" });
    }
    // Pi message_end is final; message_update repeatedly includes partial/cumulative usage.
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const m = event.message;
      const identity = m.id ?? m.timestamp;
      if (identity == null) continue;
      await recordUsage(context, { requestId: `${context.runId}:pi:${identity}:${m.model}`,
        provider: m.provider ?? "unknown", model: m.model ?? "unknown", usage: m.usage, format: "pi",
        cost: m.usage?.cost?.total });
    }
    // Claude's result provides final per-model totals for this invocation. Avoid counting
    // assistant snapshots as well (one message can be repeated for multiple content blocks).
    if (event.type === "result" && event.modelUsage && event.uuid) {
      for (const [model, usage] of Object.entries(event.modelUsage) as [string, any][]) {
        await recordUsage(context, { requestId: `${context.runId}:claude:${event.uuid}:${model}`,
          provider: "anthropic", model, format: "pi", usage: {
            input: usage.inputTokens, output: usage.outputTokens,
            cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheCreationInputTokens,
          }, cost: usage.costUSD });
      }
    }
  }
}
