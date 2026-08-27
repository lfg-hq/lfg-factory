/**
 * The in-chat page preview: bun run test:preview
 *
 * Runs renderPagePreview from chat.js against a stub DOM with a stubbed fetch — the
 * card, the sandboxed frame, and collapse/expand — plus the wiring around it.
 */
import fs from "node:fs";
const chat = fs.readFileSync("public/js/chat.js", "utf8");

function el(tag = "div") {
  const n = {
    tagName: tag.toUpperCase(), className: "", innerHTML: "", textContent: "",
    dataset: {}, children: [], attrs: {},
    classList: {
      _l() { return String(n.className || "").split(/\s+/).filter(Boolean); },
      _s(a) { n.className = a.join(" "); },
      add(...c) { const a = this._l(); c.forEach((x) => !a.includes(x) && a.push(x)); this._s(a); },
      remove(...c) { this._s(this._l().filter((x) => !c.includes(x))); },
      contains(c) { return this._l().includes(c); },
      toggle(c) { const a = this._l(); const i = a.indexOf(c); if (i >= 0) a.splice(i, 1); else a.push(c); this._s(a); return a.includes(c); },
    },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { (this._ls ||= {})[t] = f; },
    querySelector(sel) {
      const want = sel.replace(/^\./, "");
      const walk = (x) => { for (const c of x.children) { if (c.className.split(" ").includes(want)) return c; const d = walk(c); if (d) return d; } return null; };
      const found = walk(this);
      if (found) return found;
      if (this.innerHTML.includes(want)) { const m = el(); m.classList.add(want); this.appendChild(m); return m; }
      return null;
    },
  };
  return n;
}

const messageContainer = el();
let fetched = null;
globalThis.messageContainer = messageContainer;
globalThis.document = { createElement: el };
globalThis.scrollToBottom = () => {};
globalThis.window = { currentProjectId: "pub-1", open: () => {} };
globalThis.extractProjectIdFromPath = () => "pub-1";
globalThis.Blob = class {};
globalThis.URL = { createObjectURL: () => "blob:x" };
globalThis.fetch = async (u) => { fetched = u; return { json: async () => ({ content: "<!doctype html><html><body>hi</body></html>" }) }; };

const start = chat.indexOf("    function renderPagePreview(");
const end = chat.indexOf("    /**\n     * Render a question card inline in the chat.");
const fn = new Function("messageContainer", "document", "scrollToBottom", "window", "extractProjectIdFromPath", "fetch", "Blob", "URL",
  chat.slice(start, end) + "; return renderPagePreview;")(
  messageContainer, globalThis.document, globalThis.scrollToBottom, globalThis.window,
  globalThis.extractProjectIdFromPath, globalThis.fetch, globalThis.Blob, globalThis.URL);

let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

const card = fn("file-7", "RingDesk landing page");
await new Promise((r) => setTimeout(r, 20));

if (messageContainer.children.length === 1) ok("one card in the transcript");
else fail(`${messageContainer.children.length} elements appended`);
if (card.querySelector(".page-preview-name").textContent === "RingDesk landing page") ok("card is titled");
else fail("title missing");
if (fetched === "/projects/pub-1/api/files/file-7/content") ok("loads the saved document");
else fail("wrong fetch: " + fetched);

const frame = card.querySelector(".page-preview-body").children.find((c) => c.tagName === "IFRAME");
if (frame) ok("renders the html in an iframe");
else fail("no iframe rendered");
// Model-authored markup rendering inside the app must not get scripts or same-origin.
if (frame && frame.getAttribute("sandbox") === "") ok("iframe is sandboxed (no scripts, no same-origin)");
else fail("iframe is NOT sandboxed — model-authored HTML would run with privileges");
if (frame && frame.srcdoc.includes("<!doctype html>")) ok("the document is passed via srcdoc");
else fail("srcdoc not set");

card._ls.click({ target: { closest: (s) => (s === "[data-pv]" ? { getAttribute: () => "toggle" } : null) } });
if (card.classList.contains("is-collapsed")) ok("collapses on demand");
else fail("collapse does nothing");
card._ls.click({ target: { closest: (s) => (s === "[data-pv]" ? { getAttribute: () => "expand" } : null) } });
if (card.classList.contains("is-full")) ok("expands to full screen");
else fail("expand does nothing");

// The wiring around it.
if (/case 'page_preview':/.test(chat)) ok("the websocket routes page_preview to the card");
else fail("nothing handles the page_preview notification");
const tools = fs.readFileSync("src/ai/tools/document-tools.ts", "utf8");
if (/notification_type: "page_preview"/.test(tools)) ok("the tool pushes the card to chat");
else fail("tool never notifies the client");
if (/referenceForTicket/.test(tools)) ok("the tool returns a reference for the ticket");
else fail("no ticket reference returned");
const prompt = fs.readFileSync("src/ai/prompts/product.ts", "utf8");
if (/previewPage\(\{ projectId, userId, name, html \}\)/.test(prompt)) ok("the landing flow is told to use it");
else fail("prompt never calls previewPage");
if (/referenceForTicket.*verbatim/s.test(prompt)) ok("the ticket carries the approved design");
else fail("ticket wouldn't reference the preview");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
