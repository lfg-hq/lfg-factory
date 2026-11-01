import { pgTable, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

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
