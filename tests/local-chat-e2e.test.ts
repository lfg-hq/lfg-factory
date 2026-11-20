// A chat turn answered on the person's computer, end to end: server → WebSocket → desktop
// runner → agent (a stand-in for Claude Code) → LFG's MCP endpoint → DB, and the agent's
// events back as the AI SDK stream events the chat handler consumes.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lfg-local-chat-"));
// The agent calls LFG back at the app's public address: make that this test server.
const PORT = 19000 + Math.floor(Math.random() * 900);
process.env.APP_URL = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "local-chat-test-secret-only-not-a-real-one";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();

const { Hono } = await import("hono");
const { db } = await import("../src/config/db.ts");
const { users } = await import("../src/db/schema/users.ts");
const { organizations } = await import("../src/db/schema/organizations.ts");
const { projects } = await import("../src/db/schema/projects.ts");
const { projectTickets } = await import("../src/db/schema/tickets.ts");
const { conversations } = await import("../src/db/schema/chat.ts");
const hub = await import("../src/services/runner/hub.ts");
const { default: mcpServer } = await import("../src/routes/mcp-server.ts");
const { startLocalChatTurn } = await import("../src/services/runner/chat-turn.ts");
const { Runner } = await import("../desktop/src/runner.ts");
type RunnerConn = import("../src/services/runner/hub.ts").RunnerConn;

// The stand-in for Claude Code: uses LFG's tools over the MCP config it was given.
const fakeClaude = join(root, "claude");
writeFileSync(fakeClaude, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.9.9 (Claude Code)"); process.exit(0); }
const arg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const say = (o) => console.log(JSON.stringify(o));
require("node:fs").appendFileSync(${JSON.stringify(join(root, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
const lfg = JSON.parse(arg("--mcp-config")).mcpServers.lfg;
const rpc = async (method, params, id = 1) => (await (await fetch(lfg.url, { method: "POST", headers: { ...lfg.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json());
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } });
const resumed = arg("--resume");
say({ type: "system", subtype: "init", session_id: resumed ?? "sess-1" });
say({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1794865800, status: "allowed" }, seven_day: { utilization: 0.17, resetsAt: 1795312800, status: "allowed" } } } });
if (resumed) say({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 160000 } });
say({ type: "assistant", message: { content: [{ type: "text", text: resumed ? "Continuing session " + resumed + "." : "I'll create the ticket." }] } });
if (!resumed) {
  const input = { tickets: [{ name: "Add login", description: "Users can log in with email.", acceptanceCriteria: ["Email is validated", "Wrong password shows an error"] }] };
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__lfg__createTickets", input }] } });
  const result = await rpc("tools/call", { name: "createTickets", arguments: input }, 2);
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: result.result.content }] } });
}
const system = arg("--system-prompt") ?? arg("--append-system-prompt") ?? "";
say({ type: "assistant", message: { content: [{ type: "text", text: system.includes("You are LFG's planner") ? "Instructions received." : "No instructions!" }] } });
say({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 990, output_tokens: 20 } });
`);
chmodSync(fakeClaude, 0o755);

type Data = { deviceId: string; deviceName: string; userId: string; conn?: RunnerConn };
let server: ReturnType<typeof Bun.serve<Data, never>>;
const app = new Hono();
app.route("/", mcpServer);
const conn = (ws: import("bun").ServerWebSocket<Data>) => ws.data.conn ??= {
  deviceId: ws.data.deviceId, deviceName: ws.data.deviceName, userId: ws.data.userId,
  send: m => ws.send(JSON.stringify(m)), close: (c, r) => ws.close(c, r),
};
let runner: InstanceType<typeof Runner>;

beforeAll(async () => {
  await db.insert(users).values({ id: "ana", name: "Ana", email: "ana@example.com" });
  await db.insert(organizations).values({ id: "team", name: "Team", slug: "team", ownerId: "ana" });
  await db.insert(projects).values({ id: "p", projectId: "pub-p", name: "App", ownerId: "ana", organizationId: "team" });
  await db.insert(conversations).values({ id: "c1", userId: "ana", projectId: "pub-p", title: "Planning" });
  const { token } = await hub.createRunnerDevice("ana", "Ana's Mac");
  server = Bun.serve<Data, never>({
    port: PORT, hostname: "127.0.0.1",
    async fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws/runner") {
        const device = await hub.authenticateRunnerToken(req.headers.get("authorization")?.replace(/^Bearer\s+/i, ""));
        if (!device) return new Response("Unauthorized", { status: 401 });
        return srv.upgrade(req, { data: { deviceId: device.id, deviceName: device.name, userId: device.userId } }) ? undefined as unknown as Response : new Response("no", { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: {
      open: ws => { void hub.runnerOpened(conn(ws)); },
      close: ws => hub.runnerClosed(conn(ws)),
      message: (ws, data) => { void hub.runnerMessage(conn(ws), data as string); },
    },
  });
  const states: string[] = [];
  runner = new Runner({
    serverUrl: `http://127.0.0.1:${PORT}`, token, workRoot: join(root, "work"),
    createSocket: (url, headers) => new WebSocket(url, { headers } as any) as any,
    agentBins: { claude: fakeClaude, codex: join(root, "none"), copilot: join(root, "none") },
    approve: async () => ({ approved: false, reason: "builds aren't part of this test" }),
    onState: s => states.push(s),
  });
  runner.start();
  for (let i = 0; i < 100 && !states.includes("connected"); i++) await Bun.sleep(20);
  for (let i = 0; i < 100 && !hub.userHasConnectedRunner("ana"); i++) await Bun.sleep(20);
});
afterAll(() => { runner?.stop(); server?.stop(true); });

