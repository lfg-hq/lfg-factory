#!/usr/bin/env node
/**
 * Schema parity check.
 *
 * The SQLite and Postgres schemas in src/db/schema/{sqlite,pg}/ are maintained by
 * hand as mirror images of each other, and src/db/schema/<name>.ts picks between
 * them at runtime on DATABASE_DRIVER. Nothing in the type system enforces that
 * the two sides agree, so a table added to only one of them type-checks happily
 * and then fails at runtime for whoever is on the other driver.
 *
 * That already happened once: free_prd_request existed only in pg/, so the public
 * free-PRD flow was broken on the SQLite default the README tells self-hosters to
 * use. This check exists so it can't happen quietly again.
 *
 * Compares, per file: which files exist on each side, the exported table
 * constants, and the field names of each table. Column *types* legitimately
 * differ (SQLite has no boolean or timestamp type), so they are not compared.
 *
 * Exits non-zero on drift.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(here, "..", "src", "db", "schema");

const list = (dir) =>
  fs.readdirSync(path.join(base, dir)).filter((f) => f.endsWith(".ts") && f !== "index.ts");

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

const tablesIn = (src) => {
  const s = new Set();
  for (const m of src.matchAll(/export const (\w+)\s*=\s*(?:sqliteTable|pgTable)/g)) s.add(m[1]);
  return s;
};

const fieldsIn = (src) => {
  const s = new Set();
  for (const m of src.matchAll(/^\s{2,}(\w+)\s*:\s*\w+\(/gm)) s.add(m[1]);
  return s;
};

const only = (a, b) => [...a].filter((x) => !b.has(x));

const problems = [];
const sqlite = list("sqlite");
const pg = list("pg");

for (const file of [...new Set([...sqlite, ...pg])].sort()) {
  const s = read(path.join(base, "sqlite", file));
  const p = read(path.join(base, "pg", file));

  if (!s) { problems.push(`${file}: exists in pg/ but not sqlite/`); continue; }
  if (!p) { problems.push(`${file}: exists in sqlite/ but not pg/`); continue; }

  const sT = tablesIn(s), pT = tablesIn(p);
  const tS = only(sT, pT), tP = only(pT, sT);
  if (tS.length) problems.push(`${file}: table(s) only in sqlite/ — ${tS.join(", ")}`);
  if (tP.length) problems.push(`${file}: table(s) only in pg/ — ${tP.join(", ")}`);

  const fS = only(fieldsIn(s), fieldsIn(p));
  const fP = only(fieldsIn(p), fieldsIn(s));
  if (fS.length) problems.push(`${file}: field(s) only in sqlite/ — ${fS.join(", ")}`);
  if (fP.length) problems.push(`${file}: field(s) only in pg/ — ${fP.join(", ")}`);
}

if (problems.length) {
  console.error("Schema parity check FAILED — sqlite/ and pg/ have drifted:\n");
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    "\nAdd the missing table/field to the other dialect, and make sure" +
      "\nsrc/db/schema/<name>.ts switches on DATABASE_DRIVER rather than" +
      "\nre-exporting one dialect unconditionally.\n"
  );
  process.exit(1);
}

console.log(`Schema parity OK — ${sqlite.length} files mirrored across sqlite/ and pg/.`);
