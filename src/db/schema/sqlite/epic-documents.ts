import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

/**
 * Which project docs an epic is built from. A LINK, not ownership — the doc
 * stays in the project's Docs tab and stays editable. See ../pg/epic-documents.ts.
 */
export const epicDocuments = sqliteTable(
  "epic_document",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    epicId: text("epic_id").notNull(),
    fileId: text("file_id").notNull(),
    linkedById: text("linked_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("ed_epic_file_unique").on(t.epicId, t.fileId),
    index("ed_epic_idx").on(t.epicId),
    index("ed_file_idx").on(t.fileId),
  ]
);
