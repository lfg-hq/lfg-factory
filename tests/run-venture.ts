// Isolated integration/migration runner. All fixture data stays in temporary DBs.
import { mkdtemp, cp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { Database } from "bun:sqlite";
import { env } from "../src/config/env.ts";

const root = process.cwd();
async function run(command: string[], settings: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd: root, env: { ...process.env, ...settings }, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Check failed: ${command.slice(0, 3).join(" ")}`);
}
for (const driver of ["sqlite", "postgresql"] as const) {
  const temp = await mkdtemp(join(tmpdir(), "venture-tests-"));
  const name = `venture_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = driver === "postgresql" ? new Pool({ connectionString: env.POSTGRES_URL }) : null;
  let sqlDb: Database | null = null, pgDb: Pool | null = null;
  let created = false;
  try {
    const settings: Record<string, string> = { DATABASE_DRIVER: driver, VENTURE_TEST_ISOLATED: "1", NODE_ENV: "test" };
    if (admin) {
      await admin.query(`CREATE DATABASE "${name}"`); created = true;
      const url = new URL(env.POSTGRES_URL); url.pathname = `/${name}`;
      settings.DATABASE_URL = url.href;
      pgDb = new Pool({ connectionString: url.href });
    } else {
      settings.DATABASE_URL = join(temp, "test.db");
      sqlDb = new Database(settings.DATABASE_URL);
    }
    const query = async (sql: string) => pgDb ? (await pgDb.query(sql)).rows : sqlDb!.query(sql).all() as any[];
    const source = driver === "sqlite" ? "drizzle" : "drizzle/pg";
    const migrations = join(temp, "migrations");
    await cp(join(root, source), migrations, { recursive: true });
    const journalPath = join(migrations, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const last = journal.entries.pop();
    await writeFile(journalPath, JSON.stringify(journal));
    const configPath = join(temp, "drizzle.config.ts");
    await writeFile(configPath, `import config from ${JSON.stringify(join(root, "drizzle.config.ts"))}; export default {...config, out:${JSON.stringify(migrations)}};`);
    await run(["bun", "run", "db:migrate", `--config=${configPath}`], settings);
    await query(`INSERT INTO "user" (id,name,email) VALUES ('migration-fixture','TEST FIXTURE','migration-fixture@example.org')`);
    await query(`INSERT INTO account (id,account_id,provider_id,user_id,password) VALUES ('migration-account','migration-fixture','credential','migration-fixture','TEST FIXTURE preserved hash')`);
    await query(`INSERT INTO conversation (id,user_id,title) VALUES ('migration-chat','migration-fixture','TEST FIXTURE project chat')`);
    await query(`INSERT INTO message (id,conversation_id,role,content) VALUES ('migration-message','migration-chat','user','TEST FIXTURE project message')`);
    await query(`INSERT INTO session (id,expires_at,token,user_id) VALUES ('migration-session',${driver === "sqlite" ? "4102444800" : "'2100-01-01'"},'TEST FIXTURE preserved token','migration-fixture')`);
    journal.entries.push(last); await writeFile(journalPath, JSON.stringify(journal));
    await run(["bun", "run", "db:migrate", `--config=${configPath}`], settings);
    await run(["bun", "run", "db:migrate", `--config=${configPath}`], settings);
    if ((await query(`SELECT password FROM account WHERE id='migration-account'`))[0]?.password !== "TEST FIXTURE preserved hash") throw new Error("Migration changed existing account");
    if ((await query(`SELECT id FROM conversation WHERE id='migration-chat'`)).length !== 1) throw new Error("Migration changed existing chat");
    if ((await query(`SELECT token FROM session WHERE id='migration-session'`))[0]?.token !== "TEST FIXTURE preserved token") throw new Error("Migration changed existing session");
    if ((await query(`SELECT content FROM message WHERE id='migration-message'`))[0]?.content !== "TEST FIXTURE project message") throw new Error("Migration changed existing messages");
    for (const table of ["venture_conversation", "venture_message", "venture_source", "venture_assessment"]) await query(`SELECT * FROM ${table} LIMIT 1`);
    console.info(`${driver}: additive migrations applied twice; existing account hash and project chat preserved.`);
    await run(["bun", "test", "tests/venture.test.ts"], settings);
  } finally {
    sqlDb?.close(); await pgDb?.end();
    if (created) await admin!.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin?.end(); await rm(temp, { recursive: true, force: true });
  }
}
await run(["bun", "test", "tests/venture-oauth.test.ts", "tests/venture-defaults.test.ts"], { NODE_ENV: "test" });
console.info("Venture targeted checks passed. Live Google OAuth is NOT verified by fixture tests.");
