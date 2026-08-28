/**
 * Ticket chat turns: one at a time, and only a real code change commits.
 *
 * A message to a ticket used to be indistinguishable from "build this": every
 * turn ran the coding agent with an implement-it prompt, and the finalize step
 * fired on ANY agent activity (pi-cli's didWork is `toolCalls > 0 || hadSuccess`
 * — true the moment the agent reads a file). So asking a question produced a
 * commit, a merge, a status flip to In Review and a "✅ Update applied" banner.
 * Two messages in a row produced two agents racing in the same VM.
 *
 * This module holds the three pieces that fix that:
 *   1. A per-ticket lock so one turn runs at a time (users get a 409 and the
 *      Stop button; the orchestrator's messages queue behind the live turn).
 *   2. The MODE CONTRACT the agent answers with — answer / question / change —
 *      plus the parser that pulls it back out of the agent's final text.
 *   3. The evidence gate: the working tree decides whether anything is
 *      committed, no matter what mode the agent claimed.
 */

import { execOnWorkspace } from "./mags.ts";

// ── Turn modes ────────────────────────────────────────────────────────

export type TurnMode = "answer" | "question" | "change";

/** The contract appended to every ticket-chat prompt (both Claude and Pi). */
export const TICKET_CHAT_MODE_CONTRACT = `## How to respond to this message

This is a CHAT message about the ticket, not an order to build. Pick ONE mode:

- **answer** — the message is a question or a request for information. Explore the
  repo as much as you need, then answer it. Do NOT edit, create or delete any file.
- **question** — the message asks for a change, but something you'd have to GUESS at
  would change what you write (which page/component, what the copy or design should
  be, which of several plausible approaches). Ask up to 3 short, specific questions
  and stop. Do NOT edit any file. Never guess and build the wrong thing.
- **change** — the message is an unambiguous, actionable instruction. Implement it.

Choosing: if you can satisfy the message without editing files → answer. If you'd
have to guess at anything that changes what you'd write → question. Only use
change when you know exactly what to do.

End your final message with the mode on its own last line, exactly:

LFG_TURN: answer

(or \`LFG_TURN: question\` / \`LFG_TURN: change\`.) In question mode you may add one
more line offering choices the user can click:

LFG_OPTIONS: ["Restyle the hero only", "Restyle the whole page"]

In answer and question mode the working tree MUST stay clean — any edits you leave
behind are discarded, and nothing is committed.`;

/** Everything we learned about how the turn ended. */
export interface TurnOutcome {
  mode: TurnMode | null;
  options: string[];
  /** The agent's final text, with the marker lines stripped. */
  text: string;
}

const MODE_LINE = /^[\s>*_`-]*LFG[_ ]?TURN\s*[:=]\s*\**\s*(answer|question|change)\b.*$/gim;
const OPTIONS_LINE = /^[\s>*_`-]*LFG[_ ]?OPTIONS\s*[:=]\s*(.+)$/gim;

