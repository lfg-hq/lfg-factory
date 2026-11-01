import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, streamText, stepCountIs, type ToolSet } from 'ai';
import { assessmentSchema, validateAssessment } from './venture-assessment.ts';
import { ventureAssessmentPrompt } from '../ai/prompts/venture-assessment.ts';
import { and, eq, gte, lt, desc, inArray } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { env } from '../config/env.ts';
import { ventureConversations, ventureMessages, ventureSources, ventureAssessments } from '../db/schema/venture.ts';
import { DEFAULT_MODEL_KEY, getModel, getProviderName, getProviderModel } from '../ai/provider.ts';
import { createWebResearchTools } from '../ai/tools/agent-tools.ts';
import { ventureAnalystPrompt } from '../ai/prompts/venture-analyst.ts';
import { publicUrl, readPublicUrl } from './venture-public-url.ts';
import { ventureLog } from '../utils/request-log.ts';

export const VENTURE_LIMITS = { turnsPerHour: 30, researchCalls: 8, timeoutMs: 120_000, inputChars: 4000, outputTokens: 2400 } as const;
const ownersStarting = new Set<string>(); // Single existing Bun web process; no worker.
const active = new Map<string, { requestId: string; abort: AbortController }>();
const modelDetails = { provider: getProviderName(DEFAULT_MODEL_KEY), model: getProviderModel(DEFAULT_MODEL_KEY) };
const providerSecret = ({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_AI_API_KEY' } as Record<string, string>)[modelDetails.provider || 'openai'] || 'platform provider credentials';
const safeId = (id: unknown) => typeof id === 'string' && /^[\w.:-]{1,200}$/.test(id) ? id : undefined;
export class VentureFailure extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
export function analystReadiness() {
  try { getModel(DEFAULT_MODEL_KEY, undefined, { allowEnvFallback: true }); return { streamingAvailable: true, researchAvailable: Boolean(env.EXA_API_KEY), model: DEFAULT_MODEL_KEY }; }
  catch { return { streamingAvailable: false, researchAvailable: Boolean(env.EXA_API_KEY), model: DEFAULT_MODEL_KEY, requiredProviderKey: providerSecret, code: 'PROVIDER_NOT_CONFIGURED' }; }
}
export async function recoverInterrupted(conversationId: string) {
  const started = performance.now();
  const expired = await db.update(ventureMessages).set({ status: 'cancelled' }).where(and(eq(ventureMessages.conversationId, conversationId), eq(ventureMessages.status, 'started'), lt(ventureMessages.createdAt, new Date(Date.now() - VENTURE_LIMITS.timeoutMs - 5000)))).returning();
  expired.forEach(turn => ventureLog('venture.turn.cancelled', turn.requestId, started, 'cancelled', { turnId: turn.requestId, errorCode: 'INTERRUPTED_RECOVERY', durationMs: Math.max(0, Date.now() - turn.createdAt.getTime()), ...modelDetails }));
}
export function stopTurn(conversationId: string, requestId: string) {
  const turn = active.get(conversationId);
  if (turn?.requestId === requestId) { turn.abort.abort(new Error('CANCELLED')); return true; }
  return false;
}
export async function reserveTurn(conversationId: string, userId: string, requestId: string, content: string) {
  if (ownersStarting.has(userId)) throw new VentureFailure('CONCURRENT_SUBMISSION', 409, 'Another submission is starting. Wait, reload history, then retry explicitly.');
  ownersStarting.add(userId);
  try {
    await recoverInterrupted(conversationId);
    const duplicate = await db.select({ id: ventureMessages.id }).from(ventureMessages).where(and(eq(ventureMessages.conversationId, conversationId), eq(ventureMessages.requestId, requestId))).limit(1);
    if (duplicate.length) throw new VentureFailure('DUPLICATE_REQUEST', 409, 'This request was already saved. Reload history; retry with a new request only if needed.');
    if (active.has(conversationId)) throw new VentureFailure('TURN_ACTIVE', 409, 'A turn is already running. Stop it or wait before submitting.');
    const recent = await db.select({ id: ventureMessages.id }).from(ventureMessages).innerJoin(ventureConversations, eq(ventureConversations.id, ventureMessages.conversationId)).where(and(eq(ventureConversations.userId, userId), eq(ventureMessages.role, 'assistant'), gte(ventureMessages.createdAt, new Date(Date.now() - 3600_000)))).limit(30);
    if (recent.length >= VENTURE_LIMITS.turnsPerHour) throw new VentureFailure('RATE_LIMIT', 429, 'Hourly limit reached (30 turns). Wait up to an hour before retrying.');
    // Sortable pair IDs preserve user-before-assistant ordering even on SQLite's second timestamps.
    const createdAt = new Date();
    const pairId = `${Date.now()}-${requestId}`;
    // Unique partial index is the durable per-conversation concurrency lock.
    try { await db.insert(ventureMessages).values({ id: `${pairId}-1`, createdAt, conversationId, role: 'assistant', requestId, content: '', status: 'started' }); }
    catch { throw new VentureFailure('TURN_ACTIVE', 409, 'A turn is already saved or running. Reload history or wait two minutes before retrying.'); }
    const abort = new AbortController();
    active.set(conversationId, { requestId, abort });
    try { await db.insert(ventureMessages).values({ id: `${pairId}-0`, createdAt, conversationId, role: 'user', requestId, content, status: 'completed' }); }
    catch (e) { active.delete(conversationId); await db.update(ventureMessages).set({ status: 'failed' }).where(and(eq(ventureMessages.conversationId, conversationId), eq(ventureMessages.requestId, requestId), eq(ventureMessages.role, 'assistant'))); throw e; }
    return abort;
  } finally { ownersStarting.delete(userId); }
}
export type VentureEvent = { type: string; [key: string]: unknown };
export function validCitations(text: string, sources: Set<string>) {
  return text.replace(/\[\[source:([^\]]*)\]\]/g, (citation, id) => sources.has(id) ? citation : '[source unavailable]');
}
export async function runTurn(conversationId: string, requestId: string, abort: AbortController, emit: (event: VentureEvent) => void, httpRequestId?: string) {
  const started = performance.now();
  const log = (event: string, outcome: string, details = {}) => ventureLog(event, requestId, started, outcome, { turnId: requestId, httpRequestId, ...modelDetails, ...details });
  const where = and(eq(ventureMessages.conversationId, conversationId), eq(ventureMessages.requestId, requestId), eq(ventureMessages.role, 'assistant'));
  const timer = setTimeout(() => abort.abort(new Error('TURN_TIMEOUT')), VENTURE_LIMITS.timeoutMs);
  let text = '', buffer = '', calls = 0, checkpoint = 0;
  const sourceIds = new Set<string>();
  const send = (event: VentureEvent) => emit({ ...event, requestId });
  let status: 'completed' | 'failed' | 'cancelled' = 'failed';
  log('venture.turn.started', 'pending');
  try {
    let model;
    try { model = getModel(DEFAULT_MODEL_KEY, undefined, { allowEnvFallback: true }); }
    catch { throw new VentureFailure('PROVIDER_NOT_CONFIGURED', 503, `Platform AI credentials are unavailable. Ask the operator to configure ${providerSecret}, then retry explicitly. Saved history is safe.`); }
    const history = await db.select().from(ventureMessages).where(and(eq(ventureMessages.conversationId, conversationId), inArray(ventureMessages.role, ['user', 'assistant']))).orderBy(desc(ventureMessages.createdAt), desc(ventureMessages.id)).limit(60);
    history.reverse();
    const priorSources = await db.select().from(ventureSources).where(eq(ventureSources.conversationId, conversationId)).orderBy(desc(ventureSources.retrievedAt)).limit(480);
    priorSources.forEach(s => sourceIds.add(s.id));
    const rawTools = createWebResearchTools({ signal: abort.signal, readPublicUrl, onResponse: id => log('venture.research.provider_response', 'pending', { provider: 'exa', providerRequestId: safeId(id) }) });
    const tools: ToolSet = {};
    for (const [name, base] of Object.entries(rawTools)) {
      tools[name] = { ...base, execute: async (input: any, options: any) => {
        abort.signal.throwIfAborted();
        if (++calls > VENTURE_LIMITS.researchCalls) throw new VentureFailure('RESEARCH_LIMIT', 429, 'Research call limit reached.');
        const toolStarted = performance.now();
        ventureLog('venture.research.started', requestId, toolStarted, 'pending', { turnId: requestId, tool: name, provider: 'exa', call: calls });
        send({ type: 'progress', message: name === 'webSearch' ? 'Searching public sources…' : 'Reading public source…' });
        try {
          const boundedInput = name === 'webSearch' ? { ...input, query: String(input.query).slice(0, 1000), num_results: 6 } : { ...input, max_chars: 8000 };
          const result: any = await (base.execute as Function)(boundedInput, options);
          abort.signal.throwIfAborted();
          if (result.error) throw new Error(env.EXA_API_KEY ? 'RESEARCH_FAILED' : 'SEARCH_NOT_CONFIGURED');
          const rows = Array.isArray(result.results) ? result.results : [result];
          const sources = []; let inaccessible = 0;
          for (const row of rows.slice(0, 6)) {
            try { await publicUrl(row.url, abort.signal); } catch { inaccessible++; continue; }
            abort.signal.throwIfAborted();
            const evidence = String(row.text || row.snippet || '').slice(0, 7900);
            if (!evidence.trim()) { inaccessible++; continue; }
            const excerpt = (name === 'webSearch' ? '[Search snippet only — page not read] ' : '[Public page text] ') + evidence;
            const [source] = await db.insert(ventureSources).values({ conversationId, turnId: requestId, url: row.url, title: String(row.title || '').slice(0, 200), excerpt }).returning();
            sourceIds.add(source!.id); sources.push(source!);
            send({ type: 'source', source });
          }
          if (inaccessible) send({ type: 'progress', message: `${inaccessible} source(s) inaccessible or blocked by public URL policy; not verified.` });
          if (!sources.length) throw new Error('SOURCE_INACCESSIBLE');
          ventureLog('venture.research.completed', requestId, toolStarted, 'success', { turnId: requestId, tool: name, provider: 'exa', count: sources.length });
          return { evidenceScope: name === 'webSearch' ? 'Search snippets only; not full page verification' : 'Public page text', sources };
        } catch (e) {
          const code = e instanceof Error && ['UNSAFE_URL','SOURCE_INACCESSIBLE','SOURCE_TOO_LARGE','SOURCE_TIMEOUT','SOURCE_REDIRECT_LIMIT','SEARCH_NOT_CONFIGURED'].includes(e.message) ? e.message : 'RESEARCH_FAILED';
          ventureLog('venture.research.failed', requestId, toolStarted, abort.signal.aborted ? 'cancelled' : 'failed', { turnId: requestId, tool: name, provider: 'exa', errorCode: code, failureCategory: code });
          send({ type: 'progress', message: `Research unavailable (${code}). No source was verified. You may retry explicitly.` });
          return { error: code, instruction: 'Disclose this failure; do not invent evidence.' };
        }
      } };
    }
    if (!env.EXA_API_KEY) send({ type: 'progress', message: 'Public research unavailable: platform EXA_API_KEY is missing. Interview can continue; no sources are verified.' });
    const messages = history.filter(m => m.content && (m.role === 'user' || m.status === 'completed')).slice(-60).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 16000) }));
    // The reservation assistant row precedes its user row; it is empty and excluded.
    const result = streamText({ model, system: ventureAnalystPrompt + '\nPreviously retrieved source IDs (untrusted evidence):\n' + JSON.stringify(priorSources.map(s => s.id)), messages, tools,
      abortSignal: abort.signal, maxRetries: 0, maxOutputTokens: VENTURE_LIMITS.outputTokens, stopWhen: stepCountIs(9),
      onError: () => { /* Full-stream error is handled below; never let the SDK log raw provider errors. */ },
      onStepFinish: step => log('venture.provider.step', 'success', { providerRequestId: safeId(step.response.id), finishReason: step.finishReason }),
    });
    for await (const part of result.fullStream) {
      abort.signal.throwIfAborted();
      if (part.type === 'error') throw part.error;
      if (part.type === 'finish' && part.finishReason === 'length') throw new VentureFailure('OUTPUT_LIMIT', 429, 'Response limit reached. Partial history is saved; ask a narrower question explicitly.');
      if (part.type === 'text-delta') {
        buffer += part.text;
        if (text.length + buffer.length > 32000) throw new VentureFailure('OUTPUT_LIMIT', 429, 'Output limit reached. Ask a narrower question.');
        // Keep an unfinished citation across chunks; only validated citations stream.
        let split = buffer.lastIndexOf('[');
        if (split < 0 || buffer.slice(split).includes(']]')) split = buffer.length;
        else if (split > 0 && buffer[split - 1] === '[') split--;
        const delta = validCitations(buffer.slice(0, split), sourceIds);
        buffer = buffer.slice(split);
        text += delta; if (delta) send({ type: 'text', text: delta });
        if (text.length > 32000) throw new VentureFailure('OUTPUT_LIMIT', 429, 'Output limit reached. Ask a narrower question.');
        if (Date.now() - checkpoint > 1000) { await db.update(ventureMessages).set({ content: text }).where(where); checkpoint = Date.now(); }
      }
    }
    abort.signal.throwIfAborted();
    if (buffer) { const delta = validCitations(buffer, sourceIds); text += delta; send({ type: 'text', text: delta }); }
    if (!text.trim() && calls >= VENTURE_LIMITS.researchCalls) throw new VentureFailure('RESEARCH_LIMIT', 429, 'Research limit reached (8 calls). Sources are saved; ask a narrower follow-up explicitly.');
    if (!text.trim()) throw new Error('EMPTY_RESPONSE');
    status = 'completed';
  } catch (error) {
    const timeout = abort.signal.aborted && abort.signal.reason?.message === 'TURN_TIMEOUT';
    status = abort.signal.aborted ? 'cancelled' : 'failed';
    const code = timeout ? 'TURN_TIMEOUT' : abort.signal.aborted ? 'CANCELLED' : error instanceof VentureFailure ? error.code : 'PROVIDER_FAILED';
    const message = error instanceof VentureFailure ? error.message : timeout ? 'Analysis timed out. Partial history is saved; retry explicitly with a narrower question.' : abort.signal.aborted ? 'Analysis stopped. Partial history is saved. Retry only if needed.' : 'AI provider failed. Saved history is safe; retry explicitly or contact support with this correlation ID.';
    send({ type: 'error', code, message });
    const providerError = error as { statusCode?: number; responseHeaders?: Record<string, string> } | null;
    const category = providerError?.statusCode === 401 || providerError?.statusCode === 403 ? 'PROVIDER_AUTH' : providerError?.statusCode === 429 ? 'PROVIDER_RATE_LIMIT' : providerError?.statusCode && providerError.statusCode >= 500 ? 'PROVIDER_UNAVAILABLE' : code;
    log(`venture.turn.${status}`, status, { errorCode: code, failureCategory: category, providerRequestId: safeId(providerError?.responseHeaders?.['x-request-id']), researchCalls: calls });
  } finally {
    clearTimeout(timer);
    try {
      await db.update(ventureMessages).set({ content: text, status }).where(where);
      await db.update(ventureConversations).set({ updatedAt: new Date() }).where(eq(ventureConversations.id, conversationId));
      if (status === 'completed') log('venture.turn.completed', 'success', { researchCalls: calls });
      send({ type: 'done', status });
    } catch { log('venture.turn.failed', 'failed', { errorCode: 'STORAGE_UNAVAILABLE' }); send({ type: 'error', code: 'STORAGE_UNAVAILABLE', message: 'Saving failed. Reload history before retrying; contact support with this correlation ID.' }); }
    finally { active.delete(conversationId); }
  }
}

