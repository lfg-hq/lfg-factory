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

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
