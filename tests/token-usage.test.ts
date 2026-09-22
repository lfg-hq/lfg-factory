import { test, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "lfg-usage-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "usage-test-secret-only-not-a-real-secret";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();
mock.module("../src/auth/middleware.ts", () => ({ requireAuth: async (c: any, next: any) => { c.set("user", { id: c.req.header("x-test-user") ?? "alice" }); await next(); } }));
mock.module("../src/auth/project-access.ts", () => ({ getProjectAccess: async (id: string, user: string) => id === "public-project" && user !== "outsider" ? { project: { id: "project" }, role: user === "admin" ? "admin" : "member" } : null }));
const { db } = await import("../src/config/db.ts");
const { users } = await import("../src/db/schema/users.ts");
const { tokenUsage, tokenUsageDocuments, tokenUsageRuns } = await import("../src/db/schema/tokens.ts");
const { recordUsage, normalizeUsage, recordCliUsage, associateUsageDocument, associateUsageTicket } = await import("../src/services/token-usage.ts");
const { withUsage } = await import("../src/ai/usage-context.ts");
const { trackModel } = await import("../src/ai/usage-model.ts");
const { default: api } = await import("../src/routes/api/token-usage.ts");
for (const id of ["alice", "bob"]) await db.insert(users).values({ id, name: id, email: `${id}@test.invalid` });
const context = { userId: "alice", projectId: "project", ticketId: "ticket", runId: "build-1", operation: "ticket_build" };
await db.insert(tokenUsageRuns).values({ id: "build-1", ...context });

test("normalizes cache input once, reasoning as output subset, unknown is not zero", () => {
  expect(normalizeUsage({ input: 10, output: 5, cacheRead: 20, cacheWrite: 3 }, "pi")?.totalTokens).toBe(38);
  expect(normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 }, "claude")?.inputTokens).toBe(33);
  expect(normalizeUsage({ inputTokens: { total: 33, cacheRead: 20, cacheWrite: 3 }, outputTokens: { total: 5, reasoning: 2 } })?.totalTokens).toBe(38);
  expect(normalizeUsage({})).toBeNull();
});

test("replayed Pi messages deduplicate, partial updates excluded, rebuilds separate", async () => {
  const event = { type: "message_end", message: { role: "assistant", timestamp: 123, model: "lite", provider: "openai", usage: { input: 10, output: 2, cost: { total: .02 } } } };
  await recordCliUsage(context, [{ ...event, type: "message_update" }, event, event]);
  await recordCliUsage({ ...context, runId: "build-2" }, [event]);
  const rows = await db.select().from(tokenUsage).where(eq(tokenUsage.model, "lite"));
  expect(rows).toHaveLength(2);
  expect(rows.map(r => r.totalTokens)).toEqual([12, 12]);
});

test("Claude per-model totals retain separate models and subscription cost is unknown", async () => {
  const event = { type: "result", uuid: "result-1", modelUsage: { sonnet: { inputTokens: 5, outputTokens: 4, cacheReadInputTokens: 3, costUSD: 1 }, haiku: { inputTokens: 2, outputTokens: 1, costUSD: .1 } } };
  await recordCliUsage({ ...context, billingMode: "subscription" }, [event, event]);
  const rows = await db.select().from(tokenUsage).where(eq(tokenUsage.billingMode, "subscription"));
  expect(rows).toHaveLength(2);
  expect(rows.every(r => r.cost === null)).toBe(true);
  expect(rows.find(r => r.model === "sonnet")?.totalTokens).toBe(12);
});

test("concurrent SDK streams keep actors separate; finished steps survive a later failure", async () => {
  const model = trackModel({ specificationVersion: "v3", provider: "openai", modelId: "sdk-lite", supportedUrls: {},
    doGenerate: async () => { throw new Error("later request failed"); },
    doStream: async () => ({ stream: new ReadableStream({ start(c) {
      c.enqueue({ type: "tool-call", toolCallId: "doc-tool", toolName: "createDoc", input: "{}" });
      c.enqueue({ type: "finish", usage: { inputTokens: { total: 10 }, outputTokens: { total: 3 } }, finishReason: { unified: "stop", raw: "stop" } }); c.close();
    } }) }),
  } as any, { modelTier: "lite" });
  await Promise.all(["alice", "bob"].map(userId => withUsage({ userId, projectId: "project" }, async () => {
    const result = await model.doStream({ prompt: [] });
    for await (const _part of result.stream as any) { /* consume */ }
    await associateUsageDocument(`${userId}-doc`, "doc-tool");
    await associateUsageDocument(`${userId}-doc-2`, "doc-tool");
    await associateUsageTicket(`${userId}-ticket`, "doc-tool");
    await expect(model.doGenerate({ prompt: [] })).rejects.toThrow("later request failed");
  })));
  const rows = await db.select().from(tokenUsage).where(eq(tokenUsage.model, "sdk-lite"));
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map(r => r.userId)).size).toBe(2);
  for (const row of rows) {
    const docs = await db.select().from(tokenUsageDocuments).where(eq(tokenUsageDocuments.usageId, row.id));
    expect(docs.map(d => d.documentId).sort()).toEqual([`${row.userId}-doc`, `${row.userId}-doc-2`]);
    expect(row.totalTokens).toBe(13);
  }
});

