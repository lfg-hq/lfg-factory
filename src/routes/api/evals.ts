/**
 * Evals API: a project's eval suites, running them against models, and reading the results.
 */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess, type ProjectAccess } from "../../auth/project-access.ts";
import {
  EvalError, deleteSuite, getResult, getRun, getSuite, listRuns, listSuites, resultView, runView, scenariosOf, toolsOf, type Suite,
} from "../../services/evals/store.ts";
import { runFinished, startRun, stopRun } from "../../services/evals/runner.ts";
import { evalModelOptions, modelResolver } from "../../services/evals/models.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const evalsApi = new Hono<AuthEnv>();
evalsApi.use("*", requireAuth);

/** A run spends the project's model credit, like a chat turn does. */
export const canRunEvals = (access: ProjectAccess) => access.role === "owner" || access.permissions.canChat;
export const canEditEvals = (access: ProjectAccess) => access.role === "owner" || access.permissions.canEditFiles;

async function openSuite(suiteId: string, userId: string): Promise<{ suite: Suite; access: ProjectAccess } | null> {
  const suite = await getSuite(suiteId);
  if (!suite) return null;
  const access = await getProjectAccess(suite.projectId, userId);
  return access ? { suite, access } : null;
}
async function openRun(runId: string, userId: string) {
  const run = await getRun(runId);
  const found = run ? await openSuite(run.suiteId, userId) : null;
  return run && found ? { run, ...found } : null;
}

/**
 * Start a run of a suite for a person: checks the models against what they may use.
 * Shared by the Run button and the chat agent's tool. With no models named, the chat's model is used.
 */
export async function startSuiteRun(suite: Suite, access: ProjectAccess, userId: string, wanted?: string[]) {
  if (!canRunEvals(access)) throw new EvalError("You can view evals in this project, but not run them.");
  const options = await evalModelOptions(userId, suite.projectId);
  if (!options.models.length) throw new EvalError("No models are available to run evals. Add an API key in Settings → LLM Keys, or connect your ChatGPT subscription.");
  const find = (name: string) => options.models.find((m) => m.key === name) ?? options.models.find((m) => m.label.toLowerCase() === name.toLowerCase());
  const names = (wanted ?? []).map((name) => String(name).trim()).filter(Boolean);
  const unknown = names.filter((name) => !find(name));
  if (unknown.length) throw new EvalError(`Not available here: ${unknown.join(", ")}. Available models: ${options.models.map((m) => `${m.label} (${m.key})`).join(", ")}.`);
  const judge = options.models.find((m) => m.key === options.selected)!;
  const models = names.length ? names.map((name) => find(name)!) : [judge];
  return startRun({ suite, models: models.map((m) => ({ key: m.key, label: m.label })), judge: { key: judge.key, label: judge.label }, userId, resolve: modelResolver(userId, access.project) });
}

evalsApi.get("/", async (c) => {
  const user = c.get("user");
  const access = await getProjectAccess(c.req.query("projectId") ?? "", user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const run = canRunEvals(access);
  return c.json({
    suites: await listSuites(access.project.projectId), canRun: run, canEdit: canEditEvals(access),
    ...(run ? await evalModelOptions(user.id, access.project.projectId) : { models: [], selected: null }),
  });
});

// One suite: what it tests, its recent runs, and the latest run's results table.
evalsApi.get("/:id", async (c) => {
  const user = c.get("user");
  const found = await openSuite(c.req.param("id"), user.id);
  if (!found) return c.json({ error: "Eval suite not found" }, 404);
  const { suite, access } = found;
  const runs = await listRuns(suite.id, 12);
  const wanted = c.req.query("run");
  const shown = runs.find((r) => r.id === wanted) ?? runs[0];
  const run = canRunEvals(access);
  return c.json({
    suite: { id: suite.id, name: suite.name, description: suite.description, agentPrompt: suite.agentPrompt, tools: toolsOf(suite), scenarios: scenariosOf(suite), updatedAt: suite.updatedAt },
    runs: runs.map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt })),
    run: shown ? await runView(shown) : null,
    canRun: run, canEdit: canEditEvals(access),
    ...(run ? await evalModelOptions(user.id, suite.projectId) : { models: [], selected: null }),
  });
});

evalsApi.delete("/:id", async (c) => {
  const found = await openSuite(c.req.param("id"), c.get("user").id);
  if (!found) return c.json({ error: "Eval suite not found" }, 404);
  if (!canEditEvals(found.access)) return c.json({ error: "You can't delete evals in this project." }, 403);
  for (const run of await listRuns(found.suite.id, 50)) { if (stopRun(run.id)) await runFinished(run.id); }
  await deleteSuite(found.suite.id);
  return c.json({ ok: true });
});

evalsApi.post("/:id/runs", async (c) => {
  const user = c.get("user");
  const found = await openSuite(c.req.param("id"), user.id);
  if (!found) return c.json({ error: "Eval suite not found" }, 404);
  if (!canRunEvals(found.access)) return c.json({ error: "You can view evals in this project, but not run them." }, 403);
  if ((await listRuns(found.suite.id, 5)).some((r) => r.status === "running")) return c.json({ error: "These evals are already running." }, 409);
  const body = await c.req.json<{ models?: unknown }>().catch(() => ({}) as Record<string, never>);
  const models = (Array.isArray(body.models) ? body.models : []).filter((m): m is string => typeof m === "string").slice(0, 12);
  try {
    const run = await startSuiteRun(found.suite, found.access, user.id, models);
    return c.json({ run: await runView(run) });
  } catch (error) {
    if (error instanceof EvalError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

evalsApi.get("/runs/:runId", async (c) => {
  const found = await openRun(c.req.param("runId"), c.get("user").id);
  if (!found) return c.json({ error: "Run not found" }, 404);
  return c.json({ run: await runView(found.run) });
});

evalsApi.post("/runs/:runId/stop", async (c) => {
  const found = await openRun(c.req.param("runId"), c.get("user").id);
  if (!found) return c.json({ error: "Run not found" }, 404);
  if (!canRunEvals(found.access)) return c.json({ error: "You can't stop runs in this project." }, 403);
  if (stopRun(found.run.id)) await runFinished(found.run.id);
  return c.json({ run: await runView((await getRun(found.run.id))!) });
});

// One scenario on one model: the transcript and the verdict on each criterion.
evalsApi.get("/results/:resultId", async (c) => {
  const result = await getResult(c.req.param("resultId"));
  const found = result ? await openRun(result.runId, c.get("user").id) : null;
  if (!result || !found) return c.json({ error: "Result not found" }, 404);
  const view = resultView(result);
  return c.json({ result: { ...view, modelLabel: (await runView(found.run)).models.find((m) => m.key === view.modelKey)?.label ?? view.modelKey } });
});

export default evalsApi;
