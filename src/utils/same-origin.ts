import type { Context } from 'hono';
import { env } from '../config/env.ts';

function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
}

/**
 * True when a state-changing request came from this app's own pages.
 *
 * Production sits behind kamal-proxy, which terminates TLS: the browser sends
 * `Origin: https://lfg.run` while Hono sees `http://lfg.run/...` as the request
 * URL. Comparing those two directly rejected every same-origin POST, so the
 * check accepts the forwarded scheme/host and the configured public URLs too.
 * A request without an Origin header (same-origin GET-style tools, curl with a
 * session cookie) is allowed, matching the previous behaviour.
 */
export function isSameOrigin(c: Context): boolean {
  const origin = originOf(c.req.header('Origin'));
  if (!c.req.header('Origin')) return true;
  if (!origin) return false;
  const url = new URL(c.req.url);
  const allowed = new Set<string>([url.origin]);
  const host = c.req.header('X-Forwarded-Host')?.split(',')[0]?.trim() || c.req.header('Host') || url.host;
  const proto = c.req.header('X-Forwarded-Proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  allowed.add(`${proto}://${host}`);
  // TLS-terminating proxies don't always forward the scheme; same host over https is still us.
  allowed.add(`https://${host}`);
  for (const configured of [env.BETTER_AUTH_URL, env.APP_URL]) {
    const o = originOf(configured);
    if (o) allowed.add(o);
  }
  return allowed.has(origin);
}
