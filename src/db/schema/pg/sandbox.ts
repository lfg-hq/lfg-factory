import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projects } from "./projects.ts";
import { projectTickets } from "./tickets.ts";

export const sandboxes = pgTable(
  "sandbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    ticketId: text("ticket_id").references(() => projectTickets.id, { onDelete: "set null" }),
    // NOT unique: the worktree model shares ONE Mags workspace across many ticket
    // sandbox rows (each on its own git worktree/branch), so several rows
    // legitimately carry the same mags_workspace_id.
    magsWorkspaceId: text("mags_workspace_id"),
    magsJobId: text("mags_job_id"),
    magsBaseWorkspaceId: text("mags_base_workspace_id"),
    workspaceType: text("workspace_type").notNull().default("ticket"),
    status: text("status").notNull().default("ready"),
    cliSessionId: text("cli_session_id"),
    previewUrl: text("preview_url"),
    previewPort: integer("preview_port"),
    currentBranch: text("current_branch"),
    outputOffset: integer("output_offset").notNull().default(0),
    techStack: jsonb("tech_stack").$type<{
      language?: string;
      framework?: string;
      packageManager?: string;
      startCommand?: string;
      buildCommand?: string;
      port?: number;
    }>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("sb_project_idx").on(t.projectId),
    index("sb_ticket_idx").on(t.ticketId),
    index("sb_user_idx").on(t.userId),
    index("sb_mags_ws_idx").on(t.magsWorkspaceId),
  ]
);

export const serverLogs = pgTable(
  "server_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id").references(() => projectTickets.id, { onDelete: "cascade" }),
    level: text("level").notNull().default("info"),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("sl_sandbox_idx").on(t.sandboxId, t.createdAt),
    index("sl_ticket_idx").on(t.ticketId, t.createdAt),
  ]
);
