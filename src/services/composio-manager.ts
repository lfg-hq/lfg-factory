/**
 * Composio Integration Manager
 *
 * Provides connector catalog, OAuth flows, and tool fetching
 * for the Vercel AI SDK's streamText().
 */

import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { db } from "../config/db.ts";
import { composioToolkits } from "../db/schema/composio.ts";
import { eq, and } from "drizzle-orm";
import { env } from "../config/env.ts";

let composioInstance: Composio<VercelProvider> | null = null;

// Cache session IDs per user to avoid creating new sessions every call
const sessionCache = new Map<string, { sessionId: string; session: any; createdAt: number }>();
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getComposio(): Composio<VercelProvider> | null {
  if (!env.COMPOSIO_API_KEY) return null;
  if (!composioInstance) {
    composioInstance = new Composio({
      apiKey: env.COMPOSIO_API_KEY,
      provider: new VercelProvider(),
    });
  }
  return composioInstance;
}

/**
 * Get or create a ToolRouter session for a user.
 */
async function getSession(userId: string) {
  const composio = getComposio();
  if (!composio) return null;

  const cached = sessionCache.get(userId);
  if (cached && Date.now() - cached.createdAt < SESSION_TTL_MS) {
    return cached.session;
  }

  const session = await composio.create(userId, {
    manageConnections: true,
  });
  sessionCache.set(userId, {
    sessionId: (session as any).sessionId ?? "",
    session,
    createdAt: Date.now(),
  });
  return session;
}

/**
 * Get the raw Composio client for low-level API access (has descriptions).
 */
function getRawClient() {
  const composio = getComposio();
  if (!composio) return null;
  return composio.getClient();
}

// ── Connector Catalog ────────────────────────────────────────────────

export interface ConnectorItem {
  slug: string;
  name: string;
  logo: string;
  description: string;
  isConnected: boolean;
  isNoAuth: boolean;
  authSchemes: string[];
}

/**
 * List available connectors/toolkits with logos, descriptions, and connection status.
 * Uses the raw client to get full metadata including descriptions.
 */
export async function listConnectors(
  userId: string,
  options?: { search?: string; filter?: "all" | "connected" | "available"; limit?: number; cursor?: string }
): Promise<{ items: ConnectorItem[]; nextCursor?: string | null }> {
  const session = await getSession(userId);
  if (!session) return { items: [] };

  const client = getRawClient();
  if (!client) return { items: [] };

  const sessionId = (session as any).sessionId;
  if (!sessionId) return { items: [] };

  try {
    const params: any = {
      limit: options?.limit ?? 50,
    };
    if (options?.search) params.search = options.search;
    if (options?.cursor) params.cursor = options.cursor;
    if (options?.filter === "connected") params.is_connected = true;
    if (options?.filter === "available") params.is_connected = false;

    const result = await client.toolRouter.session.toolkits(sessionId, params);

    const items: ConnectorItem[] = (result.items ?? []).map((item: any) => ({
      slug: item.slug,
      name: item.name,
      logo: item.meta?.logo ?? "",
      description: item.meta?.description ?? "",
      isConnected: !!item.connected_account,
      isNoAuth: item.is_no_auth ?? false,
      authSchemes: item.composio_managed_auth_schemes ?? [],
    }));

    return { items, nextCursor: result.next_cursor };
  } catch (err) {
    console.error("[connectors] Failed to list connectors:", err);
    return { items: [] };
  }
}

// ── OAuth Connection Flow ────────────────────────────────────────────

/**
 * Initiate OAuth connection for a toolkit. Returns the redirect URL.
 */
export async function connectToolkit(
  userId: string,
  toolkit: string,
  callbackUrl: string
): Promise<{ redirectUrl: string } | { error: string }> {
  const session = await getSession(userId);
  if (!session) return { error: "Connectors not configured" };

  try {
    const result = await session.authorize(toolkit.toLowerCase(), {
      callbackUrl,
    });

    const redirectUrl = result?.redirectUrl;
    if (!redirectUrl) {
      // No-auth toolkit — just save it directly
      await saveConnectedToolkit(userId, toolkit);
      return { redirectUrl: "" };
    }

    return { redirectUrl };
  } catch (err: any) {
    console.error("[connectors] Failed to connect:", err);
    return { error: err.message ?? String(err) };
  }
}

