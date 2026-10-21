import { AsyncLocalStorage } from 'node:async_hooks';

type Trace = { id: string; conversationId?: string; projectId?: string; started: number; stage: string; stageStarted: number; failed?: boolean };
const traces = new AsyncLocalStorage<Trace>();
// Only explicit metadata is accepted. Never pass prompts, tool arguments/results,
// HTTP bodies, URLs, tokens or raw error messages to this logger.
type Metadata = { model?: string; tool?: string; status?: number; outcome?: 'complete' | 'error' | 'cancelled'; durationMs?: number; inputTokens?:number; outputTokens?:number; estimatedTokens?:number; budgetTokens?:number; compacted?:boolean; reason?: string };
// `reason` carries only error names, statuses and machine codes (see safeErrorReason).
export function chatDiagnostic(event: string, metadata: Metadata = {}) {
  const trace = traces.getStore();
  if (!trace) return;
  if (event === 'stream_error') trace.failed = true;
  const { model, tool, status, outcome, durationMs, inputTokens, outputTokens, estimatedTokens, budgetTokens, compacted, reason } = metadata;
  console.info(JSON.stringify({ component: 'chat', event, requestId: trace.id,
    conversationId: trace.conversationId, projectId: trace.projectId,
    elapsedMs: Date.now() - trace.started, stage: trace.stage,
    stageElapsedMs: Date.now() - trace.stageStarted, model, tool, status, outcome, durationMs, inputTokens, outputTokens, estimatedTokens, budgetTokens, compacted, reason }));
}
export function chatStage(stage: string) {
  const trace = traces.getStore();
  if (!trace) return;
  trace.stage = stage; trace.stageStarted = Date.now();
  chatDiagnostic('stage');
}
export function chatConversation(conversationId: string) {
  const trace = traces.getStore();
  if (trace) trace.conversationId = conversationId;
}
export async function withChatDiagnostics<T>(context: {conversationId?: string; projectId?: string; signal: AbortSignal}, run: () => Promise<T>): Promise<T> {
  const now = Date.now();
  return traces.run({id: crypto.randomUUID(), conversationId: context.conversationId, projectId: context.projectId, started: now, stage: 'subscription_selection', stageStarted: now}, async () => {
    chatDiagnostic('started');
    const trace = traces.getStore()!;
    const abort = () => traces.run(trace, () => chatDiagnostic('cancellation_requested'));
    context.signal.addEventListener('abort', abort, {once:true});
    const timer = setInterval(() => chatDiagnostic('still_waiting'), 30_000);
    timer.unref();
    try {
      const result = await run();
      chatDiagnostic('finished', {outcome: context.signal.aborted ? 'cancelled' : trace.failed ? 'error' : 'complete'});
      return result;
    } catch (error) {
      chatDiagnostic('finished', {outcome: context.signal.aborted ? 'cancelled' : 'error'});
      throw error;
    } finally { clearInterval(timer); context.signal.removeEventListener('abort', abort); }
  });
}
