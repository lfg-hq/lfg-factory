import { chatDiagnostic } from './chat-diagnostics.ts';
// Providers need not settle their stream/metadata promises after abort. Race only
// provider waits; actual tool operations must settle before the queue advances.
export function abortable<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Response interrupted', 'AbortError'));
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) { cleanup(); abort(); }
  });
}

export async function* cancellableStream<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      const item = await abortable(iterator.next(), signal);
      if (item.done) return;
      yield item.value;
    }
  } finally {
    // An uncooperative provider may also hang in return(). Observe errors without
    // making cancellation depend on its cleanup finishing.
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

export function trackTurnTools(tools: Record<string, any>, signal: AbortSignal) {
  const active = new Set<Promise<unknown>>();
  const guarded = Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (typeof tool.execute !== 'function') return [name, tool];
    return [name, { ...tool, execute: async (...args: any[]) => {
      signal.throwIfAborted();
      const started = Date.now();
      chatDiagnostic('tool_started', {tool:name});
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return tool.execute(...args);
      });
      active.add(operation);
      try { const result = await operation; chatDiagnostic('tool_finished', {tool:name, outcome:'complete', durationMs:Date.now()-started}); return result; }
      catch(error) { chatDiagnostic('tool_finished', {tool:name, outcome:'error', durationMs:Date.now()-started}); throw error; }
      finally { active.delete(operation); }
    }}];
  }));
  return { tools: guarded, drain: () => Promise.allSettled([...active]) };
}
