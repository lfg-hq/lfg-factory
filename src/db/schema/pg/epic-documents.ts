import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

/**
 * Which project docs an epic is built from.
 *
 * A LINK, deliberately — not ownership. The doc stays in the project's Docs tab
 * where it can be read and improved at any time; the epic merely points at it.
 * Moving a doc into an epic would hide a shared PRD from everyone until that epic
 * was approved, which is exactly the surprise epics exist to remove.
 *
 * Many-to-many: one epic can draw on several docs, and one doc (the Main PRD,
 * typically) feeds many epics.
 */
export const epicDocuments = pgTable(
  "epic_document",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    epicId: text("epic_id").notNull(),
    fileId: text("file_id").notNull(),
    linkedById: text("linked_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("ed_epic_file_unique").on(t.epicId, t.fileId),
    index("ed_epic_idx").on(t.epicId),
    index("ed_file_idx").on(t.fileId),
  ]
);
