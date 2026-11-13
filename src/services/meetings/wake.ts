/**
 * Spotting "Hey LFG, ..." in what people say or type in a call.
 * Speech-to-text writes the name many ways ("LFG", "L F G", "L.F.G.", "elle eff gee"), so the match is loose.
 */
const NAME = String.raw`(?:l[\s.\-]*f[\s.\-]*g\b\.?|el+e?[\s\-]*ef+[\s\-]*g(?:ee|ie?)\b)`;
const SPOKEN = new RegExp(String.raw`(?:^|[\s,.!?;:])(?:hey|hi|hello|ok|okay|yo)[\s,]+${NAME}[\s,.:;!?\-]*`, "gi");
const TYPED = new RegExp(String.raw`^\s*@?${NAME}[\s,.:;!?\-]+`, "i");

/**
 * The request that follows the wake phrase, or null when the agent was not addressed.
 * An empty string means the name was said and the request is still coming.
 */
export function requestAfterWakePhrase(text: string, typed = false): string | null {
  let end = -1;
  for (const match of text.matchAll(SPOKEN)) end = match.index! + match[0].length;
  if (end < 0 && typed) {
    const match = TYPED.exec(text);
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

export function platformOf(meetingUrl: string): "google_meet" | "zoom" | "teams" | "unknown" {
  let host = "";
  try { host = new URL(meetingUrl).hostname.toLowerCase(); } catch { return "unknown"; }
  if (host === "meet.google.com") return "google_meet";
  if (host === "zoom.us" || host.endsWith(".zoom.us") || host.endsWith(".zoom.com")) return "zoom";
  if (host === "teams.microsoft.com" || host === "teams.live.com" || host.endsWith(".teams.microsoft.com")) return "teams";
  return "unknown";
}
