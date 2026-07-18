/**
 * Notifications API — powers the dashboard inbox (assigned tickets, mentions,
 * comments). Scoped per project (we keep collaboration project-specific for now).
 */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { notifications } from "../../db/schema/notifications.ts";
import { users } from "../../db/schema/users.ts";
import { and, eq, desc, isNull, inArray } from "drizzle-orm";
import { getProjectAccess } from "../../auth/project-access.ts";
import { notify } from "../../services/notify.ts";
import { sendEmail } from "../../utils/email.ts";
import { env } from "../../config/env.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import type { auth } from "../../auth/index.ts";

function escapeHtmlText(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] || ch));
}

function parseRefs(raw: string | null): { type: string; id: string; name: string }[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

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
      refs: notifications.refs,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      actorName: users.name,
    })
    .from(notifications)
    .leftJoin(users, eq(notifications.actorId, users.id))
    .where(and(eq(notifications.userId, user.id), eq(notifications.projectId, projectId!)))
    .orderBy(desc(notifications.createdAt))
    .limit(100);

  return c.json({ notifications: rows.map((r) => ({ ...r, refs: parseRefs(r.refs) })) });
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

// POST /api/projects/:projectId/requests — send a request/review to a teammate
// (e.g. "please review these docs/tickets"). Lands in their inbox + emails them.
notificationsApi.post("/:projectId/requests", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const body = await c.req
    .json<{ toUserId: string; message: string; docIds?: string[]; ticketIds?: string[]; docId?: string }>()
    .catch(() => null);
  if (!body?.toUserId || !body.message?.trim()) {
    return c.json({ error: "toUserId and message are required" }, 400);
  }

  const docIds = [...new Set([...(body.docIds ?? []), ...(body.docId ? [body.docId] : [])])].filter(Boolean);
  const ticketIds = [...new Set(body.ticketIds ?? [])].filter(Boolean);

  // Resolve names for the referenced docs/tickets (scoped to this project).
  const docRows = docIds.length
    ? await db
        .select({ id: projectFiles.id, name: projectFiles.name })
        .from(projectFiles)
        .where(and(eq(projectFiles.projectId, access.project.id), inArray(projectFiles.id, docIds)))
    : [];
  const ticketRows = ticketIds.length
    ? await db
        .select({ id: projectTickets.id, name: projectTickets.name })
        .from(projectTickets)
        .where(and(eq(projectTickets.projectId, access.project.id), inArray(projectTickets.id, ticketIds)))
    : [];

  const link = ticketRows.length && !docRows.length
    ? `/projects/${projectId}?tab=tickets`
    : docRows.length
      ? `/projects/${projectId}?tab=documents`
      : `/projects/${projectId}`;

  const refs = [
    ...docRows.map((d) => `📄 ${d.name}`),
    ...ticketRows.map((t) => `🎫 ${t.name}`),
  ];
  const refSuffix = refs.length ? ` — re: ${refs.join(", ")}` : "";

  const structRefs = [
    ...docRows.map((d) => ({ type: "document" as const, id: d.id, name: d.name })),
    ...ticketRows.map((t) => ({ type: "ticket" as const, id: t.id, name: t.name })),
  ];

  const row = await notify({
    userId: body.toUserId,
    actorId: user.id,
    projectId: projectId!,
    type: "review_requested",
    targetType: docRows.length ? "document" : ticketRows.length ? "ticket" : "project",
    targetId: docRows[0]?.id ?? ticketRows[0]?.id ?? projectId!,
    message: `${user.name || "Someone"}: ${body.message.trim()}${refSuffix}`,
    link,
    refs: structRefs,
  });

  // Email the recipient (best-effort).
  const [recipient] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, body.toUserId));
  if (recipient?.email) {
    const base = env.APP_URL || env.BETTER_AUTH_URL || "";
    const url = base ? base.replace(/\/$/, "") + link : link;
    const refsHtml = refs.length ? `<ul>${refs.map((r) => `<li>${escapeHtmlText(r)}</li>`).join("")}</ul>` : "";
    sendEmail({
      to: recipient.email,
      subject: `${user.name || "Someone"} sent you a message in ${access.project.name}`,
      html: `<p><strong>${escapeHtmlText(user.name || "Someone")}</strong> sent you a message:</p><blockquote>${escapeHtmlText(body.message.trim())}</blockquote>${refsHtml}<p><a href="${url}">Open in LFG →</a></p>`,
      text: `${user.name || "Someone"} sent you a message: ${body.message.trim()}${refSuffix}\n\n${url}`,
    }).catch(() => {});
  }

  return c.json({ ok: true, notification: row }, 201);
});

// GET /api/projects/:projectId/requests/sent — requests the current user has sent
notificationsApi.get("/:projectId/requests/sent", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      message: notifications.message,
      link: notifications.link,
      refs: notifications.refs,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      toName: users.name,
      toEmail: users.email,
    })
    .from(notifications)
    .leftJoin(users, eq(notifications.userId, users.id))
    .where(
      and(
        eq(notifications.actorId, user.id),
        eq(notifications.projectId, projectId!),
        inArray(notifications.type, ["review_requested", "mentioned", "assigned"])
      )
    )
    .orderBy(desc(notifications.createdAt))
    .limit(100);

  return c.json({ requests: rows.map((r) => ({ ...r, refs: parseRefs(r.refs) })) });
});

// DELETE /api/projects/:projectId/requests/:id — sender unsends a message
notificationsApi.delete("/:projectId/requests/:id", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const [existing] = await db.select().from(notifications).where(eq(notifications.id, id!));
  if (!existing) return c.json({ error: "Message not found" }, 404);
  if (existing.actorId !== user.id) {
    return c.json({ error: "Only the sender can delete this message" }, 403);
  }

  await db.delete(notifications).where(eq(notifications.id, id!));
  return c.json({ ok: true });
});

export default notificationsApi;
