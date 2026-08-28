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
      // Attribute selectors — the code looks rows up by [data-key="..."], and a stub
      // that only understands classes silently reports "not found" and makes correct
      // code look broken.
      const attr = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
      if (attr) {
        const prop = attr[1].replace(/^data-/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase());
        const walkA = (n) => {
          for (const c of n.children) {
            if (c.dataset && c.dataset[prop] === attr[2]) return c;
            const d = walkA(c); if (d) return d;
          }
          return null;
        };
        return walkA(this);
      }
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
// renderSavedTrail lives just above finalizeTrail; pull it in too.
const savedStart = src.indexOf("    /** Replay a SAVED trail from history");
const savedEnd = src.indexOf("    /** The turn is over:");
const withReplay = body + src.slice(savedStart, savedEnd);
const api = new Function("messageContainer", "document", "scrollToBottom",
  withReplay + "; return { trailStep, finalizeTrail, updateTrailMeta, renderSavedTrail, getTrail: () => activeTrail };")(
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

// A file is fetched by ID, so the first line can only say "Reading a file"; the
// result names it. That refinement must REPLACE the line, not add a second one.
// finalizeTrail() ran above, so these steps open a FRESH trail — assert against that
// one, not the finished one.
api.trailStep({ detail: "Reading a file", key: "call_9", tool: "getFileContent" });
const trail2 = api.getTrail();
const beforeRefine = trail2.querySelectorAll(".agent-trail-step").length;
api.trailStep({ detail: "Reading Main PRD", key: "call_9", tool: "getFileContent" });
const afterRefine = trail2.querySelectorAll(".agent-trail-step").length;
if (afterRefine === beforeRefine) ok("a refined detail updates its own row");
else fail(`refinement added a row (${beforeRefine} → ${afterRefine})`);
const refined = trail2.querySelectorAll(".agent-trail-step").find((r) => r.dataset.key === "call_9");
if (refined && refined.dataset.text === "Reading Main PRD") ok("the row now names the file");
else fail("row text is " + (refined && refined.dataset.text));

// Different calls of the same tool stay separate lines.
api.trailStep({ detail: "Reading a file", key: "call_10", tool: "getFileContent" });
if (trail2.querySelectorAll(".agent-trail-step").length === afterRefine + 1) ok("a different call gets its own row");
else fail("rows keyed wrongly across calls");

// A refresh must bring the trail back — collapsed, with every step.
const before = messageContainer.children.length;
api.renderSavedTrail([
  { text: "Loading project dashboard", tool: "getProjectDashboard" },
  { text: "Reading Main PRD", tool: "getFileContent" },
  { text: "Listing the project files", tool: "getFileList" },
]);
const replayed = messageContainer.children[messageContainer.children.length - 1];
if (messageContainer.children.length === before + 1) ok("a saved trail replays as ONE trail");
else fail("replay produced " + (messageContainer.children.length - before) + " elements");
if (replayed.querySelectorAll(".agent-trail-step").length === 3) ok("every saved step comes back");
else fail("replayed " + replayed.querySelectorAll(".agent-trail-step").length + " steps");
if (replayed.classList.contains("is-collapsed") && replayed.classList.contains("is-done"))
  ok("history replays finished and folded away");
else fail("replayed trail is not in its finished state");
if (!api.getTrail()) ok("a replayed trail can't be continued by the next live step");
else fail("history would keep collecting live steps");

// The generic label and its detail are ONE call, so they belong on one row.
api.finalizeTrail();
api.trailStep({ label: "Inspect preview", tool: "inspectPreview" });
const t3 = api.getTrail();
const afterGeneric = t3.querySelectorAll(".agent-trail-step").length;
api.trailStep({ detail: "Inspecting the live preview — Diagnose disk-full", tool: "inspectPreview" });
if (t3.querySelectorAll(".agent-trail-step").length === afterGeneric) ok("the detail replaces the generic row (one call, one line)");
else fail("the same call produced two rows");
const only = t3.querySelectorAll(".agent-trail-step").slice(-1)[0];
if (only.dataset.text.includes("Diagnose disk-full")) ok("...keeping the specific text");
else fail("row text is " + only.dataset.text);
// A DIFFERENT tool still gets its own row.
api.trailStep({ label: "Reading the codebase", tool: "queryCodebase" });
if (t3.querySelectorAll(".agent-trail-step").length === afterGeneric + 1) ok("a different tool still gets its own row");
else fail("rows collapsed across tools");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
