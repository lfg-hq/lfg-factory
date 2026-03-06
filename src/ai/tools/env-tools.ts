import { tool, zodSchema } from "ai";
import { z } from "zod";
import { db } from "../../config/db.ts";
import { projectEnvironmentVariables, projects } from "../../db/schema/projects.ts";
import { eq, and } from "drizzle-orm";
import { env } from "../../config/env.ts";
import pg from "pg";

function encrypt(value: string): string {
  if (!env.ENCRYPTION_KEY) return `plain:${value}`;
  return `b64:${Buffer.from(value).toString("base64")}`;
}

export function decrypt(encrypted: string): string {
  if (encrypted.startsWith("plain:")) return encrypted.slice(6);
  if (encrypted.startsWith("b64:")) return Buffer.from(encrypted.slice(4), "base64").toString();
  return encrypted;
}

export const getProjectEnvVars = tool({
  description: "Get all environment variable keys registered for a project (values are masked).",
  inputSchema: zodSchema(z.object({ projectId: z.string() })),
  execute: async ({ projectId }) => {
    const rows = await db.select({
      id: projectEnvironmentVariables.id,
      key: projectEnvironmentVariables.key,
      isRequired: projectEnvironmentVariables.isRequired,
      hasValue: projectEnvironmentVariables.hasValue,
      description: projectEnvironmentVariables.description,
    }).from(projectEnvironmentVariables).where(eq(projectEnvironmentVariables.projectId, projectId));
    return { envVars: rows };
  },
});

export const registerRequiredEnvVars = tool({
  description: "Register environment variable keys the project will need (without setting values).",
  inputSchema: zodSchema(z.object({
    projectId: z.string(),
    vars: z.array(z.object({
      key: z.string(),
      description: z.string(),
      isSecret: z.boolean().default(true),
    })),
  })),
  execute: async ({ projectId, vars }) => {
    const rows = await db.insert(projectEnvironmentVariables).values(
      vars.map((v) => ({
        projectId,
        key: v.key,
        encryptedValue: "",
        isSecret: v.isSecret,
        isRequired: true,
        hasValue: false,
        description: v.description,
      }))
    ).onConflictDoNothing().returning();
    return { registered: rows.length };
  },
});

export const setEnvVar = tool({
  description: "Set or update an environment variable value for a project.",
  inputSchema: zodSchema(z.object({
    projectId: z.string(),
    key: z.string(),
    value: z.string(),
    isSecret: z.boolean().default(true),
    description: z.string().optional(),
  })),
  execute: async ({ projectId, key, value, isSecret, description }) => {
    const encryptedValue = encrypt(value);
    const existing = await db.select({ id: projectEnvironmentVariables.id }).from(projectEnvironmentVariables).where(and(eq(projectEnvironmentVariables.projectId, projectId), eq(projectEnvironmentVariables.key, key)));
    if (existing.length > 0) {
      await db.update(projectEnvironmentVariables).set({ encryptedValue, isSecret, hasValue: true, updatedAt: new Date() }).where(and(eq(projectEnvironmentVariables.projectId, projectId), eq(projectEnvironmentVariables.key, key)));
    } else {
      await db.insert(projectEnvironmentVariables).values({ projectId, key, encryptedValue, isSecret, isRequired: false, hasValue: true, description: description ?? "" });
    }
    return { success: true, key };
  },
});

// ── Provision PostgreSQL Database ────────────────────────────────────────────

export const provisionPostgresDb = tool({
  description:
    "Provision a new PostgreSQL database on the shared dev server and automatically set DATABASE_URL for the project. " +
    "Use this when the user needs a database for their project. Optionally provide a db_name, otherwise one is auto-generated from the project name.",
  inputSchema: zodSchema(
    z.object({
      projectId: z.string(),
      db_name: z.string().optional().describe("Custom database name (lowercase, numbers, underscores only). Auto-generated if omitted."),
    })
  ),
  execute: async ({ projectId, db_name }) => {
    const host = env.POSTGRES_PROVISIONING_HOST;
    const port = env.POSTGRES_PROVISIONING_PORT;
    const user = env.POSTGRES_PROVISIONING_USER;
    const password = env.POSTGRES_PROVISIONING_PASSWORD;

    if (!password) {
      return { error: "Postgres provisioning credentials not configured. Set POSTGRES_PROVISIONING_PASSWORD." };
    }

    // Look up project name for auto-generating db name
    if (!db_name) {
      const [project] = await db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      const slug = (project?.name || "project")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 40);
      const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
      db_name = `lfg_${slug}_${shortId}`;
    }

    // Validate
    if (!/^[a-z0-9_]+$/.test(db_name)) {
      return { error: `Invalid database name: ${db_name}. Use only lowercase letters, numbers, and underscores.` };
    }

    // Create the database
    const { Client } = pg;
    const client = new Client({ host, port, user, password, database: "postgres" });

    let alreadyExisted = false;
    try {
      await client.connect();

      const { rows } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [db_name]);
      alreadyExisted = rows.length > 0;

      if (!alreadyExisted) {
        // db_name is validated via regex above — safe for identifier interpolation
        await client.query(`CREATE DATABASE "${db_name}"`);
        console.log(`[PROVISION_DB] Created database: ${db_name}`);
      }
    } catch (err) {
      console.error(`[PROVISION_DB] Failed to create database:`, err);
      return { error: `Failed to provision database: ${(err as Error).message}` };
    } finally {
      await client.end().catch(() => {});
    }

    // Build connection string and set DATABASE_URL via the existing setEnvVar logic
    const connectionString = `postgresql://${user}:${password}@${host}:${port}/${db_name}`;
    const encryptedValue = encrypt(connectionString);

    const existing = await db
      .select({ id: projectEnvironmentVariables.id })
      .from(projectEnvironmentVariables)
      .where(and(eq(projectEnvironmentVariables.projectId, projectId), eq(projectEnvironmentVariables.key, "DATABASE_URL")));

    if (existing.length > 0) {
      await db
        .update(projectEnvironmentVariables)
        .set({ encryptedValue, isSecret: true, hasValue: true, updatedAt: new Date() })
        .where(and(eq(projectEnvironmentVariables.projectId, projectId), eq(projectEnvironmentVariables.key, "DATABASE_URL")));
    } else {
      await db.insert(projectEnvironmentVariables).values({
        projectId,
        key: "DATABASE_URL",
        encryptedValue,
        isSecret: true,
        isRequired: true,
        hasValue: true,
        description: `PostgreSQL connection string for database ${db_name}`,
      });
    }

    const status = alreadyExisted ? "already existed" : "created";
    const maskedUrl = `postgresql://${user}:****@${host}:${port}/${db_name}`;

    return {
      success: true,
      db_name,
      message: `Database '${db_name}' ${status}. DATABASE_URL set to: ${maskedUrl}`,
    };
  },
});
