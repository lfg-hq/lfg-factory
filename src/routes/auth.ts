import { Hono } from "hono";
import { AuthPage } from "../templates/pages/auth.tsx";
import { env } from "../config/env.ts";
import { auth } from "../auth/index.ts";

import { getVentureAccess, googleConfigured, isVentureSameOrigin } from "../services/venture-access.ts";
import { loggedRequest, ventureError } from "../utils/request-log.ts";

const authRoutes = new Hono();

// No client-selected provider, scopes, callback URL or account identity.
authRoutes.post("/auth/venture/google", c => loggedRequest(c.req.raw, "venture.google.initiate", async requestId => {
  if (!isVentureSameOrigin(c.req.raw)) return ventureError(requestId, 403, "ORIGIN_REJECTED", "Open this site's venture page and retry Google sign-in.");
  if (!googleConfigured()) return ventureError(requestId, 503, "GOOGLE_NOT_CONFIGURED", "Google sign-in is unavailable. The operator must configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then retry.");
  const { session } = await getVentureAccess(c.req.raw.headers);
  const callbackURL = new URL("/venture-analyst?chat=open", env.BETTER_AUTH_URL).href;
  const errorCallbackURL = new URL("/venture-analyst?chat=open&auth=failed", env.BETTER_AUTH_URL).href;
  try {
    const options = { headers: c.req.raw.headers, body: { provider: "google" as const, callbackURL, errorCallbackURL, disableRedirect: true }, asResponse: true as const };
    const response = session ? await auth.api.linkSocialAccount(options) : await auth.api.signInSocial(options);
    if (!response.ok) return ventureError(requestId, response.status, "GOOGLE_START_FAILED", "Google sign-in could not start. Retry; if you already have an account, sign in to it first and connect Google.");
    return response;
  } catch {
    return ventureError(requestId, 502, "GOOGLE_START_FAILED", "Google sign-in could not start. Please retry, or sign in to your existing LFG account before connecting Google.");
  }
}));

// ── Login / Register page ──────────────────────────────────────────
authRoutes.get("/auth/login", (c) => c.html(AuthPage({ turnstileSiteKey: env.TURNSTILE_SITE_KEY })));
authRoutes.get("/auth/register", (c) => c.html(AuthPage({ turnstileSiteKey: env.TURNSTILE_SITE_KEY })));

// ── Logout ─────────────────────────────────────────────────────────
// Accepts both GET (direct link) and POST (form submit), signs out, then redirects.
authRoutes.get("/auth/logout", async (c) => {
  await auth.api.signOut({ headers: c.req.raw.headers });
  return c.redirect("/auth/login");
});
authRoutes.post("/auth/logout", async (c) => {
  await auth.api.signOut({ headers: c.req.raw.headers });
  return c.redirect("/auth/login");
});

// NOTE: Better Auth API handler (/api/auth/**) is registered directly
// on the main app in index.ts so it runs before sub-router middleware.

export async function handleGoogleCallback(request: Request) {
  return loggedRequest(request, "venture.google.callback", async requestId => {
    const response = await auth.handler(request);
    const location = response.headers.get("location");
    if (location) {
      const target = new URL(location, env.BETTER_AUTH_URL);
      // Keep callbacks from other Google entry points unchanged.
      if (target.origin === new URL(env.BETTER_AUTH_URL).origin && target.pathname === "/venture-analyst" && target.searchParams.get("auth") === "failed") {
        target.searchParams.set("requestId", requestId);
        response.headers.set("location", target.href);
        response.headers.set("X-Error-Code", new URL(request.url).searchParams.get("error") === "access_denied" ? "OAUTH_CANCELLED" : "OAUTH_FAILED");
      }
    }
    return response;
  });
}

export default authRoutes;
