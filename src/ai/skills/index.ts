/**
 * Skills — workflow instructions loaded into the agent's prompt ON DEMAND.
 *
 * The product prompt carried every workflow at once: greenfield, existing project,
 * tickets, epics, design language AND the whole landing-page loop. A page request had to
 * compete for attention with ~460 lines covering situations it wasn't in, and the
 * landing-page steps (wireframe → settle copy → offer a preview → only then a ticket)
 * sat 230 lines down. Skipping straight to createTickets was the predictable result.
 *
 * A skill is a markdown file appended to the system prompt only when the conversation is
 * actually about that thing, matched on the user's own words.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Skill {
  id: string;
  file: string;
  /** Any of these in the user's message loads the skill. */
  triggers: RegExp[];
}

export const SKILLS: Skill[] = [
  {
    id: "landing-page",
    file: "landing-page.md",
    triggers: [
      /\blanding[\s-]?page\b/i,
      /\bmarketing (page|site)\b/i,
      /\bhome ?page\b/i,
      /\b(about|pricing|contact|faq|docs?) page\b/i,
      /\bsplash page\b/i,
      /\bwebsite for\b/i,
      // The follow-ups that happen once a page is in flight, so the skill stays loaded
      // through the iteration rather than only on the opening message.
      /\bpreview page\b/i,
      /\bpreviewPage\b/,
      // Verb-anchored: "preview" alone also means the running-app Preview tab, and
      // matching that would load this skill for unrelated sandbox work.
      /\b(create|make|render|refresh|regenerate|redo|show)\s+(the\s+|a\s+|another\s+)?preview\b/i,
      /\bhero (section|copy)\b/i,
      /\bwireframe\b/i,
    ],
  },
];

const cache = new Map<string, string>();

function read(file: string): string {
  const hit = cache.get(file);
  if (hit) return hit;
  try {
    const text = readFileSync(join(__dirname, file), "utf-8");
    cache.set(file, text);
    return text;
  } catch (e) {
    console.warn(`[skills] could not read ${file}:`, (e as Error).message);
    return "";
  }
}

/** Which skills the given text calls for. */
export function matchSkills(text: string): Skill[] {
  if (!text) return [];
  return SKILLS.filter((s) => s.triggers.some((t) => t.test(text)));
}

/**
 * The block to append to the system prompt for this turn, or "" when nothing matches.
 * `context` should include the user's message and enough recent conversation that a
 * skill stays loaded while the user is still working on it — "add more FAQs" on its own
 * would match nothing.
 */
export function skillsFor(context: string): string {
  const matched = matchSkills(context);
  if (!matched.length) return "";
  return matched
    .map((s) => `\n\n---\n\n${read(s.file)}`)
    .filter((t) => t.trim())
    .join("");
}
