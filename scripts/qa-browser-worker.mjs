/**
 * QA browser worker — runs under NODE (Playwright's connectOverCDP hangs under
 * Bun, but works under Node). The Bun server spawns this, writes a JSON config to
 * stdin, and reads newline-delimited JSON results from stdout:
 *   {"type":"screen","screen":{...}}   (one per page)
 *   {"type":"done","results":[...]}
 *   {"type":"error","message":"..."}
 *
 * Config (stdin JSON): { wsEndpoint, base, routes[], outDir, appId,
 *                        navTimeoutMs, navRetries, settleMs, viewport, quality }
 */
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const readStdin = () => new Promise((res) => { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => res(d)); });

async function connectWithRetry(ws) {
  let last;
  for (let i = 1; i <= 5; i++) {
    try { return await chromium.connectOverCDP(ws, { timeout: 20_000 }); }
    catch (e) { last = e; if (i < 5) await sleep(3000); }
  }
  throw last;
}

async function testOne(ctx, cfg, route, index) {
  const url = cfg.base + (route === "/" ? "/" : route);
  const consoleErrors = [];
  let pageError;
  let httpStatus = null;
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => { pageError = String(e.message ?? e).slice(0, 300); });
  // The cloud browser sandbox can have a skewed clock, which makes valid TLS certs
  // look expired (net::ERR_CERT_DATE_INVALID) and breaks every HTTPS data fetch —
  // a false failure that does NOT happen in a real user's browser. Ignore cert
  // errors so QA tests the app's behaviour, not the sandbox's clock.
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Security.enable").catch(() => {});
    await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true });
  } catch { /* best-effort; some CDP targets don't expose Security */ }
  try {
    let resp = null;
    for (let a = 0; a < cfg.navRetries; a++) {
      try { resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs }); break; }
      catch (e) { if (a === cfg.navRetries - 1) throw e; await page.waitForTimeout(2000); }
    }
    httpStatus = resp?.status() ?? null;
    await page.waitForTimeout(cfg.settleMs);

    // Observe what actually rendered (title, heading, blank-vs-content, error overlay).
    let title = "", heading = "", bodyLen = 0, errorOverlay = false, appError = false, textSnippet = "";
    try {
      title = (await page.title()) || "";
      const obs = await page.evaluate(() => {
        const h = document.querySelector("h1, h2");
        const body = ((document.body && document.body.innerText) || "").trim();
        const overlay = !!document.querySelector("nextjs-portal, [data-nextjs-dialog], #__next-build-error")
          || /Application error:|Unhandled Runtime Error|This page could not be found/i.test(body);
        // App-level error states that still return HTTP 200 (failed data fetch, error
        // boundary, empty-state-with-error). HTTP 200 + rendered ≠ healthy.
        const appError = /\b(unable to load|failed to load|couldn'?t load|could not load|something went wrong|an error occurred|an unexpected error|internal server error|error loading|failed to fetch|unable to fetch|no data available)\b/i.test(body)
          || !!document.querySelector('[role="alert"], [data-error], .error-state, [class*="errorState"]');
        return { heading: h ? h.innerText.trim().slice(0, 80) : "", bodyLen: body.length, overlay, appError, snippet: body.replace(/\s+/g, " ").slice(0, 600) };
      });
      heading = obs.heading; bodyLen = obs.bodyLen; errorOverlay = obs.overlay; appError = obs.appError; textSnippet = obs.snippet;
    } catch { /* observation best-effort */ }

    // Filter out benign console noise (favicon/static 404s, sourcemaps, extensions)
    // and SANDBOX-environment transport errors (TLS cert-date skew, DNS, network
    // resets) that are artifacts of the test VM — not bugs in the user's app —
    // so the verdict keys on real app errors (failed API logic, thrown errors).
    const realConsoleErrors = consoleErrors.filter(
      (e) => !/favicon|manifest\.json|\.map\b|sourcemap|chrome-extension|ERR_BLOCKED_BY_CLIENT|installHook|ERR_CERT_|ERR_SSL_|SSL certificate|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/i.test(e)
    );

    let screenshotUrl;
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: cfg.quality, fullPage: true });
      const slug = route.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "home";
      const file = String(index).padStart(2, "0") + "-" + slug + ".jpg";
      await writeFile(cfg.outDir + "/" + file, buf);
      screenshotUrl = "/uploads/instant-tests/" + cfg.appId + "/" + file;
    } catch { /* screenshot best-effort */ }

    // A screen passes ONLY if it loaded AND shows no error signal. A page that
    // returns HTTP 200 but logs a console error or renders an error state
    // (e.g. "Unable to load market data") is NOT healthy — it FAILS.
    const ok =
      httpStatus !== null &&
      httpStatus < 400 &&
      !pageError &&
      !errorOverlay &&
      !appError &&
      realConsoleErrors.length === 0;

    // Human-readable observation of what we saw.
    const obsParts = ["HTTP " + (httpStatus ?? "?")];
    if (heading) obsParts.push(`heading "${heading}"`);
    else if (title) obsParts.push(`title "${title}"`);
    obsParts.push(bodyLen < 40 ? "page looks blank/empty" : "content rendered");
    if (errorOverlay) obsParts.push("error overlay shown");
    if (appError) obsParts.push("visible error state");
    if (pageError) obsParts.push("JS error: " + pageError);
    if (realConsoleErrors.length) obsParts.push(realConsoleErrors.length + " console error" + (realConsoleErrors.length > 1 ? "s" : ""));
    const observation = obsParts.join(" · ");

    return { route, url, ok, httpStatus, pageError, consoleErrors: realConsoleErrors, screenshotUrl, title, observation, textSnippet };
  } catch (e) {
    return { route, url, ok: false, httpStatus, pageError: pageError ?? String(e.message).slice(0, 300), consoleErrors };
  } finally {
    await page.close().catch(() => {});
  }
}

const cfg = JSON.parse(await readStdin());
await mkdir(cfg.outDir, { recursive: true }).catch(() => {});

let browser;
try {
  browser = await connectWithRetry(cfg.wsEndpoint);
} catch (e) {
  emit({ type: "error", message: "CDP WS connect failed: " + String(e.message).split("\n")[0] });
  process.exit(0);
}

const ctx = browser.contexts()[0] || (await browser.newContext({ viewport: cfg.viewport }));
const results = [];
for (let i = 0; i < cfg.routes.length; i++) {
  const screen = await testOne(ctx, cfg, cfg.routes[i], i);
  results.push(screen);
  emit({ type: "screen", screen });
}
await browser.close().catch(() => {});
emit({ type: "done", results });
process.exit(0);
