import {
  pgTable,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

export const organizations = pgTable(
  "organization",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    description: text("description").default(""),
    avatar: text("avatar"),
    stripeCustomerId: text("stripe_customer_id"),
    allowMemberInvites: boolean("allow_member_invites").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("org_owner_idx").on(t.ownerId)]
);

export const orgMemberships = pgTable(
  "organization_membership",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    joinedAt: timestamp("joined_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("org_member_unique").on(t.userId, t.organizationId),
    index("org_member_org_idx").on(t.organizationId),
  ]
);

export const orgInvitations = pgTable(
  "organization_invitation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    token: text("token").notNull().unique(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    respondedAt: timestamp("responded_at", { mode: "date" }),
  },
  (t) => [
    uniqueIndex("org_invite_unique").on(t.organizationId, t.email),
    index("org_invite_org_idx").on(t.organizationId),
  ]
);
