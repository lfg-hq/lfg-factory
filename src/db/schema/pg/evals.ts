import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

// ── Evals ────────────────────────────────────────────────────────────
// A suite describes the AI agent a project is building (its instructions and the tools it can
// call) and the scenarios it must handle. A run plays every scenario against every chosen
// model; each scenario/model pair is one result holding the transcript and the verdict.
// projectId holds the PUBLIC project id, the same value conversation.project_id stores.
export const evalSuites = pgTable(
  "eval_suite",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    name: text("name").notNull().default("Untitled evals"),
    description: text("description").notNull().default(""),
    // The instructions of the agent under test (its system prompt).
    agentPrompt: text("agent_prompt").notNull().default(""),
    // JSON: stand-in tools the agent can call during a run, each with a canned reply.
    tools: text("tools").notNull().default("[]"),
    // JSON: the scenarios (who is talking to the agent, what they want, what must be true afterwards).
    scenarios: text("scenarios").notNull().default("[]"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("eval_suite_project_idx").on(t.projectId)]
);

export const evalRuns = pgTable(
  "eval_run",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    suiteId: text("suite_id").notNull().references(() => evalSuites.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    // JSON: [{ key, label }] for the models compared in this run.
    models: text("models").notNull().default("[]"),
    // The model that played the other side of each conversation and graded it.
    judgeModel: text("judge_model").notNull().default(""),
    status: text("status").notNull().default("running"), // running | done | stopped
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    finishedAt: timestamp("finished_at", { mode: "date" }),
  },
  (t) => [index("eval_run_suite_idx").on(t.suiteId)]
);

export const evalResults = pgTable(
  "eval_result",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id").notNull().references(() => evalRuns.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").notNull(),
    // The scenario as it was when the run started (JSON), so later edits don't rewrite history.
    scenario: text("scenario").notNull().default("{}"),
    modelKey: text("model_key").notNull(),
    status: text("status").notNull().default("pending"), // pending | running | passed | failed | error
    score: integer("score"), // 0-100: the share of criteria met
    transcript: text("transcript").notNull().default("[]"),
    verdict: text("verdict").notNull().default("{}"),
    error: text("error"),
    turns: integer("turns").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0), // average time the agent took to answer
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("eval_result_run_idx").on(t.runId)]
);
