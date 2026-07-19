/**
 * Project dev environment — ONE persistent, always-on Mags sandbox per project
 * that hosts the app + its DBs (co-located, reached over 127.0.0.1) + git
 * worktrees per branch. Used for testing the app, QA, and building tickets.
 *
 * Validated live: keepAlive keeps the VM stable; DBs install NATIVELY via apk
 * (docker OOMs a 4GB VM); the app talks to them over localhost. Two required
 * fixes are baked into the recipes: `chmod 711 /root` (so the db user can
 * traverse into a datadir under /root) and enabling TCP (Alpine disables it).
 *
 * Persistence note: the sandbox is kept alive (never reaped) because S3
 * restore-on-respawn isn't confirmed yet — so data survives as long as the env
 * is up. Stopping is intentionally not exposed until sync-on-stop is verified.
 */
import { db } from "../config/db.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { projectDatabases } from "../db/schema/project-databases.ts";
import { and, eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../utils/crypto.ts";
import { newWorkspace, execOnWorkspace, getJobStatus } from "./mags.ts";

export type DbEngine = "postgres" | "mysql" | "redis";

export interface EngineSpec {
  pkgs: string;
  port: number;
  defaultDb: string;
  username: string;
  /** Idempotent bring-up: install → init datadir → start → create db/user. */
  bringup: (pw: string) => string;
  connectionString: (c: { port: number; db: string; user: string; pw: string }) => string;
}

// Datadirs live on /root (persists across execs while the always-on VM is up).
export const ENGINES: Record<DbEngine, EngineSpec> = {
  mysql: {
    pkgs: "mariadb mariadb-client", port: 3306, defaultDb: "app", username: "app",
    bringup: (pw) => `set -e
apk add --no-cache mariadb mariadb-client >/dev/null 2>&1
mkdir -p /run/mysqld /root/db-mysql && chmod 711 /root && chown -R mysql:mysql /run/mysqld /root/db-mysql
[ -d /root/db-mysql/mysql ] || mariadb-install-db --user=mysql --datadir=/root/db-mysql --auth-root-authentication-method=normal >/dev/null 2>&1
pgrep mariadbd >/dev/null || (setsid mariadbd --user=mysql --datadir=/root/db-mysql --socket=/run/mysqld/mysqld.sock --skip-networking=0 --bind-address=127.0.0.1 --port=3306 >/root/mysql.log 2>&1 &)
for i in $(seq 1 30); do mariadb-admin ping --socket=/run/mysqld/mysqld.sock 2>/dev/null | grep -q alive && break; sleep 2; done
mariadb --socket=/run/mysqld/mysqld.sock -e "CREATE DATABASE IF NOT EXISTS app; CREATE USER IF NOT EXISTS 'app'@'127.0.0.1' IDENTIFIED BY '${pw}'; GRANT ALL ON app.* TO 'app'@'127.0.0.1'; FLUSH PRIVILEGES;" 2>/dev/null
mariadb-admin ping --socket=/run/mysqld/mysqld.sock 2>/dev/null | grep -q alive && echo ENGINE_READY || echo ENGINE_ERROR`,
    connectionString: (c) => `mysql://${c.user}:${c.pw}@127.0.0.1:${c.port}/${c.db}`,
  },
  postgres: {
    pkgs: "postgresql postgresql-client", port: 5432, defaultDb: "app", username: "app",
    bringup: (pw) => `set -e
apk add --no-cache postgresql postgresql-client >/dev/null 2>&1
chmod 711 /root; mkdir -p /root/db-postgres /run/postgresql
chown postgres:postgres /root/db-postgres /run/postgresql; chmod 700 /root/db-postgres
[ -f /root/db-postgres/PG_VERSION ] || su postgres -c "initdb -D /root/db-postgres" >/dev/null 2>&1
grep -q "listen_addresses='127.0.0.1'" /root/db-postgres/postgresql.conf || echo "listen_addresses='127.0.0.1'" >> /root/db-postgres/postgresql.conf
grep -q "127.0.0.1/32 md5" /root/db-postgres/pg_hba.conf || echo "host all all 127.0.0.1/32 md5" >> /root/db-postgres/pg_hba.conf
pgrep -x postgres >/dev/null || su postgres -c "pg_ctl -D /root/db-postgres -l /root/pg.log -o '-p 5432' -w start" >/dev/null 2>&1
sleep 2
su postgres -c "psql -tAc \\"SELECT 1 FROM pg_database WHERE datname='app'\\"" 2>/dev/null | grep -q 1 || su postgres -c "createdb app" 2>/dev/null
su postgres -c "psql -tAc \\"SELECT 1 FROM pg_roles WHERE rolname='app'\\"" 2>/dev/null | grep -q 1 || su postgres -c "psql -c \\"CREATE ROLE app LOGIN PASSWORD '${pw}'\\"" 2>/dev/null
su postgres -c "psql -c \\"ALTER ROLE app PASSWORD '${pw}'; GRANT ALL ON DATABASE app TO app;\\"" >/dev/null 2>&1
su postgres -c "pg_isready -h 127.0.0.1 -p 5432" 2>/dev/null | grep -q "accepting" && echo ENGINE_READY || echo ENGINE_ERROR`,
    connectionString: (c) => `postgresql://${c.user}:${c.pw}@127.0.0.1:${c.port}/${c.db}`,
  },
  redis: {
    pkgs: "redis", port: 6379, defaultDb: "0", username: "default",
    bringup: (pw) => `set -e
apk add --no-cache redis >/dev/null 2>&1
mkdir -p /root/db-redis
pgrep redis-server >/dev/null || (setsid redis-server --bind 127.0.0.1 --port 6379 --requirepass '${pw}' --dir /root/db-redis --appendonly yes >/root/redis.log 2>&1 &)
for i in $(seq 1 15); do redis-cli -a '${pw}' ping 2>/dev/null | grep -q PONG && break; sleep 1; done
redis-cli -a '${pw}' ping 2>/dev/null | grep -q PONG && echo ENGINE_READY || echo ENGINE_ERROR`,
    connectionString: (c) => `redis://${c.user}:${c.pw}@127.0.0.1:${c.port}`,
  },
};

function generatePassword(): string {
  const raw = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  return "Lp" + raw.slice(0, 26) + "9x"; // alnum-only, DB-safe, no shell metachars
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ensure the project's single always-on sandbox exists and is running. */
export async function ensureProjectSandbox(projectId: string): Promise<{ workspaceId: string }> {
  const workspaceId = `env-${projectId}`;
  const [existing] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId));

  const status = await getJobStatus(workspaceId).catch(() => null);
  const alive = status?.status === "running";
  if (!alive) {
    // create (or respawn) — same workspaceId re-mounts if it exists
    await newWorkspace(workspaceId, { memGb: 4, diskGb: 20, keepAlive: true });
  }

  if (existing) {
    await db.update(projectEnvironments).set({ status: "running", lastAwakeAt: new Date(), updatedAt: new Date() }).where(eq(projectEnvironments.id, existing.id));
  } else {
    await db.insert(projectEnvironments).values({ projectId, workspaceId, memGb: 4, diskGb: 20, status: "running", lastAwakeAt: new Date() });
  }
  return { workspaceId };
}

