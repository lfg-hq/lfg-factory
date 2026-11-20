/**
 * Renders the portfolio screen mockups in this folder to
 * public/images/screenshots/<name>.png at 1440x880 (2x for sharpness).
 *
 *   bun scripts/portfolio-mockups/render.ts            # all
 *   bun scripts/portfolio-mockups/render.ts screenline # one
 *
 * Each <name>.html is a body fragment; _base.html supplies Tailwind and fonts.
 * Uses the locally installed Google Chrome through playwright-core.
 */
import { chromium } from "playwright-core";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const out = join(dir, "../../public/images/screenshots");
const base = readFileSync(join(dir, "_base.html"), "utf8");
const only = process.argv[2];
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".html") && !f.startsWith("_"))
  .map((f) => f.replace(/\.html$/, ""))
  .filter((n) => !only || n === only);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 2 });
for (const name of names) {
  const body = readFileSync(join(dir, `${name}.html`), "utf8");
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8">${base}</head><body>${body}</body></html>`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`rendered ${name}.png`);
}
await browser.close();
