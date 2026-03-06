import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { mcpServers } from "../../db/schema/mcp.ts";
import { eq, and } from "drizzle-orm";
import { testMcpServer } from "../../services/mcp-manager.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const mcp = new Hono<AuthEnv>();
mcp.use("*", requireAuth);

// GET /api/mcp/servers — list user's MCP servers
mcp.get("/servers", async (c) => {
  const user = c.get("user");
  const servers = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.userId, user.id));

  return c.json({ servers });
});

// POST /api/mcp/servers — add a new MCP server
mcp.post("/servers", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    name: string;
    transportType: string;
    url: string;
    headers?: string;
    enabled?: boolean;
  }>();

  if (!body.name || !body.transportType || !body.url) {
    return c.json({ error: "name, transportType, and url are required" }, 400);
  }
  if (!["sse", "http"].includes(body.transportType)) {
    return c.json({ error: "transportType must be 'sse' or 'http'" }, 400);
  }

  // Validate headers JSON if provided
  if (body.headers) {
    try {
      JSON.parse(body.headers);
    } catch {
      return c.json({ error: "headers must be valid JSON" }, 400);
    }
  }

  const [server] = await db
    .insert(mcpServers)
    .values({
      userId: user.id,
      name: body.name,
      transportType: body.transportType,
      url: body.url,
      headers: body.headers ?? null,
      enabled: body.enabled ?? true,
    })
    .returning();

  return c.json({ server }, 201);
});

// PUT /api/mcp/servers/:id — update server config
mcp.put("/servers/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    transportType?: string;
    url?: string;
    headers?: string | null;
    enabled?: boolean;
  }>();

  if (body.transportType && !["sse", "http"].includes(body.transportType)) {
    return c.json({ error: "transportType must be 'sse' or 'http'" }, 400);
  }
  if (body.headers) {
    try {
      JSON.parse(body.headers);
    } catch {
      return c.json({ error: "headers must be valid JSON" }, 400);
    }
  }

  const updates: Record<string, any> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.transportType !== undefined) updates.transportType = body.transportType;
  if (body.url !== undefined) updates.url = body.url;
  if (body.headers !== undefined) updates.headers = body.headers;
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const [updated] = await db
    .update(mcpServers)
    .set(updates)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id)))
    .returning();

  if (!updated) return c.json({ error: "Server not found" }, 404);
  return c.json({ server: updated });
});

// DELETE /api/mcp/servers/:id — remove a server
mcp.delete("/servers/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const [deleted] = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id)))
    .returning();

  if (!deleted) return c.json({ error: "Server not found" }, 404);
  return c.json({ success: true });
});

// POST /api/mcp/servers/:id/test — test connection, return available tools
mcp.post("/servers/:id/test", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const [server] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id)));

  if (!server) return c.json({ error: "Server not found" }, 404);

  const result = await testMcpServer(server.transportType, server.url, server.headers);
  if (result.error) {
    return c.json({ success: false, error: result.error, tools: [] });
  }
  return c.json({ success: true, tools: result.tools });
});

export default mcp;
