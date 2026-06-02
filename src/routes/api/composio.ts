import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { composioToolkits } from "../../db/schema/composio.ts";
import { agents } from "../../db/schema/agents.ts";
import { eq, and } from "drizzle-orm";
import {
  isComposioConfigured,
  listConnectors,
  connectToolkit,
  disconnectToolkit,
  saveConnectedToolkit,
} from "../../services/composio-manager.ts";
import { broadcastToUser } from "../../ws/connection-manager.ts";
import { env } from "../../config/env.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const composio = new Hono<AuthEnv>();
composio.use("*", requireAuth);

// GET /api/composio/connectors — list available connectors with logos, descriptions
composio.get("/connectors", async (c) => {
  const user = c.get("user");
  if (!isComposioConfigured()) return c.json({ items: [], configured: false });

  const search = c.req.query("search") ?? undefined;
  const filter = (c.req.query("filter") as "all" | "connected" | "available") ?? "all";
  const cursor = c.req.query("cursor") ?? undefined;
  const limit = parseInt(c.req.query("limit") ?? "50", 10);

  const result = await listConnectors(user.id, { search, filter, limit, cursor });
  return c.json({ ...result, configured: true });
});

// POST /api/composio/connectors/:toolkit/connect — initiate OAuth
composio.post("/connectors/:toolkit/connect", async (c) => {
  const user = c.get("user");
  const toolkit = c.req.param("toolkit");
  const referer = c.req.header("Referer") ?? "/settings/integrations";
  const callbackUrl = `${env.BETTER_AUTH_URL}/api/composio/callback?return_to=${encodeURIComponent(referer)}`;

  const result = await connectToolkit(user.id, toolkit, callbackUrl);

  if ("error" in result) {
    return c.json({ error: result.error }, 500);
  }

  // No-auth toolkit — already saved, no redirect needed
  if (!result.redirectUrl) {
    return c.json({ connected: true, redirectUrl: null });
  }

  return c.json({ redirectUrl: result.redirectUrl });
});

// POST /api/composio/connectors/:toolkit/disconnect — remove connection
composio.post("/connectors/:toolkit/disconnect", async (c) => {
  const user = c.get("user");
  const toolkit = c.req.param("toolkit");
  await disconnectToolkit(user.id, toolkit);
  return c.json({ success: true });
});

// GET /api/composio/callback — OAuth callback after user completes auth.
//
// Two flows:
//   1. Normal:   redirect back to `return_to` (e.g. the integrations page)
//   2. Popup:    when `popup=1` is set (used by the agent's requestConnectorAuth
//                tool), return a self-closing HTML page so the OAuth popup
//                disappears and the parent chat tab can continue. The
//                `connector_connected` WS event is broadcast to all of the
//                user's tabs so the agent chat auto-retries the last message.
composio.get("/callback", async (c) => {
  const user = c.get("user");
  const toolkit = c.req.query("toolkit");
  const agentId = c.req.query("agent_id");
  const isPopup = c.req.query("popup") === "1";

  // Mirror the connection locally and notify open tabs.
  if (toolkit) {
    try {
      await saveConnectedToolkit(user.id, toolkit);
    } catch (err) {
      console.error("[composio-callback] saveConnectedToolkit failed:", (err as Error).message);
    }

    // If this OAuth flow was started from a specific agent's chat (via
    // requestConnectorAuth), automatically opt that agent into the
    // toolkit. Without this, per-agent gating means the LLM still gets
    // no tools loaded on the next turn even though the user just
    // connected — they'd see "I can't access X" right after connecting.
    if (agentId) {
      try {
        const slug = toolkit.toUpperCase();
        const [agentRow] = await db
          .select({ id: agents.id, composioToolkits: agents.composioToolkits })
          .from(agents)
          .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
          .limit(1);
        if (agentRow) {
          const current = agentRow.composioToolkits ?? [];
          if (!current.includes(slug)) {
            await db
              .update(agents)
              .set({ composioToolkits: [...current, slug], updatedAt: new Date() })
              .where(eq(agents.id, agentRow.id));
            console.log(`[composio-callback] auto-enabled ${slug} for agent ${agentId}`);
          }
        }
      } catch (err) {
        console.error("[composio-callback] agent toolkit enable failed:", (err as Error).message);
      }
    }

    broadcastToUser(user.id, {
      type: "connector_connected",
      toolkit: toolkit.toUpperCase(),
      agent_id: agentId ?? null,
    });
  }

  if (isPopup) {
    return c.html(
      `<!DOCTYPE html><html><head><title>Connected</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1117;color:#c9d1d9;}</style>
</head><body><div style="text-align:center;">
<div style="font-size:2.5rem;margin-bottom:0.5rem;">✓</div>
<div>Connected${toolkit ? ` ${toolkit}` : ""}. Returning to chat…</div>
</div><script>setTimeout(()=>window.close(),600);</script></body></html>`
    );
  }

  const returnTo = c.req.query("return_to") ?? "/settings/integrations?success=Connector+connected";
  return c.redirect(returnTo);
});

// ── Legacy endpoints for backward compat ─────────────────────────────

// GET /api/composio/toolkits — list user's enabled toolkits
composio.get("/toolkits", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select()
    .from(composioToolkits)
    .where(eq(composioToolkits.userId, user.id));
  return c.json({ toolkits: rows });
});

// POST /api/composio/toolkits — enable a toolkit
composio.post("/toolkits", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ toolkit: string }>();
  if (!body.toolkit) return c.json({ error: "toolkit required" }, 400);

  await saveConnectedToolkit(user.id, body.toolkit);
  const [row] = await db
    .select()
    .from(composioToolkits)
    .where(and(eq(composioToolkits.userId, user.id), eq(composioToolkits.toolkit, body.toolkit.toUpperCase())));
  return c.json({ toolkit: row }, 201);
});

// PUT /api/composio/toolkits/:id — toggle
composio.put("/toolkits/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json<{ enabled?: boolean }>();
  const [updated] = await db
    .update(composioToolkits)
    .set({ enabled: body.enabled ?? true })
    .where(and(eq(composioToolkits.id, id), eq(composioToolkits.userId, user.id)))
    .returning();
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({ toolkit: updated });
});

// DELETE /api/composio/toolkits/:id
composio.delete("/toolkits/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const [deleted] = await db
    .delete(composioToolkits)
    .where(and(eq(composioToolkits.id, id), eq(composioToolkits.userId, user.id)))
    .returning();
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

composio.get("/status", (c) => c.json({ configured: isComposioConfigured() }));

export default composio;
