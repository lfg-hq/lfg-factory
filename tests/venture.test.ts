// TEST FIXTURES ONLY: server-owned linked identities are seeded here. These tests
// exercise real Better Auth sessions, not a live Google OAuth round trip.
import { beforeAll, afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { auth } from "../src/auth/index.ts";
import authRoutes from "../src/routes/auth.ts";
import venture from "../src/routes/api/venture.ts";
import { db } from "../src/config/db.ts";
import { env } from "../src/config/env.ts";
import { users, accounts } from "../src/db/schema/users.ts";
import { ventureConversations, ventureMessages, ventureAssessments, ventureSources } from "../src/db/schema/venture.ts";

if (!process.env.VENTURE_TEST_ISOLATED) throw new Error("Use bun run test:venture for isolated databases.");
const app = new Hono().route("/", authRoutes).route("/api/venture", venture);
const origin = new URL(env.BETTER_AUTH_URL).origin;
const fixtureIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const cookies: string[] = [];
let conversationId: string;
async function request(path: string, user?: number, method = "GET", body?: unknown, requestOrigin: string | null = origin) {
  const headers = new Headers();
  if (user !== undefined) headers.set("cookie", cookies[user]!);
  if (requestOrigin) headers.set("origin", requestOrigin);
  if (body !== undefined) headers.set("content-type", "application/json");
  return app.request(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  for (let i = 0; i < fixtureIds.length; i++) {
    const id = fixtureIds[i]!;
    const email = `venture-test-${id}@workspace.example.org`;
    const password = crypto.randomUUID();
    await db.insert(users).values({ id, name: "TEST FIXTURE", email, emailVerified: true });
    await db.insert(accounts).values({ id: crypto.randomUUID(), userId: id, providerId: "credential", accountId: id, password: await hashPassword(password) });
    if (i < 2) await db.insert(accounts).values({ id: crypto.randomUUID(), userId: id, providerId: "google", accountId: `TEST-FIXTURE-${id}`, scope: "openid email profile" });
    const response = await auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin }), asResponse: true });
    expect(response.status).toBe(200);
    cookies[i] = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  }
});
afterAll(async () => { for (const id of fixtureIds) { await db.delete(ventureConversations).where(eq(ventureConversations.userId, id)); await db.delete(users).where(eq(users.id, id)); } });

