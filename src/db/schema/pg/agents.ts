import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { sandboxes } from "./sandbox.ts";
import { conversations } from "./chat.ts";

// ── Agents ───────────────────────────────────────────────────────────

export const agents = pgTable(
  "agent",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .unique()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    personality: text("personality"),
    instructions: text("instructions"),
    status: text("status").notNull().default("idle"),
    sandboxId: text("sandbox_id").references(() => sandboxes.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    composioToolkits: jsonb("composio_toolkits").$type<string[]>().default([]),
    memoryContent: text("memory_content"),
    memoryLastSyncedAt: timestamp("memory_last_synced_at", { mode: "date" }),
    sandboxUrl: text("sandbox_url"),
    cliSessionId: text("cli_session_id"),

    // Phase 4 — Structured state
    state: jsonb("state").$type<Record<string, unknown>>().default({}),

    // Phase 2 — Webhook trigger (24 bytes random; not unique-constrained,
    // but indexed for lookup. Token entropy makes collisions effectively impossible.)
    webhookToken: text("webhook_token"),

    // Phase 1 F2 — Current run tracking
    currentRunId: text("current_run_id"),

    // Phase 1 F3 — Auto-stop idle agents
    autoStopAfterIdleMs: integer("auto_stop_after_idle_ms"),
    lastActivityAt: timestamp("last_activity_at", { mode: "date" }),

    // Phase 3 R2 — Wall-clock timeout per run
    runTimeoutMs: integer("run_timeout_ms"),

    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("agent_user_idx").on(t.userId),
    index("agent_status_idx").on(t.status),
    index("agent_webhook_token_idx").on(t.webhookToken),
  ]
);

// ── Agent Schedules ──────────────────────────────────────────────────

export const agentSchedules = pgTable(
  "agent_schedule",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cronExpression: text("cron_expression").notNull(),
    command: text("command").notNull(),
    enabled: boolean("enabled").notNull().default(true),

    // Phase 3 R4 — Retry policy
    maxRetries: integer("max_retries").notNull().default(0),

    // Phase 3 — Timezone
    timezone: text("timezone").notNull().default("UTC"),

    lastRunAt: timestamp("last_run_at", { mode: "date" }),
    nextRunAt: timestamp("next_run_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("as_agent_idx").on(t.agentId),
  ]
);

// ── Agent Data Files ─────────────────────────────────────────────────

export const agentDataFiles = pgTable(
  "agent_data_file",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    fileType: text("file_type"),
    filePath: text("file_path").notNull(),
    fileSize: integer("file_size"),
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("adf_agent_idx").on(t.agentId),
  ]
);

// ── Agent Messages ───────────────────────────────────────────────────

export const agentMessages = pgTable(
  "agent_message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationType: text("conversation_type").notNull().default("individual"),
    role: text("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("am_agent_idx").on(t.agentId),
    index("am_type_idx").on(t.conversationType),
  ]
);

// ── Agent Secrets ────────────────────────────────────────────────────

export const agentSecrets = pgTable(
  "agent_secret",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEncrypted: text("value_encrypted").notNull(),
    description: text("description"),
    service: text("service"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("asec_agent_idx").on(t.agentId),
    uniqueIndex("asec_agent_key_uq").on(t.agentId, t.key),
  ]
);

// ── Agent Task Runs ──────────────────────────────────────────────────

export const agentTaskRuns = pgTable(
  "agent_task_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    scheduleId: text("schedule_id").references(() => agentSchedules.id, { onDelete: "set null" }),
    triggerType: text("trigger_type").notNull(),
    status: text("status").notNull().default("queued"),
    prompt: text("prompt").notNull(),
    triggerPayload: jsonb("trigger_payload").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { mode: "date" }),
    finishedAt: timestamp("finished_at", { mode: "date" }),
    exitCode: integer("exit_code"),
    outputSummary: text("output_summary"),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").notNull().default(0),
    parentRunId: text("parent_run_id"),
    timeoutAt: timestamp("timeout_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("atr_agent_idx").on(t.agentId),
    index("atr_status_idx").on(t.status),
    index("atr_schedule_idx").on(t.scheduleId),
  ]
);
