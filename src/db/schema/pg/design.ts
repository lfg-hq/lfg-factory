import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

export const projectDesignFeatures = pgTable(
  "project_design_feature",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id"),
    featureName: text("feature_name").notNull(),
    featureDescription: text("feature_description").default(""),
    explainer: text("explainer").default(""),
    platform: text("platform").notNull().default("web"),
    cssStyle: text("css_style").default(""),
    commonElements: jsonb("common_elements").default([]),
    pages: jsonb("pages").default([]),
    entryPageId: text("entry_page_id").default(""),
    featureConnections: jsonb("feature_connections").default([]),
    canvasPosition: jsonb("canvas_position").default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("pdf_project_name_unique").on(t.projectId, t.featureName),
    index("pdf_project_idx").on(t.projectId),
  ]
);

export const designCanvases = pgTable(
  "design_canvas",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").default(""),
    isDefault: boolean("is_default").notNull().default(false),
    featurePositions: jsonb("feature_positions").default({}),
    visibleFeatures: jsonb("visible_features").default([]),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("dc_project_name_unique").on(t.projectId, t.name),
    index("dc_project_idx").on(t.projectId),
    index("dc_project_default_idx").on(t.projectId, t.isDefault),
  ]
);