/** Parse (and strip) the LFG_TURN / LFG_OPTIONS markers from an agent message. */
export function parseTurnMarkers(text: string | undefined | null): TurnOutcome {
  const raw = text ?? "";
  let mode: TurnMode | null = null;
  let options: string[] = [];

  // Last marker wins — the agent may restate it while thinking out loud.
  for (const m of raw.matchAll(MODE_LINE)) mode = m[1]!.toLowerCase() as TurnMode;
  for (const m of raw.matchAll(OPTIONS_LINE)) {
    const parsed = parseOptions(m[1]!);
    if (parsed.length) options = parsed;
  }

  const cleaned = raw.replace(MODE_LINE, "").replace(OPTIONS_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { mode, options, text: cleaned };
}

/** `["a","b"]`, or `a | b`, or `a, b` — accept what a model actually writes. */
function parseOptions(rest: string): string[] {
  const s = rest.trim();
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr)) return arr.map(String).map((o) => o.trim()).filter(Boolean).slice(0, 5);
    } catch { /* fall through to the plain-text split */ }
  }
  const parts = (s.includes("|") ? s.split("|") : s.split(","))
    .map((o) => o.replace(/^["'\s]+|["'\s]+$/g, ""))
    .filter(Boolean);
  return parts.length >= 2 ? parts.slice(0, 5) : [];
}

// ── Live turn state ───────────────────────────────────────────────────

interface LiveTurn {
  startedAt: number;
  /** Mode observed on streamed agent text (the webhook sees it before we do). */
  mode: TurnMode | null;
  options: string[];
  /** Did the streamed output already surface the agent's reply as a log row? */
  repliedInStream: boolean;
}

const live = new Map<string, LiveTurn>();
/** Per-ticket promise chain — a queued (orchestrator) message waits, never races. */
const chains = new Map<string, Promise<unknown>>();

/** Is a chat turn running for this ticket right now? */
export function isChatTurnActive(ticketId: string): boolean {
  return live.has(ticketId);
}

/**
 * Run one chat turn under the ticket's lock. Concurrent calls QUEUE (they don't
 * race and they don't get dropped) — the user-facing route rejects a second
 * message up front, so in practice only the orchestrator ever queues here.
 */
export async function runChatTurn<T>(ticketId: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(ticketId) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(async () => {
    live.set(ticketId, { startedAt: Date.now(), mode: null, options: [], repliedInStream: false });
    try {
      return await fn();
    } finally {
      live.delete(ticketId);
      if (chains.get(ticketId) === run) chains.delete(ticketId);
    }
  });
  chains.set(ticketId, run);
  return run;
}

/**
 * Record what the agent's streamed reply said. The CLI's output webhook sees the
 * final assistant text before the executor does, so this is where the mode
 * usually arrives — and it tells the executor a reply row already exists.
 */
export function noteAgentReply(ticketId: string, outcome: TurnOutcome): void {
  const t = live.get(ticketId);
  if (!t) return;
  if (outcome.mode) t.mode = outcome.mode;
  if (outcome.options.length) t.options = outcome.options;
  if (outcome.text) t.repliedInStream = true;
}

/** What the stream told us about the in-flight turn (null when none is running). */
export function observedTurn(ticketId: string): { mode: TurnMode | null; options: string[]; repliedInStream: boolean } | null {
  const t = live.get(ticketId);
  return t ? { mode: t.mode, options: t.options, repliedInStream: t.repliedInStream } : null;
}

// ── The evidence gate ─────────────────────────────────────────────────

/** Does the branch's working tree actually have changes? (untracked included) */
export async function workingTreeDirty(workspaceId: string, projectDir: string): Promise<boolean> {
  try {
    const r = await execOnWorkspace(
      workspaceId,
      `cd ${projectDir} 2>/dev/null && git status --porcelain 2>/dev/null | head -50`,
      { timeout: 60_000 },
    );
    return (r.output || "").trim().length > 0;
  } catch {
    // Can't tell → assume clean. A missed commit is recoverable (the work is still
    // in the VM and the next turn continues from it); a phantom commit is not.
    return false;
  }
}

/** Throw away edits an answer/question turn left behind, so Q&A is truly read-only. */
export async function revertWorkingTree(workspaceId: string, projectDir: string): Promise<void> {
  await execOnWorkspace(
    workspaceId,
    `cd ${projectDir} 2>/dev/null && git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null; echo REVERTED`,
    { timeout: 90_000 },
  ).catch(() => {});
}

/**
 * Decide what a finished chat turn actually was, from the agent's declared mode
 * AND the working tree. The tree is the tie-breaker: no diff means nothing is
 * committed no matter what the agent claimed, and a diff left by an answer/
 * question turn is reverted rather than shipped.
 */
export async function resolveTurnOutcome(params: {
  ticketId: string;
  workspaceId: string;
  projectDir: string;
  /** Raw final text from the agent, when the executor has it (the Pi tail). */
  tail?: string;
}): Promise<{ mode: TurnMode; reply: TurnOutcome; revertedEdits: boolean; repliedInStream: boolean }> {
  const { ticketId, workspaceId, projectDir, tail } = params;
  const observed = observedTurn(ticketId);
  const fromTail = parseTurnMarkers(tail);
  const mode = observed?.mode ?? fromTail.mode;
  const options = (observed?.options?.length ? observed.options : fromTail.options) ?? [];
  const dirty = await workingTreeDirty(workspaceId, projectDir);

  // No declared mode (an older/weaker model that ignored the contract): fall back
  // to the evidence — edits mean it changed something, otherwise it answered.
  const declared: TurnMode = mode ?? (dirty ? "change" : "answer");

  let revertedEdits = false;
  if (declared !== "change" && dirty) {
    await revertWorkingTree(workspaceId, projectDir);
    revertedEdits = true;
  }

  // Claimed a change but touched nothing → it didn't change anything. Report it as
  // an answer so the UI stops saying "Update applied" over an empty commit.
  const effective: TurnMode = declared === "change" && !dirty ? "answer" : declared;

  return {
    mode: effective,
    reply: { mode: effective, options, text: fromTail.text },
    revertedEdits,
    repliedInStream: !!observed?.repliedInStream,
  };
}

// ── Question logs ─────────────────────────────────────────────────────

/**
 * `ticket_log` has no metadata column, so a question's options + whether it BLOCKS
 * ride in `explanation` as JSON. Blocking questions come from the askUser tool /
 * /request-input long-poll (the agent is parked waiting for the answer); a chat
 * question doesn't block — its answer is just the next chat message.
 */
export function encodeQuestionMeta(meta: { blocking?: boolean; options?: string[] }): string {
  return JSON.stringify({ blocking: !!meta.blocking, options: meta.options ?? [] });
}

export function decodeQuestionMeta(explanation: string | null | undefined): { blocking: boolean; options: string[] } {
  const s = (explanation ?? "").trim();
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as { blocking?: boolean; options?: unknown };
      return { blocking: !!o.blocking, options: Array.isArray(o.options) ? o.options.map(String) : [] };
    } catch { /* not ours — treat as a legacy blocking question */ }
  }
  // Legacy rows (written before this encoding) came only from the blocking path.
  return { blocking: true, options: [] };
}
