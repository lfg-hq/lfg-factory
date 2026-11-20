import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projects } from "./projects.ts";

// ── Project Files ───────────────────────────────────────────────────

export const projectFiles = sqliteTable(
  "project_file",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Which epic owns this doc. "" (the default) = a project-level MASTER doc —
    // the ratified spec the client reads. A non-empty value scopes the doc to an
    // epic: its scope/tech-analysis draft, which is only folded into the master
    // doc when the epic is APPROVED. Docs merge when code merges, so the master
    // PRD never describes unapproved work. See ../pg/documents.ts for why this is
    // NOT NULL with an "" sentinel rather than nullable.
    epicId: text("epic_id").notNull().default(""),
    name: text("name").notNull(),
    fileType: text("file_type").notNull(), // prd | implementation | design | test | other
    content: text("content"),
    s3Key: text("s3_key"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("pf_project_epic_name_type_unique").on(
      t.projectId,
      t.epicId,
      t.name,
      t.fileType
    ),
    index("pf_project_type_idx").on(t.projectId, t.fileType),
    index("pf_epic_idx").on(t.epicId),
  ]
);

// ── Project File Versions ───────────────────────────────────────────

export const projectFileVersions = sqliteTable(
  "project_file_version",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fileId: text("file_id")
      .notNull()
      .references(() => projectFiles.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    createdById: text("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    changeDescription: text("change_description"),
  },
  (t) => [
    uniqueIndex("pfv_file_version_unique").on(t.fileId, t.versionNumber),
    index("pfv_file_idx").on(t.fileId),
  ]
);

// ── Document edit log ──────────────────────────────────────────────
// One row per editing session on a document: who changed it, whether it was a
// person in the Docs editor or the agent, and which saved version holds the text
// from before the change (so the change can be shown as a diff).
export const documentEdits = sqliteTable(
  "document_edit",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fileId: text("file_id")
      .notNull()
      .references(() => projectFiles.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source").notNull(), // editor | agent | raw
    baseVersion: integer("base_version"),
    addedLines: integer("added_lines").notNull().default(0),
    removedLines: integer("removed_lines").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("de_file_idx").on(t.fileId, t.updatedAt)]
);

// ── Tool Call History ───────────────────────────────────────────────

export const toolCallHistory = sqliteTable(
  "tool_call_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id"),
    messageId: text("message_id"),
    toolName: text("tool_name").notNull(),
    toolInput: text("tool_input", { mode: "json" }).default({}),
    generatedContent: text("generated_content").notNull(),
    contentType: text("content_type")
      .notNull()
      .default("text"),
    metadata: text("metadata", { mode: "json" }).default({}),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("tch_project_idx").on(t.projectId),
    index("tch_project_tool_idx").on(t.projectId, t.toolName),
    index("tch_conv_idx").on(t.conversationId),
  ]
);