const calls = () => readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as string[]);
const argOf = (args: string[], flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

async function turn(message: string, extra: Partial<Parameters<typeof startLocalChatTurn>[0]> = {}) {
  const statuses: string[] = [];
  const stream = await startLocalChatTurn({
    ...extra,
    userId: "ana", conversationId: "c1", projectId: "p", agent: "claude",
    instructions: "You are LFG's planner.", userMessage: message,
    history: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }, { role: "user", content: message }],
    signal: new AbortController().signal, onStatus: s => statuses.push(s),
    serverUrl: `http://127.0.0.1:${PORT}`,
    ...extra,
  } as Parameters<typeof startLocalChatTurn>[0]);
  const events: any[] = [];
  for await (const e of stream.fullStream) events.push(e);
  await stream.response;
  return { events, statuses };
}

test("the agent on the computer answers, and what it creates is saved in LFG", async () => {
  const { events, statuses } = await turn("Plan the login feature");
  expect(events.find(e => e.type === "error")).toBeUndefined();
  const texts = events.filter(e => e.type === "text-delta").map(e => e.text);
  expect(texts).toEqual(["I'll create the ticket.", "Instructions received."]);
  const call = events.find(e => e.type === "tool-call");
  expect(call).toMatchObject({ toolName: "createTickets", toolCallId: "tu1" });
  const result = events.find(e => e.type === "tool-result");
  expect(result.toolName).toBe("createTickets");
  expect(typeof result.output).toBe("object"); // JSON from the tool, parsed back
  expect(statuses.some(s => /^Claude Code is working/.test(s))).toBe(true);
  const tickets = await db.select().from(projectTickets);
  expect(tickets.map(t => [t.projectId, t.name])).toEqual([["p", "Add login"]]);
});

test("LFG's prompt is the agent's whole system prompt, not an addition to Claude Code's", () => {
  const first = calls()[0]!;
  expect(argOf(first, "--system-prompt")).toContain("You are LFG's planner.");
  expect(first).not.toContain("--append-system-prompt");
  expect(first).not.toContain("--model"); // no choice made: the computer's own default
});

test("the next turn continues the agent's session, and its compaction reaches the chat", async () => {
  let compacted: unknown;
  const { events } = await turn("Now add signup", { onCompacted: info => { compacted = info; } });
  const texts = events.filter(e => e.type === "text-delta").map(e => e.text);
  expect(texts[0]).toBe("Continuing session sess-1.");
  expect(compacted).toEqual({ trigger: "auto", preTokens: 160000 });
});

test("the chosen model and effort, and this turn's context, reach the agent", async () => {
  await db.insert(conversations).values({ id: "c4", userId: "ana", projectId: "pub-p", title: "x" });
  await turn("Review LFG-12", { conversationId: "c4", model: "sonnet", effort: "high", turnContext: "<turn-context>@LFG-12: Add login</turn-context>" });
  const args = calls().at(-1)!;
  expect(argOf(args, "--model")).toBe("sonnet");
  expect(argOf(args, "--effort")).toBe("high");
  expect(argOf(args, "-p")).toContain("Review LFG-12");
  expect(argOf(args, "-p")).toContain("@LFG-12: Add login");
});

