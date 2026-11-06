// TEST FIXTURES ONLY: simulated DNS/HTTP transport; no live-page verification.
import { test, expect, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
let calls = 0, rebinding = false;
mock.module('node:dns/promises', () => ({ lookup: async () => [{ address: rebinding ? '127.0.0.1' : '93.184.215.14', family: 4 }] }));
const transport = (_url: URL, options: any, callback: Function) => {
  calls++;
  options.lookup('TEST FIXTURE host', {}, (_error: unknown, ip: string) => expect(ip).toBe('93.184.215.14'));
  const req: any = new EventEmitter(); req.setTimeout = () => req; req.end = () => queueMicrotask(() => {
    const res: any = new EventEmitter(); res.statusCode = 302; res.headers = { location: 'http://169.254.169.254/latest/meta-data' }; res.destroy = () => {}; callback(res);
  }); return req;
};
mock.module('node:http', () => ({ request: transport }));
mock.module('node:https', () => ({ request: transport }));
const { readPublicUrl, readVentureUrl, pinnedLookup } = await import('../src/venture/services/public-url.ts');
test('public redirect to metadata address is blocked before second connection', async () => {
  await expect(readPublicUrl('https://fixture.example/', 1000)).rejects.toThrow('UNSAFE_URL');
  expect(calls).toBe(1);
});
test('DNS rebinding to loopback is denied before transport', async () => {
  rebinding = true; const before = calls;
  await expect(readPublicUrl('https://fixture.example/', 1000)).rejects.toThrow('UNSAFE_URL');
  expect(calls).toBe(before);
});

test('pinned lookup answers both one-address and all-addresses callers (Bun asks for all)', () => {
  const lookup = pinnedLookup({ address: '93.184.215.14', family: 4 });
  lookup('x', {}, (_e: unknown, ip: string, family: number) => { expect(ip).toBe('93.184.215.14'); expect(family).toBe(4); });
  lookup('x', { all: true }, (_e: unknown, list: unknown) => expect(list).toEqual([{ address: '93.184.215.14', family: 4 }]));
});
test('links are read through Exa after the public-address check; bare domains work; blocked hosts never reach Exa', async () => {
  rebinding = false;
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init: any) => { seen.push(JSON.parse(init.body).urls[0]); return new Response(JSON.stringify({ results: [{ title: 'TEST FIXTURE', text: '  TEST FIXTURE page text  ' }] }), { status: 200 }); }) as any;
  try {
    const page = await readVentureUrl('fixture.example', 1000, undefined, 'TEST_FIXTURE_KEY');
    expect(page).toMatchObject({ url: 'https://fixture.example/', title: 'TEST FIXTURE', text: 'TEST FIXTURE page text' });
    rebinding = true;
    await expect(readVentureUrl('https://fixture.example/', 1000, undefined, 'TEST_FIXTURE_KEY')).rejects.toThrow('UNSAFE_URL');
    await expect(readVentureUrl('http://localhost:8080/admin', 1000, undefined, 'TEST_FIXTURE_KEY')).rejects.toThrow('UNSAFE_URL');
    expect(seen).toEqual(['https://fixture.example/']);
    rebinding = false;
    globalThis.fetch = (async () => new Response(JSON.stringify({ results: [{ text: '' }] }), { status: 200 })) as any;
    await expect(readVentureUrl('https://fixture.example/', 1000, undefined, 'TEST_FIXTURE_KEY')).rejects.toThrow('SOURCE_INACCESSIBLE');
    await expect(readVentureUrl('https://fixture.example/', 1000, undefined, '')).rejects.toThrow('SEARCH_NOT_CONFIGURED');
  } finally { globalThis.fetch = original; }
});
