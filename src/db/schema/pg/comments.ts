import { pgTable, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projectFiles } from "./documents.ts";

export const documentComments = pgTable(
  "document_comment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fileId: text("file_id")
      .notNull()
      .references(() => projectFiles.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    selectedText: text("selected_text").notNull(),
    rangeStart: integer("range_start").notNull(),
    rangeEnd: integer("range_end").notNull(),
    content: text("content").notNull(),
    parentId: text("parent_id"),
    isResolved: boolean("is_resolved").notNull().default(false),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("dc_file_idx").on(t.fileId),
    index("dc_parent_idx").on(t.parentId),
    index("dc_user_idx").on(t.userId),
  ]
);
