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

export const askUser = tool({
  description:
    "Ask the user a clarifying question with suggested options. Use this when you need a decision that significantly affects the project (e.g. auth method, database choice, UI approach). The user sees clickable option buttons and can also type a custom answer. Use sparingly — only for important decisions, not trivial details.",
  inputSchema: zodSchema(
    z.object({
      userId: z.string().describe("The userId to send the question to"),
      question: z.string().describe("The question to ask the user"),
      suggestions: z
        .array(z.string())
        .min(2)
        .max(8)
        .describe("2-8 suggested options for the user to choose from"),
      multiSelect: z
        .boolean()
        .optional()
        .default(true)
        .describe("Allow selecting multiple options (default true). Set false for single-choice questions."),
      context: z
        .string()
        .optional()
        .describe("Optional context explaining why this decision matters"),
    })
  ),
  execute: async ({ userId, question, suggestions, multiSelect, context }) => {
    if (_wsBroadcast) {
      _wsBroadcast(userId, {
        type: "ai_chunk",
        is_notification: true,
        notification_type: "ask_user",
        question,
        suggestions,
        multiSelect: multiSelect ?? true,
        context: context ?? "",
      });
    }
    return {
      presented: true,
      message: `Question with options was displayed to the user as clickable buttons. Do NOT repeat the question or options in your text response — the user already sees them. Stop generating text and wait for their reply.`,
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
