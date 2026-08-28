/**
 * Skills: bun run test:skills
 *
 * Skills are AGENT-FETCHED. The prompt advertises what exists; loadSkill returns the
 * body. Nothing here should keyword-match the user — that was the previous design, and
 * it guessed from outside the conversation.
 */
import fs from "node:fs";
import { allSkills, getSkill, skillCatalogue } from "../src/ai/skills/index.ts";
import { loadSkill } from "../src/ai/tools/skill-tools.ts";

let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

console.log("the registry:");
const skills = allSkills();
if (skills.length) ok(`${skills.length} skill(s) discovered from the directory`);
else fail("no skills found");
const lp = getSkill("landing-page");
if (lp) ok("landing-page loads by id");
else fail("landing-page missing");
if (lp && lp.description.length > 40) ok("it describes itself (frontmatter)");
else fail("no usable description");
if (lp && !lp.body.startsWith("---")) ok("frontmatter is stripped from the body");
else fail("frontmatter leaked into the instructions");
if (getSkill("LANDING-PAGE")) ok("id match is case-insensitive");
else fail("case-sensitive id lookup");

console.log("\nwhat the prompt carries:");
const cat = skillCatalogue();
if (cat.includes("landing-page") && cat.includes("loadSkill")) ok("the catalogue lists the skill and how to load it");
else fail("catalogue incomplete");
if (!cat.includes("Sketch a loose wireframe")) ok("the catalogue does NOT inline the workflow");
else fail("the whole skill is still in the prompt");
if (cat.length < 1200) ok(`catalogue is small (${cat.length} chars) vs the skill body (${lp.body.length})`);
else fail(`catalogue is ${cat.length} chars — too heavy for every turn`);

console.log("\nthe tool:");
const good = await loadSkill.execute({ id: "landing-page" }, {});
if (good.found && good.instructions.includes("Settle the CONTENT first")) ok("returns the full workflow");
else fail("tool did not return the instructions");
const bad1 = await loadSkill.execute({ id: "nope" }, {});
if (!bad1.found && Array.isArray(bad1.available) && bad1.available.length) ok("an unknown id lists the real options");
else fail("unknown id fails without guidance");

console.log("\nthe flow the skill teaches:");
const body = lp.body;
const flat = body.replace(/\n\s+/g, " ");
const rules = [
  ["content is settled before any render", /Settle the CONTENT first/],
  ["it ASKS before rendering", /Want me to render a quick preview/],
  ["and waits for the answer", /Wait for a yes/],
  ["edits after a preview stay in chat", /a content tweak is a chat reply, not a re-render/],
  ["visual changes still re-render immediately", /visual rather than textual/],
  ["the ticket carries the approved design", /referenceForTicket/],
];
for (const [label, re] of rules) {
  if (re.test(body) || re.test(flat)) ok(label);
  else fail(label);
}

console.log("\nno server-side guessing left:");
const handler = fs.readFileSync("src/ai/stream-handler.ts", "utf8");
if (!/skillsFor\(/.test(handler)) ok("the server no longer appends skills by keyword");
else fail("keyword matching is still in the stream handler");
const prompt = fs.readFileSync("src/ai/prompts/product.ts", "utf8");
if (!prompt.includes("Sketch a loose wireframe")) ok("the workflow is out of the base prompt");
else fail("workflow still inline in product.ts");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
