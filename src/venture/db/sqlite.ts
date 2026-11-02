import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "../../db/schema/sqlite/users.ts";

export const ventureConversations = sqliteTable("venture_conversation", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("New conversation"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, t => [index("venture_conv_owner_idx").on(t.userId, t.updatedAt)]);

export const ventureMessages = sqliteTable("venture_message", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  requestId: text("request_id").notNull(),
  status: text("status", { enum: ["started", "completed", "failed", "cancelled"] }).notNull().default("started"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, t => [index("venture_msg_conv_idx").on(t.conversationId, t.createdAt), uniqueIndex("venture_msg_request_idx").on(t.conversationId, t.requestId, t.role), uniqueIndex("venture_msg_active_idx").on(t.conversationId).where(sql`${t.role} = 'assistant' AND ${t.status} = 'started'`)]);

export const ventureSources = sqliteTable("venture_source", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  turnId: text("turn_id").notNull(),
  url: text("url").notNull(),
  title: text("title"),
  retrievedAt: integer("retrieved_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  excerpt: text("excerpt"),
}, t => [index("venture_source_conv_idx").on(t.conversationId)]);

export const ventureAssessments = sqliteTable("venture_assessment", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  contentJson: text("content_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, t => [uniqueIndex("venture_assessment_version_idx").on(t.conversationId, t.version)]);

// LFG's binding funding decision. The analyst only recommends; admins decide.
export const ventureDecisions = sqliteTable("venture_decision", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  assessmentId: text("assessment_id").references(() => ventureAssessments.id, { onDelete: "set null" }),
  assessmentVersion: integer("assessment_version"),
  decision: text("decision", { enum: ["approved", "needs_more_info", "declined", "prohibited"] }).notNull(),
  tokensApproved: integer("tokens_approved").notNull().default(0),
  founderNote: text("founder_note"),
  internalNote: text("internal_note"),
  adminUserId: text("admin_user_id").notNull().references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, t => [index("venture_decision_conv_idx").on(t.conversationId, t.createdAt)]);

// Founder commitments set by the analyst, tracked by the founder.
export const ventureTasks = sqliteTable("venture_task", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => ventureConversations.id, { onDelete: "cascade" }),
  assessmentId: text("assessment_id").notNull().references(() => ventureAssessments.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  action: text("action").notNull(),
  successSignal: text("success_signal"),
  dueWeek: integer("due_week"),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  doneAt: integer("done_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, t => [index("venture_task_assessment_idx").on(t.assessmentId, t.position)]);
