/**
 * The tool-result reader: bun run test:tooloutput
 *
 * AI SDK v6 carries a tool's return value on `output`; v4/v5 used `result`.
 * Reading the wrong one fails SILENTLY — undefined, no error — which is how the
 * page-preview card and the resolved file name both did nothing while every other
 * check passed.
 */
// The tool-result reader must handle the SDK's actual field. v6 = `output`.
import fs from "node:fs";
const src = fs.readFileSync("src/ai/stream-handler.ts", "utf8");
const start = src.indexOf("const toolOutput = (ev: unknown)");
const js = src.slice(start, src.indexOf("};", start) + 2)
  .replace("const toolOutput = (ev: unknown): Record<string, unknown> | undefined => {", "const toolOutput = (ev) => {")
  .replace("(e.output ?? e.result)", "(e.output ?? e.result)")
  .replace(/ as Record<string, unknown>/g, "")
  .replace(/const e = ev;/, "const e = ev;");
const toolOutput = new Function(js + "; return toolOutput;")();

let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

// What the SDK actually sends (v6).
const v6 = { type: "tool-result", toolName: "previewPage", input: {}, output: { saved: true, id: "file-1", name: "RingDesk landing page" } };
if (toolOutput(v6)?.id === "file-1") ok("reads the v6 `output` field — the card can fire");
else fail("v6 output not read: " + JSON.stringify(toolOutput(v6)));

// Older shape, in case a provider or version still uses it.
const v5 = { type: "tool-result", toolName: "previewPage", result: { id: "file-2", name: "x" } };
if (toolOutput(v5)?.id === "file-2") ok("still tolerates the older `result` field");
else fail("legacy result not read");

// Junk must not throw or produce a bogus object.
for (const junk of [{}, { output: "a string" }, { output: null }, undefined]) {
  if (toolOutput(junk) === undefined) continue;
  fail("non-object output should yield undefined: " + JSON.stringify(junk));
}
ok("non-object outputs yield undefined rather than throwing");

// And nothing in the file may still read .result directly off the event.
const direct = [...src.matchAll(/\(event as Record<string, unknown>\)\.result/g)];
if (!direct.length) ok("no code reads .result off the event any more");
else fail(`${direct.length} place(s) still read the v5 field directly`);

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
