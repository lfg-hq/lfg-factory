/**
 * Runs public/js/sidebar-chats.js against a stub DOM: bun run test:sidebar
 *
 * Reading the markup said this was wired correctly while the script was throwing
 * ReferenceError on every page. Executing it is the only check that would have
 * caught that.
 */
// Run sidebar-chats.js against a minimal DOM and a stubbed fetch, to see whether it
// actually renders rows — rather than inferring it from the markup.
import fs from "node:fs";
const src = fs.readFileSync("public/js/sidebar-chats.js", "utf8");

function makeEl(tag = "div") {
  return {
    tagName: tag.toUpperCase(), className: "", innerHTML: "", textContent: "",
    dataset: {}, children: [], attrs: {}, listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    querySelector() { return null; }, querySelectorAll() { return { forEach() {}, length: 0 }; },
    contains() { return true; }, closest() { return null; },
  };
}

const listEl = makeEl();
const host = makeEl();
host.attrs = { "data-project": "pub-123" };
host.querySelector = (sel) => (sel === "#conversation-list" ? listEl : null);

let rendered = null;
global.window = { location: { pathname: "/projects/pub-123/tickets", href: "" } };
global.document = {
  querySelector: (sel) => (sel === "[data-sidebar-chats]" ? host : null),
  getElementById: (id) => (id === "chat-form" ? null : null),
  createElement: makeEl,
  addEventListener() {},
};
global.fetch = async (url) => {
  rendered = url;
  return { ok: true, json: async () => ([
    { id: "c1", title: "can u access the db and tell me", is_mine: true, pinned: true },
    { id: "c2", title: "I want to make a change", is_mine: false, author: "Manoj Pillai" },
    { id: "c3", title: "Hello", is_mine: true, pinned: false },
  ]) };
};

new Function(src)();
await new Promise((r) => setTimeout(r, 20));

let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

if (rendered === "/api/projects/pub-123/conversations/") ok("calls the project conversations endpoint");
else fail("wrong or missing fetch: " + rendered);

const rows = listEl.children.filter((c) => c.className.includes("conversation-item"));
const labels = listEl.children.filter((c) => c.className.includes("group-label")).map((c) => c.textContent);
if (rows.length === 3) ok("renders every conversation");
else fail(`expected 3 rows, got ${rows.length}`);
if (labels.join(",") === "Pinned,Recent") ok("pinned group first, then recent");
else fail("group headings wrong: " + labels.join(","));
if (rows[0].className.includes("is-pinned")) ok("the pinned chat leads");
else fail("pinned chat is not first");
if (rows[0].innerHTML.includes('class="conversation-title"')) ok("uses the chat page's own row markup");
else fail("row markup drifted from sidebar.css's selectors");
if (rows[0].innerHTML.includes("conversation-pin")) ok("your own chats get a pin control");
else fail("no pin button on your chats");
if (!rows[1].innerHTML.includes("conversation-pin") && rows[1].innerHTML.includes("conversation-author"))
  ok("a teammate's chat shows the author, not a pin");
else fail("teammate row is wrong");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
