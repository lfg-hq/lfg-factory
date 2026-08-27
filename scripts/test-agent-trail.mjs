/**
 * Executes the working-trail functions from public/js/chat.js against a stub DOM:
 *   bun run test:trail
 *
 * chat.js is a 4k-line IIFE that can't be imported, so the trail's functions are
 * extracted and run in isolation. Reading them is not enough — a missing function in
 * this file shipped silently once already.
 */
import fs from "node:fs";
const src = fs.readFileSync("public/js/chat.js", "utf8");

function el(tag = "div") {
  const node = {
    tagName: tag.toUpperCase(), className: "", innerHTML: "", textContent: "",
    dataset: {}, children: [], attrs: {}, isConnected: true, parentNode: null,
    // className is the single source of truth: the code under test assigns it
    // directly (node.className = "a b"), so a classList backed by its own Set
    // silently diverges — which is a bug in the stub, not in chat.js.
    classList: {
      _list() { return String(node.className || "").split(/\s+/).filter(Boolean); },
      _set(a) { node.className = a.join(" "); },
      add(...c) { const a = this._list(); c.forEach((x) => { if (!a.includes(x)) a.push(x); }); this._set(a); },
      remove(...c) { this._set(this._list().filter((x) => !c.includes(x))); },
      contains(c) { return this._list().includes(c); },
      toggle(c) { const a = this._list(); const i = a.indexOf(c); if (i >= 0) a.splice(i, 1); else a.push(c); this._set(a); return a.includes(c); },
    },
    _sync() {},
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    addEventListener() {},
    closest() { return this; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    querySelector(sel) {
      const want = sel.replace(/^\./, "");
      const hit = (n) => n.className && n.className.split(" ").includes(want);
      const walk = (n) => { for (const c of n.children) { if (hit(c)) return c; const d = walk(c); if (d) return d; } return null; };
      const found = walk(this);
      if (found) return found;
      // The template HTML isn't parsed by this stub, so synthesise the pieces the code
      // looks for — every time, not only while the node is childless.
      if (this.innerHTML.includes(want)) {
        const made = el(); made.classList.add(want); this.appendChild(made); return made;
      }
      return null;
    },
    querySelectorAll(sel) {
      const want = sel.replace(/^\./, "").split(".").pop();
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (c.className.split(" ").includes(want)) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
  };
  node._sync();
  return node;
}

const messageContainer = el();
globalThis.messageContainer = messageContainer;
globalThis.document = { createElement: el, querySelector: () => null, querySelectorAll: () => [] };
globalThis.scrollToBottom = () => {};

// Pull the trail functions out of the IIFE and run them standalone.
const start = src.indexOf("    let activeTrail = null;");
const end = src.indexOf("    // Function to show a function call success message");
const body = src.slice(start, end);
const api = new Function("messageContainer", "document", "scrollToBottom",
  body + "; return { trailStep, finalizeTrail, updateTrailMeta, getTrail: () => activeTrail };")(
  messageContainer, globalThis.document, globalThis.scrollToBottom);

let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

api.trailStep({ detail: "Reading the codebase", icon: "fa-magnifying-glass", color: "#a78bfa" });
api.trailStep({ detail: "Reading src/index.ts", icon: "fa-file", color: "#a78bfa" });
api.trailStep({ detail: "Reading src/index.ts", icon: "fa-file", color: "#a78bfa" }); // duplicate
api.trailStep({ detail: "Searching for landing page", icon: "fa-magnifying-glass", color: "#a78bfa" });

const trail = api.getTrail();
if (trail) ok("a trail is created on first activity"); else fail("no trail created");
if (messageContainer.children.length === 1) ok("one trail per turn, not one widget per step");
else fail(`${messageContainer.children.length} elements appended`);

const steps = trail.querySelectorAll(".agent-trail-step");
if (steps.length === 3) ok("steps accumulate, duplicates collapse (4 events → 3 rows)");
else fail(`expected 3 steps, got ${steps.length}`);
if (steps[steps.length - 1].classList.contains("is-current")) ok("the newest step is marked current");
else fail("no current step");
if (steps[0].dataset.text === "Reading the codebase") ok("the first step is kept, not overwritten");
else fail("earlier steps were lost: " + steps[0].dataset.text);
if (trail.classList.contains("is-running")) ok("marked running while working");
else fail("not marked running");

api.finalizeTrail();
if (trail.classList.contains("is-collapsed")) ok("collapses when the job is done");
else fail("did not collapse");
if (trail.classList.contains("is-done") && !trail.classList.contains("is-running")) ok("marked done");
else fail("still marked running");
if (trail.isConnected && trail.querySelectorAll(".agent-trail-step").length === 3)
  ok("stays in the transcript with its steps, so you can go back and read it");
else fail("the record was discarded on completion");
if (!api.getTrail()) ok("the next turn starts a fresh trail");
else fail("the finished trail would keep collecting");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
