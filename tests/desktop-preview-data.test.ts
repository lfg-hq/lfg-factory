// LFG Desktop's own copy of the preview data program, run the way the runner runs it:
// `node -e PROGRAM <base64 input>` in the preview folder, with the preview's environment.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../desktop/src/proc.ts";
import { PREVIEW_DATA_PROGRAM } from "../desktop/src/preview-data-program.ts";

const call = (dir: string, input: object, env: NodeJS.ProcessEnv = process.env) =>
  run("node", ["-e", PREVIEW_DATA_PROGRAM, Buffer.from(JSON.stringify(input)).toString("base64")], { cwd: dir, env, timeoutMs: 20_000 });

function app() {
  const dir = mkdtempSync(join(tmpdir(), "preview-data-"));
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "auth.ts"), "export const auth = 1;");
  writeFileSync(join(dir, ".env"), "SECRET=hidden");
  return dir;
}

test("reads the app's code but not its .env, and reports the preview's database without credentials", async () => {
  const dir = app();
  const listed = JSON.parse((await call(dir, { kind: "listFiles", path: "." })).stdout);
  expect(listed.entries.map((e: { name: string }) => e.name).sort()).toEqual(["package.json", "src"]);
  expect(JSON.parse((await call(dir, { kind: "readFile", path: "src/auth.ts", offset: 0 })).stdout).content).toContain("auth = 1");
  expect((await call(dir, { kind: "readFile", path: ".env", offset: 0 })).code).not.toBe(0);

  const env = { ...process.env, DATABASE_URL: "postgresql://postgres:lfg@127.0.0.1:55432/recruiting" };
  const info = JSON.parse((await call(dir, { kind: "databaseInfo", connectionKeys: ["DATABASE_URL"] }, env)).stdout);
  expect(info.connections).toEqual([{ key: "DATABASE_URL", configured: true, engine: "postgres", host: "127.0.0.1", port: 55432, database: "recruiting", local: true }]);
  expect(JSON.stringify(info)).not.toContain("lfg@");
});

test("refuses a database that isn't the preview's own local one", async () => {
  const dir = app();
  const env = { ...process.env, DATABASE_URL: "postgresql://u:p@db.example.com:5432/prod" };
  const r = await call(dir, { kind: "database", connectionKey: "DATABASE_URL", sql: "select 1", params: [] }, env);
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("Only the selected local development database");
});
