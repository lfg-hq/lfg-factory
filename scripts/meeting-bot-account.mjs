/**
 * Signing a meeting-bot seat in to Google, the parts that need the browser. Node, not Bun:
 * Playwright's connectOverCDP hangs under Bun (see meeting-bot-worker.mjs).
 *
 *   stdin    { wsEndpoint, action: "open" | "whoami" }
 *   stdout   { ok: true, email?: string | null } | { ok: false, error }
 *
 * "open" shows Google's sign-in page in the seat's browser, where the admin signs in by hand
 * (password and 2-step verification are theirs to type). "whoami" reads which Google account
 * the browser is signed in to. The endpoint carries the session's secret, so it comes on
 * stdin rather than in the arguments, where other processes could see it.
 */
import { chromium } from "playwright-core";

const SIGN_IN = "https://accounts.google.com/ServiceLogin?continue=" + encodeURIComponent("https://meet.google.com/");
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * The signed-in account, read where Google shows it: Meet's account button is labelled
 * "Google Account: <name> (<email>)". Google's account page is the fallback. (The account
 * chooser's ListAccounts endpoint stopped answering requests from a plain page: HTTP 400.)
 */
async function signedInEmail(context) {
  const page = await context.newPage();
  try {
    await page.goto("https://meet.google.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    const button = page.locator('[aria-label^="Google Account"]').first();
    if (await button.waitFor({ state: "attached", timeout: 12_000 }).then(() => true, () => false)) {
      const found = ((await button.getAttribute("aria-label")) || "").match(EMAIL);
      if (found) return found[0].toLowerCase();
    }
    if (/accounts\.google\.com/.test(page.url())) return null; // sent to sign in: not signed in
    await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (/accounts\.google\.com/.test(page.url())) return null;
    const labels = await page.evaluate(() => [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join("\n"));
    const found = labels.match(EMAIL);
    return found ? found[0].toLowerCase() : null;
  } finally {
    await page.close().catch(() => {});
  }
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { wsEndpoint, action } = JSON.parse(input);

let browser;
try {
  browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 30_000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  if (action === "open") {
    const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());
    await page.bringToFront().catch(() => {});
    await page.goto(SIGN_IN, { waitUntil: "domcontentloaded", timeout: 45_000 });
    out({ ok: true });
  } else if (action === "whoami") {
    out({ ok: true, email: await signedInEmail(context) });
  } else {
    out({ ok: false, error: `unknown action ${action}` });
  }
} catch (error) {
  out({ ok: false, error: String(error?.message || error).split("\n")[0].slice(0, 300) });
} finally {
  // Only drops the connection: connectOverCDP's close never shuts a remote browser down.
  await browser?.close().catch(() => {});
}
process.exit(0);