test("API scopes personal/project reports, validates filters, and doesn't multiply totals by documents", async () => {
  const fetch = (query: string, user = "alice") => api.request(`http://test/?${query}`, { headers: { "x-test-user": user } });
  expect((await fetch("userId=bob")).status).toBe(403);
  expect((await fetch("projectId=public-project&userId=bob")).status).toBe(403);
  expect((await fetch("projectId=public-project", "outsider")).status).toBe(404);
  expect((await fetch("from=bad")).status).toBe(400);
  const result = await (await fetch("model=sdk-lite&groupBy=document")).json() as any;
  expect(result.total.totalTokens).toBe(13);
  expect(result.rows).toHaveLength(2);
  expect(result.rows.every((r: any) => r.totalTokens === 13)).toBe(true);
  const admin = await (await fetch("projectId=public-project&model=sdk-lite&groupBy=person", "admin")).json() as any;
  expect(admin.total.totalTokens).toBe(26);
  expect(admin.rows).toHaveLength(2);
  const builds = await (await fetch("groupBy=build")).json() as any;
  expect(builds.rows.every((r: any) => r.key === "build-1")).toBe(true);
});

test("migration upgrades old SQLite rows without losing history and can run twice", () => {
  const path = join(root, "legacy.db");
  const legacy = new Database(path);
  legacy.exec("CREATE TABLE token_usage (id text PRIMARY KEY, request_id text, total_tokens integer); INSERT INTO token_usage VALUES ('old', null, 42)");
  legacy.close();
  for (let i = 0; i < 2; i++) {
    const result = Bun.spawnSync(["bun", "scripts/migrate-token-usage.ts"], { env: { ...process.env, DATABASE_URL: path, DATABASE_DRIVER: "sqlite" } });
    expect(result.exitCode).toBe(0);
  }
  const check = new Database(path);
  expect((check.query("SELECT total_tokens FROM token_usage WHERE id = 'old'").get() as any).total_tokens).toBe(42);
  expect((check.query("PRAGMA table_info(token_usage)").all() as any[]).some(c => c.name === "run_id")).toBe(true);
  check.close();
});

test("CLI extraction reads the full file, ignores snapshots, handles partial lines and shell quotes", async () => {
  mock.module("../src/services/mags.ts", () => ({ execOnWorkspace: async (_id: string, command: string) => {
    const proc = Bun.spawnSync(["bash", "-c", command]);
    if (proc.exitCode) throw new Error(proc.stderr.toString());
    return { output: proc.stdout.toString() };
  } }));
  const { collectCliUsage } = await import("../src/services/usage-cli.ts");
  const path = join(root, "cli's output.jsonl");
  const message = { role: "assistant", timestamp: 789, model: "cli-extracted", provider: "openai", usage: { input: 40, output: 8 }, content: [{ type: "text", text: "x".repeat(300000) }] };
  writeFileSync(path, [JSON.stringify({ type: "message_update", message }), JSON.stringify({ type: "message_end", message }), JSON.stringify({ type: "message_end", message }), '{"partial":'].join("\n"));
  await withUsage({ ...context, cliOutputs: [{ workspaceId: "test", outputFile: path }] }, collectCliUsage);
  const rows = await db.select().from(tokenUsage).where(eq(tokenUsage.model, "cli-extracted"));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.totalTokens).toBe(48);
});

test("generated (non-streaming) responses record actual model and preserve multi-ticket totals", async () => {
  const model = trackModel({ specificationVersion: "v3", provider: "anthropic", modelId: "generated", supportedUrls: {},
    doGenerate: async () => ({ content: [], usage: { inputTokens: { total: 9 }, outputTokens: { total: 4 } } }),
  } as any);
  await withUsage({ userId: "alice", ticketIds: new Set(["t1", "t2"]) }, () => model.doGenerate({ prompt: [] }));
  const response = await api.request("http://test/?model=generated&groupBy=ticket");
  const data = await response.json() as any;
  expect(data.total.totalTokens).toBe(13);
  expect(data.rows.map((r: any) => r.key).sort()).toEqual(["t1", "t2"]);
});

test("ticket scope creates distinct attempts and preserves a delegated build's identity", async () => {
  const { projects } = await import("../src/db/schema/projects.ts");
  const { projectTickets } = await import("../src/db/schema/tickets.ts");
  const { withTicketUsage } = await import("../src/services/usage-run.ts");
  const { currentUsage } = await import("../src/ai/usage-context.ts");
  await db.insert(projects).values({ id: "run-project", projectId: "run-public", name: "Test", ownerId: "alice" });
  await db.insert(projectTickets).values({ id: "run-ticket", projectId: "run-project", name: "Test ticket", description: "Test build", assigneeId: "alice", sourceDocumentId: "source-doc" });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) await withTicketUsage("run-ticket", "bob", "ticket_build", async () => {
    ids.push(currentUsage()!.runId!);
    expect(currentUsage()!.userId).toBe("bob");
    expect(currentUsage()!.documentIds?.has("source-doc")).toBe(true);
    await withTicketUsage("run-ticket", "bob", "ticket_build", async () => {
      expect(currentUsage()!.runId).toBe(ids[i]!);
    });
  });
  expect(ids[0]).not.toBe(ids[1]);
  expect(await db.select().from(tokenUsageRuns).where(eq(tokenUsageRuns.ticketId, "run-ticket"))).toHaveLength(2);
});
