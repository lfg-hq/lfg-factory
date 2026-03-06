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
import mcpApi from "./routes/api/mcp.ts";
import invitationsApi from "./routes/api/invitations.ts";
import sharingApi from "./routes/api/sharing.ts";
import commentsApi from "./routes/api/comments.ts";
import invitationRoutes from "./routes/invitations.ts";
import shareRoutes from "./routes/share.ts";
import { auth } from "./auth/index.ts";
import { startTicketWorker } from "./workers/ticket-executor.ts";
import { registerEventHandlers } from "./events/handlers.ts";
import { db } from "./config/db.ts";
import { agentRoles, modelSelections } from "./db/schema/chat.ts";
import { eq } from "drizzle-orm";
import { onOpen, onClose, onMessage } from "./ws/chat-handler.ts";
import type { WsData } from "./ws/types.ts";
import { DEFAULT_MODEL_KEY } from "./ai/provider.ts";

const app = new Hono();

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

// ── Static files ────────────────────────────────────────────────────
app.use("/public/*", serveStatic({ root: "./" }));
app.use("/uploads/*", serveStatic({ root: "./" }));

// ── Health check ────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok" }));

// ── Routes ──────────────────────────────────────────────────────────
app.route("/", authRoutes);
app.route("/", landing);
app.route("/", chatRoutes);
app.route("/", instantRoutes);
app.route("/", projectsRoutes);
app.route("/", settingsRoutes);
app.route("/", invitationRoutes);
app.route("/", shareRoutes);
app.route("/api/files", filesApi);
app.route("/api/settings", settingsApi);
app.route("/api/projects", ticketsApi);
app.route("/api/conversations", conversationsApi);
app.route("/api/instant", instantApi);
app.route("/api/v1/cli", cliRouter);
app.route("/api/v1/claude-auth", claudeAuthApi);
app.route("/api/mcp", mcpApi);
app.route("/api/projects", invitationsApi);
app.route("/api/projects", sharingApi);
app.route("/api/projects", commentsApi);

// ── Django-compat stubs ──────────────────────────────────────────────
// chat.js calls /accounts/agent-settings/ for turbo mode + role state
app.get("/accounts/agent-settings/", async (c) => {
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

    // Turnstile verification for sign-in and sign-up
    const isAuthAction =
      req.method === "POST" &&
      (url.pathname.includes("/sign-in/email") || url.pathname.includes("/sign-up/email"));

    if (isAuthAction && env.TURNSTILE_SECRET_KEY) {
      try {
        const body = await req.clone().json();
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

  // Strip trailing slashes from CLI callback URLs — the VM may POST with
  // trailing slashes and Hono's trimTrailingSlash issues 301 redirects that
  // lose POST bodies. Rewrite the URL in-place before handing to Hono.
  if (url.pathname.startsWith("/api/v1/cli") && url.pathname.endsWith("/") && url.pathname.length > 1) {
    const cleaned = url.pathname.replace(/\/+$/, "") + url.search;
    const rewritten = new Request(new URL(cleaned, url.origin).toString(), req);
    return app.fetch(rewritten);
  }

  return app.fetch(req);
}

// ── Start background workers ─────────────────────────────────────────
registerEventHandlers();
startTicketWorker();

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
