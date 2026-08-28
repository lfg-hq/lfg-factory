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

console.log("\nthe agent tab:");
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

console.log("\ncustom skills:");
for (const d of ["pg", "sqlite"]) {
  if (fs.existsSync(`src/db/schema/${d}/project-skills.ts`)) ok(`${d}: project_skill table`);
  else fail(`${d}: table missing`);
}
const skillsApi = api.slice(api.indexOf('previewApi.get("/:projectId/skills"'), api.indexOf('previewApi.get("/:projectId/preview/build-settings"'));
if (/previewApi\.post\("\/:projectId\/skills"/.test(skillsApi)) ok("you can add one");
else fail("no create endpoint");
if (/previewApi\.delete\("\/:projectId\/skills\/:skillId"/.test(skillsApi)) ok("...and delete one");
else fail("no delete endpoint");
if (/requirePermission\(access, "canManageTickets"\)/.test(skillsApi)) ok("writing is permission-checked");
else fail("anyone could add a skill");
if (/replace\(\/\[\^a-z0-9\]\+\/g, "-"\)/.test(skillsApi)) ok("the name is normalised to a callable id");
else fail("a name with spaces would be uncallable");
if (/Describe when the agent should use it/.test(skillsApi)) ok("a description is required — it's how the agent decides");
else fail("description not enforced");
if (/overridden: ownNames\.has/.test(skillsApi)) ok("a project skill shadowing a built-in is marked, not duplicated");
else fail("both would list identically");

const skills2 = fs.readFileSync("src/ai/skills/index.ts", "utf8");
if (/export async function skillsFor/.test(skills2) && /A project skill wins on a name clash/.test(skills2)) ok("the registry merges project skills over built-ins");
else fail("project skills not merged");
const st = fs.readFileSync("src/ai/tools/skill-tools.ts", "utf8");
if (/export function buildLoadSkillTool/.test(st)) ok("loadSkill can be bound to a project");
else fail("loadSkill would only see built-ins");
if (/buildLoadSkillTool\(internalProjectId/.test(handler)) ok("...and the stream handler binds it");
else fail("bound tool never used");
if (/skillCatalogueFor\(internalProjectId/.test(handler)) ok("the prompt catalogue is per-project");
else fail("catalogue is still global");

const page2 = fs.readFileSync("src/templates/pages/project-detail.tsx", "utf8");
if (/tab=agent/.test(page2) && /activeTab === "agent" \? html`/.test(page2)) ok("Agent has its own tab");
else fail("no Agent tab");
if (/function saveSkill\(ev\)/.test(page2) && /function deleteSkill\(/.test(page2)) ok("the tab can add and remove skills");
else fail("UI can't manage skills");
if (/skill-tag/.test(page2) && /Built in/.test(page2)) ok("built-in vs project is visible at a glance");
else fail("no source badge");

console.log("\nagent shell access:");
for (const [d, f] of [["pg", "src/db/schema/pg/projects.ts"], ["sqlite", "src/db/schema/sqlite/projects.ts"]]) {
  const src = fs.readFileSync(f, "utf8");
  if (/agent_shell_access/.test(src) && /default\(false\)/.test(src.slice(src.indexOf("agent_shell_access")))) ok(`${d}: column, defaulting OFF`);
  else fail(`${d}: column missing or not off by default`);
}
if (/agentShellAccess: !!p\.agentShellAccess/.test(api)) ok("the settings endpoint reports it");
else fail("UI can't read the flag");
const shellPost = api.slice(api.indexOf("if (typeof body.agentShellAccess"));
if (/access\.role !== "owner"/.test(shellPost.slice(0, 400))) ok("only the owner can grant it");
else fail("a collaborator could grant it");

const dp = fs.readFileSync("src/services/dev-preview.ts", "utf8");
if (/export async function createPreviewInspectTool/.test(dp)) ok("the tool is built per project");
else fail("still a static tool");
if (/if \(shellAccess\) return \{ inspectPreview: previewShellTool/.test(dp)) ok("granting it swaps in the write-capable tool");
else fail("the flag doesn't change the tool");
const shellTool = dp.slice(dp.indexOf("function previewShellTool"));
if (!/classifyReadonlyPreviewCmd/.test(shellTool.slice(0, 3000))) ok("...which skips the read-only classifier");
else fail("the granted tool still refuses writes");
if (/so you can both diagnose AND FIX/.test(dp)) ok("and says so in its description — the agent knows it may fix");
else fail("description still promises read-only");
if (/resolvePreviewWorkDir/.test(shellTool.slice(0, 3000))) ok("same checkout resolution as the read-only one");
else fail("granted tool resolves workdir differently");
if (/await createPreviewInspectTool/.test(handler)) ok("the stream handler awaits the async factory");
else fail("factory result would be a Promise spread into tools");

if (/access-opt/.test(page2) && /Full shell/.test(page2) && /Read only/.test(page2)) ok("the Agent tab offers the choice");
else fail("no UI for it");
if (/function saveShellAccess/.test(page2) && /paintShellAccess\(!!d\.agentShellAccess/.test(page2)) ok("...and reflects what's saved");
else fail("toggle doesn't round-trip");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
