import fs from "node:fs";
let bad = 0;
const ok = (m: string) => console.log("  ok   " + m);
const fail = (m: string) => { bad++; console.log("  FAIL " + m); };
const read = (p: string) => fs.readFileSync(p, "utf8");

const PROJECT_PAGES = [
  "src/templates/pages/chat.tsx",
  "src/templates/pages/project-detail.tsx",
  "src/templates/pages/epics.tsx",
  "src/templates/pages/tickets-list.tsx",
];

console.log("sidebar rail:");
/** Just the TOP-LEVEL links: everything before the More section starts. */
function railTop(src: string) {
  const start = src.indexOf('<div class="sidebar-nav">');
  return src.slice(start, src.indexOf("sidebar-more-toggle", start));
}
for (const p of PROJECT_PAGES) {
  const s2 = read(p);
  const s = s2;
  const rail = s.slice(s.indexOf('<div class="sidebar-nav">'), s.indexOf("sidebar-bottom-content"));
  const has = (label: string) => rail.includes(`<span class="nav-text">${label}</span>`);
  const name = p.split("/").pop()!;
  // Instant is the ONLY link that was meant to leave the rail. Chat, Epics and
  // Tickets belong here — removing them was my misreading, not the request.
  const missing = ["Chat", "Tickets"].filter((l) => !has(l));
  if (has("Instant")) fail(`${name}: Instant still in the rail`);
  else if (missing.length) fail(`${name}: rail is missing ${missing.join(", ")}`);
  else if (railTop(s2).includes("Epics")) fail(`${name}: Epics listed twice (top level AND More)`);
  else ok(`${name}: rail has Chat + Tickets, Epics only inside More`);
}

console.log("\nchat history:");
for (const p of PROJECT_PAGES) {
  const s = read(p);
  const name = p.split("/").pop()!;
  if (s.includes('id="conversation-list"')) ok(`${name}: has the history list`);
  else fail(`${name}: no history in the rail`);
}
if (read("src/templates/pages/chat.tsx").includes(">Recent chats<")) ok("chat page heading renamed to Recent chats");
else fail("heading still says Recents");
// chat.js owns the list on the chat page; the shared script must stand down there.
if (!read("src/templates/pages/chat.tsx").includes("sidebar-chats.js")) ok("chat page keeps its own renderer");
else fail("two renderers on the chat page");
if (read("public/js/sidebar-chats.js").includes('document.getElementById("chat-form")')) ok("shared script bails on the chat page");
else fail("shared script would fight chat.js");
// The markup can name the script in a COMMENT while never loading it — which is
// exactly how the rail shipped empty. Assert the actual <script> tag.
for (const p of ["src/templates/pages/project-detail.tsx", "src/templates/pages/epics.tsx", "src/templates/pages/tickets-list.tsx"]) {
  const name = p.split("/").pop()!;
  if (read(p).includes('<script src="/public/js/sidebar-chats.js"></script>')) ok(`${name}: actually loads the script`);
  else fail(`${name}: names the script but never loads it`);
}

console.log("\npinning:");
const api = read("src/routes/api/conversations.ts");
if (api.includes('conversationsApi.post("/:id/pin"')) ok("pin endpoint exists");
else fail("no pin endpoint");
if (api.includes("!access.canWrite")) ok("pinning requires write access");
else fail("anyone who can read could pin");
if (read("src/routes/api/tickets.ts").includes("desc(conversations.pinnedAt)")) ok("pinned chats sort first");
else fail("pin state not used in ordering");
for (const d of ["pg", "sqlite"]) {
  if (read(`src/db/schema/${d}/chat.ts`).includes("pinnedAt")) ok(`${d}: column present`);
  else fail(`${d}: column missing`);
}

