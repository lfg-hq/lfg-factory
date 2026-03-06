import { env } from "./env.ts";
import * as sqliteSchema from "../db/schema/sqlite/index.ts";
import * as pgSchema from "../db/schema/pg/index.ts";

// db is typed as the SQLite variant for IDE/TypeScript support in dev.
// At runtime, the PG driver is used when DATABASE_DRIVER=postgresql —
// both drivers share the same Drizzle query API so all queries work correctly.
type SqliteDb = ReturnType<typeof import("drizzle-orm/bun-sqlite").drizzle<typeof sqliteSchema>>;

let _db: SqliteDb;

if (env.DATABASE_DRIVER === "postgresql") {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: env.POSTGRES_URL });
  _db = drizzle(pool, { schema: pgSchema }) as unknown as SqliteDb;
} else {
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { Database } = await import("bun:sqlite");
  const sqlite = new Database(env.DATABASE_URL);
  _db = drizzle(sqlite, { schema: sqliteSchema });
}

export const db = _db;
export type Database = typeof db;
