/**
 * Epics page checks: bun run scripts/test-epics-page.ts
 *
 * Renders the page and asserts on the HTML. Worth having because this template is a
 * backtick literal whose inline scripts have taken the whole page down twice, and
 * because a CSS display rule silently defeating [hidden] is invisible in review.
 */
import { EpicsPage } from "../src/templates/pages/epics.tsx";

const out = String(EpicsPage({
  project: { id: "p1", projectId: "pub1", name: "CoHire" },
  user: { name: "Jitin" },
  epics: [{
    id: "e1", epicKey: "COH-E1", name: "AI Job Description Generator",
    goal: "Generate structured job descriptions from job titles.",
    status: "in_review", branch: "epic/coh-e1-ai", baseBranch: "lfg-agent",
    prUrl: null, previewUrl: null, conversationId: "c1", mergedAt: null, createdAt: new Date(),
  }],
  tickets: [
    { id: "t1", epicId: "e1", ticketKey: "COH-16", name: "SQLite JD store", status: "review", priority: "High", githubBranch: "feature/coh-16", conversationId: "c1" },
    { id: "t2", epicId: "e1", ticketKey: "COH-21", name: "Rewire Generate Now", status: "review", priority: "High", githubBranch: "feature/coh-21", conversationId: "c2" },
  ],
  docs: [{ id: "d1", epicId: "e1", name: "AI JD Generator — PRD", fileType: "prd", owned: false }],
  conversations: [{ id: "c1", title: "JD generator kickoff" }, { id: "c2", title: "Fix Generate Now" }],
}));

const fail = (m: string) => { console.log("FAIL " + m); process.exitCode = 1; };
const ok = (m: string) => console.log("  ok  " + m);

// 1. Both inline scripts must PARSE — a stray backtick or escape in this template has
//    taken the whole page down twice before.
const scripts = [...out.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
console.log(`inline scripts: ${scripts.length}`);
scripts.forEach((src, i) => {
  try { new Function(src); ok(`script ${i + 1} parses (${src.length} chars)`); }
  catch (e) { fail(`script ${i + 1}: ${(e as Error).message}`); }
});

// 2. The panel must start CLOSED, and must not be defeated by a display rule.
if (/<aside class="epic-panel" id="epic-panel" hidden>/.test(out)) ok("panel renders hidden");
else fail("panel is not hidden on first paint");
if (/\.epic-panel\[hidden\]\s*\{\s*display:\s*none/.test(out)) ok("[hidden] beats the flex display rule");
else fail("nothing overrides display:flex for [hidden] — the old drawer bug");

// 3. Detail must live in a <template> (inert until cloned), not inline in the list.
const tpl = out.match(/<template data-epic-detail="e1"[^>]*>/);
tpl ? ok("epic detail is a <template>") : fail("no detail template");
if (out.indexOf('data-epic-title="COH-E1 · AI Job Description Generator"') > -1) ok("panel title carries key + name");
else fail("template has no title attribute");

// 4. Sections stacked, not four columns.
if (!/epic-cols/.test(out)) ok("the four-column layout is gone");
else fail("epic-cols still present");
const secOrder = ["Tickets", "Documents", "Conversations", "Branches"]
  .map((h) => out.indexOf(">" + h + " "));
if (secOrder.every((n, i) => n > 0 && (i === 0 || n > secOrder[i - 1]!))) ok("sections in order: tickets → docs → chats → branches");
else fail("section order wrong: " + JSON.stringify(secOrder));

// 5. Clicking a row opens the panel, and tickets/docs stay in it.
if (/data-epic-open="e1"/.test(out)) ok("epic rows open the panel");
else fail("no data-epic-open handler");
if (/data-open-ticket="t1"/.test(out) && /data-open-doc="d1"/.test(out)) ok("ticket + doc rows are panel buttons");
else fail("ticket/doc rows missing");
if (!/data-epic-toggle/.test(out)) ok("inline expand/collapse removed");
else fail("still expands inline");

// 6. Chats are actually linked.
if (/\/chat\/project\/pub1\/conversation\/c1/.test(out)) ok("conversations link out to the chat");
else fail("no conversation links");

// 7. Tag balance across the whole document. Strip <style>/<script> BODIES first: a CSS
//    comment in this file literally contains the text "<head>", and counting that as a
//    tag is a false alarm, not a broken page.
const markup = out
  .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "<style></style>")
  .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "<script></script>")
  .replace(/<!--[\s\S]*?-->/g, "");
const tags = [...markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)];
const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr","!doctype"]);
const stack: string[] = [];
let bad = "";
for (const m of tags) {
  const [, close, name, , selfClose] = m as unknown as [string, string, string, string, string];
  const n = name.toLowerCase();
  if (VOID.has(n) || selfClose === "/") continue;
  if (!close) stack.push(n);
  else {
    const top = stack.pop();
    if (top !== n) { bad = `</${n}> closed <${top ?? "nothing"}>`; break; }
  }
}
if (!bad && stack.length === 0) ok("every tag balances");
else fail("DOM imbalance: " + (bad || "unclosed " + stack.join(", ")));

// 8. This round's four complaints.
if (/<button class="epic-summary"[^>]*>[\s\S]*?class="epic-goal"[\s\S]*?<\/button>/.test(out)) ok("description sits INSIDE the clickable block");
else fail("description is still outside the button — clicking it does nothing");
if (/<button class="epic-summary"[^>]*>[\s\S]*?class="epic-counts"[\s\S]*?<\/button>/.test(out)) ok("counts are inside the block too");
else fail("counts outside the button");
if (/\.epic-counts \{[^}]*margin-top/.test(out)) ok("counts on their own line, not crowding the pill");
else fail("counts still packed into the title row");
if (/\.epic-panel \{[^}]*flex: 1 1 auto/.test(out)) ok("panel grows to fill the row (no dead strip on the right)");
else fail("panel still has a fixed basis");
if (/marked\.min\.js/.test(out) && /marked\.parse\(raw\)/.test(out)) ok("documents render as markdown");
else fail("documents still dumped as raw text");
if (/\.epic-doc table \{/.test(out) && /\.epic-doc h2 \{/.test(out)) ok("prose styles for headings and tables");
else fail("no prose styles");
if (/\.epic-doc pre \{[^}]*color-mix/.test(out)) ok("code blocks themed, not a hardcoded dark slab");
else fail("pre styling missing");