console.log("\nproject tabs:");
const pd = read("src/templates/pages/project-detail.tsx");
// Only the tabs whose destinations the rail already carries were meant to go.
const tabsBlock = pd.slice(pd.indexOf('<div class="project-tabs"'), pd.indexOf("<style>", pd.indexOf('<div class="project-tabs"')));
const tabLabels = [...tabsBlock.matchAll(/<\/i> (\w+)/g)].map((m) => m[1]);
if (tabLabels.join(",") === "Home,Events,Settings") ok("tab row keeps exactly what the rail lacks");
else fail("tab row is " + tabLabels.join(","));
for (const gone of ["conversations", "documents", "tickets", "inbox", "environment", "instant"]) {
  if (!new RegExp(`tab=${gone}"`).test(tabsBlock)) ok(`${gone} left the tab row (it's in the rail)`);
  else fail(`${gone} still duplicated in the tab row`);
}

console.log("\nMore, in the rail:");
for (const p of PROJECT_PAGES) {
  const s2 = read(p);
  const name = p.split("/").pop()!;
  // Slice to the END of the group: a fixed 900-char window cut off the last items
  // once the group grew, and reported them missing when they were right there.
  const moreStart = s2.indexOf('id="sidebar-more-items"');
  const more = s2.slice(moreStart, s2.indexOf("conversations-section", moreStart));
  const missing = ["Epics", "Docs", "Inbox", "Environment"].filter((t) => !more.includes(`>${t}<`));
  const strays = ["Events", "Settings"].filter((t) => more.includes(`>${t}</span>`));
  if (!s2.includes("sidebar-more-toggle")) fail(`${name}: no More toggle in the rail`);
  else if (missing.length) fail(`${name}: More is missing ${missing.join(", ")}`);
  else if (strays.length) fail(`${name}: ${strays.join(", ")} belong in the tab row, not the rail`);
  else ok(`${name}: More holds Epics, Docs, Inbox, Environment`);
}
if (read("public/js/sidebar.js").includes("sidebar-more-toggle")) ok("the toggle is wired in sidebar.js (loads on every rail)");
else fail("nothing opens the More section");
// What looked "selected" in More was only ever :hover — nothing marked the page you
// were actually on.
if (/classList\.toggle\("active", isCurrent\)/.test(read("public/js/sidebar.js"))) ok("More marks the page you're on");
else fail("no active state in More — hover is the only highlight");

console.log("\nrail rows are the same component everywhere:");
const chatJs = read("public/js/chat.js");
const shared = read("public/js/sidebar-chats.js");
if (chatJs.includes('class="conversation-pin"') && shared.includes('class="conversation-pin"')) ok("pin on both renderers");
else fail("pin missing from one renderer");
if (chatJs.includes('class="delete-conversation"') && shared.includes('class="delete-conversation"')) ok("delete on both renderers");
else fail("delete missing from one renderer");

console.log("\ndashboard:");
if (!pd.includes("Create a ticket directly")) ok("create-ticket shortcut removed");
else fail("create-ticket card still there");
if (pd.includes("start-work-options { display:grid;grid-template-columns:1fr;")) ok("remaining choice spans the row");
else fail("layout still expects two cards");

console.log("\nstyling:");
const sideCss = read("public/css/sidebar.css");
if (/\.conversations-section \.conversation-title[^}]*font-weight: 400/.test(sideCss)) ok("rail rows keep their weight against projects.css");
else fail("projects.css will win the .conversation-title font again");
if (/button\.nav-link\.sidebar-more-toggle[^}]*appearance: none/.test(sideCss)) ok("More button has no default button chrome");
else fail("More still renders as a browser button");
const lightCss = read("public/css/light/light-mode.css");
if (/\[data-theme="light"\] \.artifacts-button \{[^}]*linear-gradient/.test(lightCss)) ok("artifacts button is a circle in light mode too");
else fail("light mode still strips the artifacts button");
if (!/\.chat-container \.project-header \{[^}]*border-bottom: 1px/.test(read("public/css/chat.css"))) ok("no rule drawn through the artifacts button");
else fail("header border still crosses the button");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
