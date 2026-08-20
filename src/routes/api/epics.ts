import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { epics } from "../../db/schema/epics.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { users } from "../../db/schema/users.ts";
import { eq, and, asc, inArray } from "drizzle-orm";
import { getProjectAccess } from "../../auth/project-access.ts";
import {
  createEpic,
  getEpic,
  approveEpic,
  rejectEpic,
  promoteEpicToMain,
  getMergeBlockers,
  listDependentEpics,
  assignTicketsToEpic,
  listUnassignedTickets,
  listEpicDocs,
  linkDocsToEpic,
  unlinkDocsFromEpic,
  LEGACY_ANCHOR_BRANCH,
} from "../../services/epics.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const epicsApi = new Hono<AuthEnv>();
epicsApi.use("*", requireAuth);

/** Load an epic and confirm the caller can see its project. */
async function loadEpic(epicId: string, userId: string) {
  const epic = await getEpic(epicId);
  if (!epic) return null;
  const access = await getProjectAccess(epic.projectId, userId);
  if (!access) return null;
  return { epic, access };
}

// ── GET /api/projects/:projectId/epics ───────────────────────────────
epicsApi.get("/projects/:projectId/epics", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const rows = await db
    .select()
    .from(epics)
    .where(eq(epics.projectId, access.project.id))
    .orderBy(asc(epics.createdAt));

  if (!rows.length) return c.json({ epics: [] });

  // Ticket counts per epic, so the list can show progress without N queries.
  const tickets = await db
    .select({
      epicId: projectTickets.epicId,
      id: projectTickets.id,
      status: projectTickets.status,
    })
    .from(projectTickets)
    .where(inArray(projectTickets.epicId, rows.map((e) => e.id)));

  const DONE = new Set(["done", "review", "archived"]);
  return c.json({
    epics: rows.map((e) => {
      const mine = tickets.filter((t) => t.epicId === e.id);
      return {
        ...e,
        ticketCount: mine.length,
        ticketsBuilt: mine.filter((t) => DONE.has(t.status)).length,
      };
    }),
  });
});

// ── POST /api/projects/:projectId/epics ──────────────────────────────
epicsApi.post("/projects/:projectId/epics", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    goal?: string;
    conversationId?: string;
    parentEpicId?: string;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);

  const epic = await createEpic({
    projectId: access.project.id,
    name: body.name.trim(),
    goal: body.goal,
    createdById: user.id,
    conversationId: body.conversationId ?? null,
    parentEpicId: body.parentEpicId ?? null,
  });

  return c.json({ epic }, 201);
});

// ── GET /api/projects/:projectId/epics/unassigned-tickets ────────────
// Tickets that predate epics (or were made outside one) — the pool you pick from
// when folding existing work into an epic.
epicsApi.get("/projects/:projectId/epics/unassigned-tickets", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const tickets = await listUnassignedTickets(access.project.id);
  return c.json({
    tickets,
    // If any are already merged, the epic should ADOPT the legacy anchor rather
    // than branch off main — otherwise its branch wouldn't contain their code.
    anyAlreadyMerged: tickets.some((t) => t.githubMergeStatus === "merged"),
    legacyAnchor: LEGACY_ANCHOR_BRANCH,
  });
});

// ── POST /api/projects/:projectId/epics/adopt ────────────────────────
// Create an epic around tickets that ALREADY exist, optionally taking over the
// branch their code was built on.
epicsApi.post("/projects/:projectId/epics/adopt", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    goal?: string;
    ticketIds?: string[];
  }>();

  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  const ticketIds = body.ticketIds ?? [];
  if (!ticketIds.length) return c.json({ error: "ticketIds is required" }, 400);

  const epic = await createEpic({
    projectId: access.project.id,
    name: body.name.trim(),
    goal: body.goal,
    createdById: user.id,
  });

  const { moved, ticketIds: movedIds } = await assignTicketsToEpic(epic.id, ticketIds);

  return c.json({ epic, moved, ticketIds: movedIds }, 201);
});

// ── POST /api/epics/:epicId/tickets ──────────────────────────────────
// Move existing tickets into an epic that already exists.
epicsApi.post("/epics/:epicId/tickets", async (c) => {
  const user = c.get("user");
  const { epicId } = c.req.param();

  const loaded = await loadEpic(epicId!, user.id);
  if (!loaded) return c.json({ error: "Epic not found" }, 404);

  const body = await c.req.json<{ ticketIds?: string[] }>();
  if (!body.ticketIds?.length) return c.json({ error: "ticketIds is required" }, 400);

  const result = await assignTicketsToEpic(epicId!, body.ticketIds);
  return c.json(result);
});

