import { Hono } from "hono";
import { logger } from "hono/logger";
import { trimTrailingSlash } from "hono/trailing-slash";
import { serveStatic } from "hono/bun";
import { env } from "./config/env.ts";
import landing from "./routes/landing.ts";
import authRoutes from "./routes/auth.ts";
import chatRoutes from "./routes/chat.ts";
import instantRoutes from "./routes/instant.ts";
import projectsRoutes from "./routes/projects.ts";
import settingsRoutes from "./routes/settings.ts";
import filesApi from "./routes/api/files.ts";
import settingsApi from "./routes/api/settings.ts";
import ticketsApi from "./routes/api/tickets.ts";
import conversationsApi from "./routes/api/conversations.ts";
import instantApi from "./routes/api/instant.ts";
import { cliRouter } from "./routes/api/cli.ts";
import claudeAuthApi from "./routes/api/claude-auth.ts";
import openAICodexAuthApi from "./routes/api/openai-codex-auth.ts";
import composioApi from "./routes/api/composio.ts";
import invitationsApi from "./routes/api/invitations.ts";
import sharingApi from "./routes/api/sharing.ts";
import commentsApi from "./routes/api/comments.ts";
import notificationsApi from "./routes/api/notifications.ts";
import pinsApi from "./routes/api/pins.ts";
import homeApi from "./routes/api/project-home.ts";
import projectTransferApi from "./routes/api/project-transfer.ts";
import previewApi from "./routes/api/preview.ts";
import epicsApi from "./routes/api/epics.ts";
import previewProxy from "./routes/preview-proxy.ts";
import agentsRoutes from "./routes/agents.ts";
import agentsApi from "./routes/api/agents.ts";
import { agentCliRouter } from "./routes/api/agent-cli.ts";
import { agentWebhookRouter } from "./routes/api/agent-webhook.ts";
import invitationRoutes from "./routes/invitations.ts";
import shareRoutes from "./routes/share.ts";
import { auth } from "./auth/index.ts";
import { startTicketWorker } from "./workers/ticket-executor.ts";
import { startAgentScheduler } from "./services/agent-scheduler.ts";
import { startAgentTimeoutSweeper } from "./services/agent-timeout-sweeper.ts";
import { registerAgentNotifier } from "./services/agent-notifier.ts";
import { registerAgentReflector } from "./services/agent-reflector.ts";
import { registerEventHandlers } from "./events/handlers.ts";
import { db } from "./config/db.ts";
import { agentRoles, modelSelections } from "./db/schema/chat.ts";
import { eq } from "drizzle-orm";
import { onOpen, onClose, onMessage } from "./ws/chat-handler.ts";
import type { WsData } from "./ws/types.ts";
import { DEFAULT_MODEL_KEY } from "./ai/provider.ts";

const app = new Hono();

// ── Static files (served FIRST, before auth/logger/trailing-slash) ───
// Long-lived, CDN-cacheable headers so Cloudflare serves them from the edge and
// browsers cache them — the origin (which can be busy with LLM/build work) then
// serves each asset at most once per cache window instead of on every page load.
const STATIC_CACHE = "public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400";
app.use("/public/*", async (c, next) => {
  await next();
  if (c.res && c.res.status === 200) c.header("Cache-Control", STATIC_CACHE);
});
app.use("/public/*", serveStatic({ root: "./" }));
app.use("/uploads/*", serveStatic({ root: "./" }));
// Local file storage (FILE_STORAGE_TYPE=local): serve binaries written under
// LOCAL_STORAGE_DIR back at /storage/<key> so getPresignedGetUrl() works off-S3.
app.use(
  "/storage/*",
  serveStatic({
    root: env.LOCAL_STORAGE_DIR,
    rewriteRequestPath: (p) => p.replace(/^\/storage/, ""),
  })
);

// Root favicon — browsers request /favicon.ico regardless of <link> tags.
app.get("/favicon.ico", serveStatic({ path: "./public/favicon.ico" }));

// ── Trim trailing slashes (Django-compat: chat.js calls /api/foo/:id/) ──
// Skip for CLI callback routes — trimTrailingSlash 301-redirects POST→GET which breaks them
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/v1/cli")) {
    return next();
  }
  const mw = trimTrailingSlash();
  return mw(c, next);
});

// ── Request logging ──────────────────────────────────────────────────
app.use("*", logger());

// ── Health check ────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok" }));

// ── Routes ──────────────────────────────────────────────────────────
app.route("/", authRoutes);
app.route("/", landing);
app.route("/", chatRoutes);
app.route("/", instantRoutes);
app.route("/", projectsRoutes);
app.route("/", settingsRoutes);
app.route("/", agentsRoutes);
app.route("/", invitationRoutes);
app.route("/", shareRoutes);
app.route("/api/files", filesApi);
app.route("/api/settings", settingsApi);
app.route("/api/projects", ticketsApi);
app.route("/api/conversations", conversationsApi);
app.route("/api/instant", instantApi);
app.route("/api/v1/cli", cliRouter);
app.route("/api/v1/cli", agentCliRouter);
app.route("/api/agents", agentsApi);
app.route("/api/agents", agentWebhookRouter);
app.route("/api/v1/claude-auth", claudeAuthApi);
app.route("/api/v1/openai-codex-auth", openAICodexAuthApi);
app.route("/api/composio", composioApi);
app.route("/api/projects", invitationsApi);
app.route("/api/projects", sharingApi);
app.route("/api/projects", commentsApi);
app.route("/api/projects", notificationsApi);
app.route("/api/projects", pinsApi);
app.route("/api/projects", homeApi);
app.route("/api/projects", projectTransferApi);
app.route("/api/projects", previewApi);
// Epics own both /api/projects/:id/epics and /api/epics/:id, so they mount at /api.
app.route("/api", epicsApi);
app.route("/preview-proxy", previewProxy);

