import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
});

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: "date" }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: "date" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
});

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }),
  updatedAt: timestamp("updated_at", { mode: "date" }),
});

export const profiles = pgTable("profile", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  bio: text("bio").default(""),
  avatar: text("avatar"),
  sidebarCollapsed: boolean("sidebar_collapsed").notNull().default(false),
  emailVerified: boolean("email_verified").notNull().default(false),
  hasSeenOnboarding: boolean("has_seen_onboarding").notNull().default(false),
  claudeCodeAuthenticated: boolean("claude_code_authenticated").notNull().default(false),
  claudeCodeS3Key: text("claude_code_s3_key"),
  claudeCodeCredentials: text("claude_code_credentials"),
  claudeCodeCredentialsUpdatedAt: timestamp("claude_code_credentials_updated_at", { mode: "date" }),
  cliApiKey: text("cli_api_key").unique(),
  currentOrganizationId: text("current_organization_id"),
  allowProjectInvitations: boolean("allow_project_invitations").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
});

export const llmApiKeys = pgTable("llm_api_key", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  openaiApiKey: text("openai_api_key"),
  anthropicApiKey: text("anthropic_api_key"),
  xaiApiKey: text("xai_api_key"),
  googleApiKey: text("google_api_key"),
  kimiApiKey: text("kimi_api_key"),
  deepseekApiKey: text("deepseek_api_key"),
  glmApiKey: text("glm_api_key"),
  freeTrial: boolean("free_trial").notNull().default(true),
  usePersonalLlmKeys: boolean("use_personal_llm_keys").notNull().default(false),
});

export const externalServicesApiKeys = pgTable("external_services_api_key", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  linearApiKey: text("linear_api_key"),
  jiraApiKey: text("jira_api_key"),
  notionApiKey: text("notion_api_key"),
  googleDocsApiKey: text("google_docs_api_key"),
});

export const applicationState = pgTable("application_state", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  sidebarMinimized: boolean("sidebar_minimized").notNull().default(false),
  lastSelectedModel: text("last_selected_model").notNull().default("gpt-5-mini"),
  lastSelectedRole: text("last_selected_role").notNull().default("product_analyst"),
  turboModeEnabled: boolean("turbo_mode_enabled").notNull().default(false),
  claudeCodeEnabled: boolean("claude_code_enabled").notNull().default(false),
  builderModelKey: text("builder_model_key").default("claude_4.5_sonnet"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
});

export const githubTokens = pgTable("github_token", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
  githubUserId: text("github_user_id"),
  githubUsername: text("github_username"),
  githubAvatarUrl: text("github_avatar_url"),
  scope: text("scope"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
});

export const emailVerificationTokens = pgTable(
  "email_verification_token",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    used: boolean("used").notNull().default(false),
  },
  (t) => [index("evt_user_idx").on(t.userId)]
);

export const emailVerificationCodes = pgTable(
  "email_verification_code",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    used: boolean("used").notNull().default(false),
  },
  (t) => [index("evc_user_idx").on(t.userId)]
);
