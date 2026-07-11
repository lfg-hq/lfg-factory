/**
 * Standalone smoke test for the cloud-browser plumbing the Instant Tester uses
 * (Mags 1.13 client.browser() + playwright-core connectOverCDP + screenshot).
 *
 * Run:
 *   set -a; . ./.env; set +a; bun scripts/test-instant-tester.mjs <url>
 *   (defaults to https://example.com if no url given — pass a live instant-app URL)
 *
 * Pass = it prints the HTTP status and saves ./test-shot.jpg, then stops the VM.
 */
import { startBrowserSession, stopWorkspace } from "../src/services/mags.ts";
import { chromium } from "playwright-core";

const url = process.argv[2] || "https://example.com";

if (!process.env.MAGS_API_TOKEN) {
  console.error("MAGS_API_TOKEN not set — run: set -a; . ./.env; set +a; bun scripts/test-instant-tester.mjs <url>");
  process.exit(1);
}

console.log(`Booting Mags cloud Chromium…`);
const { requestId, wsEndpoint } = await startBrowserSession({ timeout: 120_000 });
console.log(`CDP ready: ${wsEndpoint}  (requestId=${requestId})`);

let browser;
try {
  browser = await chromium.connectOverCDP(wsEndpoint);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();

  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e.message).slice(0, 200)));

  console.log(`Navigating to ${url} …`);
  let resp = null;
  for (let i = 0; i < 3; i++) {
    try { resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }); break; }
    catch (e) { if (i === 2) throw e; await page.waitForTimeout(2000); }
  }
  await page.waitForTimeout(1200);

  await page.screenshot({ path: "test-shot.jpg", type: "jpeg", quality: 72, fullPage: true });
  console.log(`✅ HTTP ${resp?.status() ?? "?"} — saved ./test-shot.jpg`);
  console.log(errors.length ? `⚠️  ${errors.length} console/page error(s):\n  ${errors.join("\n  ")}` : "No console/page errors.");
} finally {
  await browser?.close().catch(() => {});
  await stopWorkspace(requestId).catch(() => {});
  console.log("Browser VM stopped.");
}
