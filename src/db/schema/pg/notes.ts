import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project notes ────────────────────────────────────────────────────
// Things worth keeping across chats: test logins, URLs, decisions, setup steps.
// Written by the agent or the user. A secret (password, key) is stored encrypted and
// only returned on an explicit reveal. kind: note | login | decision | link.
export const projectNotes = pgTable(
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
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("note_project_idx").on(t.projectId)]
);
