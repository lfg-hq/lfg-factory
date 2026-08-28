/**
 * loadSkill — the agent pulls in a detailed workflow when it recognises the work.
 *
 * The alternative was the server keyword-matching the user's message and appending the
 * file itself. That guesses from outside the conversation: it misses phrasings ("make
 * the top of the site nicer") and fires on collisions ("restart the preview sandbox").
 * The model already knows what the user is asking for — it just needs to be told what's
 * available and to fetch it.
 */
import { tool, zodSchema } from "ai";
import { z } from "zod";
import { allSkills, getSkill } from "../skills/index.ts";

export const loadSkill = tool({
  description:
    "Load a detailed workflow (a 'skill') into your context before doing that kind of " +
    "work. Call this the moment you recognise the request as one of the skills listed " +
    "in your prompt — before starting the work, not after. The full instructions come " +
    "back as the result; follow them exactly. Loading a skill twice in a conversation " +
    "is unnecessary: you keep what it returned.",
  inputSchema: zodSchema(
    z.object({
      id: z.string().describe("The skill id, exactly as listed in your prompt (e.g. 'landing-page')."),
    })
  ),
  execute: async ({ id }) => {
    const skill = getSkill(id);
    if (!skill) {
      // Name the real options rather than just failing — a wrong guess should not
      // silently drop the agent back into improvising.
      return {
        found: false as const,
        error: `No skill called "${id}".`,
        available: allSkills().map((s) => ({ id: s.id, description: s.description })),
      };
    }
    return {
      found: true as const,
      id: skill.id,
      instructions: skill.body,
      note: "Follow these steps for this piece of work. They replace your default approach.",
    };
  },
});
