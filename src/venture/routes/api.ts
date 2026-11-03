import { Hono } from "hono";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { ventureConversations, ventureMessages, ventureSources, ventureAssessments } from "../db/schema.ts";
import { getVentureAccess, googleConfigured, isVentureSameOrigin, ownedVentureConversation, viewableVentureConversation } from "../services/access.ts";
import { archiveVenture, deleteVenture, ventureLimit, dashboardList, METRICS, recordDecision, recordMetric, setTaskDone, updateWorkItem, ventureOverview, type MetricName } from "../services/dashboard.ts";
import { loggedRequest, ventureError } from "../request-log.ts";
import { env } from "../../config/env.ts";
import { connectDictation, transcribeDictation } from "../../services/dictation.ts";
import { AgreementFailure, requestChanges, respondToChanges, signAgreement } from "../services/agreements.ts";
import { DEAL_STRUCTURES, dealTermsProblem } from "../services/assessment.ts";
import { ventureAgreements } from "../db/schema.ts";

import { analystReadiness, reserveTurn, runAssessment, runTurn, stopTurn, recoverInterrupted, VentureFailure } from '../services/analyst.ts';

type Variables = { userId: string; requestId: string; isAdmin: boolean; viewer: { name: string; email: string } };
const venture = new Hono<{ Variables: Variables }>();
venture.onError((_error, c) => ventureError(c.get("requestId"), 500, "STORAGE_UNAVAILABLE", "Private storage is temporarily unavailable. Retry; if it continues, contact support with this correlation ID."));
venture.use("*", async (c, next) => loggedRequest(c.req.raw,
  c.req.path.includes('/dictation/') ? 'venture.dictation' : c.req.path.includes('/agreements/') ? `venture.agreement.${c.req.path.split('/').pop()}` : c.req.path.includes('/admin/work-items/') ? 'venture.admin.work' : c.req.path.endsWith('/metrics') ? 'venture.admin.metric' : c.req.path.includes('/admin/') ? 'venture.admin.decision' : c.req.path.endsWith('/dashboard') ? 'venture.dashboard.list' : c.req.path.endsWith('/overview') ? 'venture.dashboard.overview' : c.req.path.includes('/tasks/') ? 'venture.task.update' :
  c.req.path.endsWith('/assessment') ? `venture.assessment.${c.req.method === 'POST' ? 'generate' : 'load'}` : c.req.path.endsWith('/stream') ? 'venture.stream.accept' : c.req.path.endsWith('/stop') ? 'venture.stream.stop' : c.req.path.endsWith("/session") ? "venture.session" : c.req.path.endsWith("/conversations") ? `venture.conversations.${c.req.method === "POST" ? "create" : "list"}` : c.req.path.endsWith("/archive") ? "venture.archive" : c.req.method === "DELETE" ? "venture.conversation.delete" : "venture.conversation.load",
  async requestId => {
  c.set("requestId", requestId);
  c.header("Cache-Control", "private, no-store");
  const access = await getVentureAccess(c.req.raw.headers);
  if (!access.session) return ventureError(requestId, 401, "SIGN_IN_REQUIRED", "Continue with Google to open your private conversations.");
  if (!access.eligible) return ventureError(requestId, 403, "GOOGLE_LINK_REQUIRED", "Connect Google using Continue with Google, then retry.");
  c.set("userId", access.session.user.id);
  c.set("isAdmin", access.isAdmin);
  c.set("viewer", { name: access.session.user.name, email: access.session.user.email });
  if (!["GET", "HEAD"].includes(c.req.method) && !isVentureSameOrigin(c.req.raw)) {
    return ventureError(requestId, 403, "ORIGIN_REJECTED", "Open the venture page on this site and retry.");
  }
  await next();
  return c.res;
}));

