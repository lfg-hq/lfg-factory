/**
 * One or two plain sentences for a chat in a list: where the conversation left off.
 * Taken from the agent's last reply (no model call), with markdown stripped so a
 * heading, table or code fence never shows up as noise.
 */
export type ChatSummary = { text: string; failed: boolean };

const MAX = 220;

export function plainText(markdown: string): string {
  return markdown
    .replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, " ") // status tags such as <lfg-info>…</lfg-info>
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)?/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function chatSummary(lastMessages: { role: string; content: string | null }[]): ChatSummary | null {
  const newest = lastMessages[0];
  if (!newest) return null;
  const reply = lastMessages.find((m) => m.role === "assistant");
  const error = reply && /^\s*\*?Error:/i.test(reply.content ?? "");
  if (reply === newest && error) {
    return { text: plainText(reply.content ?? "").replace(/^Error:\s*/i, "").slice(0, MAX), failed: true };
  }
  const source = reply && !error ? reply : lastMessages.find((m) => m.role === "user") ?? newest;
  const text = plainText(source.content ?? "");
  if (!text) return null;
  if (text.length <= MAX) return { text, failed: false };
  // Whole sentences only, as many as fit; a list number left over from a heading is not one.
  let out = "";
  for (const sentence of text.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? []) {
    if (/^\s*\d+[.)]?\s*$/.test(sentence)) break;
    if ((out + sentence).length > MAX) break;
    out += sentence;
  }
  out = out.trim();
  return { text: out.length > 40 ? out : text.slice(0, text.lastIndexOf(" ", MAX)) + "…", failed: false };
}
