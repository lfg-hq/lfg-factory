import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRepoMigrations } from "../desktop/src/preview.ts";

const plan = { runCmd: "npm run start", port: 3000, databases: [] } as any;
const repo = (scripts: Record<string, string>, lock = "package-lock.json") => {
  const dir = mkdtempSync(join(tmpdir(), "lfg-mig-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(dir, lock), "");
  return dir;
};

test("a plan with no database update runs the app's own db:migrate", () => {
  expect(withRepoMigrations(plan, repo({ "db:migrate": "tsx scripts/migrate.ts", start: "x" })).migrations).toEqual(["npm run db:migrate"]);
  expect(withRepoMigrations(plan, repo({ migrate: "drizzle-kit migrate" }, "bun.lock")).migrations).toEqual(["bun run migrate"]);
});

test("a plan's own database update is kept as it is", () => {
  const own = { ...plan, migrations: ["npx prisma migrate deploy"] };
  expect(withRepoMigrations(own, repo({ "db:migrate": "x" })).migrations).toEqual(["npx prisma migrate deploy"]);
});

test("an app with no migrate script is left alone", () => {
  expect(withRepoMigrations(plan, repo({ start: "x" })).migrations).toBeUndefined();
});
