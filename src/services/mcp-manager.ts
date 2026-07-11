import { createMCPClient } from "@ai-sdk/mcp";
import { db } from "../config/db.ts";
import { mcpServers } from "../db/schema/mcp.ts";
import { eq, and, inArray } from "drizzle-orm";

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

interface CachedEntry {
  clients: MCPClient[];
  createdAt: number;
}

const CLIENT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CachedEntry>();

function isExpired(entry: CachedEntry): boolean {
  return Date.now() - entry.createdAt > CLIENT_TTL_MS;
}

/**
 * Fetch all enabled MCP servers for a user, connect to each, and return
 * a merged tools object ready to spread into streamText().
 */
export async function getMcpTools(userId: string, filterServerIds?: string[]): Promise<Record<string, any>> {
  let query = db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, userId), eq(mcpServers.enabled, true)));

  const servers = filterServerIds?.length
    ? (await query).filter((s) => filterServerIds.includes(s.id))
    : await query;

  if (!servers.length) return {};

  // Close stale cached clients
  const existing = cache.get(userId);
  if (existing && isExpired(existing)) {
    await closeMcpClients(userId);
  }

  const allTools: Record<string, any> = {};
  const clients: MCPClient[] = [];

  for (const server of servers) {
    try {
      const client = await createMCPClient({
        transport: {
          type: server.transportType as "sse" | "http",
          url: server.url,
          headers: server.headers ? JSON.parse(server.headers) : undefined,
        },
      });
      const tools = await client.tools();
      Object.assign(allTools, tools);
      clients.push(client);
    } catch (err) {
      console.error(`[mcp] Failed to connect to "${server.name}":`, err);
    }
  }

  if (clients.length) {
    cache.set(userId, { clients, createdAt: Date.now() });
  }

  return allTools;
}

/**
 * Close all cached MCP clients for a user.
 */
export async function closeMcpClients(userId: string): Promise<void> {
  const entry = cache.get(userId);
  if (!entry) return;
  cache.delete(userId);
  for (const client of entry.clients) {
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Connect to a single MCP server and return its tool list (for testing connections).
 */
export async function testMcpServer(
  transportType: string,
  url: string,
  headers?: string | null,
): Promise<{ tools: string[]; error?: string }> {
  let client: MCPClient | null = null;
  try {
    client = await createMCPClient({
      transport: {
        type: transportType as "sse" | "http",
        url,
        headers: headers ? JSON.parse(headers) : undefined,
      },
    });
    const tools = await client.tools();
    return { tools: Object.keys(tools) };
  } catch (err: any) {
    return { tools: [], error: err.message ?? String(err) };
  } finally {
    if (client) {
      try { await client.close(); } catch {}
    }
  }
}
