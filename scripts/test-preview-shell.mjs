/**
 * Preview shell + a toolbar that stops moving: bun run test:shell
 */
import fs from "node:fs";
const js = fs.readFileSync("public/js/preview-tab.js", "utf8");
const api = fs.readFileSync("src/routes/api/preview.ts", "utf8");
let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

console.log("the shell:");
const route = api.slice(api.indexOf('previewApi.post("/:projectId/preview/exec"'), api.indexOf('previewApi.post("/:projectId/preview/reset-db"'));
if (route) ok("there is an exec endpoint");
else fail("no exec endpoint");
if (/requirePermission\(access, "canEditFiles"\)/.test(route)) ok("gated on canEditFiles — a viewer can't run commands");
else fail("no permission gate on a shell");
if (/getProjectAccess/.test(route)) ok("scoped to a project you have access to");
else fail("no access check");
if (/timeout: 60_000/.test(route)) ok("commands time out");
else fail("a hung command would hang the request");
if (/out\.length > 40_000/.test(route)) ok("output is capped");
else fail("unbounded output");
if (/base64/.test(route)) ok("the command is base64'd through the exec channel (quoting survives)");
else fail("raw command interpolation");
if (/no sandbox yet/.test(route)) ok("says so when the project has no sandbox");
else fail("would fail obscurely without a sandbox");

if (/{ key: "shell", label: "Shell", ptab: "shell"/.test(js)) ok("Shell sits with the other panes");
else fail("no Shell tab");
if (/function shellPanel\(\)/.test(js) && /function runShell\(\)/.test(js)) ok("the panel and its runner exist");
else fail("shell panel missing");
if (/shellHistory\.length > 400/.test(js)) ok("the scrollback is bounded");
else fail("scrollback grows forever");
if (/ev\.key === "Enter"/.test(js)) ok("Enter runs the command");
else fail("no keyboard submit");

console.log("\nthe toolbar stops moving:");
const seg = js.slice(js.indexOf("function segInner()"), js.indexOf("function segButtons()"));
if (/const refresh = `<button data-action="refreshapplog"/.test(seg) && !/onLog \?/.test(seg)) ok("Refresh is always present, in one place");
else fail("Refresh still appears and disappears");
if (!/resetdb/.test(seg)) ok("Reset DB is no longer in the right-hand group");
else fail("Reset DB still shifts the segments");
if (/function syncLeftActions\(\)/.test(js) && /pv-left-actions/.test(js)) ok("Reset DB renders on the LEFT instead");
else fail("no left-hand slot");
const left = js.slice(js.indexOf("function syncLeftActions()"), js.indexOf("function refreshPanes()"));
if (/progressTab === "applogs" && selectedIsDb\(\)/.test(left)) ok("...and only on a database tab");
else fail("Reset DB shows for the wrong tabs");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
