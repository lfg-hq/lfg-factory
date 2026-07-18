/**
 * Combined Home payload — one request instead of 5 (activities + notifications
 * + members + pins). Cuts round-trips on the project Home page.
 */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { notifications } from "../../db/schema/notifications.ts";
import { users } from "../../db/schema/users.ts";
import { projectMembers } from "../../db/schema/projects.ts";
import { projectPins } from "../../db/schema/pins.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { and, eq, desc, asc, isNull, inArray } from "drizzle-orm";
import { getProjectAccess } from "../../auth/project-access.ts";
import { getProjectActivities } from "../../services/activity-log.ts";
import type { auth } from "../../auth/index.ts";

type Env = { Variables: { user: typeof auth.$Infer.Session.user } };
const homeApi = new Hono<Env>();
homeApi.use("*", requireAuth as any);

homeApi.get("/:projectId/home", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const p = access.project;
  const canManagePins = access.role === "owner" || access.role === "admin";

  const [activities, notifs, memberRows, owner, pinRows] = await Promise.all([
    getProjectActivities(p.id, { limit: 12 }),
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        message: notifications.message,
        link: notifications.link,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        actorName: users.name,
      })
      .from(notifications)
      .leftJoin(users, eq(notifications.actorId, users.id))
      .where(and(eq(notifications.userId, user.id), eq(notifications.projectId, p.projectId)))
      .orderBy(desc(notifications.createdAt))
      .limit(50),
    db
      .select({ userId: projectMembers.userId, role: projectMembers.role, userName: users.name, userEmail: users.email })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.status, "active"))),
    db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, p.ownerId)).then((r) => r[0]),
    db.select().from(projectPins).where(eq(projectPins.projectId, p.id)).orderBy(asc(projectPins.order), asc(projectPins.createdAt)),
  ]);

  // Resolve pin names/links (docs/tickets can be renamed).
  const docIds = pinRows.filter((r) => r.targetType === "document" && r.targetId).map((r) => r.targetId!);
  const ticketIds = pinRows.filter((r) => r.targetType === "ticket" && r.targetId).map((r) => r.targetId!);
  const docNames = new Map<string, string>();
  const ticketNames = new Map<string, string>();
  if (docIds.length) (await db.select({ id: projectFiles.id, name: projectFiles.name }).from(projectFiles).where(inArray(projectFiles.id, docIds))).forEach((d) => docNames.set(d.id, d.name));
  if (ticketIds.length) (await db.select({ id: projectTickets.id, name: projectTickets.name }).from(projectTickets).where(inArray(projectTickets.id, ticketIds))).forEach((t) => ticketNames.set(t.id, t.name));
  const pins = pinRows.map((r) => {
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

  const unreadCount = notifs.filter((n) => !n.readAt).length;

  return c.json({
    activities,
    notifications: notifs,
    unreadCount,
    members: {
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email, role: "owner" } : null,
      members: memberRows,
    },
    pins,
    canManagePins,
  });
});

export default homeApi;