/** Run a command inside the project's sandbox. */
export async function execInEnv(projectId: string, cmd: string, timeoutMs = 110_000): Promise<{ output: string; exitCode: number }> {
  const workspaceId = `env-${projectId}`;
  const r = await execOnWorkspace(workspaceId, cmd, { timeout: timeoutMs });
  return { output: (r.output || "") + (r.stderr ? "\n" + r.stderr : ""), exitCode: r.exitCode };
}

export interface EngineHandle {
  engine: DbEngine;
  host: string;
  port: number;
  dbName: string;
  username: string;
  password: string;
  connectionString: string;
}

/**
 * Ensure a DB engine is installed + running in the project's sandbox and return
 * connection info (localhost). Idempotent — reuses an existing engine + password.
 */
export async function ensureEngine(projectId: string, engine: DbEngine): Promise<EngineHandle> {
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`Unsupported engine: ${engine}`);
  await ensureProjectSandbox(projectId);
  const workspaceId = `env-${projectId}`;

  const [row] = await db.select().from(projectDatabases).where(and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.engine, engine)));
  const password = row?.passwordEncrypted ? decryptSecret(row.passwordEncrypted) : generatePassword();

  // Run the idempotent bring-up in the background; poll a marker (avoids the
  // exec socket timeout on apk install / init).
  const logf = `/root/bringup-${engine}.log`;
  const scriptf = `/root/bringup-${engine}.sh`;
  await execOnWorkspace(workspaceId, `cat > ${scriptf} <<'EOSH'\n${spec.bringup(password)}\nEOSH\n: > ${logf}; nohup sh ${scriptf} >> ${logf} 2>&1 & echo launched`, { timeout: 60_000 });

  let ready = false;
  for (let i = 0; i < 24; i++) {
    await sleep(8000);
    const r = await execOnWorkspace(workspaceId, `tail -1 ${logf} 2>/dev/null`, { timeout: 40_000 }).catch(() => ({ output: "" } as any));
    if ((r.output || "").includes("ENGINE_READY")) { ready = true; break; }
    if ((r.output || "").includes("ENGINE_ERROR")) throw new Error(`${engine} bring-up failed`);
  }
  if (!ready) throw new Error(`${engine} bring-up timed out`);

  const values = {
    projectId, engine, workspaceId, memGb: 4, diskGb: 20,
    host: "127.0.0.1", port: spec.port, endpoint: `127.0.0.1:${spec.port}`,
    dbName: spec.defaultDb, username: spec.username,
    passwordEncrypted: encryptSecret(password), status: "ready", updatedAt: new Date(),
  };
  if (row) await db.update(projectDatabases).set(values).where(eq(projectDatabases.id, row.id));
  else await db.insert(projectDatabases).values(values);

  return {
    engine, host: "127.0.0.1", port: spec.port, dbName: spec.defaultDb, username: spec.username, password,
    connectionString: spec.connectionString({ port: spec.port, db: spec.defaultDb, user: spec.username, pw: password }),
  };
}
