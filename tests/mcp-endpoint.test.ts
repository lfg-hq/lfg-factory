// The LFG MCP endpoint: an agent on someone's computer uses LFG's tools for one chat turn.
import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lfg-mcp-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "mcp-test-secret-only-not-a-real-secret-123";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();

const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { db } = await import("../src/config/db.ts");
const { users } = await import("../src/db/schema/users.ts");
const { organizations } = await import("../src/db/schema/organizations.ts");
const { projects } = await import("../src/db/schema/projects.ts");
const { projectTickets } = await import("../src/db/schema/tickets.ts");
const { conversations } = await import("../src/db/schema/chat.ts");
const { default: mcpServer } = await import("../src/routes/mcp-server.ts");
const { mintTurnToken, revokeTurnToken } = await import("../src/services/runner/turn-tokens.ts");

const app = new Hono();
app.route("/", mcpServer);
const rpc = (turnId: string, token: string | null, body: unknown) => app.request(`/mcp/turn/${turnId}`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

let turn: { turnId: string; token: string };
beforeAll(async () => {
  for (const id of ["ana", "eve"]) await db.insert(users).values({ id, name: id, email: `${id}@example.com` });
  await db.insert(organizations).values({ id: "team", name: "Team", slug: "team", ownerId: "ana" });
  await db.insert(projects).values({ id: "p", projectId: "pub-p", name: "App", ownerId: "ana", organizationId: "team" });
  await db.insert(projects).values({ id: "other", projectId: "pub-other", name: "Other", ownerId: "eve" });
  await db.insert(conversations).values({ id: "c1", userId: "ana", projectId: "pub-p", title: "Planning" });
  turn = await mintTurnToken({ userId: "ana", conversationId: "c1", projectId: "p" });
});

test("handshake and tool list: LFG's tools, without the fields the server fills in", async () => {
  const init = await (await rpc(turn.turnId, turn.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } })).json();
  expect(init.result.protocolVersion).toBe("2025-06-18");
  expect(init.result.capabilities.tools).toBeDefined();
  expect((await rpc(turn.turnId, turn.token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

  const list = await (await rpc(turn.turnId, turn.token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  const names = list.result.tools.map((t: { name: string }) => t.name);
  for (const n of ["createTickets", "streamDocumentContent", "getProjectDashboard", "askUser", "loadSkill", "runInPreview", "handlePreview", "getPreviewDiagnostics"]) expect(names).toContain(n);
  const create = list.result.tools.find((t: { name: string }) => t.name === "createTickets");
  expect(Object.keys(create.inputSchema.properties)).not.toContain("projectId");
  expect(Object.keys(create.inputSchema.properties)).not.toContain("userId");
  expect(create.inputSchema.required ?? []).not.toContain("projectId");
});

test("tools/call writes to the turn's project, even if the agent names another", async () => {
  const res = await (await rpc(turn.turnId, turn.token, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "createTickets", arguments: { projectId: "other", tickets: [{ name: "Add login", description: "Users can log in with email.", acceptanceCriteria: ["Form validates email", "Wrong password shows an error"] }] } },
  })).json();
  expect(res.result.isError).toBeFalsy();
  const rows = await db.select().from(projectTickets);
  expect(rows.map(r => [r.projectId, r.name])).toEqual([["p", "Add login"]]);
});

test("bad arguments and unknown tools come back as tool errors, not crashes", async () => {
  const bad = await (await rpc(turn.turnId, turn.token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "createTickets", arguments: { tickets: "nope" } } })).json();
  expect(bad.result.isError).toBe(true);
  const unknown = await (await rpc(turn.turnId, turn.token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf", arguments: {} } })).json();
  expect(unknown.result.isError).toBe(true);
  // Strict tool schemas (the preview tools) must not get the server's fields pushed into them.
  const preview = await (await rpc(turn.turnId, turn.token, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "handlePreview", arguments: { action: "manage_data", instruction: "Reset the demo user's password" } } })).json();
  expect(preview.result.content[0].text).not.toContain("Invalid arguments");
  const method = await (await rpc(turn.turnId, turn.token, { jsonrpc: "2.0", id: 6, method: "resources/list" })).json();
  expect(method.error.code).toBe(-32601);
});

test("only the right token, for this turn, while it's valid", async () => {
  expect((await rpc(turn.turnId, null, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  expect((await rpc(turn.turnId, "wrong-token-value", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  const other = await mintTurnToken({ userId: "ana", conversationId: "c1", projectId: "p" });
  expect((await rpc(other.turnId, turn.token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  const expired = await mintTurnToken({ userId: "ana", conversationId: "c1", projectId: "p" }, -1000);
  expect((await rpc(expired.turnId, expired.token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  await revokeTurnToken(other.turnId);
  expect((await rpc(other.turnId, other.token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  // Someone who can't use the conversation gets nothing, even with a valid token.
  const stranger = await mintTurnToken({ userId: "eve", conversationId: "c1", projectId: "p" });
  expect((await rpc(stranger.turnId, stranger.token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
  expect((await app.request(`/mcp/turn/${turn.turnId}`)).status).toBe(405);
});
