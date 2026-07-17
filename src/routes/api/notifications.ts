/**
 * Notifications API — powers the dashboard inbox (assigned tickets, mentions,
 * comments). Scoped per project (we keep collaboration project-specific for now).
 */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { notifications } from "../../db/schema/notifications.ts";
import { users } from "../../db/schema/users.ts";
import { and, eq, desc, isNull } from "drizzle-orm";
import type { auth } from "../../auth/index.ts";

type Env = { Variables: { user: typeof auth.$Infer.Session.user } };
const notificationsApi = new Hono<Env>();
notificationsApi.use("*", requireAuth as any);

// GET /api/projects/:projectId/notifications — current user's items for a project
notificationsApi.get("/:projectId/notifications", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      targetType: notifications.targetType,
      targetId: notifications.targetId,
      message: notifications.message,
      link: notifications.link,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      actorName: users.name,
    })
    .from(notifications)
    .leftJoin(users, eq(notifications.actorId, users.id))
    .where(and(eq(notifications.userId, user.id), eq(notifications.projectId, projectId!)))
    .orderBy(desc(notifications.createdAt))
    .limit(100);

  return c.json({ notifications: rows });
});

// POST /api/projects/:projectId/notifications/read — mark one or all read
notificationsApi.post("/:projectId/notifications/read", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const body = await c.req.json<{ id?: string }>().catch(() => ({} as { id?: string }));

  const now = new Date();
  if (body.id) {
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(and(eq(notifications.id, body.id), eq(notifications.userId, user.id)));
  } else {
    // mark all unread in this project as read
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.userId, user.id),
          eq(notifications.projectId, projectId!),
          isNull(notifications.readAt)
        )
      );
  }
  return c.json({ ok: true });
});

export default notificationsApi;
