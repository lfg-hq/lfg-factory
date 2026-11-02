import { pgTable, text, integer, bigint, boolean, doublePrecision, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "../../db/schema/pg/users.ts";

export const ventureConversations = pgTable("venture_conversation", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("New conversation"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("venture_conv_owner_idx").on(t.userId, t.updatedAt)]);

export const ventureMessages = pgTable("venture_message", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  requestId: text("request_id").notNull(),
  status: text("status", { enum: ["started", "completed", "failed", "cancelled"] }).notNull().default("started"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("venture_msg_conv_idx").on(t.conversationId, t.createdAt), uniqueIndex("venture_msg_request_idx").on(t.conversationId, t.requestId, t.role), uniqueIndex("venture_msg_active_idx").on(t.conversationId).where(sql`${t.role} = 'assistant' AND ${t.status} = 'started'`)]);

export const ventureSources = pgTable("venture_source", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  turnId: text("turn_id").notNull(),
  url: text("url").notNull(),
  title: text("title"),
  retrievedAt: timestamp("retrieved_at", { mode: "date" }).notNull().defaultNow(),
  excerpt: text("excerpt"),
}, t => [index("venture_source_conv_idx").on(t.conversationId)]);

export const ventureAssessments = pgTable("venture_assessment", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  contentJson: jsonb("content_json").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
}, t => [uniqueIndex("venture_assessment_version_idx").on(t.conversationId, t.version)]);

// LFG's binding funding decision. The analyst only recommends; admins decide.
export const ventureDecisions = pgTable("venture_decision", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  assessmentId: text("assessment_id").references(() => ventureAssessments.id, { onDelete: "set null" }),
  assessmentVersion: integer("assessment_version"),
  decision: text("decision", { enum: ["approved", "needs_more_info", "declined", "prohibited"] }).notNull(),
  tokensApproved: bigint("tokens_approved", { mode: "number" }).notNull().default(0),
  founderNote: text("founder_note"),
  internalNote: text("internal_note"),
  adminUserId: text("admin_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("venture_decision_conv_idx").on(t.conversationId, t.createdAt)]);

// Founder commitments set by the analyst, tracked by the founder.
export const ventureTasks = pgTable("venture_task", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  assessmentId: text("assessment_id").notNull().references(() => ventureAssessments.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  action: text("action").notNull(),
  successSignal: text("success_signal"),
  dueWeek: integer("due_week"),
  done: boolean("done").notNull().default(false),
  doneAt: timestamp("done_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("venture_task_assessment_idx").on(t.assessmentId, t.position)]);

// What LFG's agents build with an approved tranche, and what each has cost so far.
export const ventureWorkItems = pgTable("venture_work_item", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  decisionId: text("decision_id").references(() => ventureDecisions.id, { onDelete: "set null" }),
  workType: text("work_type").notNull(),
  title: text("title").notNull(),
  deliverable: text("deliverable"),
  tokensBudgeted: bigint("tokens_budgeted", { mode: "number" }).notNull().default(0),
  tokensSpent: bigint("tokens_spent", { mode: "number" }).notNull().default(0),
  status: text("status", { enum: ["planned", "in_progress", "shipped", "blocked"] }).notNull().default("planned"),
  startedAt: timestamp("started_at", { mode: "date" }),
  shippedAt: timestamp("shipped_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("venture_work_conv_idx").on(t.conversationId)]);

// Venture history: what happened, when, and what it cost.
export const ventureEvents = pgTable("venture_event", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  detail: text("detail"),
  tokens: bigint("tokens", { mode: "number" }),
  occurredAt: timestamp("occurred_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("venture_event_conv_idx").on(t.conversationId, t.occurredAt)]);

// Results: revenue, customers, usage. One row per reading.
export const ventureMetrics = pgTable("venture_metric", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  value: doublePrecision("value").notNull(),
  note: text("note"),
  recordedAt: timestamp("recorded_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("venture_metric_conv_idx").on(t.conversationId, t.name, t.recordedAt)]);