/**
 * Save a connected toolkit to our DB.
 */
export async function saveConnectedToolkit(userId: string, toolkit: string): Promise<void> {
  const slug = toolkit.toUpperCase();
  const [existing] = await db
    .select()
    .from(composioToolkits)
    .where(and(eq(composioToolkits.userId, userId), eq(composioToolkits.toolkit, slug)));

  if (existing) {
    await db
      .update(composioToolkits)
      .set({ enabled: true })
      .where(eq(composioToolkits.id, existing.id));
  } else {
    await db.insert(composioToolkits).values({
      userId,
      toolkit: slug,
      enabled: true,
    });
  }
}

/**
 * Disconnect a toolkit — remove from our DB.
 */
export async function disconnectToolkit(userId: string, toolkit: string): Promise<void> {
  const slug = toolkit.toUpperCase();
  await db
    .delete(composioToolkits)
    .where(and(eq(composioToolkits.userId, userId), eq(composioToolkits.toolkit, slug)));
}

// ── Tools for AI (streamText) ────────────────────────────────────────

/**
 * Fetch tools for the user's Composio connections.
 *
 * Uses Composio's tool-router session (`manageConnections: true`) which:
 *   - Exposes ALL of the user's connected accounts (not just what's in our
 *     local composioToolkits table — Composio is the source of truth)
 *   - Returns lightweight meta-tools (`composio_search_tools`,
 *     `composio_execute_tool`) instead of statically loading every tool, so
 *     a user with 100+ connected services doesn't bloat the LLM's context
 *
 * Per-agent gating: pass `enabledToolkits`. The semantics are:
 *   - undefined  → load all the user's connected toolkits (non-agent chat)
 *   - []         → return no Composio tools at all (agent with nothing
 *                  enabled — strict opt-in)
 *   - [slug,…]   → scope the toolrouter session to just those toolkits
 */
export async function getComposioTools(
  userId: string,
  enabledToolkits?: string[]
): Promise<Record<string, any>> {
  const composio = getComposio();
  if (!composio) return {};

  // Strict per-agent gating: agent has explicitly opted in to nothing.
  if (enabledToolkits && enabledToolkits.length === 0) return {};

  // Composio's slug convention is lowercase (matches session.authorize).
  // Our DB stores uppercase ("GOOGLEDRIVE"), so normalize here — otherwise
  // toolkits.enable silently fails to match and returns zero tools, which
  // makes the LLM think the toolkit isn't really enabled and loop on
  // requestConnectorAuth.
  const normalized = enabledToolkits?.length
    ? enabledToolkits.map((s) => s.toLowerCase())
    : undefined;

  try {
    const session = await composio.create(userId, {
      manageConnections: true,
      ...(normalized?.length ? { toolkits: { enable: normalized } } : {}),
    });
    const tools = await session.tools();
    const toolCount = Object.keys(tools ?? {}).length;
    console.log(
      `[connectors] getComposioTools user=${userId.slice(0, 8)} ` +
      `enabled=${normalized ? normalized.join(",") : "ALL"} → ${toolCount} tools`
    );
    return tools ?? {};
  } catch (err) {
    console.error("[connectors] Failed to fetch tools:", err);
    return {};
  }
}

// ── MCP Config for Agent Sandbox ─────────────────────────────────────

export async function getComposioMcpConfig(
  userId: string,
  toolkits?: string[]
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const composio = getComposio();
  if (!composio) return null;

  try {
    const session = await composio.create(userId, {
      ...(toolkits?.length ? { toolkits: { enable: toolkits } } : {}),
    });
    const mcpUrl = (session as any).url ?? (session as any).mcp?.url;
    if (mcpUrl) return { url: mcpUrl, headers: {} };
    return null;
  } catch (err) {
    console.error("[connectors] Failed to get MCP config:", err);
    return null;
  }
}

// ── Utilities ────────────────────────────────────────────────────────

export function isComposioConfigured(): boolean {
  return !!env.COMPOSIO_API_KEY;
}

export function getComposioInstance(): Composio<VercelProvider> | null {
  return getComposio();
}
