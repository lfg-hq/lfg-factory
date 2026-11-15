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
// The account chooser's own list: the signed-in accounts as JSON, empty when signed out.
const LIST_ACCOUNTS = "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard";

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
    const page = await context.newPage();
    try {
      await page.goto(LIST_ACCOUNTS, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [null])[0];
      out({ ok: true, email: email ? email.toLowerCase() : null });
    } finally {
      await page.close().catch(() => {});
    }
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
