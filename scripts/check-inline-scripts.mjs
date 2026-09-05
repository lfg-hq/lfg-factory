#!/usr/bin/env node
/**
 * Every inline <script> in a rendered page must PARSE.
 *
 * These pages are template literals, so a lone `'` inside a JS string — `project's`,
 * `deleteSkill(\'`+id+`\')` written with one backslash instead of two — closes the
 * string and takes the ENTIRE script down with it. Nothing errors at build time and
 * the page still renders; it just silently stops doing anything, which is how the
 * Agent tab's Skills list ended up sitting on "Loading…" forever.
 *
 * This has now bitten three times, so it is a check rather than a lesson.
 */
import { spawnSync } from "node:child_process";

const PAGES = [
  ["src/templates/pages/project-detail.tsx", "ProjectDetailPage",
    ["home", "agent", "config", "settings", "events", "documents", "inbox", "environment"]],
  ["src/templates/pages/tickets-list.tsx", "TicketsListPage", [null]],
  ["src/templates/pages/chat.tsx", "ChatPage", [null]],
  ["src/templates/pages/epics.tsx", "EpicsPage", [null]],
];

const driver = `
const results = [];
${PAGES.map(([file, fn, tabs], i) => `
try {
  const m${i} = await import(${JSON.stringify(process.cwd() + "/" + file)});
  const P${i} = m${i}[${JSON.stringify(fn)}];
  for (const tab of ${JSON.stringify(tabs)}) {
    let out;
    try {
      out = String(P${i}({
        user: { id: "u", name: "t", email: "e@e.com" },
        project: { id: "p", projectId: "pub", name: "N", icon: "x", status: "active", ownerId: "u" },
        projectName: "N", projectId: "pub", conversationId: null,
        conversations: [], stages: [], tickets: [], documents: [], epics: [],
        ticketCounts: {}, envVars: [], members: [], instantApps: [],
        ...(tab ? { activeTab: tab } : {}),
      }));
    } catch (e) { results.push([${JSON.stringify(file)}, tab, "RENDER", e.message]); continue; }
    const scripts = [...out.matchAll(/<script(?![^>]*src=)[^>]*>([\\s\\S]*?)<\\/script>/g)].map((x) => x[1]);
    scripts.forEach((code, n) => {
      try { new Function(code); }
      catch (e) { results.push([${JSON.stringify(file)}, tab, "script " + (n + 1), e.message]); }
    });
  }
} catch (e) { results.push([${JSON.stringify(file)}, null, "IMPORT", e.message]); }
`).join("\n")}
console.log(JSON.stringify(results));
`;

const r = spawnSync("bun", ["-e", driver], { encoding: "utf8" });
const line = (r.stdout || "").trim().split("\n").pop() || "[]";
let results;
try { results = JSON.parse(line); } catch { console.log("FAIL could not run the check:\n" + (r.stderr || r.stdout).slice(-800)); process.exit(1); }

const real = results.filter(([, , where]) => where !== "RENDER" && where !== "IMPORT");
for (const [file, tab, where, msg] of real) {
  console.log(`FAIL ${file}${tab ? ` [${tab}]` : ""} ${where}: ${msg.slice(0, 110)}`);
}
if (real.length) { console.log("\nAn inline script that does not parse does NOTHING at runtime — check for a lone ' in a JS string."); process.exit(1); }
console.log(`  ok  every inline script parses (${PAGES.length} pages)`);