// ── POST/DELETE /api/epics/:epicId/docs ──────────────────────────────
// Point an epic at project docs, or stop pointing at them. Never moves or hides
// the doc — it stays in the project's Docs tab throughout.
epicsApi.post("/epics/:epicId/docs", async (c) => {
  const user = c.get("user");
  const { epicId } = c.req.param();
  const loaded = await loadEpic(epicId!, user.id);
  if (!loaded) return c.json({ error: "Epic not found" }, 404);

  const body = await c.req.json<{ fileIds?: string[] }>();
  if (!body.fileIds?.length) return c.json({ error: "fileIds is required" }, 400);

  const result = await linkDocsToEpic(epicId!, body.fileIds, user.id);
  return c.json({ ...result, docs: await listEpicDocs(epicId!) });
});

epicsApi.delete("/epics/:epicId/docs", async (c) => {
  const user = c.get("user");
  const { epicId } = c.req.param();
  const loaded = await loadEpic(epicId!, user.id);
  if (!loaded) return c.json({ error: "Epic not found" }, 404);

  const body = await c.req.json<{ fileIds?: string[] }>();
  if (!body.fileIds?.length) return c.json({ error: "fileIds is required" }, 400);

  await unlinkDocsFromEpic(epicId!, body.fileIds);
  return c.json({ ok: true, docs: await listEpicDocs(epicId!) });
});

// ── GET /api/epics/:epicId ───────────────────────────────────────────
// The whole delivery unit in one payload: intent, docs, tickets, branch,
// preview, review state, and what (if anything) blocks it from going live.
epicsApi.get("/epics/:epicId", async (c) => {
  const user = c.get("user");
  const { epicId } = c.req.param();

  const loaded = await loadEpic(epicId!, user.id);
  if (!loaded) return c.json({ error: "Epic not found" }, 404);
  const { epic } = loaded;

  const [tickets, docs, blockers, dependents] = await Promise.all([
    db
      .select()
      .from(projectTickets)
      .where(eq(projectTickets.epicId, epic.id))
      .orderBy(asc(projectTickets.executionOrder), asc(projectTickets.createdAt)),
    listEpicDocs(epic.id),
    getMergeBlockers(epic),
    listDependentEpics(epic.id),
  ]);

  const parent = epic.parentEpicId ? await getEpic(epic.parentEpicId) : null;
  const approver = epic.approvedById
    ? (await db.select({ name: users.name }).from(users).where(eq(users.id, epic.approvedById)).limit(1))[0]
    : null;

  return c.json({
    epic,
    tickets,
    docs,
    stackedOn: parent ? { id: parent.id, epicKey: parent.epicKey, name: parent.name, status: parent.status } : null,
    dependents: dependents.map((d) => ({ id: d.id, epicKey: d.epicKey, name: d.name, status: d.status })),
    approvedBy: approver?.name ?? null,
    mergeBlockers: blockers,
    canMerge: blockers.length === 0,
  });
});

// ── POST /api/epics/:epicId/approve ──────────────────────────────────
epicsApi.post("/epics/:epicId/approve", async (c) => {
  const user = c.get("user");
  const { epicId } = c.req.param();

  const loaded = await loadEpic(epicId!, user.id);
  if (!loaded) return c.json({ error: "Epic not found" }, 404);

  const body = await c.req.json<{ notes?: string }>().catch(() => ({ notes: undefined }));
  const epic = await approveEpic(epicId!, user.id, body.notes);
  return c.json({ epic });
});

// ── POST /api/epics/:epicId/reject ───────────────────────────────────
epicsApi.post("/epics/:epicId/reject", async (c) => {
  const user = c.get("user");
  const { epicId } = c.req.param();

  const loaded = await loadEpic(epicId!, user.id);
  if (!loaded) return c.json({ error: "Epic not found" }, 404);

  const body = await c.req.json<{ notes?: string }>().catch(() => ({ notes: undefined }));
  const epic = await rejectEpic(epicId!, user.id, body.notes);
  const dependents = await listDependentEpics(epicId!);
  return c.json({
    epic,
    // Anything stacked on a rejected epic inherited code the client just turned
    // down — surface it rather than letting it quietly stay blocked.
    affected: dependents.map((d) => ({ id: d.id, epicKey: d.epicKey, name: d.name, status: d.status })),
  });
});

// ── POST /api/epics/:epicId/merge ────────────────────────────────────
// Promote an approved epic to main. The merge guard runs server-side, so a
// stale UI can't push unapproved work through.
epicsApi.post("/epics/:epicId/merge", async (c) => {
  const user = c.get("user");
  const { epicId } = c.req.param();

  const loaded = await loadEpic(epicId!, user.id);
  if (!loaded) return c.json({ error: "Epic not found" }, 404);

  try {
    const result = await promoteEpicToMain(epicId!, user.id);
    if (!result.merged && result.blockers?.length) {
      return c.json({ error: result.blockers[0]!.message, blockers: result.blockers }, 409);
    }
    return c.json(result);
  } catch (err) {
    return c.json({ error: `Merge failed: ${(err as Error).message}` }, 500);
  }
});

export default epicsApi;
