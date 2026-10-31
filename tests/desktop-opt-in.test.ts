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
  expect(await (await call("GET", "/api/runner/settings")).json()).toEqual({ enabled: false });
  const refused = await call("POST", "/api/projects/pub-p/tickets/t/run-local", {});
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toContain("Settings → Integrations → Computers");
});

test("turning it on lets that person build on their computer, and nobody else", async () => {
  expect(await (await call("PUT", "/api/runner/settings", { enabled: true })).json()).toEqual({ enabled: true });
  expect(await (await call("GET", "/api/runner/settings")).json()).toEqual({ enabled: true });
  expect(await (await call("GET", "/api/runner/settings", undefined, "ben")).json()).toEqual({ enabled: false });
  const started = await call("POST", "/api/projects/pub-p/tickets/t/run-local", {});
  expect(started.status).toBe(202);
});

test("turning it off again works, and bad input is rejected", async () => {
  expect((await call("PUT", "/api/runner/settings", { enabled: "yes" })).status).toBe(400);
  expect(await (await call("PUT", "/api/runner/settings", { enabled: false })).json()).toEqual({ enabled: false });
  // A profile row is created for someone who never had one.
  expect(await (await call("PUT", "/api/runner/settings", { enabled: true }, "ben")).json()).toEqual({ enabled: true });
});

test("the ticket Run menu offers it only when it's on", async () => {
  const render = (desktopBuilds: boolean) => String(TicketsListPage({
    user: { id: "ana", name: "ana" }, project: { id: "p", projectId: "pub-p", name: "App", icon: "📋" },
    stages: [], tickets: [], desktopBuilds,
  }));
  expect(render(false)).not.toContain('value="local"');
  expect(render(true)).toContain('<option value="local">Build on my computer (LFG Desktop)</option>');
});
