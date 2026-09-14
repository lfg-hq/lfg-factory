import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

// ── Token Usage ─────────────────────────────────────────────────────

export const tokenUsage = sqliteTable(
  "token_usage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id"), // FK to projects
    conversationId: text("conversation_id"), // FK to conversations
    provider: text("provider").notNull(), // openai | anthropic | xai | google
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    timestamp: integer("timestamp", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    requestId: text("request_id"),
    runId: text("run_id"),
    ticketId: text("ticket_id"),
    operation: text("operation").notNull().default("chat"),
    modelTier: text("model_tier"),
    billingMode: text("billing_mode").notNull().default("api"),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cost: real("cost"),
  },
  (t) => [
    uniqueIndex("tu_request_idx").on(t.requestId),
    index("tu_run_idx").on(t.runId),
    index("tu_ticket_idx").on(t.ticketId),
    index("tu_user_ts_idx").on(t.userId, t.timestamp),
    index("tu_project_ts_idx").on(t.projectId, t.timestamp),
    index("tu_conv_ts_idx").on(t.conversationId, t.timestamp),
    index("tu_provider_model_idx").on(t.provider, t.model),
  ]
);

// A distinct run for every build attempt or ticket chat; actor is independent of key owner.
export const tokenUsageRuns = sqliteTable("token_usage_run", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: text("project_id"),
  ticketId: text("ticket_id"),
  operation: text("operation").notNull(),
  billingMode: text("billing_mode").notNull().default("api"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// Association, not allocation: one model request can involve several documents.
export const tokenUsageDocuments = sqliteTable("token_usage_document", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  usageId: text("usage_id").notNull().references(() => tokenUsage.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull(),
}, t => [uniqueIndex("tud_usage_doc_idx").on(t.usageId, t.documentId), index("tud_doc_idx").on(t.documentId)]);

export const tokenUsageTickets = sqliteTable("token_usage_ticket", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  usageId: text("usage_id").notNull().references(() => tokenUsage.id, { onDelete: "cascade" }),
  ticketId: text("ticket_id").notNull(),
}, t => [uniqueIndex("tut_usage_ticket_idx").on(t.usageId, t.ticketId), index("tut_ticket_idx").on(t.ticketId)]);
