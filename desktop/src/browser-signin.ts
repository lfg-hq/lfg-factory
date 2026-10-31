/**
 * Sign in through the person's own browser (OAuth for native apps, RFC 8252).
 *
 * Listens on a random 127.0.0.1 port, opens the server's /desktop/authorize page in
 * the browser, waits for the browser to come back with a one-time code, then swaps
 * the code (plus the PKCE verifier only this process knows) for a runner token and
 * a one-time token that opens the app's own session.
 *
 * Plain Node, no Electron, so it can be tested on its own.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface BrowserSignInResult {
  runnerToken: string;
  deviceId: string;
  sessionToken: string;
  user: { name: string; email: string };
}

export interface BrowserSignInOptions {
  serverUrl: string;
  deviceName: string;
  openBrowser(url: string): Promise<unknown> | void;
  replaceDeviceId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SignInCancelled extends Error {
  constructor(message = "Sign-in was cancelled.") { super(message); }
}

const b64url = (buf: Buffer) => buf.toString("base64url");

const donePage = (title: string, text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--fg:#0f172a;--muted:#64748b;--border:#e2e8f0}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f19;--card:#141a2a;--fg:#e2e8f0;--muted:#94a3b8;--border:#263049}}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px}
h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

export async function signInWithBrowser(opts: BrowserSignInOptions): Promise<BrowserSignInResult> {
  const server = opts.serverUrl.replace(/\/+$/, "");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const doFetch = opts.fetchImpl ?? fetch;

  let listener: Server | undefined;
  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new SignInCancelled("Sign-in timed out. Try again.")), opts.timeoutMs ?? 10 * 60_000);
    const onAbort = () => finish(new SignInCancelled());
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort);

    listener = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const got = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (!got) {
        res.end(donePage("Sign-in cancelled", "You can close this tab. LFG Desktop wasn't connected."));
        finish(new SignInCancelled());
        return;
      }
      res.end(donePage("LFG Desktop is connected", "You can close this tab and go back to LFG Desktop."));
      finish(null, got);
    });
    listener.on("error", e => finish(e));
    listener.listen(0, "127.0.0.1", () => {
      const port = (listener!.address() as AddressInfo).port;
      const authorize = new URL(`${server}/desktop/authorize`);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("challenge", challenge);
      authorize.searchParams.set("redirect_uri", `http://127.0.0.1:${port}/callback`);
      authorize.searchParams.set("device", opts.deviceName);
      Promise.resolve(opts.openBrowser(authorize.toString())).catch(e => finish(e instanceof Error ? e : new Error(String(e))));
    });
  }).finally(() => { listener?.close(); listener?.closeAllConnections?.(); });

  const res = await doFetch(`${server}/api/desktop/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier, replaceDeviceId: opts.replaceDeviceId }),
  });
  const body = await res.json().catch(() => ({})) as Partial<BrowserSignInResult> & { error?: string };
  if (!res.ok || !body.runnerToken || !body.sessionToken) throw new Error(body.error || `Sign-in failed (HTTP ${res.status}).`);
  return body as BrowserSignInResult;
}
