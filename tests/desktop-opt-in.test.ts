// "Build on my computer" is opt-in per person: off by default, switched on in Settings.
import { test, expect, beforeAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lfg-desktop-optin-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "desktop-optin-test-secret-only-not-a-real-secret";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();
const testAuth = async (c: any, next: any) => { const id = c.req.header("x-test-user") || "ana"; c.set("user", { id, name: id, email: `${id}@example.com` }); return next(); };
mock.module("../src/auth/middleware.ts", () => ({ requireAuth: testAuth, optionalAuth: testAuth }));

const { Hono } = await import("hono");
const { db } = await import("../src/config/db.ts");
const { users, profiles } = await import("../src/db/schema/users.ts");
const { organizations, orgMemberships } = await import("../src/db/schema/organizations.ts");
const { projects } = await import("../src/db/schema/projects.ts");
const { projectTickets } = await import("../src/db/schema/tickets.ts");
const { default: runnerApi } = await import("../src/routes/api/runner.ts");
const { default: ticketsApi } = await import("../src/routes/api/tickets.ts");
const { TicketsListPage } = await import("../src/templates/pages/tickets-list.tsx");

const app = new Hono();
app.route("/api/runner", runnerApi);
app.route("/api/projects", ticketsApi);
const call = (method: string, path: string, body?: unknown, user = "ana") =>
  app.request(path, { method, headers: { "content-type": "application/json", "x-test-user": user }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  for (const id of ["ana", "ben"]) await db.insert(users).values({ id, name: id, email: `${id}@example.com` });
  await db.insert(organizations).values({ id: "team", name: "Team", slug: "team", ownerId: "ana" });
  await db.insert(orgMemberships).values({ id: "m-ben", userId: "ben", organizationId: "team", role: "member" });
  await db.insert(profiles).values({ userId: "ana", currentOrganizationId: "team" });
  await db.insert(projects).values({ id: "p", projectId: "pub-p", name: "App", ownerId: "ana", organizationId: "team", repoUrl: "https://github.com/acme/app" });
  await db.insert(projectTickets).values({ id: "t", projectId: "p", ticketKey: "APP-1", name: "Add login", description: "Users can log in." });
});

test("off by default, and the server refuses local builds while it's off", async () => {
  expect(await (await call("GET", "/api/runner/settings")).json()).toMatchObject({ enabled: false, agent: "claude", agents: [] });
  const refused = await call("POST", "/api/projects/pub-p/tickets/t/run-local", {});
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toContain("Use my computer for AI is off");
});

test("turning it on lets that person build on their computer, and nobody else", async () => {
  expect(await (await call("PUT", "/api/runner/settings", { enabled: true })).json()).toMatchObject({ enabled: true });
  expect(await (await call("GET", "/api/runner/settings")).json()).toMatchObject({ enabled: true });
  expect(await (await call("GET", "/api/runner/settings", undefined, "ben")).json()).toMatchObject({ enabled: false });
  const started = await call("POST", "/api/projects/pub-p/tickets/t/run-local", {});
  expect(started.status).toBe(202);
});

test("turning it off again works, and bad input is rejected", async () => {
  expect((await call("PUT", "/api/runner/settings", { enabled: "yes" })).status).toBe(400);
  expect((await call("PUT", "/api/runner/settings", { agent: "gemini" })).status).toBe(400);
  expect((await call("PUT", "/api/runner/settings", {})).status).toBe(400);
  expect(await (await call("PUT", "/api/runner/settings", { enabled: false })).json()).toMatchObject({ enabled: false });
  // A profile row is created for someone who never had one.
  expect(await (await call("PUT", "/api/runner/settings", { enabled: true }, "ben")).json()).toMatchObject({ enabled: true });
});

test("the agent choice is saved and builds use it; computers report their agents", async () => {
  expect(await (await call("PUT", "/api/runner/settings", { agent: "codex" })).json()).toMatchObject({ agent: "codex" });
  const { runnerDevices } = await import("../src/db/schema/runners.ts");
  await db.insert(runnerDevices).values({ userId: "ana", name: "Ana's Mac", tokenHash: "h", tokenPrefix: "lfgr_x", agents: JSON.stringify([{ kind: "claude", version: "2.1.0" }, { kind: "codex", version: "0.50.0" }]) });
  const view = await (await call("GET", "/api/runner/settings")).json();
  expect(view.agents.map((a: { kind: string }) => a.kind)).toEqual(["claude", "codex"]);
  expect(view.agentChoices.map((a: { kind: string }) => a.kind)).toEqual(["claude", "codex", "copilot"]);
  const { startTicketOnRunner } = await import("../src/services/runner/ticket-job.ts");
  await db.insert(projectTickets).values({ id: "t2", projectId: "p", ticketKey: "APP-2", name: "Add signup", description: "Users can sign up." });
  const job = await startTicketOnRunner({ projectId: "p", ticketId: "t2", actorId: "ana" });
  expect(JSON.parse(job.payload).agent).toBe("codex");
});

test("when it's on, Build and ticket chat go to the person's computer", async () => {
  const { runnerJobs } = await import("../src/db/schema/runners.ts");
  const { bus } = await import("../src/events/bus.ts");
  const { startTicketWorker } = await import("../src/workers/ticket-executor.ts");
  const { eq, desc } = await import("drizzle-orm");
  await startTicketWorker();
  await call("PUT", "/api/runner/settings", { enabled: true, agent: "claude" });
  await db.insert(projectTickets).values({ id: "t3", projectId: "p", ticketKey: "APP-3", name: "Add logout", description: "Users can log out.", queueStatus: "queued" });
  const jobsFor = (ticketId: string) => db.select().from(runnerJobs).where(eq(runnerJobs.ticketId, ticketId)).orderBy(desc(runnerJobs.createdAt));
  const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100 && !(await fn()); i++) await Bun.sleep(20); };

  // The Build button / chat tools / build runs all emit ticket.queued.
  bus.emit({ type: "ticket.queued", payload: { ticketId: "t3", projectId: "p", actorId: "ana" } } as never);
  await until(async () => (await jobsFor("t3")).length > 0);
  const [build] = await jobsFor("t3");
  expect(build?.agent).toBe("claude");
  expect(JSON.parse(build!.payload).prompt).toContain("Users can log out.");
  const [t3] = await db.select().from(projectTickets).where(eq(projectTickets.id, "t3"));
  expect(t3!.queueStatus).toBe("executing");

  // The build finished on the computer, which reported its agent session.
  await db.update(runnerJobs).set({ status: "succeeded", agentSession: "sess-42" }).where(eq(runnerJobs.id, build!.id));
  await db.update(projectTickets).set({ queueStatus: "none", status: "review" }).where(eq(projectTickets.id, "t3"));

  // A follow-up in the ticket chat continues that session on the computer.
  bus.emit({ type: "ticket.chat_message", payload: { ticketId: "t3", message: "Also add a confirm dialog", sender: "ana", actorId: "ana" } } as never);
  await until(async () => (await jobsFor("t3")).length > 1);
  const followUp = (await jobsFor("t3")).find(j => j.id !== build!.id);
  const payload = JSON.parse(followUp!.payload);
  expect(payload.sessionId).toBe("sess-42");
  expect(payload.prompt).toContain("Also add a confirm dialog");

  // Someone with it off still builds in the cloud: no job for their computer.
  await db.insert(projectTickets).values({ id: "t4", projectId: "p", ticketKey: "APP-4", name: "Add avatar", description: "x", queueStatus: "queued" });
  await call("PUT", "/api/runner/settings", { enabled: false });
  bus.emit({ type: "ticket.queued", payload: { ticketId: "t4", projectId: "p", actorId: "ana" } } as never);
  await Bun.sleep(300);
  expect(await jobsFor("t4")).toHaveLength(0);
});
