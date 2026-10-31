/**
 * LFG Desktop sign-in, in the person's own browser (see services/runner/desktop-auth.ts).
 *
 * GET  /desktop/authorize   — "Connect LFG Desktop on <computer>?" (sign-in first if needed)
 * POST /desktop/authorize   — confirm: hands a one-time code to the app's 127.0.0.1 callback
 * POST /api/desktop/token   — the app exchanges code + PKCE verifier for its tokens
 * GET  /desktop/session     — the app window opens its own session from a one-time token
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { auth } from "../auth/index.ts";
import { env } from "../config/env.ts";
import {
  DesktopAuthError, cleanDeviceName, createDesktopCode, exchangeDesktopCode,
  isValidChallenge, isValidRedirect, isValidState,
} from "../services/runner/desktop-auth.ts";

const desktopRoutes = new Hono();
const serverOrigin = () => new URL(env.BETTER_AUTH_URL).origin;

const page = (title: string, body: ReturnType<typeof html>) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { --bg: #f8fafc; --card: #fff; --fg: #0f172a; --muted: #64748b; --border: #e2e8f0; --accent: #4f46e5; --accent-fg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0f19; --card: #141a2a; --fg: #e2e8f0; --muted: #94a3b8; --border: #263049; --accent: #6366f1; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  .card { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 32px; }
  .logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; margin-bottom: 20px; }
  .logo span { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--accent); color: var(--accent-fg); }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 14px; }
  strong { color: var(--fg); }
  .actions { display: flex; gap: 10px; margin-top: 22px; flex-wrap: wrap; }
  button, .btn { appearance: none; border: 1px solid var(--border); background: transparent; color: var(--fg); border-radius: 10px; padding: 10px 18px; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
  .primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  ul { color: var(--muted); padding-left: 20px; margin: 0; }
</style>
</head>
<body><main class="card"><div class="logo"><span>▲</span>LFG</div>${body}</main></body>
</html>`;

desktopRoutes.get("/desktop/authorize", async (c) => {
  const { state, challenge, redirect_uri: redirect, device } = c.req.query();
  if (!isValidState(state) || !isValidChallenge(challenge) || !isValidRedirect(redirect)) {
    return c.html(page("Can't connect LFG Desktop", html`<h1>This link isn't valid</h1><p>Start again from LFG Desktop: choose “Sign in with your browser”.</p>`), 400);
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    const here = new URL(c.req.url);
    return c.redirect(`/auth/login?next=${encodeURIComponent(here.pathname + here.search)}`);
  }
  const name = cleanDeviceName(device);
  const cancel = `${redirect}?error=access_denied&state=${encodeURIComponent(state)}`;
  return c.html(page("Connect LFG Desktop", html`
    <h1>Connect LFG Desktop?</h1>
    <p>Signed in as <strong>${session.user.email}</strong>.</p>
    <p>LFG Desktop on <strong>${name}</strong> will be able to:</p>
    <ul>
      <li>show your LFG workspace in its window, and</li>
      <li>run builds you start with “Build on my computer”, using that computer's Claude Code and Git.</li>
    </ul>
    <form method="post" action="/desktop/authorize">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="challenge" value="${challenge}">
      <input type="hidden" name="redirect_uri" value="${redirect}">
      <input type="hidden" name="device" value="${name}">
      <div class="actions">
        <button class="primary" type="submit">Connect</button>
        <a class="btn" href="${cancel}">Cancel</a>
      </div>
    </form>`));
});

desktopRoutes.post("/desktop/authorize", async (c) => {
  // A cross-site form must not be able to connect someone's account to an attacker's app.
  if (c.req.header("origin") !== serverOrigin()) return c.text("Forbidden", 403);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.redirect("/auth/login");
  const body = await c.req.parseBody();
  const { state, challenge, redirect_uri: redirect } = body;
  if (!isValidState(state) || !isValidChallenge(challenge) || !isValidRedirect(redirect)) return c.text("Invalid request", 400);
  const code = await createDesktopCode(session.user.id, { challenge, deviceName: cleanDeviceName(body.device) });
  return c.redirect(`${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, 303);
});

desktopRoutes.post("/api/desktop/token", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    return c.json(await exchangeDesktopCode({ code: body.code, verifier: body.verifier, replaceDeviceId: body.replaceDeviceId }));
  } catch (error) {
    if (error instanceof DesktopAuthError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

desktopRoutes.get("/desktop/session", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.redirect("/auth/login");
  try {
    const { headers } = await auth.api.verifyOneTimeToken({ body: { token }, headers: c.req.raw.headers, returnHeaders: true });
    const res = c.redirect("/projects");
    for (const cookie of headers.getSetCookie()) res.headers.append("set-cookie", cookie);
    return res;
  } catch {
    return c.redirect("/auth/login");
  }
});

export default desktopRoutes;
