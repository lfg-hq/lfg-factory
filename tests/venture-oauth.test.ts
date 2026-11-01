// TEST FIXTURES ONLY: fake provider registration exercises Better Auth's real
// authorization/state APIs without claiming Google has authenticated anyone.
import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = await mkdtemp(join(tmpdir(), "venture-oauth-test-"));
process.env.DATABASE_DRIVER = "sqlite";
process.env.DATABASE_URL = join(temp, "test.db");
process.env.GOOGLE_CLIENT_ID = "TEST-FIXTURE.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "TEST-FIXTURE-not-a-real-secret";
const child = Bun.spawn(["bun", "run", "db:push"], { env: process.env, stdout: "pipe", stderr: "pipe" });
if (await child.exited !== 0) throw new Error("OAuth fixture schema setup failed");
const { default: routes, handleGoogleCallback } = await import("../src/routes/auth.ts");
const { auth } = await import("../src/auth/index.ts");
const { env } = await import("../src/config/env.ts");
const { db } = await import("../src/config/db.ts");
const { users, accounts } = await import("../src/db/schema/users.ts");
const { hashPassword } = await import("better-auth/crypto");
const origin = new URL(env.BETTER_AUTH_URL).origin;
let passwordCookie: string;
beforeAll(async () => {
  const id = crypto.randomUUID(), password = crypto.randomUUID();
  await db.insert(users).values({ id, name: "TEST FIXTURE", email: "fixture@workspace.example.org", emailVerified: true });
  await db.insert(accounts).values({ id: crypto.randomUUID(), userId: id, accountId: id, providerId: "credential", password: await hashPassword(password) });
  const response = await auth.api.signInEmail({ headers: new Headers({ origin }), body: { email: "fixture@workspace.example.org", password }, asResponse: true });
  passwordCookie = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
});
afterAll(async () => { await rm(temp, { recursive: true, force: true }); });
for (const linking of [false, true]) test(`real Better Auth ${linking ? "explicit linking" : "sign-in"} API uses fixed callback and basic scopes; cancellation retryable`, async () => {
  const response = await routes.request(`${origin}/auth/venture/google`, { method: "POST", headers: { origin, ...(linking ? { cookie: passwordCookie } : {}) }, body: JSON.stringify({ callbackURL: "https://evil.example", provider: "github", scopes: ["gmail"] }) });
  expect(response.status).toBe(200);
  const data = await response.json(); const url = new URL(data.url);
  expect(url.hostname).toBe("accounts.google.com"); expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/google`);
  const scope = url.searchParams.get("scope")!;
  expect(scope).toContain("openid"); expect(scope).not.toContain("gmail"); expect(scope).not.toContain("mail.google");
  expect(url.searchParams.get("state")).toBeTruthy(); expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  const cookies = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const callback = new URL(`${origin}/api/auth/callback/google`);
  callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("error", "access_denied");
  const cancelled = await handleGoogleCallback(new Request(callback, { headers: { cookie: cookies } }));
  expect(cancelled.status).toBe(302);
  const destination = new URL(cancelled.headers.get("location")!);
  expect(destination.origin).toBe(origin); expect(destination.pathname).toBe("/venture-analyst");
  expect(destination.searchParams.get("chat")).toBe("open"); expect(destination.searchParams.get("auth")).toBe("failed");
  expect(destination.searchParams.get("requestId")).toBe(cancelled.headers.get("X-Request-ID"));
});
