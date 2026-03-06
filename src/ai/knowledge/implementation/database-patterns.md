# Database Patterns

## When to Use This

Use these patterns when setting up a new database schema, defining relationships between models, handling migrations, or needing production-safe conventions like soft deletes, timestamps, and UUID primary keys. Covers both Prisma and Drizzle ORM.

## Quick Start

### Dependencies

```bash
# Prisma
npm install prisma @prisma/client
npx prisma init

# Drizzle (PostgreSQL)
npm install drizzle-orm drizzle-kit pg
npm install -D @types/pg

# Drizzle (SQLite - for local/edge)
npm install drizzle-orm drizzle-kit better-sqlite3
npm install -D @types/better-sqlite3

# UUID support
npm install uuid
npm install -D @types/uuid
```

### Environment Variables

```env
DATABASE_URL="postgresql://user:password@localhost:5432/mydb"
```

---

## Patterns

### 1. Prisma Schema — Full Production Schema with Relationships

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?
  role      Role     @default(USER)

  // Timestamps
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  deletedAt DateTime? // soft delete

  // Relations
  posts     Post[]
  profile   Profile?
  teamMembers TeamMember[]

  @@index([email])
  @@index([deletedAt])
  @@map("users")
}

model Profile {
  id        String  @id @default(uuid())
  bio       String?
  avatarUrl String?
  userId    String  @unique

  user      User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("profiles")
}

model Post {
  id          String   @id @default(uuid())
  title       String
  slug        String   @unique
  content     String
  published   Boolean  @default(false)
  authorId    String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?

  author      User     @relation(fields: [authorId], references: [id])
  tags        TagsOnPosts[]

  @@index([authorId])
  @@index([slug])
  @@index([published, deletedAt])
  @@map("posts")
}

// Many-to-many: Posts <-> Tags via explicit join table
model Tag {
  id    String @id @default(uuid())
  name  String @unique
  slug  String @unique
  posts TagsOnPosts[]

  @@map("tags")
}

model TagsOnPosts {
  postId     String
  tagId      String
  assignedAt DateTime @default(now())

  post       Post @relation(fields: [postId], references: [id], onDelete: Cascade)
  tag        Tag  @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@id([postId, tagId])
  @@map("tags_on_posts")
}

// Team with members (many-to-many with role on join table)
model Team {
  id        String   @id @default(uuid())
  name      String
  createdAt DateTime @default(now())
  members   TeamMember[]

  @@map("teams")
}

model TeamMember {
  userId    String
  teamId    String
  role      TeamRole @default(MEMBER)
  joinedAt  DateTime @default(now())

  user      User @relation(fields: [userId], references: [id], onDelete: Cascade)
  team      Team @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@id([userId, teamId])
  @@map("team_members")
}

enum Role {
  USER
  ADMIN
  SUPER_ADMIN
}

enum TeamRole {
  OWNER
  ADMIN
  MEMBER
}
```

---

### 2. Drizzle Schema — PostgreSQL with Full Conventions

```typescript
// src/db/schema/users.ts
import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const roleEnum = pgEnum('role', ['USER', 'ADMIN', 'SUPER_ADMIN']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    name: text('name'),
    role: roleEnum('role').notNull().default('USER'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'), // soft delete
  },
  (table) => ({
    emailIdx: uniqueIndex('users_email_idx').on(table.email),
    deletedAtIdx: index('users_deleted_at_idx').on(table.deletedAt),
  })
);

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  bio: text('bio'),
  avatarUrl: text('avatar_url'),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
});

export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    content: text('content').notNull(),
    published: boolean('published').notNull().default(false),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    authorIdx: index('posts_author_idx').on(table.authorId),
    slugIdx: uniqueIndex('posts_slug_idx').on(table.slug),
    publishedIdx: index('posts_published_idx').on(table.published, table.deletedAt),
  })
);

export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
});

// Explicit many-to-many join table
export const tagsOnPosts = pgTable(
  'tags_on_posts',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at').notNull().defaultNow(),
  },
  (table) => ({
    pk: { columns: [table.postId, table.tagId] }, // composite PK via Drizzle
  })
);

// Relations (for Drizzle relational queries)
export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(profiles, {
    fields: [users.id],
    references: [profiles.userId],
  }),
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, {
    fields: [posts.authorId],
    references: [users.id],
  }),
  tags: many(tagsOnPosts),
}));

export const tagsOnPostsRelations = relations(tagsOnPosts, ({ one }) => ({
  post: one(posts, { fields: [tagsOnPosts.postId], references: [posts.id] }),
  tag: one(tags, { fields: [tagsOnPosts.tagId], references: [tags.id] }),
}));
```

---

### 3. Drizzle Client Setup and Query Patterns

```typescript
// src/db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;

