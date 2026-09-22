// Does project-detail.tsx still produce a well-formed document? Editing a template by
// slicing between anchors can drop a container's OPENING tag and leave its closer behind
// — the page then renders with everything after it mis-nested, which is exactly what
// happened here and what a content-only check could never catch.
import fs from "node:fs";
const src = fs.readFileSync("src/templates/pages/project-detail.tsx", "utf8");

// Strip the TS/template scaffolding down to markup: drop ${...} expressions, comments,
// and the contents of <style>/<script>.
let m = src
  .replace(/\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "X")
  .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "")
  .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
  .replace(/<!--[\s\S]*?-->/g, "");

const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr","!doctype"]);
// Only real elements: this file is TypeScript, and generics like Map<string, X> look
// exactly like tags to a regex.
const HTML = new Set(["html","head","body","div","span","a","p","h1","h2","h3","h4","h5","h6","ul","ol","li",
  "table","thead","tbody","tr","td","th","form","label","button","select","option","optgroup","textarea",
  "section","aside","nav","header","footer","main","i","b","strong","em","code","pre","small","iframe",
  "template","details","summary","dialog","canvas","svg","path","figure","figcaption","picture","video","audio"]);
const stack = [];
let bad = "";
for (const t of m.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
  const [, close, name, , self] = t;
  const n = name.toLowerCase();
  if (!HTML.has(n)) continue;
  if (VOID.has(n) || self === "/") continue;
  if (!close) stack.push(n);
  else {
    const top = stack.pop();
    if (top !== n) { bad = `</${n}> closed <${top ?? "nothing"}>`; break; }
  }
}
if (bad) { console.log("FAIL " + bad); process.exit(1); }
if (stack.length) { console.log("FAIL unclosed: " + stack.join(", ")); process.exit(1); }

console.log("  ok  document balances");
// The breadcrumb / repo switcher / "Back to Workspace" header and the tab row belong
// to the project DASHBOARD — Home, Agent, Events, Settings, Config. On pages reached
// from the left rail (Docs, Environment, Inbox) you are already inside one project:
// the header is noise there, and the tab row points at views the page isn't part of.
const headerIdx = src.indexOf("<!-- Project Header");
const headerGated = src.slice(headerIdx, headerIdx + 700).includes("isDashboardTab ? html`");
if (headerGated) console.log("  ok  project header is gated on the dashboard tabs");
else { console.log("FAIL project header is not gated on isDashboardTab"); process.exit(1); }

const tabsIdx = src.indexOf('<div class="project-tabs"');
const tabsGated = src.slice(Math.max(0, tabsIdx - 200), tabsIdx).includes("isDashboardTab ? html`");
if (tabsGated) console.log("  ok  tab row is gated on the dashboard tabs");
else { console.log("FAIL tab row renders on rail-reached pages (Docs/Environment/Inbox)"); process.exit(1); }

// Every tab must get the page stylesheet. It used to live inside the home/inbox
// branch, so Agent/Events/Settings rendered unstyled.
const styleIdx = src.indexOf(".agent-card {");
const styleGated = src.slice(Math.max(0, styleIdx - 4000), styleIdx).lastIndexOf('activeTab === "home" || activeTab === "inbox"');
const styleOpen = src.slice(Math.max(0, styleIdx - 4000), styleIdx).lastIndexOf("<style>");
if (styleOpen > styleGated) console.log("  ok  page styles are emitted for every tab");
else { console.log("FAIL page styles are nested in a per-tab branch"); process.exit(1); }
// The tab row carries only the destinations the left rail does NOT — and it must
// still sit inside its flex container. Config joined it when the builder/chat model
// pickers moved out of the Tickets toolbar and the chat composer.
const tabStart = src.indexOf('<div class="project-tabs"');
if (tabStart < 0) { console.log("FAIL the tab row is missing"); process.exit(1); }
const tabs = src.slice(tabStart, src.indexOf("<style>", tabStart));
const labels = [...tabs.matchAll(/<\/i> (\w+)/g)].map((m) => m[1]);
if (labels.join(",") === "Home,Activity,Settings") console.log("  ok  tab row is Home, Activity, Settings");
else { console.log("FAIL tab row is " + labels.join(",")); process.exit(1); }
if (/display:flex/.test(tabs.slice(0, 200))) console.log("  ok  tab row has its flex container");
else { console.log("FAIL tabs have no flex container"); process.exit(1); }
const rail = src.slice(src.indexOf('<div class="sidebar-nav">'), src.indexOf("conversations-section"));
if (/<div class="sidebar-more-items"/.test(rail)) console.log("  ok  rail carries the More group");
else { console.log("FAIL rail lost the More group"); process.exit(1); }
