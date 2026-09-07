/** Add-only repair for local databases missing project settings or chat end reasons. */
import { Client } from "pg";
import { env } from "../src/config/env.ts";

const host = new URL(env.POSTGRES_URL).hostname;
if (env.DATABASE_DRIVER !== "postgresql" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  throw new Error("This repair is restricted to local PostgreSQL databases.");
}
const client = new Client({ connectionString: env.POSTGRES_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query(`ALTER TABLE public.project
    ADD COLUMN IF NOT EXISTS qa_mode text NOT NULL DEFAULT 'off',
    ADD COLUMN IF NOT EXISTS test_command text,
    ADD COLUMN IF NOT EXISTS locked_builder_model text,
    ADD COLUMN IF NOT EXISTS locked_builder_auth_mode text,
    ADD COLUMN IF NOT EXISTS locked_chat_model text`);
  await client.query(`SELECT qa_mode, test_command, locked_builder_model,
    locked_builder_auth_mode, locked_chat_model FROM public.project LIMIT 1`);
  await client.query("ALTER TABLE public.message ADD COLUMN IF NOT EXISTS end_reason text");
  await client.query("SELECT end_reason FROM public.message LIMIT 1");
  await client.query("COMMIT");
  console.log("Local project and chat fields repaired. Existing columns and records were preserved.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
