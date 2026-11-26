// Build runs start every ticket whose prerequisites are built, up to a limit, on the person's
// computer; a ticket finishing while a sibling has failed doesn't resume the paused run.
import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "lfg-bq-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "build-queue-test-secret-not-real";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();

const { db } = await import("../src/config/db.ts");
const { users, profiles } = await import("../src/db/schema/users.ts");
const { projects } = await import("../src/db/schema/projects.ts");
const { projectTickets } = await import("../src/db/schema/tickets.ts");
const { agentRuns, ticketExecutions } = await import("../src/db/schema/orchestrator.ts");
const bq = await import("../src/services/build-queue.ts");

const status = async (runId: string) => Object.fromEntries((await db.select().from(ticketExecutions).where(eq(ticketExecutions.agentRunId, runId))).map(e => [e.title.split(" ")[0], e.status]));
const finish = (key: string, ok = true) => bq.onTicketFinished(`${proj}-${key}`, ok ? "complete" : "failed");
let proj = "";

async function project(name: string, runOn: "computer" | "cloud", deps: Record<string, string[]>) {
  proj = name;
  await db.insert(projects).values({ id: name, projectId: `pub-${name}`, name, ownerId: "alice", repoUrl: "https://github.com/acme/app", runOn });
  for (const [key, on] of Object.entries(deps)) {
    await db.insert(projectTickets).values({ id: `${name}-${key}`, projectId: name, ticketKey: key, name: key, description: "", acceptanceCriteria: [], dependencies: on.map(d => `${name}-${d}`) });
  }
  return (await bq.createBuildRun({ projectId: name, userId: "alice", conversationId: null, ticketIds: Object.keys(deps).map(k => `${name}-${k}`), afterBuild: "none" as never })).runId;
}

beforeAll(async () => {
  await db.insert(users).values({ id: "alice", name: "alice", email: "alice@example.com" });
  await db.insert(profiles).values({ userId: "alice", desktopBuildsEnabled: true } as never);
});

test("tickets that don't need each other build side by side on the computer", async () => {
  // A first; B and C after A; D after B and C.
  const run = await project("p1", "computer", { A: [], B: ["A"], C: ["A"], D: ["B", "C"] });
  expect(await status(run)).toEqual({ A: "queued", B: "pending", C: "pending", D: "pending" });
  await finish("A");
  expect(await status(run)).toMatchObject({ A: "done", B: "queued", C: "queued", D: "pending" });
  await finish("B");
  expect((await status(run)).D).toBe("pending"); // still waiting on C
  await finish("C");
  expect((await status(run)).D).toBe("queued");
});

test("at most three at once", async () => {
  const run = await project("p2", "computer", { A: [], B: [], C: [], D: [], E: [], F: ["A"] });
  const s = await status(run);
  expect(Object.values(s).filter(v => v === "queued")).toHaveLength(3);
  await finish(Object.keys(s).find(k => s[k] === "queued")!);
  expect(Object.values(await status(run)).filter(v => v === "queued")).toHaveLength(3);
});

test("cloud builds stay one at a time", async () => {
  const run = await project("p3", "cloud", { A: [], B: [], C: [] });
  expect(Object.values(await status(run)).filter(v => v === "queued")).toHaveLength(1);
});

test("a sibling finishing doesn't resume a run another ticket paused", async () => {
  const run = await project("p4", "computer", { A: [], B: [], C: ["A", "B"] });
  await finish("A", false);
  expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run)))[0]!.status).toBe("blocked");
  await finish("B");
  expect((await db.select().from(agentRuns).where(eq(agentRuns.id, run)))[0]!.status).toBe("blocked");
  expect((await status(run)).C).toBe("pending");
});

test("when no ticket names a prerequisite, the run keeps its saved order", async () => {
  const run = await project("p5", "computer", { A: [], B: [], C: [] });
  expect(await status(run)).toEqual({ A: "queued", B: "pending", C: "pending" });
  await finish("A");
  expect(await status(run)).toEqual({ A: "done", B: "queued", C: "pending" });
});

test("a server restart leaves tickets building on a computer alone, so the run doesn't send them out twice", async () => {
  const runId = await project("restart", "computer", { R1: [], R2: [] });
  await db.update(projectTickets).set({ status: "in_progress", queueStatus: "executing" }).where(eq(projectTickets.projectId, "restart"));
  const { runnerJobs } = await import("../src/db/schema/runners.ts");
  await db.insert(runnerJobs).values({ id: "job-r1", userId: "alice", projectId: "restart", ticketId: "restart-R1", type: "claude_task", payload: "{}", status: "running" });
  const { resetStuckTickets } = await import("../src/workers/ticket-executor.ts");
  await resetStuckTickets();
  const q = Object.fromEntries((await db.select().from(projectTickets).where(eq(projectTickets.projectId, "restart"))).map(t => [t.ticketKey, t.queueStatus]));
  expect(q).toEqual({ R1: "executing", R2: "none" });
  expect(runId).toBeTruthy();
});
