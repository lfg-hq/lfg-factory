import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { documentComments } from "../../db/schema/comments.ts";
import { users } from "../../db/schema/users.ts";
import { eq, and, asc, isNull } from "drizzle-orm";
import { getProjectAccess, requirePermission } from "../../auth/project-access.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const commentsApi = new Hono<AuthEnv>();
commentsApi.use("*", requireAuth);

// ── GET /api/projects/:projectId/files/:fileId/comments ──────────────
commentsApi.get("/:projectId/files/:fileId/comments", async (c) => {
  const user = c.get("user");
  const { projectId, fileId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  // Fetch top-level comments with user info
  const topLevel = await db
    .select({
      id: documentComments.id,
      fileId: documentComments.fileId,
      userId: documentComments.userId,
      selectedText: documentComments.selectedText,
      rangeStart: documentComments.rangeStart,
      rangeEnd: documentComments.rangeEnd,
      content: documentComments.content,
      parentId: documentComments.parentId,
      isResolved: documentComments.isResolved,
      resolvedById: documentComments.resolvedById,
      resolvedAt: documentComments.resolvedAt,
      createdAt: documentComments.createdAt,
      updatedAt: documentComments.updatedAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(documentComments)
    .innerJoin(users, eq(documentComments.userId, users.id))
    .where(
      and(
        eq(documentComments.fileId, fileId!),
        isNull(documentComments.parentId)
      )
    )
    .orderBy(asc(documentComments.rangeStart));

  // Fetch all replies
  const replies = await db
    .select({
      id: documentComments.id,
      fileId: documentComments.fileId,
      userId: documentComments.userId,
      content: documentComments.content,
      parentId: documentComments.parentId,
      createdAt: documentComments.createdAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(documentComments)
    .innerJoin(users, eq(documentComments.userId, users.id))
    .where(eq(documentComments.fileId, fileId!))
    .orderBy(asc(documentComments.createdAt));

  // Nest replies under parents
  const replyMap = new Map<string, typeof replies>();
  for (const reply of replies) {
    if (!reply.parentId) continue;
    if (!replyMap.has(reply.parentId)) replyMap.set(reply.parentId, []);
    replyMap.get(reply.parentId)!.push(reply);
  }

  const comments = topLevel.map((comment) => ({
    ...comment,
    replies: replyMap.get(comment.id) ?? [],
  }));

  return c.json({ comments });
});

// ── POST /api/projects/:projectId/files/:fileId/comments ─────────────
commentsApi.post("/:projectId/files/:fileId/comments", async (c) => {
  const user = c.get("user");
  const { projectId, fileId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try { requirePermission(access, "canChat"); } catch { return c.json({ error: "Forbidden" }, 403); }

  const body = await c.req.json<{
    selectedText: string;
    rangeStart: number;
    rangeEnd: number;
    content: string;
  }>();

  if (!body.content?.trim() || !body.selectedText) {
    return c.json({ error: "content and selectedText are required" }, 400);
  }

  const [comment] = await db
    .insert(documentComments)
    .values({
      fileId: fileId!,
      userId: user.id,
      selectedText: body.selectedText,
      rangeStart: body.rangeStart,
      rangeEnd: body.rangeEnd,
      content: body.content.trim(),
    })
    .returning();

  return c.json({ comment }, 201);
});

// ── PATCH /api/projects/:projectId/files/:fileId/comments/:id ────────
commentsApi.patch("/:projectId/files/:fileId/comments/:id", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const [existing] = await db
    .select()
    .from(documentComments)
    .where(eq(documentComments.id, id!));

  if (!existing) return c.json({ error: "Comment not found" }, 404);
  if (existing.userId !== user.id) return c.json({ error: "Only the author can edit" }, 403);

  const body = await c.req.json<{ content: string }>();

  const [updated] = await db
    .update(documentComments)
    .set({ content: body.content.trim(), updatedAt: new Date() })
    .where(eq(documentComments.id, id!))
    .returning();

  return c.json({ comment: updated });
});

// ── DELETE /api/projects/:projectId/files/:fileId/comments/:id ───────
commentsApi.delete("/:projectId/files/:fileId/comments/:id", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const [existing] = await db
    .select()
    .from(documentComments)
    .where(eq(documentComments.id, id!));

  if (!existing) return c.json({ error: "Comment not found" }, 404);
  if (existing.userId !== user.id && access.role !== "owner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db.delete(documentComments).where(eq(documentComments.id, id!));
  return c.json({ success: true });
});

// ── POST /api/projects/:projectId/files/:fileId/comments/:id/reply ───
commentsApi.post("/:projectId/files/:fileId/comments/:id/reply", async (c) => {
  const user = c.get("user");
  const { projectId, fileId, id } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try { requirePermission(access, "canChat"); } catch { return c.json({ error: "Forbidden" }, 403); }

  const [parent] = await db
    .select()
    .from(documentComments)
    .where(eq(documentComments.id, id!));

  if (!parent) return c.json({ error: "Parent comment not found" }, 404);

  const body = await c.req.json<{ content: string }>();
  if (!body.content?.trim()) return c.json({ error: "content is required" }, 400);

  const [reply] = await db
    .insert(documentComments)
    .values({
      fileId: fileId!,
      userId: user.id,
      selectedText: parent.selectedText,
      rangeStart: parent.rangeStart,
      rangeEnd: parent.rangeEnd,
      content: body.content.trim(),
      parentId: id!,
    })
    .returning();

  return c.json({ comment: reply }, 201);
});

// ── PATCH /api/projects/:projectId/files/:fileId/comments/:id/resolve
commentsApi.patch("/:projectId/files/:fileId/comments/:id/resolve", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const [existing] = await db
    .select()
    .from(documentComments)
    .where(eq(documentComments.id, id!));

  if (!existing) return c.json({ error: "Comment not found" }, 404);

  // Owner/admin can resolve any, others can resolve their own
  if (existing.userId !== user.id && access.role !== "owner" && access.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [updated] = await db
    .update(documentComments)
    .set({
      isResolved: !existing.isResolved,
      resolvedById: existing.isResolved ? null : user.id,
      resolvedAt: existing.isResolved ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(eq(documentComments.id, id!))
    .returning();

  return c.json({ comment: updated });
});

export default commentsApi;
