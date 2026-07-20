/**
 * Screenshot worker — runs under NODE (Playwright's connectOverCDP hangs under
 * Bun). The Bun server spawns this, writes {wsEndpoint, url} JSON to stdin, and
 * reads one line of JSON from stdout: {"type":"shot","dataB64":"..."} or
 * {"type":"error","message":"..."}.
 */
import { chromium } from "playwright-core";

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const readStdin = () => new Promise((res) => { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => res(d)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = JSON.parse((await readStdin()) || "{}");
  if (!cfg.wsEndpoint || !cfg.url) { emit({ type: "error", message: "missing wsEndpoint/url" }); return; }

  let browser;
  for (let i = 1; i <= 5; i++) {
    try { browser = await chromium.connectOverCDP(cfg.wsEndpoint, { timeout: 20_000 }); break; }
    catch (e) { if (i === 5) { emit({ type: "error", message: "connect failed: " + (e.message || e) }); return; } await sleep(3000); }
  }
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = await ctx.newPage();
    await page.setViewportSize({ width: cfg.width || 1280, height: cfg.height || 800 });
    try {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Security.enable").catch(() => {});
      await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true });
    } catch { /* best-effort */ }
    await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs || 45_000 });
    await page.waitForTimeout(cfg.settleMs || 2500); // let the app render
    const buf = await page.screenshot({ type: "png", fullPage: !!cfg.fullPage });
    emit({ type: "shot", dataB64: buf.toString("base64") });
  } catch (e) {
    emit({ type: "error", message: "screenshot failed: " + (e.message || e) });
  } finally {
    await browser.close().catch(() => {});
  }
}
main().catch((e) => emit({ type: "error", message: String(e.message || e) }));
