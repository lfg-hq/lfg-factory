import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

// ── Projects ────────────────────────────────────────────────────────

export const projects = sqliteTable(
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
    organizationId: text("organization_id"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"), // active | archived | completed
    icon: text("icon").notNull().default("📋"),

    // Repository
    repoUrl: text("repo_url"),          // e.g. https://github.com/user/repo
    repoOwner: text("repo_owner"),      // owner/namespace (user or org/group)
    repoName: text("repo_name"),        // repo/project name
    repoProvider: text("repo_provider").notNull().default("github"), // "github" | "gitlab"

    // Stack
    stack: text("stack").default(""),
    customProjectDir: text("custom_project_dir"),
    customInstallCmd: text("custom_install_cmd"),
    customDevCmd: text("custom_dev_cmd"),
    customDefaultPort: integer("custom_default_port"),

    // Linear integration
    linearTeamId: text("linear_team_id"),
    linearProjectId: text("linear_project_id"),
    linearSyncEnabled: integer("linear_sync_enabled", { mode: "boolean" }).notNull().default(false),

    // Ticket key counter (auto-increment per project)
    ticketCounter: integer("ticket_counter").notNull().default(0),
    epicCounter: integer("epic_counter").notNull().default(0),

    // Preview
    previewTicketId: text("preview_ticket_id"), // FK handled in relations
    // "isolated" = fresh throwaway pi VM per ticket (build → push → destroy);
    // "shared" = git worktree in the always-on preview VM.
    ticketBuildIsolation: text("ticket_build_isolation").notNull().default("isolated"),
    // QA agent: after a ticket builds, generate a test suite from its acceptance
    // criteria and verify it red/green against the branch point. "off" (default) |
    // "tests". Opt-in because it costs a second agent run per ticket.
    qaMode: text("qa_mode").notNull().default("off"),
    // Unused: epic build mode was removed. Kept so schema push does not drop the column.
    epicBuildsEnabled: integer("epic_builds_enabled", { mode: "boolean" }).notNull().default(false),
    validationEnabled: integer("validation_enabled", { mode: "boolean" }).notNull().default(false),
    featureTestingEnabled: integer("feature_testing_enabled", { mode: "boolean" }).notNull().default(false),
    // How this repo runs its tests, detected once (or set up once) rather than
    // rediscovered per ticket. Null until the first QA run resolves it.
    testCommand: text("test_command"),
    // Project-wide model policy, set by the owner on the Config tab. NULL means
    // "each person picks their own"; a value PINS that choice for everyone working
    // on this project. Without this, a collaborator's "Build with" picker wrote to
    // their OWN account settings while builds read the project owner's — so their
    // choice silently did nothing.
    lockedBuilderModel: text("locked_builder_model"),
    lockedBuilderAuthMode: text("locked_builder_auth_mode"),
    lockedChatModel: text("locked_chat_model"),
    // "worktree" = separate worktree dir; "checkout" = switch the main checkout to
    // the branch after stashing (no extra dirs).
    previewBranchMode: text("preview_branch_mode").notNull().default("worktree"),
    // Preview DB strategy: "auto" = use the user's provided connection var if set, else
    // provision a fresh container; "new" = always provision fresh; "provided" = never
    // provision, always use the user-set connection var.
    dbMode: text("db_mode").notNull().default("auto"),

    // When ON, a collaborator's ticket build / preview uses the OWNER's Git token
    // (scoped to this repo). OFF (default): each collaborator uses their own Git.
    shareGitAccess: integer("share_git_access", { mode: "boolean" }).notNull().default(false),
    // Chat visibility across collaborators. OFF (default): each member sees ONLY
    // their own conversations in this project. ON: every active member can list
    // and open every member's project conversations, each labelled with its
    // author. See ../pg/projects.ts for why this is opt-in.
    shareChatHistory: integer("share_chat_history", { mode: "boolean" }).notNull().default(false),
    // See ../pg/projects.ts — per-project agent instructions.
    customInstructions: text("custom_instructions"),
    // See ../pg/projects.ts — when ON the agent's preview shell may write, not just read.
    agentShellAccess: integer("agent_shell_access", { mode: "boolean" }).notNull().default(false),

    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("project_owner_idx").on(t.ownerId)]
);

// ── Project Members ─────────────────────────────────────────────────

export const projectMembers = sqliteTable(
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
    canUsePersonalSubscription: integer("can_use_personal_subscription", { mode: "boolean" }).notNull().default(false),
    role: text("role").notNull().default("member"), // owner | admin | member | viewer
    status: text("status").notNull().default("active"),

    canEditFiles: integer("can_edit_files", { mode: "boolean" }).notNull().default(true),
    canManageTickets: integer("can_manage_tickets", { mode: "boolean" }).notNull().default(true),
    canChat: integer("can_chat", { mode: "boolean" }).notNull().default(true),
    canInviteMembers: integer("can_invite_members", { mode: "boolean" }).notNull().default(false),

    // Per-collaborator LLM credential sharing. `canUseOwnerLlmKey` → owner's API keys
    // (chat + codebase + api-key builds); `canUseOwnerLlmSubscription` → owner's
    // Claude/ChatGPT subscription for builds. DEFAULT true grandfathers existing members;
    // new invitees are inserted OFF (opt-in) in routes/invitations.ts.
    canUseOwnerLlmKey: integer("can_use_owner_llm_key", { mode: "boolean" }).notNull().default(false),
    canUseOwnerLlmSubscription: integer("can_use_owner_llm_subscription", { mode: "boolean" }).notNull().default(false),

    joinedAt: integer("joined_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    invitedById: text("invited_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("pm_project_user_unique").on(t.projectId, t.userId),
    index("pm_project_idx").on(t.projectId),
  ]
);

// ── Project Invitations ─────────────────────────────────────────────

export const projectInvitations = sqliteTable(
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
    canUseOwnerLlmKey: integer("can_use_owner_llm_key", { mode: "boolean" }).notNull().default(false),
    canUsePersonalSubscription: integer("can_use_personal_subscription", { mode: "boolean" }).notNull().default(false),
    role: text("role").notNull().default("member"),
    token: text("token").notNull().unique(),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    respondedAt: integer("responded_at", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("pi_project_email_unique").on(t.projectId, t.email),
    index("pi_project_idx").on(t.projectId),
  ]
);

// ── Project Environment Variables ───────────────────────────────────

export const projectEnvironmentVariables = sqliteTable(
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
    isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(true),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(false),
    hasValue: integer("has_value", { mode: "boolean" }).notNull().default(true),
    description: text("description").default(""),
    createdById: text("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("pev_project_key_unique").on(t.projectId, t.key),
    index("pev_project_idx").on(t.projectId),
  ]
);

// ── Project Code Generation ─────────────────────────────────────────

export const projectCodeGenerations = sqliteTable("project_code_generation", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  folderName: text("folder_name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
