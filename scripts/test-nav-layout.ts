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
for (const p of PROJECT_PAGES) {
  const s = read(p);
  const rail = s.slice(s.indexOf('<div class="sidebar-nav">'), s.indexOf("sidebar-bottom-content"));
  const has = (label: string) => rail.includes(`<span class="nav-text">${label}</span>`);
  const name = p.split("/").pop()!;
  if (!has("Instant") && !has("Chat") && !has("Tickets") && !has("Epics")) ok(`${name}: rail trimmed to Dashboard`);
  else fail(`${name}: still lists ${["Instant", "Chat", "Tickets", "Epics"].filter(has).join(", ")}`);
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
const tabs = pd.slice(pd.indexOf("<!-- Horizontal Tab Nav"), pd.indexOf("<style>", pd.indexOf("<!-- Horizontal Tab Nav")));
if (!/tab=instant/.test(tabs)) ok("Instant removed from the tab bar");
else fail("Instant still a tab");
for (const t of ["Home", "Chats", "Tickets", "Events", "Settings"]) {
  if (tabs.includes(`> ${t}\n`) || tabs.includes(`></i> ${t}`)) ok(`${t} stays in the row`);
  else fail(`${t} missing from the row`);
}
const menu = pd.slice(pd.indexOf('id="project-more-menu"'), pd.indexOf('id="project-more-menu"') + 1400);
for (const t of ["Inbox", "Epics", "Documents", "Environment"]) {
  if (menu.includes(`> ${t}`)) ok(`${t} moved into More`);
  else fail(`${t} not in the More menu`);
}
if (pd.includes('id="project-more-btn"') && pd.includes("aria-expanded")) ok("More menu is a real toggle");
else fail("More menu has no toggle");

console.log("\ndashboard:");
if (!pd.includes("Create a ticket directly")) ok("create-ticket shortcut removed");
else fail("create-ticket card still there");
if (pd.includes("start-work-options { display:grid;grid-template-columns:1fr;")) ok("remaining choice spans the row");
else fail("layout still expects two cards");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
