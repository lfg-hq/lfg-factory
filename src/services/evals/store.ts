/**
 * Eval storage: suites, runs and results.
 *
 * A suite describes the AI agent a project is building (its instructions and stand-in tools)
 * and the scenarios it must handle. A run plays every scenario against every chosen model, so
 * a run is a grid: one result per scenario and model, each with its transcript and verdict.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { evalResults, evalRuns, evalSuites } from "../../db/schema/evals.ts";

export type Suite = typeof evalSuites.$inferSelect;
export type Run = typeof evalRuns.$inferSelect;
export type Result = typeof evalResults.$inferSelect;

/** A stand-in for one of the agent's real tools: the agent can call it, and gets `returns` back. */
export interface EvalTool { name: string; description: string; parameters?: Record<string, unknown>; returns: string }
export interface EvalScenario {
  id: string;
  title: string;
  /** Who is talking to the agent, what they want and how they behave. Played by a model. */
  persona: string;
  /** The person's first message. Empty lets the persona open the conversation. */
  opening: string;
  /** What must be true of the agent's side of the conversation for the scenario to pass. */
  criteria: string[];
  /** How many times the agent may answer before the conversation is cut off. 1 is a single question and answer. */
  maxTurns: number;
}
export interface ToolCall { name: string; input: unknown; output: unknown }
export interface TranscriptEntry { role: "user" | "agent"; text: string; toolCalls?: ToolCall[]; ms?: number }
export interface Verdict { summary: string; criteria: Array<{ criterion: string; pass: boolean; reason: string }> }
export interface RunModel { key: string; label: string }
export type ResultStatus = "pending" | "running" | "passed" | "failed" | "error" | "stopped";

export const MAX_SCENARIOS = 40;
export const MAX_MODELS = 6;
export class EvalError extends Error {}

const text = (value: unknown, max: number) => (typeof value === "string" ? value : value == null ? "" : String(value)).trim().slice(0, max);
function parse<T>(json: string, fallback: T): T { try { return JSON.parse(json) as T; } catch { return fallback; } }

export function cleanScenario(raw: unknown, index = 0): EvalScenario | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const criteria = (Array.isArray(input.criteria) ? input.criteria : []).map((c) => text(c, 400)).filter(Boolean).slice(0, 8);
  const persona = text(input.persona, 2000), opening = text(input.opening, 4000);
  if (!criteria.length || (!persona && !opening)) return null;
  const turns = Math.round(Number(input.maxTurns));
  return {
    id: text(input.id, 64) || crypto.randomUUID().slice(0, 8),
    title: text(input.title, 140) || `Scenario ${index + 1}`,
    persona, opening, criteria,
    maxTurns: Number.isFinite(turns) ? Math.min(12, Math.max(1, turns)) : 6,
  };
}

export function cleanTool(raw: unknown): EvalTool | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const name = text(input.name, 64).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!name) return null;
  const parameters = input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters) ? input.parameters as Record<string, unknown> : undefined;
  return { name, description: text(input.description, 1000), ...(parameters ? { parameters } : {}), returns: text(typeof input.returns === "string" ? input.returns : JSON.stringify(input.returns ?? "ok"), 4000) || "ok" };
}

export const scenariosOf = (suite: Pick<Suite, "scenarios">) => parse<EvalScenario[]>(suite.scenarios, []);
export const toolsOf = (suite: Pick<Suite, "tools">) => parse<EvalTool[]>(suite.tools, []);
export const modelsOf = (run: Pick<Run, "models">) => parse<RunModel[]>(run.models, []);

export interface SuiteInput { name?: unknown; description?: unknown; agentPrompt?: unknown; tools?: unknown; scenarios?: unknown }

