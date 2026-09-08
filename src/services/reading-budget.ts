import { AsyncLocalStorage } from 'node:async_hooks';

export class ReadingError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'ReadingError'; }
}
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
const scope = new AsyncLocalStorage<{ signal: AbortSignal; onRead?: () => void; cache?: Map<string, Response> }>();
export const withRepositorySignal = <T>(signal: AbortSignal, run: () => T, onRead?: () => void, cache?: Map<string, Response>): T => scope.run({ signal, onRead, cache }, run);

/** Includes response-body reads, not just the initial HTTP headers. No secrets in errors. */
export async function repositoryFetch(url: string, init?: RequestInit, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ReadingError('repository_timeout', 'Repository request timed out. Narrow the search or try another file.')), timeoutMs);
  const context = scope.getStore();
  const parent = context?.signal;
  const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]);
  try {
    signal.throwIfAborted();
    // Cache only within one turn and credential identity. Never log this key.
    const key = JSON.stringify([url, new Headers(init?.headers).get('Authorization')]);
    const cached = context?.cache?.get(key);
    if (cached) return new Response([204, 205].includes(cached.status) ? null : await cached.clone().arrayBuffer(), { status: cached.status, statusText: cached.statusText, headers: cached.headers });
    return await abortable((async () => {
      const response = await globalThis.fetch(url, { ...init, signal });
      const body = await response.arrayBuffer();
      signal.throwIfAborted();
      context?.onRead?.();
      const buffered = new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
      if (buffered.ok && body.byteLength <= 524288 && context?.cache && context.cache.size < 64) {
        context.cache.set(key, new Response([204, 205].includes(response.status) ? null : body.slice(0), { status: response.status, statusText: response.statusText, headers: response.headers }));
      }
      return buffered;
    })(), signal);
  } finally { clearTimeout(timer); }
}

export function readingBudget(parent?: AbortSignal, totalMs = 600000, idleMs = 120000) {
  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout>;
  const activity = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new ReadingError('investigation_idle', 'Repository investigation produced no progress within its inactivity limit.')), idleMs);
  };
  activity();
  const total = setTimeout(() => controller.abort(new ReadingError('investigation_budget', 'Repository investigation reached its overall time budget.')), totalMs);
  const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]);
  return { signal, activity, dispose: () => { clearTimeout(total); clearTimeout(idle); controller.abort(new ReadingError('finished', 'Investigation finished')); } };
}
