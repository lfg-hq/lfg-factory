import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projects } from "./projects.ts";
import { projectTickets } from "./tickets.ts";

/**
 * External issue-tracker boards (Jira, Linear) linked to an LFG project.
 *
 * Three levels, deliberately separate:
 *
 *   board_connection  — a USER's OAuth grant to a provider. One per user+provider,
 *                       reusable across every project they own.
 *   board_link        — a PROJECT bound to one remote board (a Linear team, a Jira
 *                       project). Holds the status mapping, because "In Review" means
 *                       different things on different boards.
 *   ticket_board_link — a TICKET paired with one remote issue, plus the timestamps the
 *                       two-way sync needs to tell who changed what since last time.
 *
 * The ticket table already carries linear_* columns from the Django port, but they are
 * Linear-shaped and nothing ever used them. A separate pairing table keeps both
 * providers on one code path and leaves room for a ticket to live on more than one board.
 */
export const boardConnections = pgTable(
  "board_connection",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "linear" | "jira" */
    provider: text("provider").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at", { mode: "date" }),
    /** Remote account identity, for showing WHO is connected. */
    accountId: text("account_id"),
    accountName: text("account_name"),
    accountEmail: text("account_email"),
    accountAvatarUrl: text("account_avatar_url"),
    /** Jira Cloud: the site id every REST call is addressed to, and its base URL. */
    cloudId: text("cloud_id"),
    siteUrl: text("site_url"),
    scope: text("scope"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [uniqueIndex("bc_user_provider_unique").on(t.userId, t.provider)]
);

export const boardLinks = pgTable(
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
    /** Linear: team id. Jira: project id. */
    remoteId: text("remote_id").notNull(),
    /** Linear: team key (ENG). Jira: project key (COH). Used to build issue keys. */
    remoteKey: text("remote_key"),
    remoteName: text("remote_name"),
    remoteUrl: text("remote_url"),
    /** Jira only: which issue type new issues are created as. */
    issueTypeId: text("issue_type_id"),
    issueTypeName: text("issue_type_name"),
    /**
     * Status mapping, both directions:
     *   { toRemote: { "<lfg stage id>": "<remote state id>" },
     *     toLocal:  { "<remote state id>": "<lfg stage id>" } }
     * Auto-filled by name on link, editable afterwards — "In Review" is not a universal
     * concept and guessing silently is how tickets end up in the wrong column.
     */
    statusMap: jsonb("status_map").default({}),
    syncEnabled: boolean("sync_enabled").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { mode: "date" }),
    lastSyncSummary: text("last_sync_summary"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("bl_project_provider_unique").on(t.projectId, t.provider),
    index("bl_connection_idx").on(t.connectionId),
  ]
);

export const ticketBoardLinks = pgTable(
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
    /** Linear: issue id (uuid). Jira: issue id. */
    remoteId: text("remote_id").notNull(),
    /** The human key: LIN-42 / COH-19. */
    remoteKey: text("remote_key"),
    remoteUrl: text("remote_url"),
    remoteStatusId: text("remote_status_id"),
    remoteStatusName: text("remote_status_name"),
    /**
     * The three timestamps the merge rule needs: when the remote issue last changed,
     * and when WE last pushed/pulled. A side "changed since last sync" iff its updatedAt
     * is newer than lastSyncedAt — that's what decides who wins without a change log.
     */
    remoteUpdatedAt: timestamp("remote_updated_at", { mode: "date" }),
    lastSyncedAt: timestamp("last_synced_at", { mode: "date" }),
    /** Set when a sync couldn't reconcile a pair, so the UI can show it instead of hiding it. */
    syncError: text("sync_error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("tbl_ticket_provider_unique").on(t.ticketId, t.provider),
    uniqueIndex("tbl_link_remote_unique").on(t.linkId, t.remoteId),
    index("tbl_link_idx").on(t.linkId),
  ]
);
