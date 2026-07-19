/**
 * Database provisioning — one persistent, S3-backed Mags sandbox per
 * (project, engine). The DB engine runs inside the sandbox; data lives on the
 * synced workspace so it survives idle-reap, and the sandbox is respawned
 * on demand. The app (in its own sandbox) reaches it over the exposed port
 * with the password we generate and own (path A).
 *
 * Status: the orchestration + persistence are complete; the per-engine start
 * command and the raw-TCP port exposure are the pieces to verify against live
 * Mags (marked below) — everything else (schema, idempotency, wake-on-resume,
 * cred injection) is engine-agnostic.
 */
import { db } from "../config/db.ts";
import { projectDatabases } from "../db/schema/project-databases.ts";
import { and, eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../utils/crypto.ts";
import { newWorkspace, execOnWorkspace, enableHttpAccess, getJobStatus } from "./mags.ts";

export type DbEngine = "postgres" | "mysql" | "mssql" | "redis";

export interface EngineSpec {
  port: number;
  memGb: 2 | 4; // sandbox RAM tier (golden snapshots are 2 or 4 GB only)
  diskGb: number;
  defaultDb: string;
  username: string;
  /** Where the engine writes data — MUST be on the S3-synced workspace path. */
  dataDir: string;
  /** Docker run command for the engine. {PW} is replaced with the generated password. */
  startCmd: (pw: string) => string;
  /** How the app connects — used by the run step to build a connection string. */
  connectionString: (c: { host: string; port: number; db: string; user: string; pw: string }) => string;
}

// Data dir is under /workspace (the S3-synced mount). Verify the exact synced
// mount path against live Mags and adjust WORKSPACE_MNT if needed.
const WORKSPACE_MNT = "/workspace/data";

export const ENGINE_REGISTRY: Record<DbEngine, EngineSpec> = {
  postgres: {
    port: 5432, memGb: 2, diskGb: 20, defaultDb: "app", username: "postgres",
    dataDir: `${WORKSPACE_MNT}/pgdata`,
    startCmd: (pw) =>
      `docker rm -f pgdb 2>/dev/null; mkdir -p ${WORKSPACE_MNT} && docker run -d --name pgdb --restart unless-stopped ` +
      `-e POSTGRES_PASSWORD='${pw}' -e POSTGRES_DB=app -e PGDATA=/var/lib/postgresql/data/pgdata ` +
      `-v ${WORKSPACE_MNT}:/var/lib/postgresql/data -p 5432:5432 postgres:16-alpine`,
    connectionString: (c) => `postgresql://${c.user}:${c.pw}@${c.host}:${c.port}/${c.db}`,
  },
  mysql: {
    port: 3306, memGb: 2, diskGb: 20, defaultDb: "app", username: "root",
    dataDir: `${WORKSPACE_MNT}/mysql`,
    startCmd: (pw) =>
      `docker rm -f mydb 2>/dev/null; mkdir -p ${WORKSPACE_MNT} && docker run -d --name mydb --restart unless-stopped ` +
      `-e MYSQL_ROOT_PASSWORD='${pw}' -e MYSQL_DATABASE=app ` +
      `-v ${WORKSPACE_MNT}:/var/lib/mysql -p 3306:3306 mysql:8`,
    connectionString: (c) => `mysql://${c.user}:${c.pw}@${c.host}:${c.port}/${c.db}`,
  },
  mssql: {
    port: 1433, memGb: 4, diskGb: 30, defaultDb: "app", username: "sa",
    dataDir: `${WORKSPACE_MNT}/mssql`,
    startCmd: (pw) =>
      `docker rm -f mssqldb 2>/dev/null; mkdir -p ${WORKSPACE_MNT} && docker run -d --name mssqldb --restart unless-stopped ` +
      `-e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='${pw}' ` +
      `-v ${WORKSPACE_MNT}:/var/opt/mssql -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest`,
    connectionString: (c) => `Server=${c.host},${c.port};Database=${c.db};User Id=${c.user};Password=${c.pw};TrustServerCertificate=True`,
  },
  redis: {
    port: 6379, memGb: 2, diskGb: 10, defaultDb: "0", username: "default",
    dataDir: `${WORKSPACE_MNT}/redis`,
    startCmd: (pw) =>
      `docker rm -f redisdb 2>/dev/null; mkdir -p ${WORKSPACE_MNT} && docker run -d --name redisdb --restart unless-stopped ` +
      `-v ${WORKSPACE_MNT}:/data -p 6379:6379 redis:7-alpine redis-server --requirepass '${pw}' --appendonly yes`,
    connectionString: (c) => `redis://${c.user}:${c.pw}@${c.host}:${c.port}`,
  },
};

function generatePassword(): string {
  // Strong, DB-safe (no shell-breaking chars): alnum + a couple symbols.
  const raw = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  return "Lp" + raw.slice(0, 28) + "9!"; // meets MSSQL complexity too
}

export interface DbHandle {
  engine: DbEngine;
  workspaceId: string;
  host: string;
  port: number;
  endpoint: string;
  dbName: string;
  username: string;
  password: string; // decrypted, for injection into the app's env only
  connectionString: string;
}

/**
 * Expose the engine's TCP port and return the reachable endpoint.
 * NOTE: enableHttpAccess returns an HTTP proxy URL; a DB client needs a raw
 * TCP endpoint. Swap this for the Mags raw-port (`--port`) call once confirmed;
 * the rest of the flow is unchanged.
 */
async function exposePort(workspaceId: string, port: number): Promise<{ host: string; port: number; endpoint: string }> {
  const url = await enableHttpAccess(workspaceId, port);
  // Parse host from the returned URL; keep the engine port for the connection.
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* url may already be host:port */
  }
  return { host, port, endpoint: `${host}:${port}` };
}