venture.get("/session", async c => c.json({ ready: true, googleConnected: true, isAdmin: c.get("isAdmin"), googleConfigured: googleConfigured(), ventureLimit: await ventureLimit(c.get("userId"), c.get("isAdmin")), ...analystReadiness(), requestId: c.get("requestId") }));
venture.get("/conversations", async c => {
  const conversations = await db.select().from(ventureConversations)
    .where(and(eq(ventureConversations.userId, c.get("userId")), isNull(ventureConversations.archivedAt)))
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
  // Founders work on a limited number of ventures at a time; archiving frees a slot.
  const limit = await ventureLimit(c.get("userId"), c.get("isAdmin"));
  if (!limit.canCreate) return ventureError(c.get("requestId"), 409, "VENTURE_LIMIT", `You can have ${limit.max} active venture${limit.max === 1 ? "" : "s"} at a time. Archive one from your dashboard to start another.`);
  const [conversation] = await db.insert(ventureConversations).values({ userId: c.get("userId"), title: payload.data.title }).returning();
  return c.json({ conversation, requestId: c.get("requestId") }, 201);
});
venture.get("/conversations/:id", async c => {
  const conversation = await viewableVentureConversation(c.req.param("id"), c.get("userId"), c.get("isAdmin"));
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
  const conversation = await viewableVentureConversation(c.req.param('id'), c.get('userId'), c.get('isAdmin'));
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
venture.get('/dashboard', async c => {
  const all = c.req.query('scope') === 'all';
  if (all && !c.get('isAdmin')) return ventureError(c.get('requestId'), 403, 'ADMIN_REQUIRED', 'Only LFG venture reviewers can see every founder.');
  return c.json({ ventures: await dashboardList(c.get('userId'), all), isAdmin: c.get('isAdmin'), viewer: c.get('viewer'), ventureLimit: await ventureLimit(c.get('userId'), c.get('isAdmin')), usdPerMillionTokens: env.VENTURE_USD_PER_MILLION_TOKENS, requestId: c.get('requestId') });
});
venture.get('/conversations/:id/overview', async c => {
  const conversation = await viewableVentureConversation(c.req.param('id'), c.get('userId'), c.get('isAdmin'));
  if (!conversation) return ventureError(c.get('requestId'), 404, 'CONVERSATION_NOT_FOUND', 'This venture is unavailable. Select one from your dashboard.');
  const isOwner = conversation.userId === c.get('userId');
  return c.json({ ...(await ventureOverview(conversation.id, c.get('isAdmin'))), isOwner, isAdmin: c.get('isAdmin'), requestId: c.get('requestId') });
});
venture.patch('/tasks/:id', async c => {
  try {
    const payload = z.object({ done: z.boolean() }).strict().safeParse(await boundedJson(c.req.raw, 256));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_TASK', 'Send {"done": true|false}.');
    const task = await setTaskDone(c.req.param('id'), c.get('userId'), payload.data.done);
    if (!task) return ventureError(c.get('requestId'), 404, 'TASK_NOT_FOUND', 'Only the founder can update their own tasks.');
    return c.json({ task, requestId: c.get('requestId') });
  } catch (error) { if (error instanceof VentureFailure) return ventureError(c.get('requestId'), error.status, error.code, error.message); throw error; }
});
const dealShape = z.object({
  structure: z.enum(DEAL_STRUCTURES),
  equityPercent: z.number().min(0.1).max(49).nullable(),
  revenueSharePercent: z.number().min(0.5).max(50).nullable(),
  capMultiple: z.number().min(1).max(10).nullable(),
  termMonths: z.number().int().min(6).max(120).nullable(),
}).strict();
const dealPayload = dealShape.refine(d => !dealTermsProblem(d), { message: 'Inconsistent deal terms.' });
const decisionPayload = z.object({
  decision: z.enum(['approved', 'needs_more_info', 'declined', 'prohibited']),
  tokensApproved: z.number().int().nonnegative().max(1_000_000_000),
  founderNote: z.string().trim().max(2000).optional(),
  internalNote: z.string().trim().max(4000).optional(),
  deal: dealPayload.optional(),
}).strict()
  .refine(d => d.decision === 'approved' ? d.tokensApproved > 0 : d.tokensApproved === 0, { message: 'Approved decisions need tokens; others must be 0.' })
  .refine(d => d.decision === 'approved' ? Boolean(d.deal) : !d.deal, { message: 'Approvals need deal terms; other decisions carry none.' });
venture.post('/admin/conversations/:id/decision', async c => {
  if (!c.get('isAdmin')) return ventureError(c.get('requestId'), 403, 'ADMIN_REQUIRED', 'Only LFG venture reviewers can record funding decisions.');
  const conversation = await viewableVentureConversation(c.req.param('id'), c.get('userId'), true);
  if (!conversation) return ventureError(c.get('requestId'), 404, 'CONVERSATION_NOT_FOUND', 'This venture is unavailable.');
  try {
    const payload = decisionPayload.safeParse(await boundedJson(c.req.raw, 8000));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_DECISION', 'Choose a decision. Approving needs a positive token amount and consistent deal terms; other decisions use 0 tokens and no deal.');
    const decision = await recordDecision(conversation.id, c.get('userId'), payload.data);
    return c.json({ decision, requestId: c.get('requestId') }, 201);
  } catch (error) { if (error instanceof VentureFailure) return ventureError(c.get('requestId'), error.status, error.code, error.message); throw error; }
});
// Progress reports: LFG's build agents (and reviewers) record work status,
// token spend and results. Founders read them on the dashboard.
const workPayload = z.object({ status: z.enum(['planned', 'in_progress', 'shipped', 'blocked']).optional(), addTokens: z.number().int().positive().max(1_000_000_000).optional(), note: z.string().trim().max(1000).optional() }).strict()
  .refine(d => d.status !== undefined || d.addTokens !== undefined, { message: 'Change the status or add spent tokens.' });
venture.patch('/admin/work-items/:id', async c => {
  if (!c.get('isAdmin')) return ventureError(c.get('requestId'), 403, 'ADMIN_REQUIRED', 'Only LFG venture reviewers can report progress.');
  try {
    const payload = workPayload.safeParse(await boundedJson(c.req.raw, 2048));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_WORK_UPDATE', 'Send a status and/or a positive whole number of spent tokens.');
    const item = await updateWorkItem(c.req.param('id'), payload.data);
    if (!item) return ventureError(c.get('requestId'), 404, 'WORK_ITEM_NOT_FOUND', 'This work item is unavailable.');
    return c.json({ item, requestId: c.get('requestId') });
  } catch (error) { if (error instanceof VentureFailure) return ventureError(c.get('requestId'), error.status, error.code, error.message); throw error; }
});
const metricPayload = z.object({ name: z.enum(Object.keys(METRICS) as [MetricName, ...MetricName[]]), value: z.number().finite().nonnegative(), note: z.string().trim().max(500).optional() }).strict();
venture.post('/admin/conversations/:id/metrics', async c => {
  if (!c.get('isAdmin')) return ventureError(c.get('requestId'), 403, 'ADMIN_REQUIRED', 'Only LFG venture reviewers can record results.');
  const conversation = await viewableVentureConversation(c.req.param('id'), c.get('userId'), true);
  if (!conversation) return ventureError(c.get('requestId'), 404, 'CONVERSATION_NOT_FOUND', 'This venture is unavailable.');
  try {
    const payload = metricPayload.safeParse(await boundedJson(c.req.raw, 2048));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_METRIC', 'Choose a known metric and a non-negative number.');
    const metric = await recordMetric(conversation.id, payload.data.name, payload.data.value, payload.data.note);
    return c.json({ metric, requestId: c.get('requestId') }, 201);
  } catch (error) { if (error instanceof VentureFailure) return ventureError(c.get('requestId'), error.status, error.code, error.message); throw error; }
});
// Agreements: both sides sign; the founder may ask for changes first, and LFG
// answers manually with revised terms or a reply.
async function agreementAccess(c: any) {
  const [agreement] = await db.select().from(ventureAgreements).where(eq(ventureAgreements.id, c.req.param('id'))).limit(1);
  if (!agreement) return null;
  const conversation = await viewableVentureConversation(agreement.conversationId, c.get('userId'), c.get('isAdmin'));
  return conversation ? { agreement, isOwner: conversation.userId === c.get('userId') } : null;
}
const agreementError = (c: any, error: unknown) => {
  if (error instanceof AgreementFailure || error instanceof VentureFailure) return ventureError(c.get('requestId'), error.status, error.code, error.message);
  throw error;
};
const signPayload = z.object({ side: z.enum(['founder', 'lfg']), name: z.string().trim().min(2).max(120), consent: z.literal(true) }).strict();
venture.post('/agreements/:id/sign', async c => {
  try {
    const access = await agreementAccess(c);
    if (!access) return ventureError(c.get('requestId'), 404, 'AGREEMENT_NOT_FOUND', 'This agreement is unavailable.');
    const payload = signPayload.safeParse(await boundedJson(c.req.raw, 1024));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_SIGNATURE', 'Type your full name and confirm you agree.');
    if (payload.data.side === 'founder' && !access.isOwner) return ventureError(c.get('requestId'), 403, 'FOUNDER_ONLY', 'Only the founder signs for the founder.');
    if (payload.data.side === 'lfg' && !c.get('isAdmin')) return ventureError(c.get('requestId'), 403, 'ADMIN_REQUIRED', 'Only LFG venture reviewers sign for LFG.');
    const agreement = await signAgreement(access.agreement.id, payload.data.side, c.get('userId'), payload.data.name);
    return c.json({ agreement, requestId: c.get('requestId') });
  } catch (error) { return agreementError(c, error); }
});
const changesPayload = z.object({ message: z.string().trim().min(5).max(4000), proposed: dealShape.partial().optional() }).strict();
venture.post('/agreements/:id/changes', async c => {
  try {
    const access = await agreementAccess(c);
    if (!access) return ventureError(c.get('requestId'), 404, 'AGREEMENT_NOT_FOUND', 'This agreement is unavailable.');
    if (!access.isOwner) return ventureError(c.get('requestId'), 403, 'FOUNDER_ONLY', 'Only the founder can ask to change the terms.');
    const payload = changesPayload.safeParse(await boundedJson(c.req.raw, 8000));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_REQUEST', 'Explain what you would like to change.');
    const agreement = await requestChanges(access.agreement.id, c.get('userId'), payload.data.message, payload.data.proposed);
    return c.json({ agreement, requestId: c.get('requestId') });
  } catch (error) { return agreementError(c, error); }
});
const respondPayload = z.object({ message: z.string().trim().min(2).max(4000), revised: dealShape.extend({ tokens: z.number().int().positive().max(1_000_000_000).optional() }).strict().refine(d => !dealTermsProblem(d)).optional() }).strict();
venture.post('/admin/agreements/:id/respond', async c => {
  if (!c.get('isAdmin')) return ventureError(c.get('requestId'), 403, 'ADMIN_REQUIRED', 'Only LFG venture reviewers can respond.');
  try {
    const access = await agreementAccess(c);
    if (!access) return ventureError(c.get('requestId'), 404, 'AGREEMENT_NOT_FOUND', 'This agreement is unavailable.');
    const payload = respondPayload.safeParse(await boundedJson(c.req.raw, 8000));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_RESPONSE', 'Write a reply; revised terms must be consistent.');
    const agreement = await respondToChanges(access.agreement.id, c.get('userId'), payload.data.message, payload.data.revised);
    return c.json({ agreement, requestId: c.get('requestId') });
  } catch (error) { return agreementError(c, error); }
});
// Archive (reversible) and delete (permanent). Owners manage their own
// ventures; LFG reviewers can manage any. Signed deals are never deleted.
async function manageable(c: any) {
  const conversation = await viewableVentureConversation(c.req.param('id'), c.get('userId'), c.get('isAdmin'));
  return conversation && (conversation.userId === c.get('userId') || c.get('isAdmin')) ? conversation : null;
}
venture.post('/conversations/:id/archive', async c => {
  const conversation = await manageable(c);
  if (!conversation) return ventureError(c.get('requestId'), 404, 'CONVERSATION_NOT_FOUND', 'This venture is unavailable.');
  try {
    const payload = z.object({ archived: z.boolean() }).strict().safeParse(await boundedJson(c.req.raw, 256));
    if (!payload.success) return ventureError(c.get('requestId'), 400, 'INVALID_REQUEST', 'Send {"archived": true|false}.');
    if (!payload.data.archived && conversation.archivedAt && conversation.userId === c.get('userId')) {
      const limit = await ventureLimit(c.get('userId'), c.get('isAdmin'));
      if (!limit.canCreate) return ventureError(c.get('requestId'), 409, 'VENTURE_LIMIT', `You can have ${limit.max} active venture${limit.max === 1 ? '' : 's'} at a time. Archive another one first.`);
    }
    const updated = await archiveVenture(conversation.id, payload.data.archived);
    return c.json({ conversation: updated, requestId: c.get('requestId') });
  } catch (error) { if (error instanceof VentureFailure) return ventureError(c.get('requestId'), error.status, error.code, error.message); throw error; }
});
venture.delete('/conversations/:id', async c => {
  const conversation = await manageable(c);
  if (!conversation) return ventureError(c.get('requestId'), 404, 'CONVERSATION_NOT_FOUND', 'This venture is unavailable.');
  const result = await deleteVenture(conversation.id);
  if (!result.deleted) return ventureError(c.get('requestId'), 409, 'SIGNED_AGREEMENT', 'This venture has a signed, active agreement, so it is kept on record. Archive it instead.');
  return c.json({ deleted: true, requestId: c.get('requestId') });
});
// Dictation for the analyst chat: same transcription service as the main
// chat, behind the venture sign-in and paid by the platform key like the analyst.
const dictating = new Map<string, number>();
const dictationContext = z.object({
  prompt: z.string().trim().max(800).optional(),
  keywords: z.array(z.string().trim().min(1).max(80).regex(/^[^<>\r\n]+$/)).max(30).optional(),
}).strict();
for (const kind of ['session', 'transcribe'] as const) {
  venture.post(`/dictation/${kind}`, async c => {
    const key = env.OPENAI_API_KEY?.trim();
    if (!key) return ventureError(c.get('requestId'), 503, 'DICTATION_UNAVAILABLE', 'Dictation needs the platform OpenAI key. Type your message instead.');
    let file: File | undefined, data: unknown;
    try {
      if (kind === 'session') data = await boundedJson(c.req.raw, 70_000);
      else {
        if (Number(c.req.header('content-length') || 0) > 12 * 1024 * 1024) return ventureError(c.get('requestId'), 413, 'RECORDING_TOO_LARGE', 'That recording is too long. Try a shorter one.');
        const form = await c.req.formData(), audio = form.get('audio');
        if (!(audio instanceof File) || !audio.size || audio.size > 10 * 1024 * 1024 || !/^(audio\/(webm|mp4|ogg|wav|mpeg)|video\/(webm|mp4))(;.*)?$/.test(audio.type)) return ventureError(c.get('requestId'), 400, 'INVALID_RECORDING', 'Unsupported or oversized recording.');
        file = audio; data = JSON.parse(String(form.get('context') || '{}'));
      }
    } catch { return ventureError(c.get('requestId'), 400, 'INVALID_RECORDING', 'Invalid dictation request.'); }
    const shape = kind === 'session' ? dictationContext.extend({ sdp: z.string().min(20).max(60000).startsWith('v=0') }) : dictationContext;
    const parsed = shape.safeParse(data);
    if (!parsed.success) return ventureError(c.get('requestId'), 400, 'INVALID_RECORDING', 'Invalid dictation request.');
    const userId = c.get('userId');
    if ((dictating.get(userId) || 0) >= 2) return ventureError(c.get('requestId'), 429, 'DICTATION_BUSY', 'Another recording is still processing. Retry shortly.');
    dictating.set(userId, (dictating.get(userId) || 0) + 1);
    const { prompt, keywords } = parsed.data as z.infer<typeof dictationContext>;
    const context = { ...(prompt ? { prompt } : {}), ...(keywords?.length ? { keywords } : {}) };
    try {
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(kind === 'session' ? 25_000 : 60_000)]);
      if (kind === 'session') return c.body(await connectDictation((parsed.data as { sdp: string }).sdp, key, signal, context), 200, { 'Content-Type': 'application/sdp' });
      return c.json({ text: await transcribeDictation(file!, key, signal, context) });
    } catch (error: any) {
      return ventureError(c.get('requestId'), 502, 'DICTATION_FAILED', [401, 403].includes(error?.statusCode) ? 'Transcription access was denied. Type your message, or ask LFG to check the platform key.' : 'Transcription could not finish. Your recording is available to retry.');
    } finally { const n = (dictating.get(userId) || 1) - 1; if (n) dictating.set(userId, n); else dictating.delete(userId); }
  });
}
venture.all("*", c => ventureError(c.get("requestId"), 404, "ENDPOINT_NOT_FOUND", "This venture endpoint is unavailable. Return to your conversation list."));
export default venture;
