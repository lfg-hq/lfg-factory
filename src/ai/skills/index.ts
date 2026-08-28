/**
 * Skills — workflow instructions the AGENT fetches when it judges them relevant.
 *
 * Two things were wrong with carrying every workflow in the system prompt: the prompt
 * grew past what any single turn needs (the landing-page loop sat 230 lines down,
 * competing with pipelines for situations the user wasn't in), and the first fix —
 * the SERVER regex-matching the user's words and appending the file — just moved the
 * guess somewhere the model couldn't correct. Keywords miss ("make the top of the site
 * nicer") and over-fire ("restart the preview sandbox").
 *
 * So the file describes itself and the agent decides. Each skill carries frontmatter
 * saying what it's for; the prompt lists those descriptions; `loadSkill` returns the
 * body. Adding a skill is adding one .md file — nothing here or in the prompt needs a
 * matching edit.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Skill {
  id: string;
  /** One line: what this covers and when to reach for it. Shown to the agent. */
  description: string;
  body: string;
}

let cached: Skill[] | null = null;

/** Split `---\nkey: value\n---\nbody` into its parts. */
function parse(file: string, raw: string): Skill | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) {
    console.warn(`[skills] ${file} has no frontmatter — skipped`);
    return null;
  }
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const id = meta.name || file.replace(/\.md$/, "");
  if (!meta.description) {
    console.warn(`[skills] ${file} has no description — the agent won't know when to use it`);
  }
  return { id, description: meta.description ?? "", body: (m[2] ?? "").trim() };
}

export function allSkills(): Skill[] {
  if (cached) return cached;
  try {
    cached = readdirSync(__dirname)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parse(f, readFileSync(join(__dirname, f), "utf-8")))
      .filter((s): s is Skill => !!s && !!s.body);
  } catch (e) {
    console.warn("[skills] could not read the skills directory:", (e as Error).message);
    cached = [];
  }
  return cached;
}

export function getSkill(id: string): Skill | undefined {
  const want = String(id ?? "").trim().toLowerCase();
  return allSkills().find((s) => s.id.toLowerCase() === want);
}

/**
 * The catalogue for the system prompt: ids and descriptions only, so the agent knows
 * what exists and can decide. Costs a few lines rather than the whole workflow.
 */
export function skillCatalogue(): string {
  const skills = allSkills();
  if (!skills.length) return "";
  const lines = skills.map((s) => `- \`${s.id}\` — ${s.description}`).join("\n");
  return `## Skills

Detailed workflows you can load when they apply. Each is a full set of steps that
REPLACES improvising:

${lines}

Call \`loadSkill({ id })\` the moment you recognise the work as one of these — BEFORE
you start it — and then follow what it says. Load it once per conversation; you keep
it for the rest of the turn and the ones after. If a skill covers the work, following
it is not optional: skipping ahead (straight to \`createTickets\`, say) is exactly what
these exist to prevent.`;
}

// ── Project skills ──────────────────────────────────────────────────────────
// The same shape as a built-in, stored per project. Merged into the catalogue the
// agent sees, so it can't tell the two apart — which is the point: "how we cut a
// release here" should be as loadable as the workflows that ship with the product.

export interface ResolvedSkills {
  list: Skill[];
  catalogue: string;
}

async function projectSkills(projectId?: string): Promise<Skill[]> {
  if (!projectId) return [];
  try {
    const { db } = await import("../../config/db.ts");
    const { projectSkills: table } = await import("../../db/schema/project-skills.ts");
    const { and, eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(table)
      .where(and(eq(table.projectId, projectId), eq(table.enabled, true)));
    return rows.map((r) => ({ id: r.name, description: r.description, body: r.body }));
  } catch (e) {
    console.warn("[skills] could not load project skills:", (e as Error).message);
    return [];
  }
}

/** Built-ins plus this project's own. A project skill wins on a name clash. */
export async function skillsFor(projectId?: string): Promise<Skill[]> {
  const own = await projectSkills(projectId);
  const ownIds = new Set(own.map((s) => s.id.toLowerCase()));
  return [...own, ...allSkills().filter((s) => !ownIds.has(s.id.toLowerCase()))];
}

export async function getSkillFor(projectId: string | undefined, id: string): Promise<Skill | undefined> {
  const want = String(id ?? "").trim().toLowerCase();
  return (await skillsFor(projectId)).find((s) => s.id.toLowerCase() === want);
}

/** The prompt catalogue, including anything this project added. */
export async function skillCatalogueFor(projectId?: string): Promise<string> {
  const skills = await skillsFor(projectId);
  if (!skills.length) return "";
  const lines = skills.map((s) => `- \`${s.id}\` — ${s.description}`).join("\n");
  return `## Skills

Detailed workflows you can load when they apply. Each is a full set of steps that
REPLACES improvising:

${lines}

Call \`loadSkill({ id })\` the moment you recognise the work as one of these — BEFORE
you start it — and then follow what it says. Load it once per conversation; you keep
it for the rest of the turn and the ones after. If a skill covers the work, following
it is not optional: skipping ahead (straight to \`createTickets\`, say) is exactly what
these exist to prevent.`;
}