/**
 * Ensure a ready DB for (project, engine): reuse if present, wake if reaped,
 * else create + install + expose + persist. Idempotent, keyed on workspaceId.
 */
export async function ensureDatabase(projectId: string, engine: DbEngine): Promise<DbHandle> {
  const spec = ENGINE_REGISTRY[engine];
  const workspaceId = `db-${projectId}-${engine}`;

  const [existing] = await db
    .select()
    .from(projectDatabases)
    .where(and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.engine, engine)));

  // Reuse a ready row after making sure the sandbox is awake.
  if (existing && existing.status === "ready" && existing.passwordEncrypted) {
    const awake = await wake(workspaceId, spec.port).catch(() => null);
    const host = awake?.host ?? existing.host ?? "";
    const password = decryptSecret(existing.passwordEncrypted);
    await db.update(projectDatabases).set({ status: "ready", host, lastAwakeAt: new Date(), updatedAt: new Date() }).where(eq(projectDatabases.id, existing.id));
    return handleFrom(engine, workspaceId, host, spec, existing.dbName ?? spec.defaultDb, existing.username ?? spec.username, password);
  }

  // Fresh provision.
  const password = existing?.passwordEncrypted ? decryptSecret(existing.passwordEncrypted) : generatePassword();
  const row = existing
    ? existing
    : (
        await db
          .insert(projectDatabases)
          .values({
            projectId, engine, workspaceId, memGb: spec.memGb, diskGb: spec.diskGb,
            port: spec.port, dbName: spec.defaultDb, username: spec.username,
            passwordEncrypted: encryptSecret(password), status: "provisioning",
          })
          .returning()
      )[0]!;

  try {
    await newWorkspace(workspaceId, { memGb: spec.memGb, idleMinutes: 30 });
    await execOnWorkspace(workspaceId, spec.startCmd(password), { timeout: 300_000 });
    const exposed = await exposePort(workspaceId, spec.port);
    await db
      .update(projectDatabases)
      .set({ status: "ready", host: exposed.host, endpoint: exposed.endpoint, lastAwakeAt: new Date(), updatedAt: new Date() })
      .where(eq(projectDatabases.id, row.id));
    return handleFrom(engine, workspaceId, exposed.host, spec, spec.defaultDb, spec.username, password);
  } catch (err) {
    await db.update(projectDatabases).set({ status: "error", updatedAt: new Date() }).where(eq(projectDatabases.id, row.id));
    throw err;
  }
}

/** Respawn a reaped sandbox (same workspaceId → S3 remount) and re-expose. */
async function wake(workspaceId: string, port: number): Promise<{ host: string }> {
  const status = await getJobStatus(workspaceId).catch(() => null);
  if (!status || status.status !== "running") {
    await newWorkspace(workspaceId, {}); // same workspaceId re-mounts S3 data
  }
  const exposed = await exposePort(workspaceId, port);
  return { host: exposed.host };
}

function handleFrom(
  engine: DbEngine, workspaceId: string, host: string, spec: EngineSpec,
  dbName: string, username: string, password: string
): DbHandle {
  const connectionString = spec.connectionString({ host, port: spec.port, db: dbName, user: username, pw: password });
  return { engine, workspaceId, host, port: spec.port, endpoint: `${host}:${spec.port}`, dbName, username, password, connectionString };
}
