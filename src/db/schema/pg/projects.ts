import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

export const projects = pgTable(
  "project",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .unique()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    providedName: text("provided_name"),
    description: text("description"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    icon: text("icon").notNull().default("📋"),
    repoUrl: text("repo_url"),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    repoProvider: text("repo_provider").notNull().default("github"), // "github" | "gitlab"
    stack: text("stack").default(""),
    customProjectDir: text("custom_project_dir"),
    customInstallCmd: text("custom_install_cmd"),
    customDevCmd: text("custom_dev_cmd"),
    customDefaultPort: integer("custom_default_port"),
    linearTeamId: text("linear_team_id"),
    linearProjectId: text("linear_project_id"),
    linearSyncEnabled: boolean("linear_sync_enabled").notNull().default(false),
    ticketCounter: integer("ticket_counter").notNull().default(0),
    previewTicketId: text("preview_ticket_id"),
    // How ticket builds run: "isolated" = a fresh throwaway pi VM per ticket
    // (build → commit → push → destroy; the preview VM stays clean), "shared" =
    // a git worktree inside the always-on preview VM (warm caches, but a bad build
    // can disrupt the preview).
    ticketBuildIsolation: text("ticket_build_isolation").notNull().default("isolated"),
    // How the preview runs a ticket's FEATURE branch: "worktree" = a separate git
    // worktree dir (keeps the main checkout untouched), "checkout" = switch the
    // single main checkout to the branch after stashing local changes (no extra
    // dirs — the workstation stays tidy).
    previewBranchMode: text("preview_branch_mode").notNull().default("worktree"),
    // Preview DB strategy: "auto" = use the user's provided connection var if set, else
    // provision a fresh container; "new" = always provision fresh; "provided" = never
    // provision, always use the user-set connection var.
    dbMode: text("db_mode").notNull().default("auto"),
    // Fine-grained Git sharing. When ON, a COLLABORATOR's ticket build / preview uses
    // the OWNER's connected Git (GitHub/GitLab) token — scoped to this project's repo —
    // so teammates can build/push/open PRs/MRs without their own repo access. OFF
    // (default): each collaborator acts with their OWN connected Git; the owner's
    // credentials are NEVER used for a collaborator without this explicit opt-in.
    shareGitAccess: boolean("share_git_access").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("project_owner_idx").on(t.ownerId)]
);

export const projectMembers = pgTable(
  "project_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    canEditFiles: boolean("can_edit_files").notNull().default(true),
    canManageTickets: boolean("can_manage_tickets").notNull().default(true),
    canChat: boolean("can_chat").notNull().default(true),
    canInviteMembers: boolean("can_invite_members").notNull().default(false),
    joinedAt: timestamp("joined_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
    invitedById: text("invited_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("pm_project_user_unique").on(t.projectId, t.userId),
    index("pm_project_idx").on(t.projectId),
  ]
);

export const projectInvitations = pgTable(
  "project_invitation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    token: text("token").notNull().unique(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    respondedAt: timestamp("responded_at", { mode: "date" }),
  },
  (t) => [
    uniqueIndex("pi_project_email_unique").on(t.projectId, t.email),
    index("pi_project_idx").on(t.projectId),
  ]
);

export const projectEnvironmentVariables = pgTable(
  "project_environment_variable",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    isSecret: boolean("is_secret").notNull().default(true),
    isRequired: boolean("is_required").notNull().default(false),
    hasValue: boolean("has_value").notNull().default(true),
    description: text("description").default(""),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("pev_project_key_unique").on(t.projectId, t.key),
    index("pev_project_idx").on(t.projectId),
  ]
);

export const projectCodeGenerations = pgTable("project_code_generation", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  folderName: text("folder_name").notNull().unique(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
});
