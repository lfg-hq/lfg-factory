/**
 * Project ↔ issue-tracker board API (Jira, Linear).
 *
 * Everything is project-scoped and gated on canManageTickets — linking a board and
 * syncing both write tickets, so read-only members can look but not touch. The OAuth
 * grant itself lives on the USER (see /accounts/{linear,jira}-connect in routes/settings).
 */
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess, requirePermission, PermissionError } from "../../auth/project-access.ts";
import { db } from "../../config/db.ts";
import { ticketStages, projectTickets } from "../../db/schema/tickets.ts";
import { boardLinks, ticketBoardLinks } from "../../db/schema/boards.ts";
import { clientFor, getConnection, listConnections, providerConfigured } from "../../services/boards/connections.ts";
import {
  autoMapStatuses, getProjectLink, linkBoard, listProjectLinks, readStatusMap,
  setStatusMap, summarize, syncBoard, unlinkBoard,
} from "../../services/boards/sync.ts";
import { BOARD_PROVIDERS, isBoardProvider, providerLabel, type BoardProvider } from "../../services/boards/types.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const boardsApi = new Hono<AuthEnv>();
boardsApi.use("*", requireAuth);

/** Just what these helpers need from the request — Hono's Context generics don't infer
 *  through a shared helper, and inferring them produced `never`. */
type Ctx = {
  get: (k: "user") => { id: string };
  req: { param: (k: string) => string | undefined };
};

/** Resolve project + permission in one step. Null = no such project for this caller. */
async function access(c: Ctx, write: boolean) {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const acc = await getProjectAccess(projectId!, user.id);
  if (!acc) return null;
  if (write) requirePermission(acc, "canManageTickets");
  return acc;
}

function provider(c: Ctx): BoardProvider {
  const p = c.req.param("provider") ?? "";
  if (!isBoardProvider(p)) throw new Error(`Unknown board provider "${p}"`);
  return p;
}

/** GET /api/projects/:projectId/boards — what's connected, what's linked, last sync. */
boardsApi.get("/:projectId/boards", async (c) => {
  const acc = await access(c, false);
  if (!acc) return c.json({ error: "Project not found" }, 404);
  const user = c.get("user");

  const [connections, links] = await Promise.all([
    listConnections(user.id),
    listProjectLinks(acc.project.id),
  ]);

  const providers = BOARD_PROVIDERS.map((p) => {
    const conn = connections.find((x) => x.provider === p) ?? null;
    const link = links.find((x) => x.provider === p) ?? null;
    return {
      provider: p,
      label: providerLabel(p),
      configured: providerConfigured(p),
      connected: !!conn,
      account: conn ? { name: conn.accountName, email: conn.accountEmail, site: conn.siteUrl } : null,
      link: link ? {
        id: link.id,
        remoteId: link.remoteId,
        remoteKey: link.remoteKey,
        remoteName: link.remoteName,
        remoteUrl: link.remoteUrl,
        syncEnabled: link.syncEnabled,
        lastSyncedAt: link.lastSyncedAt,
        lastSyncSummary: link.lastSyncSummary,
      } : null,
    };
  });

  // Per-ticket pairings, so the board/list views can show "COH-19 ↗".
  const linkIds = links.map((l) => l.id);
  const pairs = linkIds.length
    ? await db.select().from(ticketBoardLinks).where(inArray(ticketBoardLinks.linkId, linkIds))
    : [];

  return c.json({
    providers,
    tickets: pairs.map((p) => ({
      ticketId: p.ticketId, provider: p.provider, key: p.remoteKey,
      url: p.remoteUrl, status: p.remoteStatusName, error: p.syncError,
    })),
  });
});

