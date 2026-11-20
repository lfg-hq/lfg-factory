// Each ticket picks where it builds: Claude Code / Codex / Copilot on the person's computer, or the LFG cloud.
import { test, expect, beforeAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lfg-build-with-"));
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
const { projects } = await import("../src/db/schema/projects.ts");
const { projectTickets } = await import("../src/db/schema/tickets.ts");
const { default: ticketsApi } = await import("../src/routes/api/tickets.ts");
const { resolveBuildTarget } = await import("../src/services/runner/build-target.ts");
const { setLocalAiSettings } = await import("../src/services/runner/opt-in.ts");

const app = new Hono();
app.route("/api/projects", ticketsApi);
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json", "x-test-user": "ana" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  await db.insert(users).values({ id: "ana", name: "ana", email: "ana@example.com" });
  await db.insert(profiles).values({ userId: "ana" });
  await db.insert(projects).values({ id: "p", projectId: "pub-p", name: "App", ownerId: "ana", repoUrl: "https://github.com/acme/app" });
  await db.insert(projectTickets).values({ id: "t", projectId: "p", ticketKey: "APP-1", name: "Add login", description: "Users can log in." });
});

test("with Use my computer off, builds go to the cloud, even if the ticket asks for the computer", async () => {
  expect(await resolveBuildTarget("ana", null)).toEqual({ where: "cloud" });
  const t = await resolveBuildTarget("ana", { buildWith: "claude" });
  expect(t.where).toBe("cloud");
  expect((t as { reason?: string }).reason).toContain("Use my computer for AI is off");
  expect(await resolveBuildTarget(null, null)).toEqual({ where: "cloud" });
});

test("with it on, builds use the person's agent unless the ticket picks another, or the cloud", async () => {
  await setLocalAiSettings("ana", { enabled: true, agent: "claude" });
  expect(await resolveBuildTarget("ana", null)).toEqual({ where: "computer", agent: "claude" });
  expect(await resolveBuildTarget("ana", { buildWith: "codex" })).toEqual({ where: "computer", agent: "codex" });
  expect(await resolveBuildTarget("ana", { buildWith: "cloud" })).toEqual({ where: "cloud" });
});

test("the ticket's choice is saved, shown, and cleared back to the default", async () => {
  let view = (await (await call("GET", "/api/projects/pub-p/tickets/t")).json()).ticket;
  expect(view).toMatchObject({ buildWith: null, buildDefault: "claude", computerEnabled: true });
  expect((await call("POST", "/api/projects/pub-p/tickets/t/build-with", { buildWith: "gemini" })).status).toBe(400);
  expect(await (await call("POST", "/api/projects/pub-p/tickets/t/build-with", { buildWith: "cloud" })).json()).toMatchObject({ buildWith: "cloud" });
  view = (await (await call("GET", "/api/projects/pub-p/tickets/t")).json()).ticket;
  expect(view.buildWith).toBe("cloud");
  expect(await (await call("POST", "/api/projects/pub-p/tickets/t/build-with", { buildWith: "default" })).json()).toMatchObject({ buildWith: null, buildDefault: "claude" });
});
