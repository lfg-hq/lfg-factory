import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

/**
 * Document templates a project defines for itself, alongside the ones that ship with
 * LFG (src/ai/doc-templates/*.md).
 *
 * A template is the SHAPE a document of some type should take here — the headings a
 * PRD needs, the tables an SOW needs — plus any house rules for writing one. The
 * agent loads the template for the type it is about to write BEFORE writing it, so
 * the document comes out in the project's own form rather than the model's default.
 *
 * Same shape as project skills on purpose: a body the agent follows, and a line
 * saying when it applies.
 */
export const documentTemplates = sqliteTable(
  "document_template",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The document type this applies to: prd | sow | spec | tech_analysis | … */
    docType: text("doc_type").notNull(),
    /** Human label shown in the picker, e.g. "Acme PRD". */
    name: text("name").notNull(),
    /** The skeleton or sample page — headings, tables, placeholder prose. */
    body: text("body").notNull(),
    /** House rules for writing this type here. Kept SEPARATE from the body so the
     *  agent can be told "follow these" without them ending up in the document. */
    instructions: text("instructions").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    // One template per type per project — the agent must never have to choose.
    uniqueIndex("dtpl_project_type_unique").on(t.projectId, t.docType),
    index("dtpl_project_idx").on(t.projectId),
  ]
);
