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
import { projectTickets } from "./tickets.ts";

/**
 * External issue-tracker boards (Jira, Linear). See ../pg/boards.ts for the rationale
 * behind the three levels: a user's OAuth grant, a project bound to one remote board,
 * and a ticket paired with one remote issue.
 */
export const boardConnections = sqliteTable(
  "board_connection",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: integer("token_expires_at", { mode: "timestamp" }),
    accountId: text("account_id"),
    accountName: text("account_name"),
    accountEmail: text("account_email"),
    accountAvatarUrl: text("account_avatar_url"),
    cloudId: text("cloud_id"),
    siteUrl: text("site_url"),
    scope: text("scope"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("bc_user_provider_unique").on(t.userId, t.provider)]
);

export const boardLinks = sqliteTable(
  "board_link",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => boardConnections.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    remoteId: text("remote_id").notNull(),
    remoteKey: text("remote_key"),
    remoteName: text("remote_name"),
    remoteUrl: text("remote_url"),
    issueTypeId: text("issue_type_id"),
    issueTypeName: text("issue_type_name"),
    statusMap: text("status_map", { mode: "json" }).default({}),
    syncEnabled: integer("sync_enabled", { mode: "boolean" }).notNull().default(true),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
    lastSyncSummary: text("last_sync_summary"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("bl_project_provider_unique").on(t.projectId, t.provider),
    index("bl_connection_idx").on(t.connectionId),
  ]
);

export const ticketBoardLinks = sqliteTable(
  "ticket_board_link",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => projectTickets.id, { onDelete: "cascade" }),
    linkId: text("link_id")
      .notNull()
      .references(() => boardLinks.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    remoteId: text("remote_id").notNull(),
    remoteKey: text("remote_key"),
    remoteUrl: text("remote_url"),
    remoteStatusId: text("remote_status_id"),
    remoteStatusName: text("remote_status_name"),
    remoteUpdatedAt: integer("remote_updated_at", { mode: "timestamp" }),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
    syncError: text("sync_error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("tbl_ticket_provider_unique").on(t.ticketId, t.provider),
    uniqueIndex("tbl_link_remote_unique").on(t.linkId, t.remoteId),
    index("tbl_link_idx").on(t.linkId),
  ]
);
