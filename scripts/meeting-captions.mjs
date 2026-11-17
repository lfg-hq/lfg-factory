/**
 * Turns Google Meet's live captions into finished lines of transcript.
 *
 * Meet shows one block per speaker and keeps rewriting it while they talk: words are
 * appended, earlier words are corrected, and long blocks lose their beginning. This takes
 * snapshots of those blocks and hands back each stretch of speech once, when the speaker
 * pauses, when someone else starts, or when a block has grown long.
 */
const hasWords = (s) => /[\p{L}\p{N}]/u.test(s);

/** The part of `text` that has not been handed out yet, given what was (`emitted`). */
export function unseenPart(emitted, text) {
  if (!emitted) return text;
  if (text.startsWith(emitted)) return text.slice(emitted.length);
  // The start scrolled away: the end of what we emitted overlaps the start of what is shown.
  for (let k = Math.min(emitted.length, text.length); k >= 12; k--) {
    if (emitted.endsWith(text.slice(0, k))) return text.slice(k);
  }
  // An earlier word was corrected: keep what follows the part that still matches.
  let same = 0;
  while (same < emitted.length && same < text.length && emitted[same] === text[same]) same++;
  if (same >= emitted.length * 0.6) return text.slice(same);
  return text;
}

export function createCaptionAssembler({ quietMs = 1400, longChars = 320, now = Date.now } = {}) {
  /** block id -> { speaker, text, emitted, changedAt } */
  const blocks = new Map();
  const take = (block, upTo) => {
    const fresh = unseenPart(block.emitted, upTo).replace(/\s+/g, " ").trim();
    block.emitted = upTo;
    return hasWords(fresh) ? [{ speaker: block.speaker, text: fresh }] : [];
  };

  return {
    /** `shown`: the caption blocks on screen right now, in order: [{ id, speaker, text }]. */
    update(shown) {
      const out = [];
      const at = now();
      const ids = new Set(shown.map((b) => b.id));
      for (const [id, block] of blocks) {
        if (!ids.has(id)) { out.push(...take(block, block.text)); blocks.delete(id); } // block left the screen
      }
      shown.forEach((b, i) => {
        const text = String(b.text ?? "").replace(/\s+/g, " ").trim();
        let block = blocks.get(b.id);
        if (!block) { block = { speaker: b.speaker || "Someone", text: "", emitted: "", changedAt: at }; blocks.set(b.id, block); }
        if (b.speaker) block.speaker = b.speaker;
        if (text !== block.text) { block.text = text; block.changedAt = at; }
        const pending = unseenPart(block.emitted, block.text);
        if (!hasWords(pending)) return;
        const someoneElseStarted = i < shown.length - 1;
        if (someoneElseStarted || at - block.changedAt >= quietMs) out.push(...take(block, block.text));
        else if (pending.length > longChars) {
          // Still talking: hand out the finished sentences and keep the one in progress.
          const stop = Math.max(pending.lastIndexOf(". "), pending.lastIndexOf("? "), pending.lastIndexOf("! "));
          if (stop > 40) out.push(...take(block, block.text.slice(0, block.text.length - pending.length + stop + 1)));
        }
      });
      return out;
    },
    /** Everything not yet handed out (the call is ending). */
    flush() {
      const out = [];
      for (const block of blocks.values()) out.push(...take(block, block.text));
      blocks.clear();
      return out;
    },
  };
}
