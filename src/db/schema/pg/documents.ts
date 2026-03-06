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
import { projects } from "./projects.ts";

export const projectFiles = pgTable(
  "project_file",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    fileType: text("file_type").notNull(),
    content: text("content"),
    s3Key: text("s3_key"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("pf_project_name_type_unique").on(t.projectId, t.name, t.fileType),
    index("pf_project_type_idx").on(t.projectId, t.fileType),
  ]
);

export const projectFileVersions = pgTable(
  "project_file_version",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    fileId: text("file_id")
      .notNull()
      .references(() => projectFiles.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    changeDescription: text("change_description"),
  },
  (t) => [
    uniqueIndex("pfv_file_version_unique").on(t.fileId, t.versionNumber),
    index("pfv_file_idx").on(t.fileId),
  ]
);

export const toolCallHistory = pgTable(
  "tool_call_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id"),
    messageId: text("message_id"),
    toolName: text("tool_name").notNull(),
    toolInput: jsonb("tool_input").default({}),
    generatedContent: text("generated_content").notNull(),
    contentType: text("content_type").notNull().default("text"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("tch_project_idx").on(t.projectId),
    index("tch_project_tool_idx").on(t.projectId, t.toolName),
    index("tch_conv_idx").on(t.conversationId),
  ]
);
