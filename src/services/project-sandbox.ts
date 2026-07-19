/**
 * Project dev environment — ONE persistent, always-on Mags sandbox per project
 * that hosts the app + its DBs (co-located, reached over 127.0.0.1) + git
 * worktrees per branch. Used for testing the app, QA, and building tickets.
 *
 * VM model (standardized on Instant): a local ext4 volume (diskGb) mounted at
 * /data, NO JuiceFS/S3 sync (noSync). The app (/data/project) and DB datadirs
 * (/data/db-*) both live on that volume — nothing is on the synced /workspace,
 * so we don't pay for or risk that mount. keepAlive keeps this box always-on
 * (unlike Instant, which reaps + rebuilds from GitHub) since it hosts the DBs.
 *
 * DBs install NATIVELY via apk (docker OOMs a 4GB VM); the app talks to them
 * over 127.0.0.1. The one required fix baked into the recipes is enabling TCP
 * (Alpine disables it). Data persists as long as the VM is up; a hard VM loss
 * means a fresh setup (re-clone + re-provision), same tradeoff as Instant.
 */
import { db } from "../config/db.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { projectDatabases } from "../db/schema/project-databases.ts";
import { and, eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../utils/crypto.ts";
import { newWorkspace, execOnWorkspace, findJob, deleteWorkspace } from "./mags.ts";

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

// Datadirs live on /data — the big ext4 volume (diskGb) mounted by Mags, same as
// Instant. NOT /root (only ~1.9GB → fills up). Co-located with the app in
// /data/project; persists as long as the keep-alive VM is up.
export const ENGINES: Record<DbEngine, EngineSpec> = {
  mysql: {
    pkgs: "mariadb mariadb-client", port: 3306, defaultDb: "app", username: "app",
    bringup: (pw) => `set -e
apk add --no-cache mariadb mariadb-client >/dev/null 2>&1
chmod 755 /data 2>/dev/null || true
mkdir -p /run/mysqld /data/db-mysql && chown -R mysql:mysql /run/mysqld /data/db-mysql
[ -d /data/db-mysql/mysql ] || mariadb-install-db --user=mysql --datadir=/data/db-mysql --auth-root-authentication-method=normal >/dev/null 2>&1
pgrep mariadbd >/dev/null || (setsid mariadbd --user=mysql --datadir=/data/db-mysql --socket=/run/mysqld/mysqld.sock --skip-networking=0 --bind-address=127.0.0.1 --port=3306 >/data/mysql.log 2>&1 &)
for i in $(seq 1 30); do mariadb-admin ping --socket=/run/mysqld/mysqld.sock 2>/dev/null | grep -q alive && break; sleep 2; done
mariadb --socket=/run/mysqld/mysqld.sock -e "CREATE DATABASE IF NOT EXISTS app; CREATE USER IF NOT EXISTS 'app'@'127.0.0.1' IDENTIFIED BY '${pw}'; GRANT ALL ON app.* TO 'app'@'127.0.0.1'; FLUSH PRIVILEGES;" 2>/dev/null
mariadb-admin ping --socket=/run/mysqld/mysqld.sock 2>/dev/null | grep -q alive && echo ENGINE_READY || echo ENGINE_ERROR`,
    connectionString: (c) => `mysql://${c.user}:${c.pw}@127.0.0.1:${c.port}/${c.db}`,
  },
  postgres: {
    pkgs: "postgresql postgresql-client", port: 5432, defaultDb: "app", username: "app",
    bringup: (pw) => `set -e
apk add --no-cache postgresql postgresql-client >/dev/null 2>&1
chmod 755 /data 2>/dev/null || true; mkdir -p /data/db-postgres /run/postgresql
chown postgres:postgres /data/db-postgres /run/postgresql; chmod 700 /data/db-postgres
[ -f /data/db-postgres/PG_VERSION ] || su postgres -c "initdb -D /data/db-postgres" >/dev/null 2>&1
grep -q "listen_addresses='127.0.0.1'" /data/db-postgres/postgresql.conf || echo "listen_addresses='127.0.0.1'" >> /data/db-postgres/postgresql.conf
grep -q "127.0.0.1/32 md5" /data/db-postgres/pg_hba.conf || echo "host all all 127.0.0.1/32 md5" >> /data/db-postgres/pg_hba.conf
pgrep -x postgres >/dev/null || su postgres -c "pg_ctl -D /data/db-postgres -l /data/pg.log -o '-p 5432' -w start" >/dev/null 2>&1
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
mkdir -p /data/db-redis
pgrep redis-server >/dev/null || (setsid redis-server --bind 127.0.0.1 --port 6379 --requirepass '${pw}' --dir /data/db-redis --appendonly yes >/data/redis.log 2>&1 &)
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

  // Resolve the workspace by NAME (findJob), not getJobStatus — the env-<uuid>
  // name is long/dashed and getJobStatus would misread it as a request_id.
  const job = await findJob(workspaceId).catch(() => null);
  const alive = job?.status === "running";
  if (!alive) {
    // Standardized on the Instant VM model: a local ext4 volume mounted at /data
    // (diskGb), NO JuiceFS/S3 sync (noSync) — the app + DBs live on /data, not on
    // the synced /workspace, so syncing it only added cost + flakiness. keepAlive
    // keeps this always-on box up (it hosts the DBs), unlike Instant which reaps.
    const opts = { noSync: true, diskGb: 20, memGb: 4, keepAlive: true } as const;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await newWorkspace(workspaceId, opts);
        break;
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        // Already up → success (that's the goal).
        if (/already exists/i.test(msg)) break;
        // Transient Mags provisioning failure (VM ended with status: error /
        // completed, or never started) — clear the bad VM and retry.
        if (attempt < 3 && /status: error|status: completed|did not start/i.test(msg)) {
          console.warn(`[project-sandbox] VM ${workspaceId} attempt ${attempt} failed (${msg.slice(0, 80)}); recreating…`);
          await deleteWorkspace(workspaceId).catch(() => {});
          await sleep(3000);
          continue;
        }
        throw err;
      }
    }
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
