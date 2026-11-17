/**
 * A chat turn answered by the agent on the person's own computer ("Use my computer for AI").
 *
 * The server keeps doing everything it does for a chat turn (history, instructions,
 * saving, the browser stream); only the model step moves. This sends the turn to the
 * person's LFG Desktop as a `chat_turn` job, gives their agent a one-turn MCP token so it
 * can use LFG's tools (src/routes/mcp-server.ts), and turns the agent's events back into
 * the same stream events the AI SDK produces. stream-handler.ts consumes it in place of
 * streamText(), so cards, document panels, the activity trail and saving all work as usual.
 */

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { env } from "../../config/env.ts";
import { runnerJobs } from "../../db/schema/runners.ts";
import { cancelJob, enqueueJob, userHasConnectedRunner, watchJob, type JobUpdate } from "./hub.ts";
import { mintTurnToken, revokeTurnToken } from "./turn-tokens.ts";
import { AGENT_LABELS, RUNNER_PROTOCOL_VERSION, type AgentEffort, type AgentEvent, type AgentKind } from "./protocol.ts";

export interface LocalChatTurnInput {
  userId: string;
  conversationId: string;
  /** Internal project id (projects.id), or null. */
  projectId: string | null;
  /** The user message being answered. */
  messageId?: string;
  agent: AgentKind;
  /** Model alias and effort for the agent; null/absent: its own default. */
  model?: string | null;
  effort?: AgentEffort | null;
  /** The chat's system prompt and context, for the agent's instructions. */
  instructions: string;
  userMessage: string;
  /** What the server adds for this turn (@ticket context, branch, notes, plan): rides on the message, as for the web chat. */
  turnContext?: string;
  /** Earlier messages, used when there's no agent session to continue. */
  history: Array<{ role: string; content: unknown }>;
  signal: AbortSignal;
  /** Plain-language progress for the person ("Waiting for your computer…"). */
  onStatus(text: string): void;
  onActivity?(): void;
  /** The agent condensed its own conversation (Claude Code's auto-compact). */
  onCompacted?(info: { trigger?: string; preTokens?: number }): void;
  /** Tests: the server origin the agent should call. */
  serverUrl?: string;
}

/** The subset of streamText()'s result that stream-handler.ts uses. */
export interface LocalChatStream {
  fullStream: AsyncIterable<any>;
  response: Promise<{ messages: any[] }>;
}

const START_TIMEOUT_MS = 10 * 60_000;

/** LFG's tools reach the agent as MCP tools; give them back their LFG names. */
export const lfgToolName = (name: string) => name.replace(/^mcp__lfg__/, "").replace(/^lfg[-_.:/]+/, "");

const textOf = (content: unknown): string =>
  typeof content === "string" ? content
  : Array.isArray(content) ? content.map(p => (p && typeof p === "object" && (p as any).type === "text" ? (p as any).text : "")).filter(Boolean).join("\n")
  : "";

/**
 * The conversation so far, as text, for an agent that has no session to continue. It
 * starts from LFG's saved summary of older turns when there is one (the same checkpoint
 * the web chat starts from), then the newest messages that fit.
 */
export function transcript(history: LocalChatTurnInput["history"], limit = 24_000): string {
  const summaryAt = history.findIndex(m => m.role === "assistant" && textOf(m.content).startsWith("Conversation handoff"));
  const summary = summaryAt >= 0 ? textOf(history[summaryAt]!.content).trim().slice(0, Math.floor(limit / 2)) : "";
  const lines: string[] = [];
  for (const m of history.slice(summaryAt + 1)) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = textOf(m.content).trim();
    if (text) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  const room = limit - summary.length;
  let recent = lines.join("\n\n");
  if (recent.length > room) recent = "…" + recent.slice(recent.length - room);
  return [summary && `### Summary of earlier turns\n\n${summary}`, recent && `### Latest messages\n\n${recent}`].filter(Boolean).join("\n\n");
}

/** A tiny async queue: the job's watcher pushes, the chat handler's for-await pulls. */
function eventQueue() {
  const items: any[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(item: any) { if (!closed) { items.push(item); wake?.(); } },
    close() { closed = true; wake?.(); },
    async *iterate() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise<void>(r => { wake = r; });
        wake = null;
      }
    },
  };
}

