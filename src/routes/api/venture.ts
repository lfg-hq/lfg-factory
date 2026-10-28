import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { ventureConversations, ventureMessages } from "../../db/schema/venture.ts";
import { getVentureAccess, googleConfigured, isVentureSameOrigin, ownedVentureConversation } from "../../services/venture-access.ts";
import { loggedRequest, ventureError } from "../../utils/request-log.ts";

type Variables = { userId: string; requestId: string };
const venture = new Hono<{ Variables: Variables }>();
venture.onError((_error, c) => ventureError(c.get("requestId"), 500, "STORAGE_UNAVAILABLE", "Private storage is temporarily unavailable. Retry; if it continues, contact support with this correlation ID."));
venture.use("*", async (c, next) => loggedRequest(c.req.raw,
  c.req.path.endsWith("/session") ? "venture.session" : c.req.path.endsWith("/conversations") ? `venture.conversations.${c.req.method === "POST" ? "create" : "list"}` : "venture.conversation.load",
  async requestId => {
  c.set("requestId", requestId);
  c.header("Cache-Control", "private, no-store");
  const access = await getVentureAccess(c.req.raw.headers);
  if (!access.session) return ventureError(requestId, 401, "SIGN_IN_REQUIRED", "Continue with Google to open your private conversations.");
  if (!access.eligible) return ventureError(requestId, 403, "GOOGLE_LINK_REQUIRED", "Connect Google using Continue with Google, then retry.");
  c.set("userId", access.session.user.id);
  if (!["GET", "HEAD"].includes(c.req.method) && !isVentureSameOrigin(c.req.raw)) {
    return ventureError(requestId, 403, "ORIGIN_REJECTED", "Open the venture page on this site and retry.");
  }
  await next();
  return c.res;
}));

venture.get("/session", c => c.json({ ready: true, googleConnected: true, googleConfigured: googleConfigured(), streamingAvailable: false, requestId: c.get("requestId") }));
venture.get("/conversations", async c => {
  const conversations = await db.select().from(ventureConversations)
    .where(eq(ventureConversations.userId, c.get("userId")))
    .orderBy(desc(ventureConversations.updatedAt), desc(ventureConversations.id)).limit(100);
  return c.json({ conversations, requestId: c.get("requestId") });
});
const createPayload = z.object({ title: z.string().trim().min(1).max(160).optional() }).strict();
venture.post("/conversations", async c => {
  if (!c.req.header("content-type")?.startsWith("application/json")) return ventureError(c.get("requestId"), 415, "JSON_REQUIRED", "Send a JSON conversation title and retry.");
  if (Number(c.req.header("content-length") || 0) > 2048) return ventureError(c.get("requestId"), 413, "PAYLOAD_TOO_LARGE", "Use a title of at most 160 characters.");
  // Bound streamed/chunked bodies too, not just Content-Length.
  const reader = c.req.raw.body?.getReader();
  let body = "";
  if (reader) {
    const decoder = new TextDecoder();
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2048) { await reader.cancel(); return ventureError(c.get("requestId"), 413, "PAYLOAD_TOO_LARGE", "Use a title of at most 160 characters."); }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  }
  let payload;
  try { payload = createPayload.safeParse(JSON.parse(body)); } catch { /* invalid JSON */ }
  if (!payload?.success) return ventureError(c.get("requestId"), 400, "INVALID_CONVERSATION", "Supply only an optional title, up to 160 characters, and retry.");
  const [conversation] = await db.insert(ventureConversations).values({ userId: c.get("userId"), title: payload.data.title }).returning();
  return c.json({ conversation, requestId: c.get("requestId") }, 201);
});
venture.get("/conversations/:id", async c => {
  const conversation = await ownedVentureConversation(c.req.param("id"), c.get("userId"));
  if (!conversation) return ventureError(c.get("requestId"), 404, "CONVERSATION_NOT_FOUND", "This conversation is unavailable. Select one from your history or create a new one.");
  const messages = await db.select().from(ventureMessages).where(eq(ventureMessages.conversationId, conversation.id))
    .orderBy(asc(ventureMessages.createdAt), asc(ventureMessages.id));
  return c.json({ conversation, messages, requestId: c.get("requestId") });
});
venture.all("*", c => ventureError(c.get("requestId"), 404, "ENDPOINT_NOT_FOUND", "This venture endpoint is unavailable. Return to your conversation list."));
export default venture;
