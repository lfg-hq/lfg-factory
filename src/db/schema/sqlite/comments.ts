import {
  sqliteTable,
  text,
  integer,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projectFiles } from "./documents.ts";

// ── Document Comments ────────────────────────────────────────────────

export const documentComments = sqliteTable(
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
    parentId: text("parent_id"), // null = top-level, set = reply
    isResolved: integer("is_resolved", { mode: "boolean" }).notNull().default(false),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("dc_file_idx").on(t.fileId),
    index("dc_parent_idx").on(t.parentId),
    index("dc_user_idx").on(t.userId),
  ]
);
