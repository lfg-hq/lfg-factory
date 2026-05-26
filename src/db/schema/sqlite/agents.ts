import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { sandboxes } from "./sandbox.ts";
import { conversations } from "./chat.ts";

// ── Agents ───────────────────────────────────────────────────────────

export const agents = sqliteTable(
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
    personality: text("personality"), // system prompt / persona
    instructions: text("instructions"), // default task instructions
    status: text("status").notNull().default("idle"), // idle | starting | running | paused | error | stopped
    sandboxId: text("sandbox_id").references(() => sandboxes.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    composioToolkits: text("composio_toolkits", { mode: "json" })
      .$type<string[]>()
      .default(sql`'[]'`),
    memoryContent: text("memory_content"),
    memoryLastSyncedAt: integer("memory_last_synced_at", { mode: "timestamp" }),
    sandboxUrl: text("sandbox_url"),
    cliSessionId: text("cli_session_id"),

    // Phase 4 — Structured state (incremental watermarks, per-agent key/value)
    state: text("state", { mode: "json" })
      .$type<Record<string, unknown>>()
      .default(sql`'{}'`),

    // Phase 2 — Webhook trigger (24 bytes random; not unique-constrained,
    // but indexed for lookup. Token entropy makes collisions effectively impossible.)
    webhookToken: text("webhook_token"),

    // Phase 1 F2 — Current run tracking (one run at a time per agent)
    currentRunId: text("current_run_id"),

    // Phase 1 F3 — Auto-stop idle agents (null = never auto-stop)
    autoStopAfterIdleMs: integer("auto_stop_after_idle_ms"),
    lastActivityAt: integer("last_activity_at", { mode: "timestamp" }),

    // Phase 3 R2 — Wall-clock timeout per run (null = use default)
    runTimeoutMs: integer("run_timeout_ms"),

    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .default(sql`'{}'`),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("agent_user_idx").on(t.userId),
    index("agent_status_idx").on(t.status),
    index("agent_webhook_token_idx").on(t.webhookToken),
  ]
);

// ── Agent Schedules ──────────────────────────────────────────────────

export const agentSchedules = sqliteTable(
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
    command: text("command").notNull(), // prompt text
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

    // Phase 3 R4 — Retry policy
    maxRetries: integer("max_retries").notNull().default(0),

    // Phase 3 — Timezone (IANA name, e.g. "America/Los_Angeles")
    timezone: text("timezone").notNull().default("UTC"),

    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    nextRunAt: integer("next_run_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("as_agent_idx").on(t.agentId),
  ]
);

// ── Agent Data Files ─────────────────────────────────────────────────

export const agentDataFiles = sqliteTable(
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
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .default(sql`'{}'`),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("adf_agent_idx").on(t.agentId),
  ]
);

// ── Agent Messages ───────────────────────────────────────────────────

export const agentMessages = sqliteTable(
  "agent_message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationType: text("conversation_type").notNull().default("individual"), // individual | central
    role: text("role").notNull(), // user | assistant | system | agent_question
    content: text("content").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .default(sql`'{}'`),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("am_agent_idx").on(t.agentId),
    index("am_type_idx").on(t.conversationType),
  ]
);

// ── Agent Secrets ────────────────────────────────────────────────────
// Per-agent encrypted env vars. Injected into the sandbox at /root/.env
// and also exported into the Claude CLI shell. Let the agent call any API
// without needing a Composio toolkit.

export const agentSecrets = sqliteTable(
  "agent_secret",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // env var name, e.g. SHOPIFY_TOKEN
    valueEncrypted: text("value_encrypted").notNull(),
    description: text("description"),
    service: text("service"), // optional hint: "shopify", "bigquery", etc.
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("asec_agent_idx").on(t.agentId),
    uniqueIndex("asec_agent_key_uq").on(t.agentId, t.key),
  ]
);

// ── Agent Task Runs ──────────────────────────────────────────────────
// One row per task execution for the autonomous agent system. Gives us
// observability, concurrency control, retries, and a foundation for timeouts
// & alerting. Named distinctly from orchestrator.agentRuns to avoid conflict.

export const agentTaskRuns = sqliteTable(
  "agent_task_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    scheduleId: text("schedule_id").references(() => agentSchedules.id, { onDelete: "set null" }),
    triggerType: text("trigger_type").notNull(), // cron | manual | webhook | start | chat
    status: text("status").notNull().default("queued"), // queued | running | success | error | timeout | cancelled
    prompt: text("prompt").notNull(),
    triggerPayload: text("trigger_payload", { mode: "json" }).$type<Record<string, unknown>>(),
    startedAt: integer("started_at", { mode: "timestamp" }),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    exitCode: integer("exit_code"),
    outputSummary: text("output_summary"),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").notNull().default(0),
    parentRunId: text("parent_run_id"),
    timeoutAt: integer("timeout_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("atr_agent_idx").on(t.agentId),
    index("atr_status_idx").on(t.status),
    index("atr_schedule_idx").on(t.scheduleId),
  ]
);
