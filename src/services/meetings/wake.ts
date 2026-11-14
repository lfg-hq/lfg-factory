/**
 * Spotting "Hey LFG, ..." in what people say or type in a call.
 *
 * Live captions spell an acronym many ways ("LFG", "L F G", "L.F.G.", "elle eff gee") and
 * sometimes mangle it completely: in the first real call Google Meet wrote "Hey LFG" as
 * "Hey, I love to you". So the bot also answers to plain words captions get right,
 * "Hey agent" and "Hey assistant" by default (MEETING_WAKE_ALIASES, comma-separated).
 */
const ACRONYM = String.raw`l[\s.\-]*f[\s.\-]*g\b\.?|el+e?[\s\-]*ef+[\s\-]*g(?:ee|ie?)\b`;
const escape = (word: string) => word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, String.raw`\s+`);
const aliases = () => (process.env.MEETING_WAKE_ALIASES ?? "agent,assistant").split(",").map(escape).filter(Boolean);
let built: { key: string; spoken: RegExp; typed: RegExp } | null = null;
function patterns() {
  const key = process.env.MEETING_WAKE_ALIASES ?? "";
  if (built?.key === key) return built;
  const name = `(?:${[ACRONYM, ...aliases().map((a) => a + String.raw`\b`)].join("|")})`;
  built = {
    key,
    spoken: new RegExp(String.raw`(?:^|[\s,.!?;:])(?:hey|hi|hello|ok|okay|yo)[\s,]+${name}[\s,.:;!?\-]*`, "gi"),
    // Typed, only the product's own name counts: "agent: ..." at the start of a chat message is ordinary talk.
    typed: new RegExp(String.raw`^\s*@?(?:${ACRONYM})[\s,.:;!?\-]+`, "i"),
  };
  return built;
}

/**
 * The request that follows the wake phrase, or null when the agent was not addressed.
 * An empty string means the name was said and the request is still coming.
 */
export function requestAfterWakePhrase(text: string, typed = false): string | null {
  let end = -1;
  const { spoken, typed: typedPattern } = patterns();
  for (const match of text.matchAll(spoken)) end = match.index! + match[0].length;
  if (end < 0 && typed) {
    const match = typedPattern.exec(text);
    if (match) end = match[0].length;
  }
  return end < 0 ? null : text.slice(end).trim();
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
