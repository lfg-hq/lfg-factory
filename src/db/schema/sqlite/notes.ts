import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project notes ────────────────────────────────────────────────────
// Things worth keeping across chats: test logins, URLs, decisions, setup steps.
// Written by the agent or the user. A secret (password, key) is stored encrypted and
// only returned on an explicit reveal. kind: note | login | decision | link.
export const projectNotes = sqliteTable(
  "project_note",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("note"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    secretEncrypted: text("secret_encrypted"),
    source: text("source").notNull().default("user"), // agent | user
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("note_project_idx").on(t.projectId)]
);
