import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projects } from "./projects.ts";
import { sandboxes } from "./sandbox.ts";
import { conversations } from "./chat.ts";

export const instantApps = pgTable(
  "instant_app",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    appId: text("app_id")
      .notNull()
      .unique()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("gathering"),
    requirements: text("requirements"),
    envVars: jsonb("env_vars").$type<Record<string, string>>().default({}),
    previewUrl: text("preview_url"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sandboxId: text("sandbox_id").references(() => sandboxes.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("instant_user_idx").on(t.userId),
    index("instant_project_idx").on(t.projectId),
    index("instant_status_idx").on(t.status),
    uniqueIndex("instant_app_id_unique").on(t.appId),
    uniqueIndex("instant_sandbox_unique").on(t.sandboxId),
    uniqueIndex("instant_conversation_unique").on(t.conversationId),
  ]
);
