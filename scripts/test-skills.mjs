/**
 * Skill loading: bun run test:skills
 *
 * A skill must load when the work is about it, stay loaded while the user keeps
 * iterating, and stay out of the prompt the rest of the time.
 */
import { matchSkills, skillsFor, SKILLS } from "../src/ai/skills/index.ts";

let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

const loads = (text) => matchSkills(text).some((s) => s.id === "landing-page");

console.log("loads when it should:");
for (const t of [
  "I want to build a landing page for this project",
  "can you make a marketing page",
  "build me a home page",
  "add a pricing page",
  "I want a website for my clinic",
  "tweak the hero copy",
  "redo the wireframe",
  "pls create preview again",   // mid-iteration, via history
]) {
  if (loads(t)) ok(`"${t.slice(0, 42)}"`);
  else fail(`did NOT load for "${t}"`);
}

console.log("\nstays out otherwise:");
for (const t of [
  "fix the merge conflict on COH-19",
  "restart the preview sandbox",        // the app Preview tab, not a page
  "the preview is failing to build",
  "why did the build fail?",
  "add a column to the tickets table",
  "what does this project do",
  "",
]) {
  if (!loads(t)) ok(`"${(t || "(empty)").slice(0, 42)}"`);
  else fail(`loaded for unrelated: "${t}"`);
}

console.log("\nthe content:");
const block = skillsFor("I want to build a landing page");
if (block.includes("Settle the CONTENT first")) ok("carries the content-before-preview rule");
else fail("skill text missing the content rule");
if (block.includes("previewPage")) ok("carries the preview step");
else fail("skill text missing previewPage");
if (block.includes("Build on approval")) ok("carries the ticket step");
else fail("skill text missing the ticket step");
if (skillsFor("unrelated question") === "") ok("adds nothing when no skill matches");
else fail("injected text for an unrelated turn");
if (block.length > 3000) ok(`skill is substantial (${block.length} chars) and out of the base prompt`);
else fail(`skill looks truncated (${block.length} chars)`);

// The base prompt must no longer carry the whole workflow.
const fs = await import("node:fs");
const prompt = fs.readFileSync("src/ai/prompts/product.ts", "utf8");
if (!prompt.includes("Settle the CONTENT first")) ok("the base prompt no longer inlines the workflow");
else fail("workflow is still inline in product.ts");
if (prompt.includes("loaded into your context automatically")) ok("the base prompt points at the skill");
else fail("nothing tells the model a skill exists");

// The flow rules themselves — they moved from product.ts into the skill, so they're
// asserted here now.
console.log("\nthe flow the skill teaches:");
const skill = fs.readFileSync("src/ai/skills/landing-page.md", "utf8");
const flat = skill.replace(/\n\s+/g, " ");
if (/Settle the CONTENT first/.test(skill)) ok("content is settled before any render");
else fail("preview still comes first");
if (/Want me to render a quick preview/.test(flat)) ok("it ASKS before rendering");
else fail("no permission step");
if (/Wait for a yes/.test(skill)) ok("and waits for the answer");
else fail("doesn't wait");
if (/a content tweak is a chat reply, not a re-render/.test(flat)) ok("edits after a preview stay in chat");
else fail("would re-render on every tweak");
if (/visual rather than textual/.test(skill)) ok("visual changes still re-render immediately");
else fail("no exception for layout changes");
if (/referenceForTicket/.test(skill)) ok("the ticket carries the approved design");
else fail("ticket wouldn't reference the preview");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
