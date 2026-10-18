/**
 * Did this turn end by ANNOUNCING an action it never took?
 *
 * The failure looks like: "The codebase query came back empty — let me retry with more
 * targeted questions." … and then the turn ends. The SDK's agent loop keeps going only
 * while the model emits tool calls, so a promise-then-stop is a legitimate end of turn
 * and the user gets a dead half-thought.
 *
 * Deliberately conservative: it only matches a FINAL sentence that is a first-person
 * statement of intent. A turn that ends by answering, asking the user something, or
 * offering a choice ("Want me to build it?") is a normal, complete turn and must not be
 * nudged — a false positive costs a wasted model round-trip and a confusing double reply.
 */
export function endsOnUnkeptPromise(text: string): boolean {
  const trimmed = (text ?? "").replace(/[’‘]/g, "'").trim();
  if (!trimmed) return false;
  // A question back to the user is a complete turn: the ball is in their court.
  if (/[?]\s*$/.test(trimmed)) return false;
  // Take the last sentence/line with content.
  const last = trimmed
    .split(/\n+/).pop()!
    .split(/(?<=[.!])\s+/).filter((s) => s.trim()).pop()!
    .trim()
    .replace(/^[-*>\s]+/, "");
  if (!last || last.length > 200) return false;
  // "Let me …", "I'll …", "Now let me …", "Let's check …", "One moment while I …"
  const intent =
    /^(now\s+)?(let me\b|let's\b|i'?ll\b|i am going to\b|i'?m going to\b|i will\b|give me a (moment|second)\b|one (moment|sec)\b|checking\b|looking\b|searching\b|hold on\b)/i;
  if (!intent.test(last)) return false;
  // "I'll need you to …" / "Let me know …" are requests TO THE USER, not self-directed.
  if (/\b(let me know|i'?ll need (you|your)|tell me|send me|share)\b/i.test(last)) return false;
  return true;
}

export function shouldContinuePromise(text: string, state: { aborted: boolean; waitingForUser: boolean; closedByCard: boolean }): boolean {
  return !state.aborted && !state.waitingForUser && !state.closedByCard && endsOnUnkeptPromise(text);
}

/** Keep tool results when continuing so completed writes are not repeated. */
export function continuationMessages(history: any[], response: any[], instruction: string): any[] {
  return [...history, ...response, { role: 'user', content: instruction }];
}

/** A successful question-only turn is not a stopped generation. */
export function emptyTurnContent(waitingForUser: boolean, aborted: boolean): string {
  if (aborted) return '*Generation stopped*';
  return waitingForUser ? '' : '*No response was returned. Please try again.*';
}
