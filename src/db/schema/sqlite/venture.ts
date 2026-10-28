import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

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
}, t => [index("venture_msg_conv_idx").on(t.conversationId, t.createdAt), uniqueIndex("venture_msg_request_idx").on(t.conversationId, t.requestId, t.role)]);

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
