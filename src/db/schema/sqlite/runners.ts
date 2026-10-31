import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

// ── Desktop runners ──────────────────────────────────────────────────
// A person's own computer running LFG Desktop. It connects out to the server and
// runs coding jobs with the Claude Code login on that computer. Only a SHA-256 of
// the device token is stored; the token itself is shown once, at pairing.
export const runnerDevices = sqliteTable(
  "runner_device",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    platform: text("platform"),
    appVersion: text("app_version"),
    claudeVersion: text("claude_version"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("runner_device_token_idx").on(t.tokenHash), index("runner_device_user_idx").on(t.userId)]
);

// One unit of work for a runner. userId is the person whose computer must run it:
// a job is never offered to anyone else's device.
// status: queued | offered | running | succeeded | failed | rejected | cancelled
export const runnerJobs = sqliteTable(
  "runner_job",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id"),
    projectId: text("project_id").notNull(),
    ticketId: text("ticket_id"),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("queued"),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    summary: text("summary"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    startedAt: integer("started_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
  },
  (t) => [index("runner_job_user_status_idx").on(t.userId, t.status), index("runner_job_ticket_idx").on(t.ticketId)]
);
