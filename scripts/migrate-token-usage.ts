/** Additive, repeatable migration. Uses the same database configuration as the app. */
import { env } from "../src/config/env.ts";

const columns: Record<string, string> = {
  run_id: "text", ticket_id: "text", operation: "text NOT NULL DEFAULT 'chat'", model_tier: "text",
  billing_mode: "text NOT NULL DEFAULT 'api'", cache_read_tokens: "integer NOT NULL DEFAULT 0",
  cache_write_tokens: "integer NOT NULL DEFAULT 0", reasoning_tokens: "integer NOT NULL DEFAULT 0",
};
const common = (pg: boolean) => [
  `CREATE TABLE IF NOT EXISTS token_usage_run (id text PRIMARY KEY, user_id text NOT NULL,
    project_id text, ticket_id text, operation text NOT NULL, billing_mode text NOT NULL DEFAULT 'api',
    started_at ${pg ? "timestamptz NOT NULL DEFAULT now()" : "integer NOT NULL DEFAULT (unixepoch())"})`,
  `CREATE TABLE IF NOT EXISTS token_usage_document (id text PRIMARY KEY, usage_id text NOT NULL REFERENCES token_usage(id) ON DELETE CASCADE, document_id text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS token_usage_ticket (id text PRIMARY KEY, usage_id text NOT NULL REFERENCES token_usage(id) ON DELETE CASCADE, ticket_id text NOT NULL)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS tut_usage_ticket_idx ON token_usage_ticket(usage_id, ticket_id)",
  "CREATE INDEX IF NOT EXISTS tut_ticket_idx ON token_usage_ticket(ticket_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS tu_request_idx ON token_usage(request_id)",
  "CREATE INDEX IF NOT EXISTS tu_run_idx ON token_usage(run_id)",
  "CREATE INDEX IF NOT EXISTS tu_ticket_idx ON token_usage(ticket_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS tud_usage_doc_idx ON token_usage_document(usage_id, document_id)",
  "CREATE INDEX IF NOT EXISTS tud_doc_idx ON token_usage_document(document_id)",
];
if (env.DATABASE_DRIVER === "postgresql") {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: env.POSTGRES_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const [column, type] of Object.entries(columns)) await client.query(`ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    for (const statement of common(true)) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { await client.end(); }
} else {
  const { Database } = await import("bun:sqlite");
  const db = new Database(env.DATABASE_URL);
  try {
    db.transaction(() => {
      const existing = new Set((db.query("PRAGMA table_info(token_usage)").all() as { name: string }[]).map(c => c.name));
      if (!existing.size) throw new Error("token_usage is missing. Initialize the app schema before running this migration.");
      for (const [column, type] of Object.entries(columns)) if (!existing.has(column)) db.exec(`ALTER TABLE token_usage ADD COLUMN ${column} ${type}`);
      for (const statement of common(false)) db.exec(statement);
    })();
  } finally { db.close(); }
}
console.log("Token usage migration complete.");
