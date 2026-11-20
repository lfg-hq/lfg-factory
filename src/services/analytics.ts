// Product analytics (PostHog). Off unless POSTHOG_KEY is set, so self-hosted LFG sends nothing.
//
// Three pieces:
//   1. analyticsScript()    — the browser snippet put into every LFG page (see index.ts).
//   2. proxyIngest()        — /ingest/* forwards the browser's events to PostHog from our own
//                             domain, so ad blockers don't drop them.
//   3. trackAuthRequest() / captureServer() — sign-in attempts, failures, successes and signups,
//                             sent from the server so they're counted even when the browser blocks PostHog.
import { env } from "../config/env.ts";

export const analyticsEnabled = () => !!env.POSTHOG_KEY;

const ingestHost = () => env.POSTHOG_HOST.replace(/\/+$/, "");
// us.i.posthog.com → us-assets.i.posthog.com (array.js, the recorder and /array/<key>/config)
const assetsHost = () => ingestHost().replace(".i.posthog.com", "-assets.i.posthog.com");
// us.i.posthog.com → us.posthog.com (the app, for the toolbar)
const uiHost = () => ingestHost().replace(".i.posthog.com", ".posthog.com");

// ── 1. Browser snippet ──────────────────────────────────────────────

// Pages that never get the snippet: other people's apps shown through LFG, files, and APIs.
const SKIP_PREFIXES = ["/preview-proxy", "/api/", "/ingest", "/public/", "/uploads/", "/storage/", "/vendor/", "/ws/"];
export const shouldInjectAnalytics = (path: string) => analyticsEnabled() && !SKIP_PREFIXES.some((p) => path.startsWith(p));

// JSON that is safe inside <script>: no "</script>" or "<!--" can be formed.
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** PostHog's official loader stub, then init, then identify the signed-in person (if any). */
export function analyticsScript(user?: { id: string; email?: string | null; name?: string | null } | null): string {
  const config = {
    api_host: "/ingest",
    ui_host: uiHost(),
    person_profiles: "identified_only",
    capture_pageview: "history_change",
    capture_pageleave: true,
    session_recording: { maskAllInputs: true },
  };
  const person = user ? { id: user.id, email: user.email || undefined, name: user.name || undefined } : null;
  return `<script>
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group startSessionRecording stopSessionRecording onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
(function(){
  var cfg=${scriptJson(config)};
  // Settings pages show API keys and tokens: never record them.
  cfg.disable_session_recording=location.pathname.indexOf("/settings")===0;
  posthog.init(${scriptJson(env.POSTHOG_KEY)},cfg);
  posthog.register({client:/Electron|LFG-?Desktop/i.test(navigator.userAgent)?"desktop":"web"});
  var who=${scriptJson(person)};
  if(who){posthog.identify(who.id,{email:who.email,name:who.name});}
})();
</script>`;
}

// ── 2. /ingest proxy ────────────────────────────────────────────────

export async function proxyIngest(req: Request): Promise<Response> {
  if (!analyticsEnabled()) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const rest = url.pathname.replace(/^\/ingest/, "") || "/";
  const target = (/^\/(static|array)\//.test(rest) ? assetsHost() : ingestHost()) + rest + url.search;

  // Only what PostHog needs: never forward LFG's cookies or auth headers.
  const headers = new Headers();
  for (const name of ["content-type", "content-encoding", "accept", "accept-encoding", "user-agent"]) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  // PostHog finds the visitor's country/city from this IP.
  const ip = clientIp(req);
  if (ip) headers.set("x-forwarded-for", ip);

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });
    const out = new Headers();
    for (const name of ["content-type", "content-encoding", "cache-control", "etag"]) {
      const v = upstream.headers.get(name);
      if (v) out.set(name, v);
    }
    // Bun's fetch decompresses the body, so a passed-through content-encoding would lie.
    out.delete("content-encoding");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return new Response("Analytics unavailable", { status: 502 });
  }
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    ""
  );
}

// ── 3. Server-side events ───────────────────────────────────────────