// ── Django-compat stubs ──────────────────────────────────────────────
// chat.js calls /accounts/agent-settings for turbo mode + role state.
// Registered WITHOUT a trailing slash: trimTrailingSlash() strips the slash and
// 301-redirects before routing, so a "/…/" registration would 404 post-redirect.
app.get("/accounts/agent-settings", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return c.json({ success: false }, 401);

  const [roleRow, modelRow] = await Promise.all([
    db.select().from(agentRoles).where(eq(agentRoles.userId, session.user.id)).then((r) => r[0]),
    db.select().from(modelSelections).where(eq(modelSelections.userId, session.user.id)).then((r) => r[0]),
  ]);

  return c.json({
    success: true,
    turbo_mode: roleRow?.turboMode ?? false,
    agent_role: roleRow?.name ?? "product_analyst",
    model_key: modelRow?.selectedModel ?? DEFAULT_MODEL_KEY,
  });
});

// ── WebSocket upgrade handler ────────────────────────────────────────
// Bun.serve handles WS upgrades outside Hono. We intercept /ws/chat here
// by using a custom fetch that tries the WS upgrade first.
async function handleFetch(req: Request, server: import("bun").Server<WsData>): Promise<Response> {
  const url = new URL(req.url);

  // Better Auth — handle before Hono to avoid sub-router middleware conflicts
  if (url.pathname.startsWith("/api/auth/")) {
    console.log(`[auth] ${req.method} ${url.pathname}`);

    // Turnstile verification for password sign-in/up and the OTP *send* step
    // (not the OTP verify step — the user already passed the captcha to get the code).
    const p = url.pathname;
    const isAuthAction =
      req.method === "POST" &&
      (p.endsWith("/sign-in/email") ||
        p.endsWith("/sign-up/email") ||
        p.endsWith("/email-otp/send-verification-otp"));

    if (isAuthAction && env.TURNSTILE_SECRET_KEY) {
      try {
        const body = (await req.clone().json()) as { turnstileToken?: string };
        const token = body?.turnstileToken;
        if (!token) {
          return Response.json({ message: "Please complete the captcha verification." }, { status: 400 });
        }
        const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET_KEY,
            response: token,
          }),
        });
        const verifyData = (await verifyRes.json()) as { success: boolean };
        if (!verifyData.success) {
          return Response.json({ message: "Captcha verification failed. Please try again." }, { status: 403 });
        }
      } catch (err) {
        console.error("[turnstile] Verification error:", err);
        return Response.json({ message: "Captcha verification error. Please try again." }, { status: 500 });
      }
    }

    return auth.handler(req);
  }

  if (url.pathname === "/ws/chat" || url.pathname === "/ws/chat/") {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user) {
      return new Response("Unauthorized", { status: 401 });
    }

    const sessionId = session.session.id;
    const userId = session.user.id;

    // Parse query params so WS handler can send chat history on connect
    const conversationId = url.searchParams.get("conversation_id") || undefined;
    const projectId = url.searchParams.get("project_id") || undefined;

    const upgraded = server.upgrade(req, {
      data: { sessionId, userId, conversationId, projectId },
    });

    if (upgraded) return undefined as unknown as Response;
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  // Normalize trailing slashes for the API/app namespaces in-place (no redirect).
  // The frontend uses Django-style "/…/" URLs everywhere; Hono's trimTrailingSlash
  // would 301-redirect each one — a wasted round-trip per call (and it drops POST
  // bodies). Rewriting the URL here before routing avoids the redirect entirely.
  // Landing/marketing pages are left to trimTrailingSlash (SEO canonical URLs).
  if (
    url.pathname.length > 1 &&
    url.pathname.endsWith("/") &&
    (url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/projects/") ||
      url.pathname.startsWith("/accounts/"))
  ) {
    const cleaned = url.pathname.replace(/\/+$/, "") + url.search;
    const rewritten = new Request(new URL(cleaned, url.origin).toString(), req);
    return app.fetch(rewritten);
  }

  return app.fetch(req);
}

// ── Start background workers ─────────────────────────────────────────
registerEventHandlers();
registerAgentNotifier();
registerAgentReflector();
startTicketWorker();
startAgentScheduler();
startAgentTimeoutSweeper();

// ── Public Telegram bot (instant app builder) ────────────────────────
import("./services/public-instant/transports/telegram.ts")
  .then((m) => m.startPublicTelegramBot())
  .catch((err) => console.error("[public-telegram] Failed to start:", err));

// ── Backfill ticket keys for existing tickets ────────────────────────
import("./utils/ticket-keys.ts").then((m) => m.backfillTicketKeys()).catch(console.error);

// ── Start server ────────────────────────────────────────────────────
console.log(`Starting LFG on port ${env.PORT} (${env.NODE_ENV})`);

export default {
  port: env.PORT,

  // Long-running endpoints (Mags VM provisioning, Claude CLI install) can take
  // 60-300s. Disable Bun's default 10s idle timeout.
  idleTimeout: 0,

  fetch: handleFetch,

  websocket: {
    open: onOpen,
    close: onClose,
    message: onMessage,
  },
};
