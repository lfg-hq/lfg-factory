/**
 * Per-project agent instructions + the skills list: bun run test:instructions
 */
import fs from "node:fs";
import { allSkills } from "../src/ai/skills/index.ts";
let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };

const api = fs.readFileSync("src/routes/api/preview.ts", "utf8");
const page = fs.readFileSync("src/templates/pages/project-detail.tsx", "utf8");
const handler = fs.readFileSync("src/ai/stream-handler.ts", "utf8");
const exec = fs.readFileSync("src/workers/ticket-executor.ts", "utf8");

console.log("storage + api:");
for (const d of ["pg", "sqlite"]) {
  if (/customInstructions/.test(fs.readFileSync(`src/db/schema/${d}/projects.ts`, "utf8"))) ok(`${d}: column present`);
  else fail(`${d}: column missing`);
}
if (/customInstructions: p\.customInstructions \?\? ""/.test(api)) ok("settings endpoint returns them");
else fail("not returned");
if (/requirePermission\(access, "canManageTickets"\)/.test(api.slice(api.indexOf("customInstructions === \"string\"") - 200, api.indexOf("customInstructions === \"string\"") + 400))) ok("saving is permission-checked");
else fail("anyone could rewrite the agent's instructions");
if (/slice\(0, 4000\)/.test(api)) ok("length capped");
else fail("uncapped paste could crowd out the prompt");

console.log("\nboth agents receive them:");
if (/Project instructions \(from this project's settings\)/.test(handler)) ok("chat agent");
else fail("chat agent never sees them");
if (/PROJECT INSTRUCTIONS \(from this project's settings\)/.test(exec)) ok("build agent");
else fail("build agent never sees them");
if (/Where they conflict with your defaults, follow these/.test(handler)) ok("and they outrank the defaults");
else fail("no precedence stated");

console.log("\nsettings page:");
if (/id="custom-instructions"/.test(page) && /saveCustomInstructions\(\)/.test(page)) ok("there's a box and a save");
else fail("no instructions UI");
if (/id="skills-list"/.test(page) && /loadSkills\(\)/.test(page)) ok("skills are listed");
else fail("skills not shown");
if (/fetch\("\/api\/projects\/" \+ projectId \+ "\/skills"\)/.test(page)) ok("...from the endpoint that actually exists");
else fail("client calls a path that isn't mounted");
if (/previewApi\.get\("\/:projectId\/skills"/.test(api)) ok("the endpoint is project-scoped");
else fail("skills endpoint missing or ambiguous");

console.log("\nthe registry behind it:");
const skills = allSkills();
if (skills.length && skills.every((s) => s.id && s.description)) ok(`${skills.length} skill(s), each with an id and a description`);
else fail("a skill is missing its id or description");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
