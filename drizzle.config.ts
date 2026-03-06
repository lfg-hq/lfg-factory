import { defineConfig } from "drizzle-kit";

const isPg = process.env.DATABASE_DRIVER === "postgresql";

const pgUrl = `postgresql://${process.env.POSTGRES_USER ?? "postgres"}:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "")}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB ?? "lfg_node"}`;

export default defineConfig({
  schema: isPg
    ? "./src/db/schema/pg/index.ts"
    : "./src/db/schema/sqlite/index.ts",
  out: isPg ? "./drizzle/pg" : "./drizzle",
  dialect: isPg ? "postgresql" : "sqlite",
  dbCredentials: isPg
    ? { url: pgUrl }
    : { url: process.env.DATABASE_URL || "./data/lfg.db" },
});
