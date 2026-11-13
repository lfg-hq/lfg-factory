/**
 * Bound a turn's saved tool steps without breaking call/result pairs.
 *
 * Steps are replayed on later turns so the agent still has what it read and did. They
 * used to be cut to 4,000 characters per result and, above 16k per turn, flattened into
 * "Used X / Result X" prose: a document read one turn was gone the next, and the prose
 * taught models to narrate tool calls instead of making them. Now results keep up to
 * `resultChars`; only if the turn still exceeds `maxChars` are results shortened further,
 * in steps. The message structure is never changed.
 */
const KEEP_WHOLE = new Set(['loadSkill']);
const NOTE = '\n[Output shortened; inspect the source again for full details.]\n';
const shorten = (text: string, max: number) => text.length <= max ? text
  : text.slice(0, Math.floor(max * .65)) + NOTE + text.slice(-Math.floor(max * .25));

function trimSteps(steps: any[], resultChars: number): void {
  for (const message of steps) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && !KEEP_WHOLE.has(part.toolName)) {
        const value = part.output?.value ?? part.output ?? part.result ?? '';
        const raw = typeof value === 'string' ? value : JSON.stringify(value);
        if (raw.length > resultChars) {
          const text = shorten(raw, resultChars);
          if ('output' in part) part.output = { type: 'text', value: text }; else part.result = text;
        }
      }
      // A written document travels in the call's input; keep it, bounded the same way.
      if (part.type === 'tool-call') {
        const input = part.input ?? part.args;
        if (input && typeof input === 'object') for (const key of Object.keys(input)) {
          if (typeof input[key] === 'string' && input[key].length > resultChars) input[key] = shorten(input[key], resultChars);
        }
      }
    }
  }
}

export function compactToolSteps(steps: any[], maxChars = 600_000, resultChars = 40_000): any[] {
  const copy = structuredClone(steps);
  for (const limit of [resultChars, 8000, 2000, 500]) {
    if (limit > resultChars) continue;
    trimSteps(copy, limit);
    if (JSON.stringify(copy).length <= maxChars) break;
  }
  return copy;
}

/**
 * One line per tool call in a saved turn, for the rolling summary: the summarizer used to
 * see only the reply text, so work the reply did not mention was lost from the handoff.
 */
export function toolDigest(steps: any[], maxChars = 6000): string {
  const clip = (value: unknown, max: number) => {
    const text = (typeof value === 'string' ? value : JSON.stringify(value ?? '') ?? '').replace(/\s+/g, ' ');
    return text.length > max ? text.slice(0, max) + '…' : text;
  };
  const calls = new Map<string, unknown>();
  const lines: string[] = [];
  for (const message of steps) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'tool-call') calls.set(part.toolCallId, part.input ?? part.args);
      if (part?.type === 'tool-result') lines.push(`${part.toolName}(${clip(calls.get(part.toolCallId) ?? {}, 200)}) → ${clip(part.output?.value ?? part.output ?? part.result, 500)}`);
    }
  }
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars / 2) + '\n[…]\n' + text.slice(-maxChars / 2) : text;
}

export function selectConversationHistory<T extends {userRole?:string|null}>(rows:T[],limit=20):T[] {
 return rows.filter(r=>r.userRole!=='operation_status').slice(0,limit);
}
