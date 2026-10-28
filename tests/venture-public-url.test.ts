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
const { readPublicUrl } = await import('../src/services/venture-public-url.ts');
test('public redirect to metadata address is blocked before second connection', async () => {
  await expect(readPublicUrl('https://fixture.example/', 1000)).rejects.toThrow('UNSAFE_URL');
  expect(calls).toBe(1);
});
test('DNS rebinding to loopback is denied before transport', async () => {
  rebinding = true; const before = calls;
  await expect(readPublicUrl('https://fixture.example/', 1000)).rejects.toThrow('UNSAFE_URL');
  expect(calls).toBe(before);
});
