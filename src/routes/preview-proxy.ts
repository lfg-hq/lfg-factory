/**
 * Preview reverse proxy — serves the running client app from OUR origin so the
 * in-app browser can keep navigation inside the panel. A cross-origin iframe
 * can't be told to keep target="_blank" links in-app (browser security); routing
 * the app through a same-origin path-prefix proxy lets us rewrite links + inject
 * a small interceptor so clicks stay in the embedded browser.
 *
 * Mounted at /preview-proxy/:projectId/*  → forwards to the project's live
 * preview origin. HTML responses get URL-rewriting + an interceptor script.
 *
 * HONEST LIMITATION: this proxies HTTP only. Apps that rely on WebSockets
 * (e.g. SignalR) won't get those through the proxy — for full fidelity use the
 * direct (non-proxied) mode. It's offered as an opt-in "in-app links" mode.
 */
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.ts";
import { getProjectAccess } from "../auth/project-access.ts";
import { getPreviewState } from "../services/dev-preview.ts";
import type { auth } from "../auth/index.ts";

type Env = { Variables: { user: typeof auth.$Infer.Session.user } };
const previewProxy = new Hono<Env>();
previewProxy.use("*", requireAuth as any);

// Hop-by-hop / origin-specific headers we must not forward verbatim.
const STRIP_REQ = new Set(["host", "origin", "referer", "connection", "content-length", "accept-encoding"]);
const STRIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "content-security-policy", "x-frame-options", "strict-transport-security"]);

const handle = async (c: any) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.text("Project not found", 404);

  const state = await getPreviewState(access.project.id);
  if (!state.previewUrl) return c.text("Preview is not running", 409);
  const origin = new URL(state.previewUrl).origin;
  const prefix = `/preview-proxy/${projectId}`;

  // The app path is everything after the prefix (+ query string).
  const url = new URL(c.req.url);
  const appPath = url.pathname.slice(prefix.length) || "/";
  const target = origin + appPath + url.search;

  // Forward the request.
  const reqHeaders = new Headers();
  for (const [k, v] of c.req.raw.headers) if (!STRIP_REQ.has(k.toLowerCase())) reqHeaders.set(k, v);
  const method = c.req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers: reqHeaders, body, redirect: "manual" });
  } catch (e) {
    return c.text(`Preview proxy could not reach the app: ${(e as Error).message}`, 502);
  }

  // Build response headers, rewriting Location redirects to stay in the proxy.
  const resHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    if (STRIP_RES.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === "location") { resHeaders.set(k, rewriteUrl(v, origin, prefix)); continue; }
    if (k.toLowerCase() === "set-cookie") { resHeaders.append("set-cookie", v.replace(/;\s*Domain=[^;]+/i, "").replace(/;\s*SameSite=None/i, "; SameSite=Lax")); continue; }
    resHeaders.set(k, v);
  }

  const ctype = upstream.headers.get("content-type") || "";
  if (ctype.includes("text/html")) {
    let html = await upstream.text();
    html = rewriteHtml(html, origin, prefix);
    resHeaders.set("content-type", ctype);
    return new Response(html, { status: upstream.status, headers: resHeaders });
  }
  // Everything else (css/js/img/json/…) streams through untouched.
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
};

previewProxy.all("/:projectId", handle);   // proxy root
previewProxy.all("/:projectId/*", handle); // app sub-paths

/** Rewrite a single URL (absolute-to-app-origin or root-relative) into the proxy path. */
function rewriteUrl(u: string, origin: string, prefix: string): string {
  if (!u) return u;
  if (u.startsWith(origin)) return prefix + u.slice(origin.length);
  if (u.startsWith("/") && !u.startsWith("//")) return prefix + u;
  return u;
}

/** Rewrite an HTML document's URLs + inject a <base> and a link interceptor. */
function rewriteHtml(html: string, origin: string, prefix: string): string {
  // Absolute URLs to the app origin → proxy path.
  html = html.split(origin).join(prefix);
  // Root-relative href/src/action="/..." → proxy path (skip //, data:, already-prefixed).
  html = html.replace(/(\s(?:href|src|action|data-src|poster)\s*=\s*)(["'])\/(?!\/|preview-proxy)/gi, `$1$2${prefix}/`);
  // srcset entries.
  html = html.replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (_m, p, q, val) =>
    p + q + val.replace(/(^|,\s*)\/(?!\/)/g, `$1${prefix}/`) + q);

  const inject = `<base href="${prefix}/">
<script>(function(){
  var PFX=${JSON.stringify(prefix)};
  // Keep target="_blank" / window.open navigations INSIDE the in-app browser.
  document.addEventListener('click',function(e){
    var a=e.target && e.target.closest && e.target.closest('a[href]');
    if(a && (a.target==='_blank'||a.target==='_new')) a.removeAttribute('target');
  },true);
  var _open=window.open;
  window.open=function(u){ if(u){ try{ location.href=u; }catch(_){ return _open.apply(window,arguments);} } return null; };
})();</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  return inject + html;
}

export default previewProxy;
