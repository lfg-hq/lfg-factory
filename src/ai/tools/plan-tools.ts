/**
 * The chat agent's working plan for a conversation.
 *
 * Long work (research, two documents, tickets, a build, verification) used to live only
 * in the model's context: once earlier history was condensed, "what am I in the middle
 * of" survived only if the summary happened to say so. The plan is stored per
 * conversation, shown to the agent at the start of every turn and re-attached after
 * every condense, so the agent resumes at the right step.
 */
import { tool, zodSchema } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { conversationPlans } from "../../db/schema/chat.ts";

export type PlanItem = { step: string; status: "pending" | "in_progress" | "done" | "blocked"; note?: string };
const MARK: Record<PlanItem["status"], string> = { pending: "[ ]", in_progress: "[>]", done: "[x]", blocked: "[!]" };

export async function readPlan(conversationId: string, store = db): Promise<PlanItem[]> {
  const [row] = await store.select({ items: conversationPlans.items }).from(conversationPlans)
    .where(eq(conversationPlans.conversationId, conversationId)).limit(1);
  return Array.isArray(row?.items) ? row!.items as PlanItem[] : [];
}

/** The plan as the agent reads it. "" when there is nothing left to do (a finished plan is not context). */
export function formatPlan(items: PlanItem[]): string {
  if (!items.length || items.every(i => i.status === "done")) return "";
  return "Your working plan for this conversation (keep it current with updatePlan):\n" +
    items.map((i, n) => `${n + 1}. ${MARK[i.status] ?? "[ ]"} ${i.step}${i.note ? ` — ${i.note}` : ""}`).join("\n");
}
export const planContext = async (conversationId: string) => formatPlan(await readPlan(conversationId).catch(() => []));

/** One line for the activity trail: progress and the step in hand. */
export function planProgress(items: PlanItem[]): string {
  const done = items.filter(i => i.status === "done").length;
  const current = items.find(i => i.status === "in_progress") ?? items.find(i => i.status === "blocked") ?? items.find(i => i.status === "pending");
  return `Plan ${done}/${items.length} done` + (current ? ` · ${current.status === "blocked" ? "blocked on" : "now"}: ${current.step.slice(0, 80)}` : "");
}

export function planTools(context: { conversationId: string; onUpdate?: (items: PlanItem[]) => void }, store = db) {
  return {
    updatePlan: tool({
      description:
        "Record or update your working plan for this conversation. Use it for any work of three or more steps " +
        "(a feature taken from research to tickets to a build, a multi-document change, a diagnosis with a fix and a re-check). " +
        "Send the WHOLE plan every time: each step with its status. Keep exactly one step in_progress while working; " +
        "mark a step done as soon as it is done, and blocked (with a note saying on what) when it waits on the user or a build. " +
        "The plan survives context condensing and is shown to you at the start of each turn, so put exact IDs in notes " +
        "(epic, document, ticket keys, build run). It is your own working state, not approval: it never authorizes a build or a change.",
      inputSchema: zodSchema(z.object({
        items: z.array(z.object({
          step: z.string().min(1).max(240).describe("One short imperative line"),
          status: z.enum(["pending", "in_progress", "done", "blocked"]),
          note: z.string().max(400).optional().describe("IDs, outcome, or what it is blocked on"),
        })).max(20),
      })),
      execute: async ({ items }: { items: PlanItem[] }) => {
        await store.insert(conversationPlans).values({ conversationId: context.conversationId, items, updatedAt: new Date() })
          .onConflictDoUpdate({ target: conversationPlans.conversationId, set: { items, updatedAt: new Date() } });
        context.onUpdate?.(items);
        return { saved: true, progress: planProgress(items) };
      },
    }),
  };
}
