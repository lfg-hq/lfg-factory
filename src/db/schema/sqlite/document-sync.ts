import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projectFiles } from "./documents.ts";

// Where a user's project documents are published in an external knowledge base.
// One row per (user, provider); the connection itself lives in Composio.
export const documentSyncTargets = sqliteTable("document_sync_target", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // NOTION | GOOGLEDOCS | GOOGLEDRIVE | CONFLUENCE | ...
  destination: text("destination").notNull().default(""), // parent page, space, folder or doc ID
  autoSync: integer("auto_sync", { mode: "boolean" }).notNull().default(false),
  lastSyncedAt: integer("last_synced_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, t => [uniqueIndex("document_sync_target_user_provider").on(t.userId, t.provider)]);

// The remote copy of one document, so later syncs update it instead of duplicating.
export const documentSyncLinks = sqliteTable("document_sync_link", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  fileId: text("file_id").notNull().references(() => projectFiles.id, { onDelete: "cascade" }),
  remoteId: text("remote_id"),
  remoteUrl: text("remote_url"),
  remoteVersion: integer("remote_version"),
  contentHash: text("content_hash"),
  syncedAt: integer("synced_at"),
  error: text("error"),
}, t => [uniqueIndex("document_sync_link_unique").on(t.userId, t.provider, t.fileId)]);