// src/db/queries/users.ts
import { eq, isNull, and, desc, ilike } from 'drizzle-orm';
import { db } from '../index';
import { users, posts } from '../schema';

// Find active (non-deleted) user by email
export async function findUserByEmail(email: string) {
  return db.query.users.findFirst({
    where: and(eq(users.email, email), isNull(users.deletedAt)),
    with: {
      profile: true,
    },
  });
}

// Soft delete
export async function softDeleteUser(id: string) {
  return db
    .update(users)
    .set({ deletedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
}

// Paginated query with cursor
export async function listUsers({
  cursor,
  limit = 20,
}: {
  cursor?: string;
  limit?: number;
}) {
  const conditions = [isNull(users.deletedAt)];

  if (cursor) {
    // cursor is the last seen createdAt ISO string
    conditions.push(
      // fetch rows older than the cursor
      // use lt() for timestamp-based cursor pagination
      // import lt from drizzle-orm
    );
  }

  return db.query.users.findMany({
    where: and(...conditions),
    limit: limit + 1, // fetch one extra to determine if there is a next page
    orderBy: [desc(users.createdAt)],
  });
}

// Upsert pattern
export async function upsertProfile(
  userId: string,
  data: { bio?: string; avatarUrl?: string }
) {
  const { profiles } = await import('../schema');
  return db
    .insert(profiles)
    .values({ userId, ...data })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: {
        ...data,
        // updatedAt would go here if profile had it
      },
    })
    .returning();
}
```

---

### 4. Drizzle Migration Config and Workflow

```typescript
// drizzle.config.ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
} satisfies Config;
```

```bash
# Generate a migration from schema changes
npx drizzle-kit generate:pg

# Apply migrations
npx drizzle-kit push:pg          # push directly (dev only)
# OR in code via migrate()
```

```typescript
// src/db/migrate.ts — run this as a one-off script before app starts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

async function runMigrations() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');

  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

---

### 5. Prisma Client Setup and CRUD Patterns

```typescript
// src/lib/prisma.ts
import { PrismaClient } from '@prisma/client';

// Prevent multiple instances in development (Next.js hot reload)
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// src/lib/db/posts.ts
import { prisma } from '../prisma';
import { Prisma } from '@prisma/client';

// Type-safe include helper
const postWithRelations = Prisma.validator<Prisma.PostDefaultArgs>()({
  include: {
    author: { select: { id: true, name: true, email: true } },
    tags: { include: { tag: true } },
  },
});
export type PostWithRelations = Prisma.PostGetPayload<typeof postWithRelations>;

// Create post with tags (many-to-many connect or create)
export async function createPost(data: {
  title: string;
  slug: string;
  content: string;
  authorId: string;
  tags: string[]; // tag names
}): Promise<PostWithRelations> {
  return prisma.post.create({
    data: {
      title: data.title,
      slug: data.slug,
      content: data.content,
      authorId: data.authorId,
      tags: {
        create: data.tags.map((name) => ({
          tag: {
            connectOrCreate: {
              where: { name },
              create: { name, slug: name.toLowerCase().replace(/\s+/g, '-') },
            },
          },
        })),
      },
    },
    ...postWithRelations,
  });
}

// Soft delete with Prisma
export async function softDeletePost(id: string) {
  return prisma.post.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

// Query excluding soft-deleted records
export async function getActivePosts() {
  return prisma.post.findMany({
    where: { deletedAt: null, published: true },
    orderBy: { createdAt: 'desc' },
    ...postWithRelations,
  });
}
```

---

### 6. Database Seeding

```typescript
// prisma/seed.ts
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create admin user
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'ADMIN',
      profile: {
        create: { bio: 'Platform administrator' },
      },
    },
  });

  // Create tags
  const tagNames = ['typescript', 'react', 'nodejs', 'postgresql'];
  const tags = await Promise.all(
    tagNames.map((name) =>
      prisma.tag.upsert({
        where: { name },
        update: {},
        create: { name, slug: name },
      })
    )
  );

  // Create sample posts
  await prisma.post.createMany({
    skipDuplicates: true,
    data: [
      {
        title: 'Getting Started with TypeScript',
        slug: 'getting-started-typescript',
        content: 'TypeScript is a typed superset of JavaScript...',
        published: true,
        authorId: admin.id,
      },
    ],
  });

  console.log(`Seeded ${tags.length} tags, 1 admin user`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

```json
// package.json (add this)
{
  "prisma": {
    "seed": "ts-node --transpile-only prisma/seed.ts"
  }
}
```

```bash
npx prisma db seed
```

---

### 7. Drizzle Seeding

```typescript
// src/db/seed.ts
import { db } from './index';
import { users, tags, posts } from './schema';

