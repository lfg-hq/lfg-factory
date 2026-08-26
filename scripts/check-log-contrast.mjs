// Every log card must define readable text under [data-theme="light"]. Dark-mode
// values like #e2e8f0 or rgba(255,255,255,...) on a white page are the bug.
import fs from "node:fs";
const dark = fs.readFileSync("public/css/tickets.css", "utf8");
// Light overrides live in BOTH sheets — tickets.css carries [data-theme="light"]
// blocks of its own, and reading only light-mode.css reported false failures.
const light = fs.readFileSync("public/css/light/light-mode.css", "utf8")
  + fs.readFileSync("public/css/tickets.css", "utf8").split('[data-theme="light"]').slice(1).map((b) => '[data-theme="light"]' + b).join("");
const types = [...new Set([...dark.matchAll(/\.log-entry\.(log-[a-z-]+)/g)].map((m) => m[1]))];
let bad = 0;
for (const t of types) {
  // What colours does the DARK sheet give this card's text?
  const block = dark.split(`.log-entry.${t}`).slice(1).join("");
  const darkText = /color:\s*(#e2e8f0|#f8fafc|rgba\(255,\s*255,\s*255)/i.test(block.slice(0, 900));
  const stem = t.replace(/^log-/, "");
  const hasLight = light.includes(`[data-theme="light"] .log-entry.${t}`)
    || new RegExp(`\\[data-theme="light"\\][^{]*\\.log-${stem}-(content|label)`).test(light);
  const verdict = !darkText || hasLight ? "ok  " : "FAIL";
  if (verdict === "FAIL") bad++;
  console.log(`  ${verdict} ${t.padEnd(16)} ${darkText ? "dark-only text colour" : "theme-neutral"}${hasLight ? " · has light override" : ""}`);
}
console.log(bad ? `\n${bad} card(s) unreadable in light mode` : "\nevery card readable in light mode");
process.exit(bad ? 1 : 0);
