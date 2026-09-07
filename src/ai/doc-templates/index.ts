/**
 * Document templates — the SHAPE a document takes here, loaded before one is written.
 *
 * Without this, every PRD came out in whatever form the model felt like that day: the
 * headings drifted between documents, house conventions had to be re-explained in every
 * conversation, and an SOW written for a client looked nothing like the last one.
 *
 * The shape mirrors skills deliberately (src/ai/skills), because the problem is the
 * same: the agent needs to know something exists, and fetch it only when it applies.
 * Each template is a .md file with frontmatter saying which document TYPE it is for;
 * a project can override any of them, or add types of its own, from the Config tab.
 *
 * Two separate fields, and the distinction matters:
 *   body         the skeleton/sample — headings, tables, placeholder prose. This is
 *                what the finished document should LOOK like.
 *   instructions house rules for writing one. Followed, never copied into the document.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DocTemplate {
  /** Stable id — the file name, or the project template's name. */
  id: string;
  /** The document type this applies to (prd, sow, spec, tech_analysis, …). */
  docType: string;
  /** One line: what this is for. Shown to the agent so it knows when to load it. */
  description: string;
  /** The skeleton the document should follow. */
  body: string;
  /** House rules for writing it. Empty for the built-ins. */
  instructions: string;
  /** Did this come from the project, or ship with LFG? */
  source: "project" | "builtin";
}

let cached: DocTemplate[] | null = null;

function parse(file: string, raw: string): DocTemplate | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) {
    console.warn(`[doc-templates] ${file} has no frontmatter — skipped`);
    return null;
  }
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const id = meta.name || file.replace(/\.md$/, "");
  return {
    id,
    docType: (meta.docType || id).toLowerCase(),
    description: meta.description ?? "",
    body: (m[2] ?? "").trim(),
    instructions: "",
    source: "builtin",
  };
}

/** The templates that ship with LFG. */
export function builtinTemplates(): DocTemplate[] {
  if (cached) return cached;
  try {
    cached = readdirSync(__dirname)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parse(f, readFileSync(join(__dirname, f), "utf-8")))
      .filter((t): t is DocTemplate => !!t && !!t.body);
  } catch (e) {
    console.warn("[doc-templates] could not read the templates directory:", (e as Error).message);
    cached = [];
  }
  return cached;
}

/** A project's own templates, if it has any. */
async function projectTemplates(projectId?: string): Promise<DocTemplate[]> {
  if (!projectId) return [];
  try {
    const { db } = await import("../../config/db.ts");
    const { documentTemplates } = await import("../../db/schema/document-templates.ts");
    const { and, eq } = await import("drizzle-orm");
    const rows = await db.select().from(documentTemplates)
      .where(and(eq(documentTemplates.projectId, projectId), eq(documentTemplates.enabled, true)));
    return rows.map((r) => ({
      id: r.name,
      docType: r.docType.toLowerCase(),
      description: `This project's own ${r.docType} template.`,
      body: r.body,
      instructions: r.instructions ?? "",
      source: "project" as const,
    }));
  } catch (e) {
    console.warn("[doc-templates] could not load project templates:", (e as Error).message);
    return [];
  }
}

/** Built-ins plus this project's own. A project template WINS on its document type. */
export async function templatesFor(projectId?: string): Promise<DocTemplate[]> {
  const own = await projectTemplates(projectId);
  const ownTypes = new Set(own.map((t) => t.docType));
  return [...own, ...builtinTemplates().filter((t) => !ownTypes.has(t.docType))];
}

/** The template for one document type, or undefined when there isn't one. */
export async function templateFor(projectId: string | undefined, docType: string): Promise<DocTemplate | undefined> {
  const want = String(docType ?? "").trim().toLowerCase();
  if (!want) return undefined;
  const all = await templatesFor(projectId);
  return all.find((t) => t.docType === want)
    // "implementation" and "tech_analysis" are the same document wearing two names;
    // a near miss should still find the template rather than silently writing freehand.
    ?? all.find((t) => t.docType.replace(/[_-]/g, "") === want.replace(/[_-]/g, ""));
}

/** The catalogue for the system prompt — types only, so it stays cheap. */
export async function templateCatalogueFor(projectId?: string): Promise<string> {
  const all = await templatesFor(projectId);
  if (!all.length) return "";
  const lines = all
    .map((t) => `- \`${t.docType}\`${t.source === "project" ? " (this project's own)" : ""} — ${t.description}`)
    .join("\n");
  return `## Document templates

Documents written here follow a set shape. These types have a template:

${lines}

Before you write a document with \`streamDocumentContent\`, call
\`loadDocumentTemplate({ docType })\` for its type and follow what it returns — the
skeleton is the shape the document should take, and any instructions are house rules
to obey without copying them into the document. Load it BEFORE writing, not after: a
document already written in the wrong shape has to be rewritten. If a type has no
template, write it as you normally would.`;
}