async function seed() {
  console.log('Seeding...');

  const [admin] = await db
    .insert(users)
    .values({
      email: 'admin@example.com',
      name: 'Admin',
      role: 'ADMIN',
    })
    .onConflictDoNothing()
    .returning();

  await db
    .insert(tags)
    .values([
      { name: 'typescript', slug: 'typescript' },
      { name: 'react', slug: 'react' },
    ])
    .onConflictDoNothing();

  console.log('Seed complete');
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

---

### 8. Transaction Pattern

```typescript
// Drizzle transaction
import { db } from '../db';

async function transferCredits(fromId: string, toId: string, amount: number) {
  return db.transaction(async (tx) => {
    const [from] = await tx
      .select()
      .from(users)
      .where(eq(users.id, fromId))
      .for('update'); // row-level lock

    if (!from || from.credits < amount) {
      throw new Error('Insufficient credits');
    }

    await tx
      .update(users)
      .set({ credits: from.credits - amount })
      .where(eq(users.id, fromId));

    await tx
      .update(users)
      .set({ credits: sql`credits + ${amount}` })
      .where(eq(users.id, toId));

    return { success: true };
  });
}

// Prisma transaction
async function transferCreditsPrisma(fromId: string, toId: string, amount: number) {
  return prisma.$transaction(async (tx) => {
    const from = await tx.user.findUniqueOrThrow({ where: { id: fromId } });

    if (from.credits < amount) throw new Error('Insufficient credits');

    await tx.user.update({
      where: { id: fromId },
      data: { credits: { decrement: amount } },
    });

    await tx.user.update({
      where: { id: toId },
      data: { credits: { increment: amount } },
    });
  });
}
```

---

## Common Mistakes

- **Missing `updatedAt` triggers in Drizzle**: Drizzle does not auto-update `updatedAt`. You must set it manually in every update call: `.set({ updatedAt: new Date(), ...data })`. Consider a helper:
  ```typescript
  export const withTimestamp = <T extends object>(data: T) => ({
    ...data,
    updatedAt: new Date(),
  });
  ```

- **PrismaClient instantiation in Next.js**: Every hot reload creates a new connection pool. Always use the global singleton pattern shown above.

- **Forgetting soft delete filters**: After adding `deletedAt`, every query must include `where: { deletedAt: null }` or `isNull(users.deletedAt)`. Add a default scope or always use a query helper to enforce this.

- **Drizzle composite primary key syntax**: The composite PK in `pgTable` must use the `primaryKey()` helper from `drizzle-orm/pg-core`, not an object literal. Use:
  ```typescript
  import { primaryKey } from 'drizzle-orm/pg-core';
  // in the third argument (extra config):
  (table) => ({ pk: primaryKey({ columns: [table.postId, table.tagId] }) })
  ```

- **Not indexing foreign keys**: PostgreSQL does not automatically index foreign key columns. Always add an index on `authorId`, `userId`, etc.

- **Prisma N+1 queries**: Never call `prisma.post.findMany()` then loop and call `prisma.user.findUnique()` for each. Always use `include` or `select` to fetch related data in one query.

- **Drizzle `defaultRandom()` vs `default(sql`gen_random_uuid()`)**: Both work for UUIDs on PostgreSQL, but `defaultRandom()` is the idiomatic Drizzle approach and does not require importing `sql`.

---

## Framework-Specific Notes

### Next.js

- Use `prisma` singleton from `src/lib/prisma.ts` in Server Components and Route Handlers directly — no need for an API layer.
- In Route Handlers, always `await` the query; do not return the Prisma promise directly.
- Use `unstable_cache` from `next/cache` to cache expensive DB queries at the page level.
- For Server Actions that mutate data, call `revalidatePath()` or `revalidateTag()` after the DB write.

```typescript
// app/api/posts/route.ts
import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';

export async function GET() {
  const posts = await prisma.post.findMany({
    where: { deletedAt: null, published: true },
    include: { author: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json(posts);
}
```

### Express

- Initialize the DB client once at module load, not per request.
- Use a middleware to attach `db` to `req` for dependency injection in tests.
- Wrap async route handlers to catch unhandled promise rejections:
  ```typescript
  const asyncHandler = (fn: RequestHandler): RequestHandler =>
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  ```
