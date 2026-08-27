// Exercise the SERVER-side recording rule: a turn's steps must all be captured, with a
// readable label even when the tool has no specific detail.
import fs from "node:fs";
const src = fs.readFileSync("src/ai/stream-handler.ts", "utf8");

// Pull toolLabel + TOOL_LABELS out of the TS file (they're plain data + string ops).
const start = src.indexOf("const TOOL_LABELS: Record<string, string> = {");
const end = src.indexOf("export function toolActionDetail");
const js = src.slice(start, end)
  .replace("const TOOL_LABELS: Record<string, string> = {", "const TOOL_LABELS = {")
  .replace("export function toolLabel(toolName: string): string {", "function toolLabel(toolName) {")
  .replace(/!;/g, ";");   // strip TS non-null assertions
const toolLabel = new Function(js + "; return toolLabel;")();

let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

// The exact steps from the screenshot that vanished on refresh.
const seen = ["getProjectDashboard", "getFileList", "queryCodebase", "previewPage", "startEpic"];
for (const t of seen) {
  const l = toolLabel(t);
  if (l && !/^[a-z]/.test(l)) ok(`${t} → "${l}"`);
  else fail(`${t} produced "${l}"`);
}
// An unmapped tool must still read as something, not a raw identifier.
const made = toolLabel("someBrandNewTool");
if (made === "Some brand new tool") ok(`an unmapped tool reads as "${made}"`);
else fail(`unmapped tool produced "${made}"`);

// And the recording call must not be gated on a detail existing.
const call = src.slice(src.indexOf("const detail = toolActionDetail"), src.indexOf("const detail = toolActionDetail") + 700);
if (/noteActivity\(detail \|\| toolLabel\(event\.toolName\), event\.toolName\);/.test(call)) ok("every tool call is recorded, detail or not");
else fail("recording is still conditional on a detail string");
if (call.indexOf("noteActivity") < call.indexOf("if (detail)")) ok("recorded before the detail-only branch");
else fail("still inside the detail-only branch");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
