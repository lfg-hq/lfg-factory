// Tests Playwright connectOverCDP against a fresh Mags browser, under whatever
// runtime invokes it. Run with both:  bun scripts/pw-connect-test.mjs  AND  node scripts/pw-connect-test.mjs
import Mags from "@magpiecloud/mags";
import { chromium } from "playwright-core";

const runtime = typeof Bun !== "undefined" ? "BUN" : "NODE";
const c = new Mags({ apiToken: process.env.MAGS_API_TOKEN });
const { requestId, wsEndpoint } = await c.browser({ timeout: 120_000 });
console.log(`[${runtime}] wsEndpoint:`, wsEndpoint);
try {
  const t0 = Date.now();
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 25_000 });
  console.log(`[${runtime}] ✅ connectOverCDP OK in ${Date.now() - t0}ms`);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15_000 });
  console.log(`[${runtime}] ✅ navigated:`, await page.title());
  await browser.close();
} catch (e) {
  console.log(`[${runtime}] ❌ Playwright failed:`, String(e.message).split("\n")[0]);
}
await c.stop(requestId).catch(() => {});
process.exit(0);
