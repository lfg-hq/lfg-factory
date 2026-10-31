// LFG Desktop browser sign-in, end to end: the desktop app's signInWithBrowser against
// the real /desktop routes and Better Auth, with a scripted "browser" that is signed
// in, confirms, and follows the redirect back to the app's 127.0.0.1 callback.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), "lfg-desktop-auth-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "desktop-auth-test-secret-only-not-a-real-secret";
process.env.BETTER_AUTH_URL = ORIGIN;
process.env.SENDGRID_API_KEY = "";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();

const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { db } = await import("../src/config/db.ts");
const { auth } = await import("../src/auth/index.ts");
const { users } = await import("../src/db/schema/users.ts");
const { runnerDevices } = await import("../src/db/schema/runners.ts");
const { default: desktopRoutes } = await import("../src/routes/desktop.ts");
const { authenticateRunnerToken } = await import("../src/services/runner/hub.ts");
const { signInWithBrowser, SignInCancelled } = await import("../desktop/src/browser-signin.ts");

const app = new Hono();
app.route("/", desktopRoutes);
let server: ReturnType<typeof Bun.serve>;
let cookie = "";

beforeAll(async () => {
  server = Bun.serve({
    port: PORT, hostname: "127.0.0.1",
    fetch: (req) => new URL(req.url).pathname.startsWith("/api/auth/") ? auth.handler(req) : app.fetch(req),
  });
  await auth.api.signUpEmail({ body: { email: "ana@example.com", password: "a-long-test-password", name: "Ana" } });
  await db.update(users).set({ emailVerified: true }).where(eq(users.email, "ana@example.com"));
  const { headers } = await auth.api.signInEmail({ body: { email: "ana@example.com", password: "a-long-test-password" }, returnHeaders: true });
  cookie = headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
});
afterAll(() => server?.stop(true));

/** A signed-in browser that confirms (or cancels) on the authorize page. */
function browser(action: "connect" | "cancel" | "tamper", seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    const page = await fetch(url, { headers: { cookie }, redirect: "manual" });
    expect(page.status).toBe(200);
    const htmlText = await page.text();
    if (action === "cancel") {
      const cancel = htmlText.match(/class="btn" href="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
      await fetch(cancel);
      return;
    }
    const form = new URLSearchParams();
    const decode = (v: string) => v.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    for (const [, name, value] of htmlText.matchAll(/name="(\w+)" value="([^"]*)"/g)) form.set(name!, decode(value!));
    if (action === "tamper") form.set("redirect_uri", "https://evil.example/callback");
    const confirmed = await fetch(`${ORIGIN}/desktop/authorize`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
    if (action === "tamper") { expect(confirmed.status).toBe(400); return; }
    expect(confirmed.status).toBe(303);
    await fetch(confirmed.headers.get("location")!); // the browser lands on the app's callback
  };
}

test("browser sign-in pairs the computer and opens a session of the app's own", async () => {
  const seen: string[] = [];
  const result = await signInWithBrowser({ serverUrl: ORIGIN, deviceName: "Ana's MacBook", openBrowser: browser("connect", seen), timeoutMs: 10_000 });
  expect(result.user.email).toBe("ana@example.com");
  expect(new URL(seen[0]!).searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  // The runner token works, for the right person and computer.
  const device = await authenticateRunnerToken(result.runnerToken);
  expect(device?.name).toBe("Ana's MacBook");
  expect(device?.id).toBe(result.deviceId);

  // The one-time token signs the app window in, with a new session (not the browser's).
  const opened = await fetch(`${ORIGIN}/desktop/session?token=${result.sessionToken}`, { redirect: "manual" });
  expect(opened.headers.get("location")).toBe("/projects");
  const appCookie = opened.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const appSession = await auth.api.getSession({ headers: new Headers({ cookie: appCookie }) });
  const browserSession = await auth.api.getSession({ headers: new Headers({ cookie }) });
  expect(appSession?.user.email).toBe("ana@example.com");
  expect(appSession?.session.id).not.toBe(browserSession?.session.id);

  // …and only once.
  const again = await fetch(`${ORIGIN}/desktop/session?token=${result.sessionToken}`, { redirect: "manual" });
  expect(again.headers.get("location")).toBe("/auth/login");
  expect(again.headers.getSetCookie().join("")).not.toContain("session_token=");
});

test("signing in again on the same computer replaces its pairing", async () => {
  const first = await signInWithBrowser({ serverUrl: ORIGIN, deviceName: "Ana's iMac", openBrowser: browser("connect") });
  const second = await signInWithBrowser({ serverUrl: ORIGIN, deviceName: "Ana's iMac", openBrowser: browser("connect"), replaceDeviceId: first.deviceId });
  expect(await authenticateRunnerToken(first.runnerToken)).toBeNull();
  expect((await authenticateRunnerToken(second.runnerToken))?.id).toBe(second.deviceId);
});

test("cancel in the browser, or cancel in the app", async () => {
  await expect(signInWithBrowser({ serverUrl: ORIGIN, deviceName: "x", openBrowser: browser("cancel") })).rejects.toBeInstanceOf(SignInCancelled);
  const controller = new AbortController();
  const pending = signInWithBrowser({ serverUrl: ORIGIN, deviceName: "x", openBrowser: () => { controller.abort(); }, signal: controller.signal });
  await expect(pending).rejects.toBeInstanceOf(SignInCancelled);
});

test("the authorize page refuses other hosts, cross-site posts and strangers", async () => {
  const devices = (await db.select().from(runnerDevices)).length;
  await expect(signInWithBrowser({ serverUrl: ORIGIN, deviceName: "x", openBrowser: browser("tamper"), timeoutMs: 1500 })).rejects.toBeInstanceOf(SignInCancelled);

  const challenge = createHash("sha256").update("v".repeat(43)).digest("base64url");
  const qs = `state=${"s".repeat(24)}&challenge=${challenge}`;
  expect((await fetch(`${ORIGIN}/desktop/authorize?${qs}&redirect_uri=${encodeURIComponent("https://evil.example/callback")}`, { headers: { cookie } })).status).toBe(400);
  // Not signed in: off to sign-in, coming back here afterwards.
  const anon = await fetch(`${ORIGIN}/desktop/authorize?${qs}&redirect_uri=${encodeURIComponent("http://127.0.0.1:5555/callback")}`, { redirect: "manual" });
  expect(anon.headers.get("location")).toStartWith("/auth/login?next=%2Fdesktop%2Fauthorize%3F");
  // A form posted from another site is refused.
  const csrf = await fetch(`${ORIGIN}/desktop/authorize`, { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: `${qs}&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback`, redirect: "manual" });
  expect(csrf.status).toBe(403);
  expect((await db.select().from(runnerDevices)).length).toBe(devices);
});

test("a code needs the app's PKCE verifier, and works once", async () => {
  // Capture the code the way a snooping process on the callback port might.
  let code = "";
  const snoop = (async (url: string, init?: RequestInit) => {
    code = JSON.parse(String(init!.body)).code;
    const wrong = await fetch(url, { ...init, body: JSON.stringify({ code, verifier: "w".repeat(43) }) });
    expect(wrong.status).toBe(400);
    return fetch(url, init); // the real verifier, but the code was spent by the wrong attempt
  }) as typeof fetch;
  await expect(signInWithBrowser({ serverUrl: ORIGIN, deviceName: "x", openBrowser: browser("connect"), fetchImpl: snoop })).rejects.toThrow(/already used/);
});
