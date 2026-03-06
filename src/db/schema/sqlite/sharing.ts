import {
  sqliteTable,
  text,
  integer,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projects } from "./projects.ts";

// ── Share Links ──────────────────────────────────────────────────────

export const shareLinks = sqliteTable(
  "share_link",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    token: text("token").notNull().unique(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(), // "file" | "ticket"
    resourceId: text("resource_id").notNull(),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    viewCount: integer("view_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("sl_project_idx").on(t.projectId),
    index("sl_token_idx").on(t.token),
  ]
);