/** GET /api/projects/:projectId/boards/:provider/remote — boards available to link. */
boardsApi.get("/:projectId/boards/:provider/remote", async (c) => {
  const acc = await access(c, false);
  if (!acc) return c.json({ error: "Project not found" }, 404);
  const user = c.get("user");
  const p = provider(c);

  const conn = await getConnection(user.id, p);
  if (!conn) return c.json({ error: `${providerLabel(p)} isn't connected`, needsConnect: true }, 400);
  try {
    const client = await clientFor(conn);
    const boards = await client.listBoards();
    return c.json({ boards });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

/** POST /api/projects/:projectId/boards/:provider/link */
boardsApi.post("/:projectId/boards/:provider/link", async (c) => {
  const acc = await access(c, true);
  if (!acc) return c.json({ error: "Project not found" }, 404);
  const user = c.get("user");
  const p = provider(c);
  const body = await c.req.json().catch(() => ({})) as {
    remoteId?: string; remoteKey?: string; remoteName?: string; remoteUrl?: string; issueTypeId?: string; issueTypeName?: string;
  };
  if (!body.remoteId) return c.json({ error: "Pick a board to link" }, 400);

  try {
    const link = await linkBoard({
      projectId: acc.project.id,
      userId: user.id,
      provider: p,
      remoteId: body.remoteId,
      remoteKey: body.remoteKey ?? null,
      remoteName: body.remoteName ?? null,
      remoteUrl: body.remoteUrl ?? null,
      issueTypeId: body.issueTypeId ?? null,
      issueTypeName: body.issueTypeName ?? null,
    });
    return c.json({ ok: true, link });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** POST /api/projects/:projectId/boards/:provider/unlink */
boardsApi.post("/:projectId/boards/:provider/unlink", async (c) => {
  const acc = await access(c, true);
  if (!acc) return c.json({ error: "Project not found" }, 404);
  await unlinkBoard(acc.project.id, provider(c));
  return c.json({ ok: true });
});

/** POST /api/projects/:projectId/boards/:provider/sync — the "Sync now" button. */
boardsApi.post("/:projectId/boards/:provider/sync", async (c) => {
  const acc = await access(c, true);
  if (!acc) return c.json({ error: "Project not found" }, 404);
  const p = provider(c);
  try {
    const summary = await syncBoard(acc.project.id, p);
    return c.json({ ok: true, summary, message: summarize(summary) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** POST /api/projects/:projectId/boards/:provider/pause — stop syncing without unlinking. */
boardsApi.post("/:projectId/boards/:provider/pause", async (c) => {
  const acc = await access(c, true);
  if (!acc) return c.json({ error: "Project not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  const link = await getProjectLink(acc.project.id, provider(c));
  if (!link) return c.json({ error: "Not linked" }, 404);
  await db.update(boardLinks).set({ syncEnabled: body.enabled !== false, updatedAt: new Date() })
    .where(eq(boardLinks.id, link.id));
  return c.json({ ok: true, syncEnabled: body.enabled !== false });
});

/** GET /api/projects/:projectId/boards/:provider/mapping — stages ↔ statuses. */
boardsApi.get("/:projectId/boards/:provider/mapping", async (c) => {
  const acc = await access(c, false);
  if (!acc) return c.json({ error: "Project not found" }, 404);
  const p = provider(c);
  const link = await getProjectLink(acc.project.id, p);
  if (!link) return c.json({ error: "Not linked" }, 404);

  const [conn] = await Promise.all([getConnection(c.get("user").id, p)]);
  if (!conn) return c.json({ error: `${providerLabel(p)} isn't connected` }, 400);

  try {
    const client = await clientFor(conn);
    const [stages, statuses] = await Promise.all([
      db.select().from(ticketStages).where(eq(ticketStages.projectId, acc.project.id)).orderBy(ticketStages.order),
      client.listStatuses(link.remoteId),
    ]);
    const map = readStatusMap(link);
    // Nothing mapped yet (link made before statuses existed) → show the guess.
    const effective = Object.keys(map.toRemote).length ? map : autoMapStatuses(stages, statuses);
    return c.json({
      stages: stages.map((s) => ({ id: s.id, name: s.name, color: s.color, isCompleted: s.isCompleted })),
      statuses,
      map: effective,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

/** PUT /api/projects/:projectId/boards/:provider/mapping */
boardsApi.put("/:projectId/boards/:provider/mapping", async (c) => {
  const acc = await access(c, true);
  if (!acc) return c.json({ error: "Project not found" }, 404);
  const p = provider(c);
  const link = await getProjectLink(acc.project.id, p);
  if (!link) return c.json({ error: "Not linked" }, 404);

  const body = await c.req.json().catch(() => ({})) as { toRemote?: Record<string, string> };
  const toRemote = body.toRemote ?? {};
  // Derive the reverse direction here rather than trusting the client to keep two
  // dictionaries consistent. First stage claiming a status owns incoming issues.
  const toLocal: Record<string, string> = {};
  for (const [stageId, statusId] of Object.entries(toRemote)) {
    if (statusId && !toLocal[statusId]) toLocal[statusId] = stageId;
  }
  await setStatusMap(link.id, { toRemote, toLocal });
  return c.json({ ok: true });
});

/** GET /api/projects/:projectId/boards/tickets — pairings for the ticket views. */
boardsApi.get("/:projectId/boards/tickets", async (c) => {
  const acc = await access(c, false);
  if (!acc) return c.json({ error: "Project not found" }, 404);
  const links = await listProjectLinks(acc.project.id);
  if (!links.length) return c.json({ tickets: [] });
  const rows = await db.select().from(ticketBoardLinks).where(inArray(ticketBoardLinks.linkId, links.map((l) => l.id)));
  return c.json({
    tickets: rows.map((r) => ({
      ticketId: r.ticketId, provider: r.provider, key: r.remoteKey, url: r.remoteUrl,
      status: r.remoteStatusName, error: r.syncError, lastSyncedAt: r.lastSyncedAt,
    })),
  });
});

boardsApi.onError((err, c) => {
  if (err instanceof PermissionError) return c.json({ error: "You don't have permission to manage tickets on this project" }, 403);
  console.error("[boards-api]", err);
  return c.json({ error: err.message || "Board request failed" }, 500);
});

export default boardsApi;
