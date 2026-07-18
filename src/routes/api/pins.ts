/**
 * Project pins API — the "Start here" resources shown on the project Home.
 * Everyone in the project can read; only owner/admin can add/remove.
 */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { projectPins } from "../../db/schema/pins.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { and, eq, asc, inArray } from "drizzle-orm";
import { getProjectAccess } from "../../auth/project-access.ts";
import type { auth } from "../../auth/index.ts";

type Env = { Variables: { user: typeof auth.$Infer.Session.user } };
const pinsApi = new Hono<Env>();
pinsApi.use("*", requireAuth as any);

function canManage(role: string) {
  return role === "owner" || role === "admin";
}

// GET /api/projects/:projectId/pins — list pins (resolves current names/links)
pinsApi.get("/:projectId/pins", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const rows = await db
    .select()
    .from(projectPins)
    .where(eq(projectPins.projectId, access.project.id))
    .orderBy(asc(projectPins.order), asc(projectPins.createdAt));

  // Resolve fresh names for doc/ticket pins (labels can go stale on rename).
  const docIds = rows.filter((r) => r.targetType === "document" && r.targetId).map((r) => r.targetId!);
  const ticketIds = rows.filter((r) => r.targetType === "ticket" && r.targetId).map((r) => r.targetId!);
  const docNames = new Map<string, string>();
  const ticketNames = new Map<string, string>();
  if (docIds.length) {
    const ds = await db.select({ id: projectFiles.id, name: projectFiles.name }).from(projectFiles).where(inArray(projectFiles.id, docIds));
    ds.forEach((d) => docNames.set(d.id, d.name));
  }
  if (ticketIds.length) {
    const ts = await db.select({ id: projectTickets.id, name: projectTickets.name }).from(projectTickets).where(inArray(projectTickets.id, ticketIds));
    ts.forEach((t) => ticketNames.set(t.id, t.name));
  }

  const pins = rows.map((r) => {
    let href = r.url ?? "#";
    let label = r.label;
    if (r.targetType === "document" && r.targetId) {
      label = docNames.get(r.targetId) ?? r.label;
      href = `/projects/${projectId}?tab=documents&doc=${encodeURIComponent(r.targetId)}&docName=${encodeURIComponent(label)}`;
    } else if (r.targetType === "ticket" && r.targetId) {
      label = ticketNames.get(r.targetId) ?? r.label;
      href = `/projects/${projectId}?tab=tickets`;
    }
    return { id: r.id, targetType: r.targetType, label, href };
  });

  return c.json({ pins, canManage: canManage(access.role) });
});

// POST /api/projects/:projectId/pins — add a pin (owner/admin)
pinsApi.post("/:projectId/pins", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (!canManage(access.role)) return c.json({ error: "Only owners/admins can pin" }, 403);

  const body = await c.req
    .json<{ targetType: "document" | "ticket" | "link"; targetId?: string; url?: string; label: string }>()
    .catch(() => null);
  if (!body?.targetType || !body.label?.trim()) {
    return c.json({ error: "targetType and label are required" }, 400);
  }
  if (body.targetType === "link" && !body.url?.trim()) {
    return c.json({ error: "url is required for a link pin" }, 400);
  }

  const [row] = await db
    .insert(projectPins)
    .values({
      projectId: access.project.id,
      targetType: body.targetType,
      targetId: body.targetType === "link" ? null : body.targetId ?? null,
      url: body.targetType === "link" ? body.url!.trim() : null,
      label: body.label.trim(),
      createdBy: user.id,
    })
    .returning();

  return c.json({ ok: true, pin: row }, 201);
});

// DELETE /api/projects/:projectId/pins/:id — remove a pin (owner/admin)
pinsApi.delete("/:projectId/pins/:id", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (!canManage(access.role)) return c.json({ error: "Only owners/admins can unpin" }, 403);

  await db.delete(projectPins).where(and(eq(projectPins.id, id!), eq(projectPins.projectId, access.project.id)));
  return c.json({ ok: true });
});

export default pinsApi;
