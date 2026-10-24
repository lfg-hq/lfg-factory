import { pgTable, text, boolean, bigint, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projectFiles } from "./documents.ts";

// Where a user's project documents are published in an external knowledge base.
// One row per (user, provider); the connection itself lives in Composio.
export const documentSyncTargets = pgTable("document_sync_target", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // NOTION | GOOGLEDOCS | GOOGLEDRIVE | CONFLUENCE | ...
  destination: text("destination").notNull().default(""), // parent page, space, folder or doc ID
  autoSync: boolean("auto_sync").notNull().default(false),
  lastSyncedAt: bigint("last_synced_at", { mode: "number" }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
}, t => [uniqueIndex("document_sync_target_user_provider").on(t.userId, t.provider)]);

// The remote copy of one document, so later syncs update it instead of duplicating.
export const documentSyncLinks = pgTable("document_sync_link", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  fileId: text("file_id").notNull().references(() => projectFiles.id, { onDelete: "cascade" }),
  remoteId: text("remote_id"),
  remoteUrl: text("remote_url"),
  remoteVersion: integer("remote_version"),
  contentHash: text("content_hash"),
  syncedAt: bigint("synced_at", { mode: "number" }),
  error: text("error"),
}, t => [uniqueIndex("document_sync_link_unique").on(t.userId, t.provider, t.fileId)]);
