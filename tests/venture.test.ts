// TEST FIXTURES ONLY: server-owned linked identities are seeded here. These tests
// exercise real Better Auth sessions, not a live Google OAuth round trip.
import { beforeAll, afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { auth } from "../src/auth/index.ts";
import authRoutes from "../src/venture/routes/auth.ts";
import venture from "../src/venture/routes/api.ts";
import { db } from "../src/config/db.ts";
import { env } from "../src/config/env.ts";
import { users, accounts } from "../src/db/schema/users.ts";
import { ventureConversations, ventureMessages, ventureAssessments, ventureSources, ventureTasks, ventureWorkItems } from "../src/venture/db/schema.ts";
import { fundRecommendation } from "./venture-assessment.fixture.ts";

if (!process.env.VENTURE_TEST_ISOLATED) throw new Error("Use bun run test:venture for isolated databases.");
const app = new Hono().route("/", authRoutes).route("/api/venture", venture);
const origin = new URL(env.BETTER_AUTH_URL).origin;
const fixtureIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const cookies: string[] = [];
let conversationId: string;
const emails: string[] = [];
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
    const email = `venture-test-${id}@workspace.example.org`; emails[i] = email;
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
  const child = Bun.spawn(["bun", "-e", `import {db} from './src/config/db.ts'; import {ventureMessages} from './src/venture/db/schema.ts'; import {eq} from 'drizzle-orm'; const r=await db.select().from(ventureMessages).where(eq(ventureMessages.conversationId, ${JSON.stringify(conversationId)})); if(r.length!==1)process.exit(1);process.exit(0);`], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
});
test('stream and stop endpoints retain all access guards and enforce payload limits', async () => {
  for (const suffix of ['stream', 'stop', 'assessment']) {
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
test('assessment read isolation and failed real-adapter generation preserve saved version', async () => {
  const path = `/api/venture/conversations/${conversationId}/assessment`;
  for (const [user, status] of [[undefined, 401], [2, 403], [1, 404]] as const) expect((await request(path, user)).status).toBe(status);
  const before = await (await request(path, 0)).json(); expect(before.assessment.version).toBe(1);
  const requestId = crypto.randomUUID();
  const failed = await request(path, 0, 'POST', { requestId }); expect(failed.status).toBe(503);
  expect((await failed.json()).code).toBe('PROVIDER_NOT_CONFIGURED');
  expect((await request(path, 0, 'POST', { requestId })).status).toBe(409);
  expect((await (await request(path, 0)).json()).assessment).toEqual(before.assessment);
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

test("LFG admins review every venture and record decisions; founders keep tasks and never see internal notes", async () => {
  const [assessment] = await db.select().from(ventureAssessments).where(eq(ventureAssessments.conversationId, conversationId));
  const [task] = await db.insert(ventureTasks).values({ conversationId, assessmentId: assessment!.id, position: 0, action: "TEST FIXTURE interview 10 customers", successSignal: "3 pilots", dueWeek: 2 }).returning();
  const previous = env.VENTURE_ADMIN_EMAILS;
  env.VENTURE_ADMIN_EMAILS = ` ${emails[1]!.toUpperCase()} , other@example.org`;
  try {
    expect((await (await request("/api/venture/session", 0)).json()).isAdmin).toBe(false);
    expect((await (await request("/api/venture/session", 1)).json()).isAdmin).toBe(true);
    expect((await request("/api/venture/dashboard?scope=all", 0)).status).toBe(403);
    const own = await (await request("/api/venture/dashboard", 0)).json();
    expect(own.ventures.find((v: any) => v.id === conversationId)?.owner).toBeUndefined();
    const all = await (await request("/api/venture/dashboard?scope=all", 1)).json();
    expect(all.ventures.find((v: any) => v.id === conversationId)?.owner.email).toBe(emails[0]);
    const overview = await request(`/api/venture/conversations/${conversationId}/overview`, 1);
    expect(overview.status).toBe(200); expect((await overview.json()).isOwner).toBe(false);
    expect((await request(`/api/venture/conversations/${conversationId}/overview`, 2)).status).toBe(403);
    // Admin read access never extends to writing the founder's conversation.
    expect((await request(`/api/venture/conversations/${conversationId}/stream`, 1, "POST", { requestId: crypto.randomUUID(), content: "x" })).status).toBe(404);
    const decisionPath = `/api/venture/admin/conversations/${conversationId}/decision`;
    expect((await request(decisionPath, 0, "POST", { decision: "approved", tokensApproved: 1000 })).status).toBe(403);
    expect((await request(decisionPath, 1, "POST", { decision: "approved", tokensApproved: 1000 }, "https://evil.example")).status).toBe(403);
    expect((await request(decisionPath, 1, "POST", { decision: "approved", tokensApproved: 0 })).status).toBe(400);
    expect((await request(decisionPath, 1, "POST", { decision: "declined", tokensApproved: 5 })).status).toBe(400);
    expect((await request(decisionPath, 1, "POST", { decision: "approved", tokensApproved: 1000 })).status).toBe(400); // approvals need deal terms
    const decided = await request(decisionPath, 1, "POST", { decision: "approved", tokensApproved: 2_500_000, founderNote: "TEST FIXTURE go", internalNote: "TEST FIXTURE internal only", deal: { structure: "revenue_share", equityPercent: null, revenueSharePercent: 8, capMultiple: 3, termMonths: 36 } });
    expect(decided.status).toBe(201); expect((await decided.json()).decision.assessmentVersion).toBe(1);
    const founderView = await (await request(`/api/venture/conversations/${conversationId}/overview`, 0)).json();
    expect(founderView.decision.tokensApproved).toBe(2_500_000); expect(founderView.decision.founderNote).toBe("TEST FIXTURE go");
    expect(JSON.stringify(founderView)).not.toContain("internal only");
    expect((await (await request(`/api/venture/conversations/${conversationId}/overview`, 1)).json()).decision.internalNote).toBe("TEST FIXTURE internal only");
    expect((await request(`/api/venture/tasks/${task!.id}`, 1, "PATCH", { done: true })).status).toBe(404);
    expect((await request(`/api/venture/tasks/${task!.id}`, 0, "PATCH", { done: "yes" })).status).toBe(400);
    const ticked = await request(`/api/venture/tasks/${task!.id}`, 0, "PATCH", { done: true });
    expect(ticked.status).toBe(200); expect((await ticked.json()).task.done).toBe(true);
    expect((await (await request("/api/venture/dashboard", 0)).json()).ventures.find((v: any) => v.id === conversationId)?.tasks).toEqual({ total: 1, done: 1 });
  } finally { env.VENTURE_ADMIN_EMAILS = previous; }
});

test("approval releases the tranche as work items; reviewers report progress and results; founders see the timeline", async () => {
  await db.insert(ventureAssessments).values({ conversationId, version: 2, status: "provisional", contentJson: fundRecommendation() });
  const previous = env.VENTURE_ADMIN_EMAILS;
  env.VENTURE_ADMIN_EMAILS = emails[1]!;
  try {
    // 2.0M approved against a 2.5M recommendation: proportions kept, exact total.
    expect((await request(`/api/venture/admin/conversations/${conversationId}/decision`, 1, "POST", { decision: "approved", tokensApproved: 2_000_000, deal: { structure: "revenue_share", equityPercent: null, revenueSharePercent: 8, capMultiple: 3, termMonths: 36 } })).status).toBe(201);
    // Nothing is released until both sides sign.
    expect((await db.select().from(ventureWorkItems).where(eq(ventureWorkItems.conversationId, conversationId))).length).toBe(0);
    const agreementId = (await (await request(`/api/venture/conversations/${conversationId}/overview`, 0)).json()).agreements.current.id;
    const sign = (user: number, side: string) => request(`/api/venture/agreements/${agreementId}/sign`, user, "POST", { side, name: "TEST FIXTURE Signer", consent: true });
    expect((await sign(0, "lfg")).status).toBe(403);
    expect((await sign(1, "founder")).status).toBe(403);
    expect((await request(`/api/venture/agreements/${agreementId}/sign`, 0, "POST", { side: "founder", name: "TEST FIXTURE" })).status).toBe(400);
    expect((await sign(0, "founder")).status).toBe(200);
    expect((await sign(0, "founder")).status).toBe(409);
    expect((await db.select().from(ventureWorkItems).where(eq(ventureWorkItems.conversationId, conversationId))).length).toBe(0);
    const active = await (await sign(1, "lfg")).json();
    expect(active.agreement.status).toBe("active"); expect(active.agreement.activatedAt).toBeTruthy();
    expect(active.agreement.body).toContain("8% of the Venture's gross revenue");
    const items = await db.select().from(ventureWorkItems).where(eq(ventureWorkItems.conversationId, conversationId));
    expect(items.map(i => i.workType).sort()).toEqual(["landing_page", "mvp"]);
    expect(items.reduce((sum, i) => sum + i.tokensBudgeted, 0)).toBe(2_000_000);
    expect(items.find(i => i.workType === "landing_page")!.tokensBudgeted).toBe(400_000);
    const landing = items.find(i => i.workType === "landing_page")!;
    const path = `/api/venture/admin/work-items/${landing.id}`;
    expect((await request(path, 0, "PATCH", { status: "shipped" })).status).toBe(403);
    expect((await request(path, 1, "PATCH", {})).status).toBe(400);
    expect((await request(path, 1, "PATCH", { addTokens: -5 })).status).toBe(400);
    const shipped = await request(path, 1, "PATCH", { status: "shipped", addTokens: 350_000, note: "TEST FIXTURE live" });
    expect(shipped.status).toBe(200);
    const item = (await shipped.json()).item;
    expect(item.tokensSpent).toBe(350_000); expect(item.shippedAt).toBeTruthy(); expect(item.startedAt).toBeTruthy();
    const metrics = `/api/venture/admin/conversations/${conversationId}/metrics`;
    expect((await request(metrics, 0, "POST", { name: "revenue_usd", value: 120 })).status).toBe(403);
    expect((await request(metrics, 1, "POST", { name: "made_up", value: 1 })).status).toBe(400);
    expect((await request(metrics, 1, "POST", { name: "revenue_usd", value: 120 })).status).toBe(201);
    const view = await (await request(`/api/venture/conversations/${conversationId}/overview`, 0)).json();
    expect(view.progress.tokensSpent).toBe(350_000); expect(view.progress.shipped).toBe(1); expect(view.progress.week).toBe(1);
    expect(view.metrics.at(-1).value).toBe(120);
    const titles = view.events.map((e: any) => e.title);
    expect(titles).toContain("Shipped: TEST FIXTURE landing page");
    expect(titles.some((t: string) => t.startsWith("LFG approved 2M tokens"))).toBe(true);
    expect(view.events.every((e: any) => e.week === null || e.week >= 1)).toBe(true);
    const list = await (await request("/api/venture/dashboard", 0)).json();
    const row = list.ventures.find((v: any) => v.id === conversationId);
    expect(row.progress.tokensSpent).toBe(350_000); expect(row.revenueUsd).toBe(120); expect(list.usdPerMillionTokens).toBeGreaterThan(0);
  } finally { env.VENTURE_ADMIN_EMAILS = previous; }
});

test("founders can ask to renegotiate before signing; LFG revises (new version) or keeps the terms", async () => {
  const [other] = await db.insert(ventureConversations).values({ userId: fixtureIds[0]!, title: "TEST FIXTURE negotiation" }).returning();
  await db.insert(ventureAssessments).values({ conversationId: other!.id, version: 1, status: "provisional", contentJson: fundRecommendation() });
  const previous = env.VENTURE_ADMIN_EMAILS;
  env.VENTURE_ADMIN_EMAILS = emails[1]!;
  try {
    expect((await request(`/api/venture/admin/conversations/${other!.id}/decision`, 1, "POST", { decision: "approved", tokensApproved: 2_500_000, deal: { structure: "equity", equityPercent: 6, revenueSharePercent: null, capMultiple: null, termMonths: null } })).status).toBe(201);
    const current = async () => (await (await request(`/api/venture/conversations/${other!.id}/overview`, 0)).json()).agreements;
    const v1 = (await current()).current;
    expect(v1.structure).toBe("equity"); expect(v1.body).toContain("6% of the fully diluted equity");
    const changes = `/api/venture/agreements/${v1.id}/changes`;
    expect((await request(changes, 1, "POST", { message: "TEST FIXTURE not mine" })).status).toBe(403);
    expect((await request(changes, 0, "POST", { message: "TEST FIXTURE could we do 4% given I bring partners?", proposed: { structure: "equity", equityPercent: 4 } })).status).toBe(200);
    expect((await current()).current.status).toBe("changes_requested");
    expect((await request(`/api/venture/agreements/${v1.id}/sign`, 0, "POST", { side: "founder", name: "TEST FIXTURE", consent: true })).status).toBe(409);
    const respond = `/api/venture/admin/agreements/${v1.id}/respond`;
    expect((await request(respond, 0, "POST", { message: "TEST FIXTURE" })).status).toBe(403);
    expect((await request(respond, 1, "POST", { message: "TEST FIXTURE", revised: { structure: "equity", equityPercent: 5, revenueSharePercent: 8, capMultiple: null, termMonths: null } })).status).toBe(400);
    expect((await request(respond, 1, "POST", { message: "TEST FIXTURE meet in the middle at 5%", revised: { structure: "equity", equityPercent: 5, revenueSharePercent: null, capMultiple: null, termMonths: null } })).status).toBe(200);
    const after = await current();
    expect(after.current.version).toBe(2); expect(after.current.equityPercent).toBe(5); expect(after.current.status).toBe("awaiting_signatures");
    expect(after.versions.find((v: any) => v.version === 1).status).toBe("superseded");
    expect(after.messages.map((m: any) => m.kind)).toEqual(["change_request", "revision"]);
    expect((await request(`/api/venture/agreements/${v1.id}/sign`, 0, "POST", { side: "founder", name: "TEST FIXTURE", consent: true })).status).toBe(409);
    // A second request, answered by keeping the terms, reopens the same version.
    const v2 = after.current.id;
    await request(`/api/venture/agreements/${v2}/changes`, 0, "POST", { message: "TEST FIXTURE one more ask" });
    expect((await request(`/api/venture/admin/agreements/${v2}/respond`, 1, "POST", { message: "TEST FIXTURE 5% is our final offer" })).status).toBe(200);
    expect((await current()).current.status).toBe("awaiting_signatures");
  } finally { env.VENTURE_ADMIN_EMAILS = previous; }
});

test("founders get one active venture; archive frees the slot; delete is permanent but never for signed deals", async () => {
  const create = (user: number) => request("/api/venture/conversations", user, "POST", { title: "TEST FIXTURE limit" });
  // User 0 already has active ventures from earlier tests: at the limit.
  expect((await (await request("/api/venture/session", 0)).json()).ventureLimit).toMatchObject({ max: 1, canCreate: false });
  const blocked = await create(0);
  expect(blocked.status).toBe(409); expect((await blocked.json()).code).toBe("VENTURE_LIMIT");
  const mine = await db.select().from(ventureConversations).where(eq(ventureConversations.userId, fixtureIds[0]!));
  for (const v of mine) expect((await request(`/api/venture/conversations/${v.id}/archive`, 0, "POST", { archived: true })).status).toBe(200);
  expect((await (await request("/api/venture/conversations", 0)).json()).conversations.length).toBe(0);
  const created = await create(0);
  expect(created.status).toBe(201);
  const fresh = (await created.json()).conversation.id;
  expect((await create(0)).status).toBe(409);
  // Restoring while at the limit is refused too.
  expect((await request(`/api/venture/conversations/${mine[0]!.id}/archive`, 0, "POST", { archived: false })).status).toBe(409);
  // Others can't manage your ventures (user 1 is not an admin here); non-Google users are refused.
  expect((await request(`/api/venture/conversations/${fresh}/archive`, 1, "POST", { archived: true })).status).toBe(404);
  expect((await request(`/api/venture/conversations/${fresh}`, 1, "DELETE")).status).toBe(404);
  expect((await request(`/api/venture/conversations/${fresh}`, 2, "DELETE")).status).toBe(403);
  // A signed, active agreement is a contract record: archive only.
  const del = await request(`/api/venture/conversations/${conversationId}`, 0, "DELETE");
  expect(del.status).toBe(409); expect((await del.json()).code).toBe("SIGNED_AGREEMENT");
  // Deleting removes the venture and everything under it, on SQLite as on Postgres.
  await db.insert(ventureMessages).values({ conversationId: fresh, role: "user", content: "TEST FIXTURE", requestId: crypto.randomUUID(), status: "completed" });
  expect((await request(`/api/venture/conversations/${fresh}`, 0, "DELETE")).status).toBe(200);
  expect((await db.select().from(ventureConversations).where(eq(ventureConversations.id, fresh))).length).toBe(0);
  expect((await db.select().from(ventureMessages).where(eq(ventureMessages.conversationId, fresh))).length).toBe(0);
  expect((await request(`/api/venture/conversations/${mine[0]!.id}/archive`, 0, "POST", { archived: false })).status).toBe(200);
});

test("analyst dictation sits behind the venture sign-in and says so honestly when the platform key is missing", async () => {
  for (const kind of ["session", "transcribe"]) {
    const path = `/api/venture/dictation/${kind}`;
    expect((await request(path, undefined, "POST", {})).status).toBe(401);
    expect((await request(path, 2, "POST", {})).status).toBe(403);
    expect((await request(path, 0, "POST", {}, "https://evil.example")).status).toBe(403);
  }
  if (!env.OPENAI_API_KEY) {
    const response = await request("/api/venture/dictation/session", 0, "POST", { sdp: "v=0 TEST FIXTURE offer" });
    expect(response.status).toBe(503); expect((await response.json()).code).toBe("DICTATION_UNAVAILABLE");
  }
  expect((await request("/api/venture/dictation/session", 0, "POST", { sdp: "not sdp", projectId: "x" })).status).toBeGreaterThanOrEqual(400);
});
