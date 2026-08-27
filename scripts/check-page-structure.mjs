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

// And the specific breakage: tabs must sit inside their flex container.
const tabs = src.slice(src.indexOf("<!-- Horizontal Tab Nav"), src.indexOf("project-more-menu"));
if (!/<div class="project-tabs"[^>]*display:flex/.test(tabs)) { console.log("FAIL tabs have no flex container"); process.exit(1); }
const opens = (tabs.match(/<div /g) || []).length;
console.log("  ok  document balances");
console.log("  ok  tab row has its flex container");
console.log(`  ok  ${(tabs.match(/class="tab-item/g) || []).length} tabs + More menu inside it (${opens} divs opened in the block)`);