// Uses the same durable reservation, hourly budget and per-conversation lock as chat.
export async function runAssessment(conversationId: string, requestId: string, abort: AbortController, httpRequestId: string) {
  const started = performance.now();
  const log = (event: string, outcome: string, details = {}) => ventureLog(event, requestId, started, outcome, { httpRequestId, turnId: requestId, ...modelDetails, ...details });
  const where = and(eq(ventureMessages.conversationId, conversationId), eq(ventureMessages.requestId, requestId), eq(ventureMessages.role, 'assistant'));
  const timer = setTimeout(() => abort.abort(new Error('TURN_TIMEOUT')), VENTURE_LIMITS.timeoutMs);
  log('venture.assessment.started', 'pending');
  try {
    let model;
    try { model = getModel(DEFAULT_MODEL_KEY, undefined, { allowEnvFallback: true }); }
    catch { throw new VentureFailure('PROVIDER_NOT_CONFIGURED', 503, `Configure ${providerSecret}, then retry explicitly. The last saved assessment is safe.`); }
    const history = await db.select().from(ventureMessages).where(eq(ventureMessages.conversationId, conversationId)).orderBy(desc(ventureMessages.createdAt), desc(ventureMessages.id)).limit(60);
    const sources = await db.select().from(ventureSources).where(eq(ventureSources.conversationId, conversationId)).orderBy(desc(ventureSources.retrievedAt)).limit(480);
    const result = await generateText({ model, system: ventureAssessmentPrompt, prompt: JSON.stringify({
      conversation: history.reverse().filter(m => m.content && (m.role === 'user' || m.status === 'completed')).map(m => ({ role: m.role, content: m.content.slice(0, 16000) })),
      sources: sources.map(s => ({ id: s.id, url: s.url, retrievedAt: s.retrievedAt, excerpt: s.excerpt?.slice(0, 8000) })),
    }), output: Output.object({ schema: assessmentSchema }), maxOutputTokens: 12000, maxRetries: 0, abortSignal: abort.signal });
    log('venture.assessment.provider_response', 'success', { providerRequestId: safeId(result.response.id) });
    let content;
    try { content = validateAssessment(result.output, new Set(sources.map(s => s.id))); }
    catch { throw new VentureFailure('ASSESSMENT_INVALID', 422, 'Generated assessment failed evidence, schema or arithmetic checks. Correct missing inputs in chat and retry explicitly. The previous version is unchanged.'); }
    abort.signal.throwIfAborted();
    const [last] = await db.select({ version: ventureAssessments.version }).from(ventureAssessments).where(eq(ventureAssessments.conversationId, conversationId)).orderBy(desc(ventureAssessments.version)).limit(1);
    // One insert is atomic; the durable assistant reservation serializes writers.
    const [assessment] = await db.insert(ventureAssessments).values({ conversationId, version: (last?.version || 0) + 1, status: content.status, contentJson: content }).returning();
    await db.update(ventureMessages).set({ status: 'completed', content: `Saved assessment version ${assessment!.version}. Open Assessment to read it.` }).where(where);
    log('venture.assessment.completed', 'success', { validationOutcome: 'valid', version: assessment!.version });
    return assessment!;
  } catch (error) {
    const cancelled = abort.signal.aborted;
    const invalid = NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error);
    const failure = error instanceof VentureFailure ? error : invalid ? new VentureFailure('ASSESSMENT_INVALID', 422, 'The model returned an incomplete or invalid assessment. Add missing inputs in chat and retry explicitly. Your previous assessment is unchanged.') : new VentureFailure(cancelled ? 'ASSESSMENT_CANCELLED' : 'ASSESSMENT_FAILED', cancelled ? 408 : 502, 'Assessment could not be saved. The previous valid version is safe. Retry explicitly, or contact support with this correlation ID.');
    await db.update(ventureMessages).set({ status: cancelled ? 'cancelled' : 'failed' }).where(where);
    const providerError = error as { statusCode?: number; responseHeaders?: Record<string, string> } | null;
    const failureCategory = providerError?.statusCode === 401 || providerError?.statusCode === 403 ? 'PROVIDER_AUTH' : providerError?.statusCode === 429 ? 'PROVIDER_RATE_LIMIT' : providerError?.statusCode && providerError.statusCode >= 500 ? 'PROVIDER_UNAVAILABLE' : failure.code;
    log(`venture.assessment.${cancelled ? 'cancelled' : 'failed'}`, cancelled ? 'cancelled' : 'failed', { errorCode: failure.code, failureCategory, providerRequestId: safeId(providerError?.responseHeaders?.['x-request-id']), validationOutcome: failure.code === 'ASSESSMENT_INVALID' ? 'invalid' : 'not_saved' });
    throw failure;
  } finally { clearTimeout(timer); active.delete(conversationId); }
}
