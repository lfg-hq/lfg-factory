import { Hono } from "hono";
import { env } from "../../config/env.ts";
import { auth } from "../../auth/index.ts";
import { getVentureAccess, googleConfigured, isVentureSameOrigin } from "../services/access.ts";
import { loggedRequest, ventureError } from "../request-log.ts";

// Venture sign-in: Google only, so the analyst can check public profiles the
// founder confirms. Other LFG login methods stay in src/routes/auth.ts.
const ventureAuth = new Hono();

// No client-selected provider, scopes, callback URL or account identity; only a
// whitelisted landing page after sign-in.
ventureAuth.post("/auth/venture/google", c => loggedRequest(c.req.raw, "venture.google.initiate", async requestId => {
  if (!isVentureSameOrigin(c.req.raw)) return ventureError(requestId, 403, "ORIGIN_REJECTED", "Open this site's venture page and retry Google sign-in.");
  if (!googleConfigured()) return ventureError(requestId, 503, "GOOGLE_NOT_CONFIGURED", "Google sign-in is unavailable. The operator must configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then retry.");
  const { session } = await getVentureAccess(c.req.raw.headers);
  // The only client choice is where to land afterwards, from a fixed list.
  let next: unknown;
  try { next = JSON.parse((await c.req.text()).slice(0, 512)).next; } catch { /* empty or invalid body */ }
  const callbackURL = new URL(next === "dashboard" ? "/venture/dashboard" : "/venture/chat", env.BETTER_AUTH_URL).href;
  const errorCallbackURL = new URL(`/venture/chat?auth=failed${next === "dashboard" ? "&next=dashboard" : ""}`, env.BETTER_AUTH_URL).href;
  try {
    const options = { headers: c.req.raw.headers, body: { provider: "google" as const, callbackURL, errorCallbackURL, disableRedirect: true }, asResponse: true as const };
    const response = session ? await auth.api.linkSocialAccount(options) : await auth.api.signInSocial(options);
    if (!response.ok) return ventureError(requestId, response.status, "GOOGLE_START_FAILED", "Google sign-in could not start. Retry; if you already have an account, sign in to it first and connect Google.");
    return response;
  } catch {
    return ventureError(requestId, 502, "GOOGLE_START_FAILED", "Google sign-in could not start. Please retry, or sign in to your existing LFG account before connecting Google.");
  }
}));

// Wraps Better Auth's Google callback so a failed venture sign-in returns to the
// venture page with a correlation ID. Other Google entry points pass through.
export async function handleGoogleCallback(request: Request) {
  return loggedRequest(request, "venture.google.callback", async requestId => {
    const response = await auth.handler(request);
    const location = response.headers.get("location");
    if (location) {
      const target = new URL(location, env.BETTER_AUTH_URL);
      // Keep callbacks from other Google entry points unchanged.
      if (target.origin === new URL(env.BETTER_AUTH_URL).origin && target.pathname === "/venture/chat" && target.searchParams.get("auth") === "failed") {
        target.searchParams.set("requestId", requestId);
        response.headers.set("location", target.href);
        response.headers.set("X-Error-Code", new URL(request.url).searchParams.get("error") === "access_denied" ? "OAUTH_CANCELLED" : "OAUTH_FAILED");
      }
    }
    return response;
  });
}

export default ventureAuth;
