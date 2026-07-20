/**
 * Project dev environment — ONE persistent, always-on Mags sandbox per project
 * that hosts the app + its DBs (co-located, reached over 127.0.0.1) + git
 * worktrees per branch. Used for testing the app, QA, and building tickets.
 *
 * VM model: a BIG persistent box created via the raw Mags v2 API (the SDK caps
 * RAM at 4GB) — 4 vCPU / 8GB / 20GB disk, enough for SQL Server + a .NET build.
 * keepAlive keeps it always-on since it hosts the DBs. The app (/data/project)
 * and DB datadirs (/data/db-*) live on the /data volume.
 *
 * DBs run co-located over 127.0.0.1: postgres/mysql/redis install NATIVELY via
 * apk (the one required fix is enabling TCP, which Alpine disables); SQL Server
 * runs via Docker (no native Alpine build) — dockerd is bootstrapped in-VM.
 * Data persists while the VM is up; a hard VM loss means a fresh setup.
 */
import { db } from "../config/db.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { projectDatabases } from "../db/schema/project-databases.ts";
import { and, eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../utils/crypto.ts";
import { newWorkspaceV2, execOnWorkspace, findJob, deleteWorkspace } from "./mags.ts";

export type DbEngine = "postgres" | "mysql" | "redis" | "mssql";

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
  // SQL Server can't build natively on Alpine → run the official image via Docker
  // (dockerd is bootstrapped by ensureDocker). Data on the /data volume. Readiness
  // is detected from the container log so we don't depend on sqlcmd being bundled.
  mssql: {
    pkgs: "", port: 1433, defaultDb: "app", username: "sa",
    bringup: (pw) => `set -e
mkdir -p /data/db-mssql && chmod 777 /data/db-mssql
for i in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 3; done
docker info >/dev/null 2>&1 || { echo "docker unavailable"; echo ENGINE_ERROR; exit 1; }
if docker ps -a --format '{{.Names}}' | grep -qx mssql; then docker start mssql >/dev/null 2>&1 || true; else
  docker run -d --name mssql -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=${pw}" -e MSSQL_PID=Developer -p 1433:1433 -v /data/db-mssql:/var/opt/mssql mcr.microsoft.com/mssql/server:2022-latest >/dev/null 2>&1
fi
for i in $(seq 1 90); do docker logs mssql 2>&1 | grep -q "SQL Server is now ready for client connections" && break; sleep 4; done
docker logs mssql 2>&1 | grep -q "SQL Server is now ready for client connections" && echo ENGINE_READY || { docker logs mssql 2>&1 | tail -5; echo ENGINE_ERROR; }`,
    connectionString: (c) => `Server=127.0.0.1,${c.port};Database=${c.db};User Id=${c.user};Password=${c.pw};TrustServerCertificate=True`,
  },
};

/** Bootstrap Docker (install + start dockerd) inside the sandbox — needed for
 *  engines that ship as images (SQL Server) and available to the run agent too.
 *  Best-effort; images + data live on the big /data volume. */
export async function ensureDocker(projectId: string): Promise<boolean> {
  const workspaceId = `env-${projectId}`;
  const script = `
command -v docker >/dev/null 2>&1 || apk add --no-cache docker docker-cli >/dev/null 2>&1 || apk add --no-cache docker >/dev/null 2>&1 || true
if docker info >/dev/null 2>&1; then echo DOCKER_READY; exit 0; fi
mountpoint -q /sys/fs/cgroup 2>/dev/null || mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null || true
mkdir -p /data/docker
pgrep dockerd >/dev/null 2>&1 || (setsid dockerd --data-root=/data/docker --storage-driver=vfs --iptables=false >/data/dockerd.log 2>&1 &)
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 && echo DOCKER_READY || echo DOCKER_FAIL`;
  const b64 = Buffer.from(script).toString("base64");
  const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | sh`, { timeout: 150_000 }).catch(() => ({ output: "" } as any));
  return (r.output || "").includes("DOCKER_READY");
}

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
    // Big always-on box via the raw v2 API (the SDK caps RAM at 4GB): 4 vCPU /
    // 8GB / 20GB disk — enough for SQL Server + a .NET build without OOM. keepAlive
    // keeps it up (it hosts the DBs). Data lives on the /data volume.
    const opts = { vcpus: 4, memoryMb: 8192, diskGb: 20, keepAlive: true } as const;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await newWorkspaceV2(workspaceId, opts);
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
    await db.insert(projectEnvironments).values({ projectId, workspaceId, memGb: 8, diskGb: 20, status: "running", lastAwakeAt: new Date() });
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

  // Docker-backed engines (SQL Server) need dockerd up first.
  if (engine === "mssql") {
    const dockerOk = await ensureDocker(projectId);
    if (!dockerOk) throw new Error("Docker could not be started in the sandbox (needed for SQL Server)");
  }

  const [row] = await db.select().from(projectDatabases).where(and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.engine, engine)));
  const password = row?.passwordEncrypted ? decryptSecret(row.passwordEncrypted) : generatePassword();

  // Run the idempotent bring-up in the background; poll a marker (avoids the
  // exec socket timeout on apk install / init / image pull).
  const logf = `/data/bringup-${engine}.log`;
  const scriptf = `/data/bringup-${engine}.sh`;
  await execOnWorkspace(workspaceId, `cat > ${scriptf} <<'EOSH'\n${spec.bringup(password)}\nEOSH\n: > ${logf}; nohup sh ${scriptf} >> ${logf} 2>&1 & echo launched`, { timeout: 60_000 });

  // SQL Server pulls a ~1.5GB image on first run — allow much longer.
  const maxPolls = engine === "mssql" ? 100 : 45; // ~13min / ~6min
  let ready = false;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(8000);
    const r = await execOnWorkspace(workspaceId, `tail -1 ${logf} 2>/dev/null`, { timeout: 40_000 }).catch(() => ({ output: "" } as any));
    if ((r.output || "").includes("ENGINE_READY")) { ready = true; break; }
    if ((r.output || "").includes("ENGINE_ERROR")) {
      const log = await execOnWorkspace(workspaceId, `tail -8 ${logf} 2>/dev/null`, { timeout: 20_000 }).catch(() => ({ output: "" } as any));
      throw new Error(`${engine} bring-up failed: ${(log.output || "").slice(-300)}`);
    }
  }
  if (!ready) throw new Error(`${engine} bring-up timed out`);

  const values = {
    projectId, engine, workspaceId, memGb: 8, diskGb: 20,
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
