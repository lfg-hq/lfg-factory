import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { isSameOrigin } from '../src/utils/same-origin.ts';

const app = new Hono();
app.post('/x', c => c.json({ ok: isSameOrigin(c) }));
const check = async (url: string, headers: Record<string, string>) => (await (await app.request(url, { method: 'POST', headers })).json()).ok;

test('TLS-terminating proxy: https Origin, http request URL, same host is allowed', async () => {
  expect(await check('http://lfg.run/x', { Origin: 'https://lfg.run', Host: 'lfg.run' })).toBe(true);
  expect(await check('http://lfg.run/x', { Origin: 'https://lfg.run', Host: 'lfg.run', 'X-Forwarded-Proto': 'https' })).toBe(true);
});
test('plain same-origin and missing Origin are allowed', async () => {
  expect(await check('http://localhost:8000/x', { Origin: 'http://localhost:8000' })).toBe(true);
  expect(await check('http://localhost:8000/x', {})).toBe(true);
});
test('foreign or malformed Origin is refused', async () => {
  expect(await check('http://lfg.run/x', { Origin: 'https://evil.example', Host: 'lfg.run' })).toBe(false);
  expect(await check('http://lfg.run/x', { Origin: 'null', Host: 'lfg.run' })).toBe(false);
});