/** Create a suite, or change the given parts of an existing one. */
export async function saveSuite(owner: { userId: string; projectId: string }, input: SuiteInput, suiteId?: string): Promise<Suite> {
  const existing = suiteId ? await getSuite(suiteId) : null;
  if (suiteId && (!existing || existing.projectId !== owner.projectId)) throw new EvalError("No eval suite with that id in this project.");
  const scenarios = input.scenarios === undefined ? undefined : (Array.isArray(input.scenarios) ? input.scenarios : []).map(cleanScenario).filter((s): s is EvalScenario => !!s).slice(0, MAX_SCENARIOS);
  if (scenarios && !scenarios.length) throw new EvalError("An eval suite needs at least one scenario with a persona or opening message and at least one criterion.");
  if (scenarios) {
    const seen = new Set<string>();
    for (const scenario of scenarios) { while (seen.has(scenario.id)) scenario.id = crypto.randomUUID().slice(0, 8); seen.add(scenario.id); }
  }
  const tools = input.tools === undefined ? undefined : (Array.isArray(input.tools) ? input.tools : []).map(cleanTool).filter((t): t is EvalTool => !!t).slice(0, 20);
  const agentPrompt = input.agentPrompt === undefined ? undefined : text(input.agentPrompt, 60000);
  if (!existing) {
    if (!agentPrompt) throw new EvalError("Give the instructions (system prompt) of the agent being tested.");
    if (!scenarios) throw new EvalError("Give at least one scenario.");
    const [row] = await db.insert(evalSuites).values({
      userId: owner.userId, projectId: owner.projectId, name: text(input.name, 120) || "Untitled evals", description: text(input.description, 600),
      agentPrompt, tools: JSON.stringify(tools ?? []), scenarios: JSON.stringify(scenarios),
    }).returning();
    return row!;
  }
  if (agentPrompt === "") throw new EvalError("The agent's instructions can't be empty.");
  await db.update(evalSuites).set({
    ...(input.name !== undefined ? { name: text(input.name, 120) || existing.name } : {}),
    ...(input.description !== undefined ? { description: text(input.description, 600) } : {}),
    ...(agentPrompt ? { agentPrompt } : {}),
    ...(tools ? { tools: JSON.stringify(tools) } : {}),
    ...(scenarios ? { scenarios: JSON.stringify(scenarios) } : {}),
    updatedAt: new Date(),
  }).where(eq(evalSuites.id, existing.id));
  return (await getSuite(existing.id))!;
}

export const getSuite = async (id: string): Promise<Suite | null> =>
  (await db.select().from(evalSuites).where(eq(evalSuites.id, id)).limit(1))[0] ?? null;

export const deleteSuite = async (id: string) => { await db.delete(evalSuites).where(eq(evalSuites.id, id)); };

/** Runs a server process is working on right now. A run marked running that is not here was cut off by a restart. */
export const liveRuns = new Set<string>();

async function settle(run: Run): Promise<Run> {
  if (run.status !== "running" || liveRuns.has(run.id)) return run;
  const finishedAt = new Date();
  await db.update(evalRuns).set({ status: "stopped", finishedAt }).where(eq(evalRuns.id, run.id));
  const open = (await db.select({ id: evalResults.id, status: evalResults.status }).from(evalResults).where(eq(evalResults.runId, run.id))).filter((r) => r.status === "pending" || r.status === "running");
  if (open.length) await db.update(evalResults).set({ status: "stopped" }).where(inArray(evalResults.id, open.map((r) => r.id)));
  return { ...run, status: "stopped", finishedAt };
}

/** Start a run: one pending result per scenario and model. */
export async function createRun(suite: Suite, models: RunModel[], judgeModel: string, userId: string): Promise<Run> {
  const scenarios = scenariosOf(suite);
  const [run] = await db.insert(evalRuns).values({ suiteId: suite.id, userId, models: JSON.stringify(models), judgeModel }).returning();
  await db.insert(evalResults).values(scenarios.flatMap((scenario) => models.map((model) => ({ runId: run!.id, scenarioId: scenario.id, scenario: JSON.stringify(scenario), modelKey: model.key }))));
  return run!;
}

export const getRun = async (id: string): Promise<Run | null> => {
  const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1);
  return run ? settle(run) : null;
};
export const listRuns = async (suiteId: string, limit = 20): Promise<Run[]> =>
  Promise.all((await db.select().from(evalRuns).where(eq(evalRuns.suiteId, suiteId)).orderBy(desc(evalRuns.createdAt), desc(evalRuns.id)).limit(limit)).map(settle));