test("the plan usage the agent reports is kept for the person", async () => {
  const { localAgentUsage } = await import("../src/services/runner/opt-in.ts");
  for (let i = 0; i < 50 && !(await localAgentUsage("ana"))?.lastTurn; i++) await Bun.sleep(20);
  const usage = await localAgentUsage("ana");
  expect(usage?.agent).toBe("claude");
  expect(usage?.windows.map(w => [w.kind, w.utilization])).toEqual([["five_hour", 0.08], ["seven_day", 0.17]]);
  expect(usage?.lastTurn).toMatchObject({ inputTokens: 1000, outputTokens: 20, costUsd: 0.01 });
});

test("a fresh session starts from LFG's summary of older turns plus the latest messages", async () => {
  const { transcript } = await import("../src/services/runner/chat-turn.ts");
  const history = [
    { role: "assistant", content: "Conversation handoff — historical evidence.\nDecided: email login, no SSO." },
    ...Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} ` + "x".repeat(300) })),
  ];
  const text = transcript(history, 8000);
  expect(text).toContain("Decided: email login, no SSO.");
  expect(text).toContain("message 199");
  expect(text).not.toContain("message 0 ");
  expect(text.length).toBeLessThan(8200);
});

test("stopping a turn cancels it on the computer", async () => {
  const controller = new AbortController();
  const stream = await startLocalChatTurn({
    userId: "ana", conversationId: "c2", projectId: "p", agent: "codex",
    instructions: "x", userMessage: "hi", history: [], signal: controller.signal, onStatus: () => {},
    serverUrl: `http://127.0.0.1:${PORT}`,
  });
  controller.abort();
  const events: any[] = [];
  for await (const e of stream.fullStream) events.push(e);
  expect(events.filter(e => e.type === "text-delta")).toHaveLength(0);
});

test("an agent that isn't installed is reported plainly", async () => {
  await db.insert(conversations).values({ id: "c3", userId: "ana", projectId: "pub-p", title: "x" });
  const stream = await startLocalChatTurn({
    userId: "ana", conversationId: "c3", projectId: "p", agent: "copilot",
    instructions: "x", userMessage: "hi", history: [], signal: new AbortController().signal, onStatus: () => {},
    serverUrl: `http://127.0.0.1:${PORT}`,
  });
  const events: any[] = [];
  for await (const e of stream.fullStream) events.push(e);
  expect(String(events.find(e => e.type === "error")?.error?.message)).toContain("GitHub Copilot isn't installed");
});

test("through the real chat handler: the reply streams to the browser and is saved", async () => {
  const { profiles } = await import("../src/db/schema/users.ts");
  const { messages } = await import("../src/db/schema/chat.ts");
  const { eq } = await import("drizzle-orm");
  const { handleStream } = await import("../src/ai/stream-handler.ts");
  await db.insert(profiles).values({ userId: "ana", desktopBuildsEnabled: true, localAgent: "claude" })
    .onConflictDoUpdate({ target: profiles.userId, set: { desktopBuildsEnabled: true, localAgent: "claude" } });
  const frames: any[] = [];
  const ws = { send: (s: string) => frames.push(JSON.parse(s)), data: { userId: "ana", sessionId: "s" }, readyState: 1 } as any;
  const { conversationId } = await handleStream({ ws, userId: "ana", userMessage: "Plan the logout feature", projectId: "pub-p", abortController: new AbortController() }) as { conversationId: string };

  const saved = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
  const reply = saved.find(m => m.role === "assistant");
  expect(reply?.content).toContain("I'll create the ticket.");
  expect(reply?.isPartial).toBe(false);
  const streamed = frames.filter(f => f.type === "ai_chunk" && f.chunk).map(f => f.chunk).join("");
  expect(streamed).toContain("I'll create the ticket.");
  expect(frames.some(f => f.type === "ai_chunk" && f.is_final)).toBe(true);
  expect(frames.some(f => f.notification_type === "createTickets" || f.function_name === "createTickets")).toBe(true);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  expect(conv?.title).toBe("Plan the logout feature");
});
