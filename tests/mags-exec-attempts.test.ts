import { test, expect, afterEach } from 'bun:test';
import { execOnWorkspace } from '../src/services/sandbox/mags-backend.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
// A VM that never answers: the request hangs until it is aborted.
const hang = (calls: { n: number }) => ((_url: any, init: any) => { calls.n++; return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')))); }) as any;

test('a probe with attempts: 1 gives up after one short try', async () => {
  process.env.MAGS_API_TOKEN = 'test';
  const calls = { n: 0 }; globalThis.fetch = hang(calls);
  const started = Date.now();
  await expect(execOnWorkspace('clone-x', 'true', { timeout: 100, attempts: 1, socketGraceMs: 50 })).rejects.toThrow('aborted');
  expect(calls.n).toBe(1);
  expect(Date.now() - started).toBeLessThan(1000);
});

test('ordinary commands still retry transient failures', async () => {
  process.env.MAGS_API_TOKEN = 'test';
  let n = 0;
  globalThis.fetch = (async () => { n++; if (n < 2) throw new Error('fetch failed'); return new Response(JSON.stringify({ exit_code: 0, stdout: 'ok' })); }) as any;
  expect((await execOnWorkspace('clone-x', 'true', { timeout: 100 })).output).toBe('ok');
  expect(n).toBe(2);
}, 15000);
