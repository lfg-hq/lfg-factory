import { tool, zodSchema } from "ai";
import { z } from "zod";

let _wsBroadcast: ((userId: string, data: object) => void) | null = null;
export function setWsBroadcast(fn: (userId: string, data: object) => void) {
  _wsBroadcast = fn;
}

export const broadcastToUser = tool({
  description: "Send a real-time notification or UI update to the user via WebSocket.",
  inputSchema: zodSchema(z.object({
    userId: z.string(),
    type: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })),
  execute: async ({ userId, type, message, data }) => {
    if (_wsBroadcast) _wsBroadcast(userId, { type, message, ...(data ?? {}) });
    return { sent: true };
  },
});

/**
 * Normalize askUser question items to the canonical { question, suggestions, context }
 * shape the frontend renders. Accepts `title` as an alias for `question` and
 * `options` as an alias for `suggestions`, so a call with either naming works.
 * Drops items that have no question text or fewer than 2 options.
 */
export function normalizeAskUserQuestions(input: unknown): Array<{
  question: string;
  suggestions: string[];
  context?: string;
}> {
  if (!Array.isArray(input)) return [];
  return input
    .map((q) => {
      const item = (q ?? {}) as Record<string, unknown>;
      const question =
        typeof item.question === "string"
          ? item.question
          : typeof item.title === "string"
            ? item.title
            : "";
      const rawOptions = Array.isArray(item.suggestions)
        ? item.suggestions
        : Array.isArray(item.options)
          ? item.options
          : [];
      const suggestions = rawOptions.filter(
        (o): o is string => typeof o === "string"
      );
      const context =
        typeof item.context === "string" ? item.context : undefined;
      return { question, suggestions, context };
    })
    .filter((q) => q.question.length > 0 && q.suggestions.length >= 2);
}

export const askUser = tool({
  description:
    "Ask the user one or more clarifying questions with suggested options. Each question becomes a section with checkboxes in an inline card. Use this when you need decisions that significantly affect the project (e.g. auth method, database choice, UI approach). Use sparingly — only for important decisions, not trivial details. Group related questions into a single call (up to 4 sections).",
  inputSchema: zodSchema(
    z.object({
      questions: z
        .array(
          z
            .object({
              // Canonical field names. `title`/`options` are accepted as
              // aliases (some models emit those) and normalized in execute().
              question: z.string().optional().describe("The question to ask"),
              title: z.string().optional().describe("Alias for `question`"),
              suggestions: z
                .array(z.string())
                .max(6)
                .optional()
                .describe("2-6 suggested options"),
              options: z
                .array(z.string())
                .max(6)
                .optional()
                .describe("Alias for `suggestions`"),
              context: z
                .string()
                .optional()
                .describe("Optional context for this question"),
            })
            .describe("Each item needs question text (question/title) and 2-6 options (suggestions/options)")
        )
        .min(1)
        .max(4)
        .describe("1-4 questions, each rendered as a section with its own options"),
    })
  ),
  // execute is a no-op — the stream handler sends the WS notification
  // directly using the session ws, so we don't need userId here.
  execute: async (args) => {
    const questions = normalizeAskUserQuestions(args?.questions);
    return {
      presented: true,
      questions,
      message: `Questions were displayed to the user as an inline card with checkboxes. Do NOT repeat the questions or options in your text response — the user already sees them. Stop generating text and wait for their reply.`,
    };
  },
});

export const confirmAction = tool({
  description:
    "Ask the user to approve or reject a specific action BEFORE you take it, rendered as a blocking Yes/No popup card. Use this EVERY time before you create or overwrite a document (PRD, Technical Analysis, Design Language) or create tickets — the user must click Yes before you call streamDocumentContent / createTickets. This is NOT for open-ended choices (use askUser for those) — it's strictly for a go/no-go permission gate. After calling it, STOP and wait — do not call the action tool in the same turn.",
  inputSchema: zodSchema(
    z.object({
      title: z
        .string()
        .describe("The Yes/No question, e.g. \"Ready for me to write the PRD?\" or \"Create these 6 tickets?\""),
      summary: z
        .string()
        .optional()
        .describe("Optional 1-2 line recap of exactly what will be created if they say Yes."),
      confirmLabel: z
        .string()
        .optional()
        .describe("Label for the Yes button. Default \"Yes, go ahead\"."),
      cancelLabel: z
        .string()
        .optional()
        .describe("Label for the No button. Default \"No, let me adjust\"."),
    })
  ),
  // execute is a no-op — the stream handler sends the WS notification directly.
  execute: async (args) => {
    return {
      presented: true,
      title: args?.title ?? "",
      message:
        "A Yes/No confirmation card was shown to the user. Do NOT proceed with the action or repeat the question in text — stop generating and wait for the user to click Yes or No.",
    };
  },
});

export const lookupTechnologySpecs = tool({
  description: "Look up documentation or best practices for a technology before recommending it.",
  inputSchema: zodSchema(z.object({
    technology: z.string().describe("Technology name e.g. 'Next.js 15', 'Drizzle ORM'"),
    query: z.string().describe("What to look up e.g. 'setup guide', 'authentication patterns'"),
  })),
  execute: async ({ technology, query }) => {
    return {
      technology,
      query,
      note: "Web search not available in this environment. Use training knowledge and recommend the user verify against official docs.",
    };
  },
});
