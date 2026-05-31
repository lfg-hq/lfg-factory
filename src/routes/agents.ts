/**
 * Agent Page Routes
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.ts";
import { db } from "../config/db.ts";
import { agents, agentMessages } from "../db/schema/agents.ts";
import { modelSelections, agentRoles } from "../db/schema/chat.ts";
import { composioToolkits } from "../db/schema/composio.ts";
import { listConnectors } from "../services/composio-manager.ts";
import { listModels, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { AgentsListPage } from "../templates/pages/agents-list.tsx";
import { AgentDetailPage } from "../templates/pages/agent-detail.tsx";
import { AgentsCentralPage } from "../templates/pages/agents-central.tsx";
import type { auth } from "../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const agentsRoutes = new Hono<AuthEnv>();
agentsRoutes.use("*", requireAuth);

// Strip trailing slashes
agentsRoutes.use("*", async (c, next) => {
  const path = c.req.path;
  if (path !== "/agents" && path !== "/agents/" && path.endsWith("/")) {
    return c.redirect(path.slice(0, -1), 301);
  }
  return next();
});

// ── Agent list ────────────────────────────────────────────────────────

agentsRoutes.get("/agents", async (c) => {
  const user = c.get("user");

  const agentList = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, user.id))
    .orderBy(desc(agents.createdAt));

  return c.html(
    AgentsListPage({
      user: { id: user.id, name: user.name, email: user.email ?? "" },
      agents: agentList.map((a) => ({
        agentId: a.agentId,
        name: a.name,
        status: a.status,
        personality: a.personality,
        instructions: a.instructions,
        composioToolkits: (a.composioToolkits as string[] | null) ?? [],
        sandboxUrl: a.sandboxUrl,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    })
  );
});

// ── Central chat ──────────────────────────────────────────────────────

agentsRoutes.get("/agents/central", async (c) => {
  const user = c.get("user");

  const agentList = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, user.id))
    .orderBy(desc(agents.createdAt));

  // Fetch recent messages from all agents
  const recentMessages = await db
    .select({
      id: agentMessages.id,
      agentId: agentMessages.agentId,
      role: agentMessages.role,
      content: agentMessages.content,
      createdAt: agentMessages.createdAt,
    })
    .from(agentMessages)
    .innerJoin(agents, eq(agentMessages.agentId, agents.id))
    .where(eq(agents.userId, user.id))
    .orderBy(desc(agentMessages.createdAt))
    .limit(50);

  // Build agent name map
  const agentMap = new Map(agentList.map((a) => [a.id, a]));

  return c.html(
    AgentsCentralPage({
      user: { id: user.id, name: user.name, email: user.email ?? "" },
      agents: agentList.map((a) => ({
        agentId: a.agentId,
        internalId: a.id,
        name: a.name,
        status: a.status,
      })),
      messages: recentMessages.reverse().map((m) => {
        const ag = agentMap.get(m.agentId);
        return {
          id: m.id,
          agentId: ag?.agentId ?? "",
          agentName: ag?.name ?? "Unknown",
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        };
      }),
    })
  );
});

// ── Agent detail ──────────────────────────────────────────────────────

agentsRoutes.get("/agents/:agentId", async (c) => {
  const user = c.get("user");
  const { agentId } = c.req.param();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, user.id)))
    .limit(1);

  if (!agent) return c.text("Agent not found", 404);

  // Source of truth for connected toolkits is Composio (their connected_account
  // flag). Our local composio_toolkit table is just a cache and may be missing
  // rows for connections established before the OAuth-callback-saves-locally
  // fix shipped (commit aa263f9). Falls back to local rows on Composio outage.
  const [composioList, localToolkits, modelSel] = await Promise.all([
    listConnectors(user.id, { filter: "connected", limit: 100 }).catch(() => ({ items: [] })),
    db.select().from(composioToolkits).where(eq(composioToolkits.userId, user.id)),
    db.select().from(modelSelections).where(eq(modelSelections.userId, user.id)).then((r) => r[0]),
  ]);

  // Merge: prefer Composio's view, fall back to local rows it didn't return.
  const seenSlugs = new Set<string>();
  const mergedToolkits: { slug: string; name: string }[] = [];
  for (const t of composioList.items) {
    const slug = (t.slug || "").toUpperCase();
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    mergedToolkits.push({ slug, name: t.name || slug });
  }
  for (const t of localToolkits.filter((t) => t.enabled)) {
    const slug = (t.toolkit || "").toUpperCase();
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    mergedToolkits.push({ slug, name: t.toolkit });
  }

  const models = listModels().map((m) => ({
    key: m.key,
    label: m.label,
    providerLabel: m.providerLabel,
    requiresPro: m.requiresPro,
  }));

  return c.html(
    AgentDetailPage({
      user: { id: user.id, name: user.name, email: user.email ?? "" },
      agent: {
        agentId: agent.agentId,
        name: agent.name,
        status: agent.status,
        personality: agent.personality,
        instructions: agent.instructions,
        sandboxUrl: agent.sandboxUrl,
        composioToolkits: (agent.composioToolkits as string[] | null) ?? [],
        memoryContent: agent.memoryContent,
        memoryLastSyncedAt: agent.memoryLastSyncedAt,
        conversationId: agent.conversationId,
        webhookToken: agent.webhookToken,
        autoStopAfterIdleMs: agent.autoStopAfterIdleMs,
        runTimeoutMs: agent.runTimeoutMs,
      },
      composioToolkits: mergedToolkits,
      modelKey: modelSel?.selectedModel ?? DEFAULT_MODEL_KEY,
      models,
    })
  );
});

export default agentsRoutes;