export async function startLocalChatTurn(input: LocalChatTurnInput): Promise<LocalChatStream> {
  const label = AGENT_LABELS[input.agent];
  const [previous] = await db.select({ session: runnerJobs.agentSession }).from(runnerJobs)
    .where(and(eq(runnerJobs.conversationId, input.conversationId), eq(runnerJobs.userId, input.userId),
      eq(runnerJobs.agent, input.agent), isNotNull(runnerJobs.agentSession)))
    .orderBy(desc(runnerJobs.createdAt)).limit(1);
  const sessionId = previous?.session ?? undefined;
  const message = input.turnContext?.trim() ? `${input.userMessage}\n\n${input.turnContext.trim()}` : input.userMessage;
  // Without a session on that computer (first turn there, another computer, an expired
  // session) the agent starts from LFG's summary plus the latest messages.
  const earlier = transcript(input.history.slice(0, -1));
  const freshPrompt = earlier ? `## The conversation so far\n\n${earlier}\n\n## The user's new message\n\n${message}` : message;
  const prompt = sessionId ? message : freshPrompt;

  const { turnId, token } = await mintTurnToken({ userId: input.userId, conversationId: input.conversationId, projectId: input.projectId, messageId: input.messageId });
  const origin = (input.serverUrl ?? (env.APP_URL || env.BETTER_AUTH_URL)).replace(/\/+$/, "");
  const job = await enqueueJob({
    userId: input.userId, projectId: input.projectId ?? "", conversationId: input.conversationId, type: "chat_turn",
    payload: {
      protocol: RUNNER_PROTOCOL_VERSION, agent: input.agent, conversationId: input.conversationId,
      prompt, sessionId, ...(sessionId ? { freshPrompt } : {}),
      // LFG's prompt is the whole system prompt where the CLI allows it (Claude Code), so a
      // chat answers as it does on the web rather than as a coding assistant.
      instructionsMode: "replace",
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      instructions: `${input.instructions}\n\nLFG's tools are available through the MCP server named "lfg"; the tool names in these instructions refer to them. Use them for anything that should be saved or shared (documents, tickets, epics, notes): that is how your work reaches the user's team. When your working folder is a checkout of the project's repository, read its files directly for questions about the code or what the app does.`,
      mcp: { url: `${origin}/mcp/turn/${turnId}`, token },
    },
  });

  const queue = eventQueue();
  const toolNames = new Map<string, { name: string; input: unknown }>();
  let textBlock = 0;
  let started = false;
  let settle!: () => void;
  const response = new Promise<{ messages: any[] }>((resolve) => { settle = () => resolve({ messages: [] }); });

  const finish = (error?: Error) => {
    if (error) { console.warn(`[local-chat] turn ${job.id} failed: ${error.message.slice(0, 300)}`); queue.push({ type: "error", error }); }
    queue.close();
    clearTimeout(startTimer);
    stopWatching();
    input.signal.removeEventListener("abort", onAbort);
    void revokeTurnToken(turnId).catch(() => {});
    settle();
  };
  const onAbort = () => { void cancelJob(job.id); finish(); };
  const startTimer = setTimeout(() => {
    if (started) return;
    void cancelJob(job.id);
    finish(new Error(`Your computer didn't pick this up. Open LFG Desktop and make sure it's connected, then send your message again.`));
  }, START_TIMEOUT_MS);

  const onEvent = (event: AgentEvent) => {
    input.onActivity?.();
    switch (event.type) {
      case "text": {
        const id = `local-text-${textBlock++}`;
        queue.push({ type: "text-start", id });
        queue.push({ type: "text-delta", id, text: event.text });
        queue.push({ type: "text-end", id });
        return;
      }
      case "tool_start": {
        const toolName = lfgToolName(event.name);
        const id = event.id || `local-tool-${toolNames.size}`;
        const toolInput = event.input ?? {};
        toolNames.set(id, { name: toolName, input: toolInput });
        queue.push({ type: "tool-input-start", id, toolName });
        queue.push({ type: "tool-input-delta", id, delta: JSON.stringify(toolInput) });
        queue.push({ type: "tool-input-end", id });
        queue.push({ type: "tool-call", toolCallId: id, toolName, input: toolInput });
        return;
      }
      case "tool_result": {
        const tool = toolNames.get(event.id) ?? { name: "tool", input: {} };
        if (event.isError) { queue.push({ type: "tool-error", toolCallId: event.id, toolName: tool.name, input: tool.input, error: event.output }); return; }
        let output: unknown = event.output;
        try { output = JSON.parse(event.output); } catch { /* plain text */ }
        queue.push({ type: "tool-result", toolCallId: event.id, toolName: tool.name, input: tool.input, output });
        return;
      }
      case "compacted": input.onCompacted?.({ trigger: event.trigger, preTokens: event.preTokens }); return;
      default: return; // session, result, limits: the job's finish and the hub carry what matters
    }
  };

  const stopWatching = watchJob(job.id, (update: JobUpdate) => {
    switch (update.type) {
      case "offered": input.onStatus(`Sent to ${update.deviceName}…`); return;
      case "accepted": started = true; input.onStatus(`${label} on ${update.deviceName} is working…`); return;
      case "rejected": finish(new Error(`Your computer declined this: ${update.reason ?? "no reason given"}`)); return;
      case "event": onEvent(update.event); return;
      case "finished": finish(update.ok ? undefined : new Error(update.error || `${label} on your computer stopped with an error.`)); return;
    }
  });
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  else if (!userHasConnectedRunner(input.userId)) input.onStatus("Waiting for your computer. Open LFG Desktop to continue.");

  return { fullStream: queue.iterate(), response };
}
