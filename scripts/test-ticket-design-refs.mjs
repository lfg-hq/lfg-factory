/**
 * Does a ticket's design reference actually reach the build agent?
 *   bun run test:designrefs
 *
 * The product agent writes "document <uuid>" into the ticket. That only means anything
 * if the file lands in the sandbox and the prompt points at it — the build prompt never
 * carried project documents, so the id was a dead reference.
 */
import fs from "node:fs";
const src = fs.readFileSync("src/workers/ticket-executor.ts", "utf8");
let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

const helper = src.slice(src.indexOf("async function materializeTicketDocs"), src.indexOf("function buildPiTicketPrompt"));
if (helper) ok("the executor materializes referenced documents");
else fail("no materialize step");

// UUID extraction — the exact shape the product agent writes.
const m = helper.match(/\/\[0-9a-f\]\{8\}[^/]+\/gi/);
if (m) {
  const re = new RegExp(m[0].slice(1, -3), "gi");
  const sample = 'Approved design preview: document 8b21cc0d-c9f5-42a8-ba5c-a0043a57f245 ("RingDesk landing page")';
  const found = sample.match(re);
  if (found && found[0] === "8b21cc0d-c9f5-42a8-ba5c-a0043a57f245") ok("finds the document id in real ticket text");
  else fail("the id pattern does not match what the agent writes");
} else fail("no id pattern in the helper");

if (/eq\(projectFiles\.projectId, args\.projectId\)/.test(helper)) ok("scoped to THIS project (an id from elsewhere can't be pulled in)");
else fail("document lookup is not project-scoped");
if (/\.lfg\/design\//.test(helper)) ok("written under .lfg/, which is already gitignored");
else fail("would write into the repo tree");
if (/content\.length > 400_000/.test(helper)) ok("skips absurdly large documents");
else fail("no size guard");
if (/fileType === "page_preview" \? "html"/.test(helper)) ok("a page preview lands as .html");
else fail("extension not derived from the type");
if (/catch/.test(helper) && /return \[\]/.test(helper)) ok("a failure degrades to no refs rather than killing the build");
else fail("errors would break the build");

const prompt = src.slice(src.indexOf("function buildPiTicketPrompt"), src.indexOf("## Acceptance Criteria"));
if (/Design reference — READ THIS FIRST/.test(prompt)) ok("the prompt has a design-reference section");
else fail("prompt never mentions the file");
if (/refBlock\}\$\{runBlock\}/.test(src)) ok("the section is actually included in the prompt body");
else fail("the block is built but never inserted");
if (/APPROVED page design, already signed off/.test(prompt)) ok("tells the agent the design is approved, not a suggestion");
else fail("no weight given to the reference");
if (/rather than pasting the file in/.test(prompt)) ok("says to PORT it into the project's own conventions");
else fail("agent might paste raw HTML into a React app");

if (/designRefs: await materializeTicketDocs\(/.test(src)) ok("wired into the build call");
else fail("helper is never called");
if (/text: \[ticket\.name, ticket\.description \?\? "", ticket\.notes \?\? ""\]/.test(src)) ok("scans name + description + notes for references");
else fail("only part of the ticket is scanned");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