/** The anonymous id PostHog's browser library keeps in its cookie, so server events join the visitor's session. */
export function anonymousId(headers: Headers | null | undefined): string | undefined {
  const cookie = headers?.get("cookie");
  if (!cookie || !env.POSTHOG_KEY) return undefined;
  const name = `ph_${env.POSTHOG_KEY}_posthog=`;
  const raw = cookie.split(/;\s*/).find((c) => c.startsWith(name))?.slice(name.length);
  if (!raw) return undefined;
  try {
    return (JSON.parse(decodeURIComponent(raw)) as { distinct_id?: string }).distinct_id || undefined;
  } catch {
    return undefined;
  }
}

/** Fire-and-forget: analytics must never slow down or break a sign-in. */
export function captureServer(
  event: string,
  distinctId: string | undefined,
  properties: Record<string, unknown> = {},
  headers?: Headers | null,
): void {
  if (!analyticsEnabled()) return;
  const anonymous = !distinctId;
  const ip = headers ? clientIp(new Request("http://x", { headers })) : "";
  const body = {
    api_key: env.POSTHOG_KEY,
    event,
    distinct_id: distinctId || `server-${crypto.randomUUID()}`,
    properties: {
      ...properties,
      $lib: "lfg-server",
      ...(ip ? { $ip: ip } : {}),
      // No browser cookie to tie it to: count the event, don't make a person for it.
      ...(anonymous ? { $process_person_profile: false } : {}),
    },
    timestamp: new Date().toISOString(),
  };
  fetch(`${ingestHost()}/i/v0/e/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** How someone is signing in, from the Better Auth path. Undefined for paths that aren't a sign-in step. */
export function authMethod(path: string, provider?: string): string | undefined {
  if (path.endsWith("/sign-in/email") || path.endsWith("/sign-up/email")) return "password";
  if (path.endsWith("/sign-in/social")) return provider || "social";
  if (path.includes("/callback/")) return path.split("/callback/")[1]?.split(/[/?]/)[0] || "social";
  if (path.endsWith("/email-otp/send-verification-otp") || path.endsWith("/sign-in/email-otp")) return "email_code";
  if (path.endsWith("/verify-email")) return "email_link";
  if (path.includes("/one-time-token/")) return "desktop";
  return undefined;
}

const ATTEMPT_PATHS: Record<string, string> = {
  "/api/auth/sign-in/email": "sign_in",
  "/api/auth/sign-up/email": "sign_up",
  "/api/auth/sign-in/social": "oauth_start",
  "/api/auth/email-otp/send-verification-otp": "code_requested",
  "/api/auth/sign-in/email-otp": "code_entered",
};

/**
 * Wraps a /api/auth/* request: records `login_attempted` for each sign-in/sign-up step and
 * `login_failed` when it's refused. Success (`login_succeeded`, `signed_up`) is recorded by
 * the Better Auth hooks in auth/index.ts, which also cover OAuth callbacks and email links.
 */
export async function trackAuthRequest(req: Request, handle: () => Promise<Response>): Promise<Response> {
  const path = new URL(req.url).pathname;
  const step = req.method === "POST" ? ATTEMPT_PATHS[path] : undefined;
  if (!step || !analyticsEnabled()) return handle();

  let provider: string | undefined;
  if (step === "oauth_start") {
    try { provider = ((await req.clone().json()) as { provider?: string }).provider; } catch { /* no body */ }
  }
  const visitor = anonymousId(req.headers);
  const props = { method: authMethod(path, provider), step };
  captureServer("login_attempted", visitor, props, req.headers);

  const res = await handle();
  if (res.status >= 400) {
    let reason: string | undefined;
    try {
      const body = (await res.clone().json()) as { message?: string; code?: string };
      reason = body.code || (/captcha/i.test(body.message || "") ? "CAPTCHA" : undefined);
    } catch { /* not JSON */ }
    captureServer("login_failed", visitor, { ...props, status: res.status, reason }, req.headers);
  }
  return res;
}
