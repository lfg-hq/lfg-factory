import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  real,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projects } from "./projects.ts";

export const ticketStages = pgTable(
  "ticket_stage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    order: integer("order").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    isCompleted: boolean("is_completed").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("ts_project_name_unique").on(t.projectId, t.name),
    index("ts_project_order_idx").on(t.projectId, t.order),
  ]
);

export const projectTickets = pgTable(
  "project_ticket",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ticketKey: text("ticket_key"),
    name: text("name").notNull(),
    status: text("status").notNull().default("open"),
    stageId: text("stage_id").references(() => ticketStages.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    priority: text("priority").notNull().default("Medium"),
    role: text("role").notNull().default("user"),
    details: jsonb("details").default({}),
    uiRequirements: jsonb("ui_requirements").default({}),
    componentSpecs: jsonb("component_specs").default({}),
    acceptanceCriteria: jsonb("acceptance_criteria").default([]),
    dependencies: jsonb("dependencies").default([]),
    sourceDocumentId: text("source_document_id"),
    conversationId: text("conversation_id"),
    notes: text("notes").default(""),
    executionOrder: integer("execution_order").notNull().default(0),
    complexity: text("complexity").notNull().default("medium"),
    requiresWorktree: boolean("requires_worktree").notNull().default(true),
    githubBranch: text("github_branch"),
    githubCommitSha: text("github_commit_sha"),
    githubPrUrl: text("github_pr_url"),
    githubPrNumber: integer("github_pr_number"),
    githubMergeStatus: text("github_merge_status"),
    githubMergeCommitSha: text("github_merge_commit_sha"),
    githubLastRevertSha: text("github_last_revert_sha"),
    githubRevertedAt: timestamp("github_reverted_at", { mode: "date" }),
    githubRevertedById: text("github_reverted_by_id").references(() => users.id, { onDelete: "set null" }),
    linearIssueId: text("linear_issue_id"),
    linearIssueUrl: text("linear_issue_url"),
    linearState: text("linear_state"),
    linearPriority: integer("linear_priority"),
    linearAssigneeId: text("linear_assignee_id"),
    linearSyncedAt: timestamp("linear_synced_at", { mode: "date" }),
    linearSyncEnabled: boolean("linear_sync_enabled").notNull().default(true),
    queueStatus: text("queue_status").notNull().default("none"),
    queuedAt: timestamp("queued_at", { mode: "date" }),
    queueTaskId: text("queue_task_id"),
    executionTimeSeconds: real("execution_time_seconds").notNull().default(0),
    lastExecutionAt: timestamp("last_execution_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("pt_project_idx").on(t.projectId),
    index("pt_stage_idx").on(t.stageId),
    index("pt_conv_idx").on(t.conversationId),
    uniqueIndex("pt_project_key_unique").on(t.projectId, t.ticketKey),
  ]
);

export const ticketMergeHistory = pgTable(
  "ticket_merge_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => projectTickets.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    mergeCommitSha: text("merge_commit_sha").notNull(),
    revertCommitSha: text("revert_commit_sha"),
    performedById: text("performed_by_id").references(() => users.id, { onDelete: "set null" }),
    filesChanged: jsonb("files_changed").default([]),
    linesAdded: integer("lines_added").notNull().default(0),
    linesRemoved: integer("lines_removed").notNull().default(0),
    commitMessage: text("commit_message").default(""),
    commitAuthor: text("commit_author").default(""),
    commitDate: timestamp("commit_date", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("tmh_ticket_idx").on(t.ticketId, t.createdAt),
    index("tmh_sha_idx").on(t.mergeCommitSha),
  ]
);

export const projectTodoLists = pgTable(
  "project_todo_list",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => projectTickets.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    status: text("status").notNull().default("pending"),
    order: integer("order").notNull().default(0),
    cliTaskId: text("cli_task_id"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("ptl_ticket_idx").on(t.ticketId)]
);

export const ticketLogs = pgTable(
  "ticket_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => projectTickets.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => projectTodoLists.id, { onDelete: "set null" }),
    logType: text("log_type").notNull().default("command"),
    command: text("command").notNull(),
    explanation: text("explanation"),
    output: text("output"),
    exitCode: integer("exit_code"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("tl_ticket_idx").on(t.ticketId),
    index("tl_task_idx").on(t.taskId),
    index("tl_type_idx").on(t.logType),
  ]
);

export const projectTicketAttachments = pgTable(
  "project_ticket_attachment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => projectTickets.id, { onDelete: "cascade" }),
    uploadedById: text("uploaded_by_id").references(() => users.id, { onDelete: "set null" }),
    filePath: text("file_path").notNull(),
    originalFilename: text("original_filename").default(""),
    fileType: text("file_type").default(""),
    fileSize: integer("file_size").notNull().default(0),
    uploadedAt: timestamp("uploaded_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("pta_ticket_idx").on(t.ticketId)]
);
