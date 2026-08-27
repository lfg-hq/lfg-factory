import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

export const agentRoles = pgTable("agent_role", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("product_analyst"),
  turboMode: boolean("turbo_mode").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
});

export const conversations = pgTable(
  "conversation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    projectId: text("project_id"),
    designCanvasId: text("design_canvas_id"),
    // Pinned chats sit above the recent list and never scroll away. A timestamp rather
    // than a boolean so the pinned group has a stable order of its own.
    pinnedAt: timestamp("pinned_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("conv_user_idx").on(t.userId),
    index("conv_project_idx").on(t.projectId),
  ]
);

export const messages = pgTable(
  "message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    // Who actually typed this. NULL = the conversation's own author (every legacy
    // row, and the normal case). Set when an owner/admin continues someone else's
    // shared chat, so the transcript shows who said what.
    authorId: text("author_id"),
    content: text("content").notNull(),
    contentIfFile: jsonb("content_if_file").default([]),
    userRole: text("user_role").default("default"),
    isPartial: boolean("is_partial").notNull().default(false),
    // Full AI SDK response.messages sequence for this assistant turn —
    // includes intermediate tool-calls + tool-results so the next turn
    // can replay context the LLM had (not just its final text).
    // Null on user rows and on legacy assistant rows.
    toolSteps: jsonb("tool_steps").$type<any[] | null>(),
    // The compact list of steps the user watched while this turn ran ("Reading X",
    // "Listing the project files"). SEPARATE from toolSteps, which is the AI SDK's raw
    // replay context — provider-shaped, huge, and dropped past 200KB. This is the UI's
    // record, so the working trail survives a refresh.
    activityTrail: jsonb("activity_trail").$type<Array<{ text: string; tool?: string }> | null>(),
    // Page previews produced during this turn, so the card comes back on refresh
    // rather than living only in the socket message that announced it.
    pagePreviews: jsonb("page_previews").$type<Array<{ id: string; name: string }> | null>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    lastUpdated: timestamp("last_updated", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("msg_conv_created_idx").on(t.conversationId, t.createdAt),
    index("msg_conv_partial_idx").on(t.conversationId, t.isPartial),
  ]
);

export const chatFiles = pgTable(
  "chat_file",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    originalFilename: text("original_filename").notNull(),
    fileType: text("file_type").default(""),
    fileSize: integer("file_size").notNull().default(0),
    uploadedAt: timestamp("uploaded_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("chatfile_conv_idx").on(t.conversationId)]
);

export const modelSelections = pgTable("model_selection", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  selectedModel: text("selected_model").notNull().default("gpt-5.6-luna"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
});