test("anonymous and password-only sessions cannot access any private endpoint", async () => {
  for (const [user, status] of [[undefined, 401], [2, 403]] as const) {
    for (const path of ["/session", "/conversations", "/conversations/not-owned"]) {
      const response = await request(`/api/venture${path}`, user);
      expect(response.status).toBe(status); expect((await response.json()).requestId).toBeTruthy();
    }
    expect((await request("/api/venture/conversations", user, "POST", {})).status).toBe(status);
  }
});
test("server-owned Workspace identity is accepted without Gmail scopes", async () => {
  const response = await request("/api/venture/session", 0);
  expect(response.status).toBe(200); expect((await response.json()).ready).toBe(true);
});
test("strict payload and mandatory same-origin write protection", async () => {
  for (const requestOrigin of [null, "https://evil.example"]) expect((await request("/api/venture/conversations", 0, "POST", {}, requestOrigin)).status).toBe(403);
  for (const payload of [{ userId: fixtureIds[1] }, { projectId: "foreign" }, { title: "x".repeat(161) }, { title: 3 }]) expect((await request("/api/venture/conversations", 0, "POST", payload)).status).toBe(400);
  expect((await request("/api/venture/conversations", 0, "POST", { title: "x".repeat(3000) })).status).toBe(413);
});
test("owner-only create/list/load and durable messages; no project chat context", async () => {
  const created = await request("/api/venture/conversations", 0, "POST", { title: "TEST FIXTURE private venture" });
  expect(created.status).toBe(201); const data = await created.json(); conversationId = data.conversation.id;
  expect(data.conversation.userId).toBe(fixtureIds[0]);
  await db.insert(ventureMessages).values({ conversationId, role: "user", content: "TEST FIXTURE private content", requestId: crypto.randomUUID(), status: "completed" });
  await db.insert(ventureSources).values({ conversationId, turnId: "TEST FIXTURE", url: "https://example.org", title: "TEST FIXTURE" });
  await db.insert(ventureAssessments).values({ conversationId, version: 1, status: "completed", contentJson: { fixture: true } });
  const ownList = await (await request("/api/venture/conversations", 0)).json();
  expect(ownList.conversations.some((item: any) => item.id === conversationId)).toBe(true);
  const foreignList = await (await request("/api/venture/conversations", 1)).json();
  expect(foreignList.conversations.some((item: any) => item.id === conversationId)).toBe(false);
  expect((await request(`/api/venture/conversations/${conversationId}`, 1)).status).toBe(404);
  expect((await request(`/api/venture/conversations/${conversationId}`, 1, "POST", { title: "stolen" })).status).toBe(404);
  const loaded = await (await request(`/api/venture/conversations/${conversationId}`, 0)).json();
  expect(loaded.messages[0].content).toBe("TEST FIXTURE private content");
  // A fresh process/connection proves durable storage, not in-memory UI state.
  const child = Bun.spawn(["bun", "-e", `import {db} from './src/config/db.ts'; import {ventureMessages} from './src/db/schema/venture.ts'; import {eq} from 'drizzle-orm'; const r=await db.select().from(ventureMessages).where(eq(ventureMessages.conversationId, ${JSON.stringify(conversationId)})); if(r.length!==1)process.exit(1);process.exit(0);`], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
});
test('stream and stop endpoints retain all access guards and enforce payload limits', async () => {
  for (const suffix of ['stream', 'stop']) {
    const path = `/api/venture/conversations/${conversationId}/${suffix}`;
    expect((await request(path, undefined, 'POST', {})).status).toBe(401);
    expect((await request(path, 2, 'POST', {})).status).toBe(403);
    expect((await request(path, 1, 'POST', {})).status).toBe(404);
    expect((await request(path, 0, 'POST', {}, 'https://evil.example')).status).toBe(403);
  }
  const path = `/api/venture/conversations/${conversationId}/stream`;
  for (const payload of [{ requestId: crypto.randomUUID(), content: 'x'.repeat(4001) }, { requestId: crypto.randomUUID(), content: 'TEST FIXTURE', projectId: 'foreign' }, { requestId: 'bad', content: 'x' }]) expect((await request(path, 0, 'POST', payload)).status).toBe(400);
  expect((await request(path, 0, 'POST', { content: 'x'.repeat(18001) })).status).toBe(413);
});
test('real adapter with missing credentials streams truthful error and persists without replay', async () => {
  if (env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.GOOGLE_AI_API_KEY) return; // This is a missing-key test, not live-provider evidence.
  const requestId = crypto.randomUUID(), path = `/api/venture/conversations/${conversationId}/stream`;
  const response = await request(path, 0, 'POST', { requestId, content: 'TEST FIXTURE missing provider request' });
  expect(response.headers.get('content-type')).toBe('application/x-ndjson');
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  expect(events.some(e => e.code === 'PROVIDER_NOT_CONFIGURED' && e.requestId === requestId)).toBe(true);
  expect(events.at(-1).status).toBe('failed');
  expect((await request(path, 0, 'POST', { requestId, content: 'TEST FIXTURE duplicate' })).status).toBe(409);
  const loaded = await (await request(`/api/venture/conversations/${conversationId}`, 0)).json();
  expect(loaded.messages.some((m: any) => m.requestId === requestId && m.status === 'failed')).toBe(true);
  expect(loaded.messages.some((m: any) => m.content === 'TEST FIXTURE private content')).toBe(true);
  expect(loaded.sources.length).toBe(1);
});
test("request logs include success and denial, correlation and duration without secrets/content", async () => {
  const records: any[] = []; const original = console.info;
  console.info = (...values) => { records.push(JSON.parse(String(values[0]))); };
  try { await request("/api/venture/session", 0); await request("/api/venture/conversations"); }
  finally { console.info = original; }
  expect(records.some(r => r.transition === "completed" && r.outcome === "success")).toBe(true);
  expect(records.some(r => r.transition === "failed" && r.errorCode === "SIGN_IN_REQUIRED")).toBe(true);
  for (const row of records) { expect(row.timestamp).toBeTruthy(); expect(row.level).toBeTruthy(); expect(row.service).toBe("venture"); expect(row.requestId).toBeTruthy(); expect(typeof row.durationMs).toBe("number"); }
  const text = JSON.stringify(records);
  expect(text).not.toContain(cookies[0]!); expect(text).not.toContain("private content"); expect(text).not.toContain("workspace.example.org");
});
test("Google initiation rejects cross-origin and reports missing credentials honestly", async () => {
  expect((await request("/auth/venture/google", undefined, "POST", {}, "https://evil.example")).status).toBe(403);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    const response = await request("/auth/venture/google", undefined, "POST", {});
    expect(response.status).toBe(503); expect((await response.json()).code).toBe("GOOGLE_NOT_CONFIGURED");
  }
  expect((await auth.$context).options.account?.accountLinking?.disableImplicitLinking).toBe(true);
});
