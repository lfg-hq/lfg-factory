import { Hono } from "hono";
import { AuthPage } from "../templates/pages/auth.tsx";
import { env } from "../config/env.ts";
import { auth } from "../auth/index.ts";

const authRoutes = new Hono();

// ── Login / Register page ──────────────────────────────────────────
// Google sign-in only shows when it's configured (a self-host or test server may not have it).
const authPage = () => AuthPage({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, googleEnabled: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
authRoutes.get("/auth/login", (c) => c.html(authPage()));
authRoutes.get("/auth/register", (c) => c.html(authPage()));

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

export default authRoutes;
