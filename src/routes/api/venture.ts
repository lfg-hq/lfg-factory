import { Hono } from "hono";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { ventureConversations, ventureMessages, ventureSources, ventureAssessments } from "../../db/schema/venture.ts";
import { getVentureAccess, googleConfigured, isVentureSameOrigin, ownedVentureConversation } from "../../services/venture-access.ts";
import { loggedRequest, ventureError } from "../../utils/request-log.ts";

import { analystReadiness, reserveTurn, runAssessment, runTurn, stopTurn, recoverInterrupted, VentureFailure } from '../../services/venture-analyst.ts';

type Variables = { userId: string; requestId: string };
const venture = new Hono<{ Variables: Variables }>();
venture.onError((_error, c) => ventureError(c.get("requestId"), 500, "STORAGE_UNAVAILABLE", "Private storage is temporarily unavailable. Retry; if it continues, contact support with this correlation ID."));
venture.use("*", async (c, next) => loggedRequest(c.req.raw,
  c.req.path.endsWith('/assessment') ? `venture.assessment.${c.req.method === 'POST' ? 'generate' : 'load'}` : c.req.path.endsWith('/stream') ? 'venture.stream.accept' : c.req.path.endsWith('/stop') ? 'venture.stream.stop' : c.req.path.endsWith("/session") ? "venture.session" : c.req.path.endsWith("/conversations") ? `venture.conversations.${c.req.method === "POST" ? "create" : "list"}` : "venture.conversation.load",
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

venture.get("/session", c => c.json({ ready: true, googleConnected: true, googleConfigured: googleConfigured(), ...analystReadiness(), requestId: c.get("requestId") }));
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
  await recoverInterrupted(conversation.id);
  const sources = await db.select().from(ventureSources).where(eq(ventureSources.conversationId, conversation.id));
  const messages = await db.select().from(ventureMessages).where(eq(ventureMessages.conversationId, conversation.id))
    .orderBy(asc(ventureMessages.createdAt), asc(ventureMessages.id));
  return c.json({ conversation, messages, sources, requestId: c.get("requestId") });
});
const turnPayload = z.object({ requestId: z.string().uuid(), content: z.string().trim().min(1).max(4000) }).strict();
async function boundedJson(request: Request, limit = 18000): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new VentureFailure('INVALID_MESSAGE', 400, 'Supply a message and unique request ID.');
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
    if (size > limit) { await reader.cancel(); throw new VentureFailure('PAYLOAD_TOO_LARGE', 413, 'Use at most 4,000 characters.'); } chunks.push(chunk.value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new VentureFailure('INVALID_MESSAGE', 400, 'Supply valid JSON and retry.'); }
}
venture.post('/conversations/:id/stream', async c => {
  const conversation = await ownedVentureConversation(c.req.param('id'), c.get('userId'));
  if (!conversation) return ventureError(c.get('requestId'), 404, 'CONVERSATION_NOT_FOUND', 'Select an owned conversation or create a new one.');
  if (!c.req.header('content-type')?.startsWith('application/json')) return ventureError(c.get('requestId'), 415, 'JSON_REQUIRED', 'Send a JSON message.');
  try {
    const payload = turnPayload.safeParse(await boundedJson(c.req.raw));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_MESSAGE', 'Use 1–4,000 characters and a unique UUID requestId; no project or owner fields.');
    const { requestId, content } = payload.data;
    const abort = await reserveTurn(conversation.id, c.get('userId'), requestId, content);
    const onAbort = () => abort.abort(new Error('CANCELLED'));
    c.req.raw.signal.addEventListener('abort', onAbort, { once: true });
    if (c.req.raw.signal.aborted) onAbort();
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: unknown) => { if (!closed) { try { controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')); } catch { closed = true; onAbort(); } } };
        void runTurn(conversation.id, requestId, abort, emit, c.get('requestId')).finally(() => {
          c.req.raw.signal.removeEventListener('abort', onAbort);
          if (!closed) { closed = true; controller.close(); }
        });
      },
      cancel() { closed = true; onAbort(); },
    });
    return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no', 'X-Turn-ID': requestId } });
  } catch (error) {
    if (error instanceof VentureFailure) return ventureError(c.get('requestId'), error.status, error.code, error.message);
    throw error;
  }
});
venture.post('/conversations/:id/stop', async c => {
  const conversation = await ownedVentureConversation(c.req.param('id'), c.get('userId'));
  if (!conversation) return ventureError(c.get('requestId'), 404, 'CONVERSATION_NOT_FOUND', 'Select an owned conversation.');
  try {
    const payload = z.object({ requestId: z.string().uuid() }).strict().safeParse(await boundedJson(c.req.raw, 512));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_REQUEST', 'Supply the active turn request ID.');
    const cancellationRequested = stopTurn(conversation.id, payload.data.requestId);
    return c.json({ cancellationRequested, requestId: c.get('requestId') });
  } catch (error) { if (error instanceof VentureFailure) return ventureError(c.get('requestId'), error.status, error.code, error.message); throw error; }
});
venture.get('/conversations/:id/assessment', async c => {
  const conversation = await ownedVentureConversation(c.req.param('id'), c.get('userId'));
  if (!conversation) return ventureError(c.get('requestId'), 404, 'CONVERSATION_NOT_FOUND', 'Select an owned conversation.');
  const [assessment] = await db.select().from(ventureAssessments).where(eq(ventureAssessments.conversationId, conversation.id)).orderBy(desc(ventureAssessments.version)).limit(1);
  const sources = await db.select().from(ventureSources).where(eq(ventureSources.conversationId, conversation.id));
  return c.json({ assessment: assessment || null, sources, requestId: c.get('requestId') });
});
venture.post('/conversations/:id/assessment', async c => {
  const conversation = await ownedVentureConversation(c.req.param('id'), c.get('userId'));
  if (!conversation) return ventureError(c.get('requestId'), 404, 'CONVERSATION_NOT_FOUND', 'Select an owned conversation.');
  if (!c.req.header('content-type')?.startsWith('application/json')) return ventureError(c.get('requestId'), 415, 'JSON_REQUIRED', 'Send a JSON request ID.');
  try {
    const payload = z.object({ requestId: z.string().uuid() }).strict().safeParse(await boundedJson(c.req.raw, 512));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_REQUEST', 'Supply a unique UUID requestId.');
    const abort = await reserveTurn(conversation.id, c.get('userId'), payload.data.requestId, 'Generate a saved assessment from the latest conversation and retrieved evidence.');
    const onAbort = () => abort.abort(new Error('CANCELLED'));
    c.req.raw.signal.addEventListener('abort', onAbort, { once: true });
    if (c.req.raw.signal.aborted) onAbort();
    try {
      const assessment = await runAssessment(conversation.id, payload.data.requestId, abort, c.get('requestId'));
      return c.json({ assessment, requestId: c.get('requestId') }, 201);
    } finally { c.req.raw.signal.removeEventListener('abort', onAbort); }
  } catch (error) { if (error instanceof VentureFailure) return ventureError(c.get('requestId'), error.status, error.code, error.message); throw error; }
});
venture.all("*", c => ventureError(c.get("requestId"), 404, "ENDPOINT_NOT_FOUND", "This venture endpoint is unavailable. Return to your conversation list."));
export default venture;
