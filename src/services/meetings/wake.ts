/**
 * Spotting "Hey LFG, ..." in what people say or type in a call.
 *
 * Live captions spell an acronym many ways ("LFG", "L F G", "L.F.G.", "elle eff gee") and
 * sometimes mangle it completely: in the first real call Google Meet wrote "Hey LFG" as
 * "Hey, I love to you". So the bot also answers to plain words captions get right,
 * "Hey agent" and "Hey assistant" by default (MEETING_WAKE_ALIASES, comma-separated).
 */
// "Hey LFG" also comes out glued together: "Alfg", "Elfg", "Heylfg".
const ACRONYM = String.raw`(?:a|e|hey|hay)?l[\s.\-]*f[\s.\-]*g\b\.?|el+e?[\s\-]*ef+[\s\-]*g(?:ee|ie?)\b`;
const escape = (word: string) => word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, String.raw`\s+`);
const aliases = () => (process.env.MEETING_WAKE_ALIASES ?? "agent,assistant").split(",").map(escape).filter(Boolean);
const ASKING = "what|which|who|whom|whose|how|when|where|why|can|could|would|will|should|is|are|do|does|did|please|create|make|show|list|tell|give|find|get|pull|summari[sz]e|draft|write|open|add|check|explain|share|look|search|count|update|remind";
let built: { key: string; spoken: RegExp; garbled: RegExp; opening: RegExp; typed: RegExp } | null = null;
function patterns() {
  const key = process.env.MEETING_WAKE_ALIASES ?? "";
  if (built?.key === key) return built;
  const name = `(?:${[ACRONYM, ...aliases().map((a) => a + String.raw`\b`)].join("|")})`;
  built = {
    key,
    // Anywhere in what was said: a greeting, then the name.
    spoken: new RegExp(String.raw`(?:^|[\s,.!?;:])(?:hey|hi|hello|ok|okay|yo)[\s,]+${name}[\s,.:;!?\-]*`, "gi"),
    // "Hey" mangled mid-sentence ("are there any lfg are there any docs"): only when a question
    // or instruction follows, so "do we have any LFG tickets" stays talk about it.
    garbled: new RegExp(String.raw`(?:^|[\s,.!?;:])(?:any|a|eh|ay|hay)[\s,]+${name}[\s,.:;!?\-]*(?=(?:${ASKING})\b)`, "gi"),
    // Opening a sentence with the name is addressing it too: "LFG, what project is this?".
    // Captions also turn "hey" into "a", "eh" or "hay" ("A agent which project is this?").
    // Only when it reads as being spoken to: a pause after the name, or a question or instruction
    // straight after it. "LFG shipped the preview yesterday" is talk about it, not to it.
    opening: new RegExp(String.raw`^\s*(?:(?:a|eh|ay|hay|hey|hi|so|and|um|uh)[\s,]+)?${name}(?:\s*[,.:;!?\-]+\s*|\s*$|\s+(?=(?:${ASKING})\b))`, "i"),
    typed: new RegExp(String.raw`^\s*@?${name}[\s,.:;!?\-]+`, "i"),
  };
  return built;
}

/**
 * The request that follows the wake phrase, or null when the agent was not addressed.
 * An empty string means the name was said and the request is still coming.
 */
export function requestAfterWakePhrase(text: string, typed = false): string | null {
  const p = patterns();
  let end = -1;
  for (const match of text.matchAll(p.spoken)) end = match.index! + match[0].length;
  if (end < 0 && !typed) for (const match of text.matchAll(p.garbled)) end = match.index! + match[0].length;
  if (end < 0) {
    const match = (typed ? p.typed : p.opening).exec(text);
    if (match) end = match[0].length;
  }
  return end < 0 ? null : text.slice(end).trim();
}

/** What the bot says aloud: plain sentences, no markdown, and short. Long answers are cut at a sentence. */
export function spokenText(reply: string, limit = 500): string {
  const plain = reply
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link in the chat")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~>|]/g, "")
    .replace(/\s+/g, " ").trim();
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return `${stop > limit / 3 ? cut.slice(0, stop + 1) : cut.trimEnd() + "..."} The rest is in the meeting chat.`;
}

/** Split a reply to fit the meeting app's chat limit (Google Meet allows 500 characters per message). */
export function chatChunks(reply: string, limit: number, maxChunks = 4): string[] {
  const chunks: string[] = [];
  let rest = reply.trim();
  while (rest && chunks.length < maxChunks) {
    if (rest.length <= limit) { chunks.push(rest); rest = ""; break; }
    const cut = rest.slice(0, limit);
    const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". ") + 1, cut.lastIndexOf(" "));
    const size = at > limit / 2 ? at : limit;
    chunks.push(rest.slice(0, size).trim());
    rest = rest.slice(size).trim();
  }
  if (rest && chunks.length) chunks[chunks.length - 1] = chunks[chunks.length - 1]!.slice(0, limit - 28).trimEnd() + "... (full answer is in LFG)";
  return chunks;
}

/** A Meet link in any of its forms (with /meet/, ?authuser=1, a trailing slash) as the plain link a guest would open. */
export function meetLink(meetingUrl: string): string | null {
  let url: URL;
  try { url = new URL(meetingUrl.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "meet.google.com") return null;
  const code = url.pathname.split("/").filter(Boolean).pop() ?? "";
  return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(code) || /^[a-z0-9_-]{6,60}$/i.test(code) && !/^(meet|new|landing|home)$/i.test(code) ? `https://meet.google.com/${code.toLowerCase()}` : null;
}

export function platformOf(meetingUrl: string): "google_meet" | "zoom" | "teams" | "unknown" {
  let host = "";
  try { host = new URL(meetingUrl).hostname.toLowerCase(); } catch { return "unknown"; }
  if (host === "meet.google.com") return "google_meet";
  if (host === "zoom.us" || host.endsWith(".zoom.us") || host.endsWith(".zoom.com")) return "zoom";
  if (host === "teams.microsoft.com" || host === "teams.live.com" || host.endsWith(".teams.microsoft.com")) return "teams";
  return "unknown";
}