export const resultsOf = (runId: string): Promise<Result[]> => db.select().from(evalResults).where(eq(evalResults.runId, runId));
export const getResult = async (id: string): Promise<Result | null> =>
  (await db.select().from(evalResults).where(eq(evalResults.id, id)).limit(1))[0] ?? null;
export const updateResult = async (id: string, values: Partial<typeof evalResults.$inferInsert>) => { await db.update(evalResults).set(values).where(eq(evalResults.id, id)); };
export const finishRun = async (id: string, status: "done" | "stopped") => { await db.update(evalRuns).set({ status, finishedAt: new Date() }).where(eq(evalRuns.id, id)); };

export interface ModelSummary extends RunModel { passed: number; failed: number; errors: number; done: number; total: number; passRate: number | null; avgScore: number | null; avgLatencyMs: number | null; inputTokens: number; outputTokens: number }

/** How each model did across the run's scenarios. Rates count graded scenarios only, so an outage is not a failed eval. */
export function summarize(run: Run, results: Result[]): ModelSummary[] {
  return modelsOf(run).map((model) => {
    const mine = results.filter((r) => r.modelKey === model.key);
    const graded = mine.filter((r) => r.status === "passed" || r.status === "failed");
    const passed = graded.filter((r) => r.status === "passed").length;
    const average = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
    return {
      ...model, passed, failed: graded.length - passed, errors: mine.filter((r) => r.status === "error").length,
      done: mine.filter((r) => r.status !== "pending" && r.status !== "running").length, total: mine.length,
      passRate: graded.length ? Math.round((100 * passed) / graded.length) : null,
      avgScore: average(graded.map((r) => r.score ?? 0)), avgLatencyMs: average(graded.filter((r) => r.latencyMs > 0).map((r) => r.latencyMs)),
      inputTokens: mine.reduce((sum, r) => sum + r.inputTokens, 0), outputTokens: mine.reduce((sum, r) => sum + r.outputTokens, 0),
    };
  });
}

/** A run as the results table needs it: the grid without transcripts, and each model's totals. */
export async function runView(run: Run) {
  const results = await resultsOf(run.id);
  const scenarios: Array<{ id: string; title: string }> = [];
  for (const result of results) {
    if (!scenarios.some((s) => s.id === result.scenarioId)) scenarios.push({ id: result.scenarioId, title: parse<Partial<EvalScenario>>(result.scenario, {}).title || "Scenario" });
  }
  return {
    id: run.id, suiteId: run.suiteId, status: run.status, judgeModel: run.judgeModel, createdAt: run.createdAt, finishedAt: run.finishedAt,
    models: summarize(run, results), scenarios,
    cells: results.map((r) => ({ id: r.id, scenarioId: r.scenarioId, modelKey: r.modelKey, status: r.status as ResultStatus, score: r.score, turns: r.turns, latencyMs: r.latencyMs, error: r.error, summary: parse<Partial<Verdict>>(r.verdict, {}).summary ?? "" })),
  };
}

export function resultView(result: Result) {
  return {
    id: result.id, runId: result.runId, modelKey: result.modelKey, status: result.status as ResultStatus, score: result.score, error: result.error,
    turns: result.turns, latencyMs: result.latencyMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    scenario: parse<Partial<EvalScenario>>(result.scenario, {}), transcript: parse<TranscriptEntry[]>(result.transcript, []), verdict: parse<Partial<Verdict>>(result.verdict, {}),
  };
}

/** A project's suites, newest first, each with how its latest run went. */
export async function listSuites(projectId: string) {
  const suites = await db.select().from(evalSuites).where(eq(evalSuites.projectId, projectId)).orderBy(desc(evalSuites.updatedAt));
  return Promise.all(suites.map(async (suite) => {
    const [latest] = await listRuns(suite.id, 1);
    return {
      id: suite.id, name: suite.name, description: suite.description, scenarioCount: scenariosOf(suite).length, updatedAt: suite.updatedAt,
      lastRun: latest ? { id: latest.id, status: latest.status, createdAt: latest.createdAt, models: summarize(latest, await resultsOf(latest.id)).map((m) => ({ key: m.key, label: m.label, passed: m.passed, total: m.total, passRate: m.passRate })) } : null,
    };
  }));
}
