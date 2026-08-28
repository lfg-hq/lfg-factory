import fs from "node:fs";
const js = fs.readFileSync("public/js/artifacts-loader.js", "utf8");
const css = fs.readFileSync("public/css/artifacts.css", "utf8");
let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

const block = js.slice(js.indexOf("if (data.type === 'page_preview')"), js.indexOf("// Always render as markdown"));
if (/data-pvdoc="render"/.test(block) && /data-pvdoc="code"/.test(block)) ok("both Preview and Code are offered");
else fail("no render/code toggle");
if (/showRender\(\);\s*\n\s*wrap\.addEventListener/.test(block)) ok("opens on the rendered page, not the markup");
else fail("does not default to the preview");
if (/frame\.setAttribute\('sandbox', ''\)/.test(block)) ok("the frame is sandboxed");
else fail("iframe is not sandboxed");
if (/pre\.textContent = content/.test(block)) ok("code view escapes via textContent");
else fail("code view could inject markup");
if (/URL\.createObjectURL/.test(block)) ok("open-in-tab uses a blob (own origin)");
else fail("no safe open-in-tab");

// Contrast: the code view must set its OWN colours in both themes — inheriting the
// viewer's prose colour is what made the markup near-invisible on dark.
const codeRule = css.slice(css.indexOf(".pv-doc-code {"), css.indexOf("}", css.indexOf(".pv-doc-code {")));
if (/background:\s*#0f1117/.test(codeRule) && /color:\s*#d7dce5/.test(codeRule)) ok("dark: explicit background and text colour");
else fail("dark code view still inherits");
const lightRule = css.slice(css.indexOf('[data-theme="light"] .pv-doc-code {'), css.indexOf("}", css.indexOf('[data-theme="light"] .pv-doc-code {')));
if (/color:\s*#1e293b/.test(lightRule)) ok("light: dark text on a light panel");
else fail("light code view has no colour");

// light-mode.css carries a GLOBAL `[data-theme="light"] pre { color: #e2e8f0
// !important }` plus a light background for .markdown-content pre — pale on pale.
// Our rules have to be marked or they lose.
const lightCode = css.slice(css.indexOf('[data-theme="light"] .pv-doc-code {'), css.indexOf("}", css.indexOf('[data-theme="light"] .pv-doc-code {')));
if (/color:\s*#1e293b\s*!important/.test(lightCode)) ok("light code colour is marked (beats the global pre rule)");
else fail("light code colour would lose to [data-theme=light] pre");
const darkCode = css.slice(css.indexOf(".pv-doc-code {"), css.indexOf("}", css.indexOf(".pv-doc-code {")));
if (/color:\s*#d7dce5\s*!important/.test(darkCode)) ok("dark code colour is marked");
else fail("dark code colour unmarked");
if (/\.pv-doc-tab\.is-on \{[^}]*color:\s*#fff\s*!important/.test(css)) ok("the active tab label stays white");
else fail("active tab label can be repainted");

const loader = fs.readFileSync("public/js/artifacts-loader.js", "utf8");
if (/'page_preview': 'fas fa-window-maximize'/.test(loader)) ok("previews get their own icon in Docs");
else fail("preview still shows the generic file icon");

const chat = fs.readFileSync("public/js/chat.js", "utf8");
if (/showToast\('Preview saved to Docs'/.test(chat)) ok("a toast says where the preview was saved");
else fail("no toast on save");
if (/renderPagePreview\(p\.id, p\.name, \{ replay: true \}\)/.test(chat)) ok("history replay does NOT re-toast");
else fail("reloading a chat would fire a toast per saved preview");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
