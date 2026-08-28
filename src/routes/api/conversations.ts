import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { conversations, messages } from "../../db/schema/chat.ts";
import { projects } from "../../db/schema/projects.ts";
import { users } from "../../db/schema/users.ts";
import { eq, and, inArray } from "drizzle-orm";
import { getChatAccess } from "../../services/chat-access.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const conversationsApi = new Hono<AuthEnv>();
conversationsApi.use("*", requireAuth);

// POST /api/conversations/:id/pin — pin or unpin a chat.
//
// Pinning is per CONVERSATION, not per viewer: a chat belongs to whoever started it,
// and getChatAccess already decides who may touch it. Body { pinned: boolean }; omit it
// to toggle.
conversationsApi.post("/:id/pin", async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  // getChatAccess RETURNS a verdict rather than throwing, so a truthiness check would
  // have let a denied viewer pin someone else's chat.
  const access = await getChatAccess(id, user.id);
  if (!access.canRead) return c.json({ error: "Conversation not found" }, 404);
  if (!access.canWrite) return c.json({ error: "You can't pin a chat you don't own" }, 403);

  const [row] = await db.select({ pinnedAt: conversations.pinnedAt })
    .from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!row) return c.json({ error: "Conversation not found" }, 404);

  const body = await c.req.json().catch(() => ({})) as { pinned?: boolean };
  const wantPinned = typeof body.pinned === "boolean" ? body.pinned : !row.pinnedAt;

  await db.update(conversations)
    .set({ pinnedAt: wantPinned ? new Date() : null })
    .where(eq(conversations.id, id));

  return c.json({ ok: true, pinned: wantPinned });
});

// GET /api/conversations/:id/
conversationsApi.get("/:id", async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();
  console.log("[conversations] GET", id, "user:", user?.id);

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));

  const access = conv ? await getChatAccess(id, user.id) : null;
  if (!conv || !access?.canRead) {
    return c.json({ error: "Not found" }, 404);
  }

  // Load messages
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  // Names for any guest turns (an owner/admin who continued this chat).
  const guestIds = [...new Set(msgs.map((m) => m.authorId).filter(Boolean))] as string[];
  const authorNames: Record<string, string> = {};
  if (guestIds.length) {
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, guestIds));
    for (const r of rows) authorNames[r.id] = r.name;
  }

  // Load project info if linked (conv.projectId stores the URL-based projectId)
  let project = null;
  if (conv.projectId) {
    const [proj] = await db
      .select({ id: projects.projectId, name: projects.name })
      .from(projects)
      .where(eq(projects.projectId, conv.projectId));
    project = proj ?? null;
  }

  return c.json({
    id: conv.id,
    title: conv.title,
    project,
    // A teammate's shared chat: readable by any member, continuable only by an
    // owner/admin — the UI hides the composer when read_only.
    is_mine: access.isAuthor,
    read_only: !access.canWrite,
    messages: msgs.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      content_if_file: m.contentIfFile ?? null,
      created_at: m.createdAt,
      // What the agent did during this turn, so reopening the chat still shows it.
      activity_trail: m.activityTrail ?? null,
      // Previews rendered in this turn, so reopening the chat shows the card again.
      page_previews: m.pagePreviews ?? null,
      // Dictated, so the transcript can show a mic rather than looking typed.
      is_voice: !!m.isVoice,
      // Null on every normal message (the conversation's own author). Set when an
      // owner/admin stepped into this chat, so the UI can label that turn.
      author: m.authorId ? (authorNames[m.authorId] ?? "Teammate") : null,
    })),
  });
});

// GET /api/conversations/:id/files — chat.js fetches attached files
conversationsApi.get("/:id/files", async (c) => {
  // Return empty list — file attachments not yet implemented in Node rewrite
  return c.json({ files: [] });
});

// DELETE /api/conversations/:id  (chat.js calls with trailing slash → trimTrailingSlash covers GET but not DELETE)
conversationsApi.delete("/:id", async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)));

  if (!conv) return c.json({ error: "Not found" }, 404);

  await db.delete(conversations).where(eq(conversations.id, id));
  return c.json({ success: true });
});

// POST /api/conversations/
conversationsApi.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ project_id?: string; title?: string }>().catch(() => ({ project_id: undefined, title: undefined }));

  const [conv] = await db
    .insert(conversations)
    .values({
      userId: user.id,
      // conversations.projectId stores the URL-based projectId (public UUID)
      projectId: body.project_id ?? null,
      title: body.title ?? "New conversation",
    })
    .returning();

  return c.json({ id: conv!.id, title: conv!.title });
});

export default conversationsApi;
