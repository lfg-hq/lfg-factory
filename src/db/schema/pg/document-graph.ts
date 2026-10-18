import { pgTable, text, bigint, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./projects.ts";
import { users } from "./users.ts";
import type { GraphSnapshot } from "../../../services/document-graph-types.ts";

// A user's private sources never contribute to another user's graph or model prompt.
export const documentGraphs = pgTable("document_graph", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  snapshot: jsonb("snapshot").$type<GraphSnapshot>().notNull(),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  checkedAt: bigint("checked_at", { mode: "number" }).notNull().default(0),
}, t => [uniqueIndex("document_graph_project_user").on(t.projectId, t.userId)]);

export const documentGraphSources = pgTable("document_graph_source", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
  url: text("url"),
  provider: text("provider").notNull(),
});

export const documentGraphLinks = pgTable("document_graph_link", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  target: text("target").notNull(),
  relation: text("relation").notNull(),
  // Rejected suggestions are retained so a later scan cannot resurrect them.
  decision: text("decision").notNull(),
}, t => [uniqueIndex("document_graph_link_unique").on(t.projectId, t.userId, t.source, t.target, t.relation)]);
