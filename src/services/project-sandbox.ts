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
 * DBs run co-located over 127.0.0.1 as official DOCKER images (postgres/mysql/
 * redis/mssql) — uniform + robust, no musl/locale/init quirks of native Alpine
 * installs; dockerd is bootstrapped in-VM. Ports publish to 127.0.0.1 only; data
 * persists on the workspace disk. VM replacement must not attach that disk while
 * another VM owns it; a job's terminal status does not prove disk release.
 */
import { db } from "../config/db.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { projectDatabases } from "../db/schema/project-databases.ts";
import { and, eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../utils/crypto.ts";
import { newWorkspaceV2, execOnWorkspace, findJob, stopWorkspace } from "./mags.ts";
import { dockerBringup } from "./database-bringup.ts";
import { env } from "../config/env.ts";
import { ensureProjectVm, singleFlight } from "./sandbox/project-lifecycle.ts";

export type DbEngine = "postgres" | "mysql" | "redis" | "mssql";

export interface EngineSpec {
  /** Container name (docker-scoped; also the target for `docker exec` SQL apply). */
  container: string;
  port: number;
  defaultDb: string;
  username: string;
  /** Host data dir on /data (persists across VM restarts) — wiped on a DB reset. */
  dataDir: string;
  /** Idempotent bring-up: run the official image (or start it) + wait for ready. */
  bringup: (pw: string) => string;
  connectionString: (c: { port: number; db: string; user: string; pw: string }) => string;
}

// ALL databases run as official Docker images (dockerd bootstrapped by
// ensureDocker). This is uniform + robust: the images self-initialize from env
// vars and behave identically regardless of the sandbox rootfs — no musl/locale/
// initdb quirks like the native Alpine installs had. Images + data live on the
// big /data volume; ports are published to 127.0.0.1 ONLY (never exposed off-box).
//
// Shared, idempotent bring-up: if the container exists, start it; else `docker
// run` the pinned image; then poll a readiness probe (via `docker exec`) and emit
// ENGINE_READY / ENGINE_ERROR (+ container logs on failure, so a real reason
// surfaces instead of an opaque timeout). `restart=unless-stopped` survives a VM
// reboot. First run pulls the image (blocking) — the outer poll budget accounts
// for that.

export const ENGINES: Record<DbEngine, EngineSpec> = {
  postgres: {
    container: "postgres", port: 5432, defaultDb: "app", username: "app", dataDir: "/data/pgdata",
    // The postgres image creates the role+db from POSTGRES_* on first init and
    // allows password auth over TCP by default — no manual initdb/pg_hba needed.
    bringup: (pw) => dockerBringup({
      name: "postgres", image: "postgres:16-alpine", port: 5432,
      // Fresh docker-era volume (not the old native /data/db-postgres cluster,
      // which could be a different PG build and confuse the image).
      volume: "/data/pgdata:/var/lib/postgresql/data",
      env: [`POSTGRES_DB=app`, `POSTGRES_USER=app`, `POSTGRES_PASSWORD=${pw}`],
      readyProbe: `docker exec postgres pg_isready -U app -d app`,
      readyGrep: "accepting connections",
      // pg_isready doesn't authenticate — a REAL query as our role catches a foreign
      // cluster (role "app" does not exist) so startup fails without changing existing data.
      authProbe: `docker exec -e PGPASSWORD='${pw}' postgres psql -h 127.0.0.1 -U app -d app -tAc 'select 1'`,
    }),
    connectionString: (c) => `postgresql://${c.user}:${c.pw}@127.0.0.1:${c.port}/${c.db}`,
  },
  mysql: {
    container: "mysql", port: 3306, defaultDb: "app", username: "app", dataDir: "/data/mysqldata",
    // mysql_native_password for broad driver compatibility (.NET/Node/PHP mysql
    // clients). Image creates app db+user from MYSQL_* on first init.
    bringup: (pw) => dockerBringup({
      name: "mysql", image: "mysql:8.0", port: 3306,
      volume: "/data/mysqldata:/var/lib/mysql",
      env: [`MYSQL_DATABASE=app`, `MYSQL_USER=app`, `MYSQL_PASSWORD=${pw}`, `MYSQL_ROOT_PASSWORD=${pw}`],
      cmd: "--default-authentication-plugin=mysql_native_password",
      readyProbe: `docker exec mysql mysqladmin ping -uroot -p${pw}`,
      readyGrep: "alive",
      // Real query as our app user — checks access without changing an existing cluster.
      authProbe: `docker exec mysql mysql -uapp -p'${pw}' app -e 'select 1'`,
    }),
    connectionString: (c) => `mysql://${c.user}:${c.pw}@127.0.0.1:${c.port}/${c.db}`,
  },
  redis: {
    container: "redis", port: 6379, defaultDb: "0", username: "default", dataDir: "/data/redisdata",
    bringup: (pw) => dockerBringup({
      name: "redis", image: "redis:7-alpine", port: 6379,
      volume: "/data/redisdata:/data",
      cmd: `redis-server --requirepass '${pw}' --appendonly yes --dir /data`,
      readyProbe: `docker exec redis redis-cli -a '${pw}' ping`,
      readyGrep: "PONG",
      // redis-cli exits 0 even when AUTH fails (it just prints "NOAUTH …"), so the
      // probe MUST grep for PONG. Without this, a container left over from a run
      // whose password we never persisted rejects the newly generated one forever.
      authProbe: `docker exec redis redis-cli -a '${pw}' ping 2>/dev/null | grep -q PONG`,
      // NOAUTH/WRONGPASS = definitively our password is wrong. LOADING is deliberately
      // absent: that means the password WORKED and redis is replaying its AOF.
      authFailGrep: "NOAUTH|WRONGPASS|invalid username-password",
    }),
    connectionString: (c) => `redis://${c.user}:${c.pw}@127.0.0.1:${c.port}`,
  },
  mssql: {
    container: "mssql", port: 1433, defaultDb: "app", username: "sa", dataDir: "/data/db-mssql",
    // Readiness from the container log (sqlcmd isn't reliably on PATH inside the
    // image at first boot); the SA login is what apps use.
    bringup: (pw) => dockerBringup({
      name: "mssql", image: "mcr.microsoft.com/mssql/server:2022-latest", port: 1433,
      volume: "/data/db-mssql:/var/opt/mssql",
      env: ["ACCEPT_EULA=Y", `MSSQL_SA_PASSWORD=${pw}`, "MSSQL_PID=Developer"],
      readyProbe: "docker logs --tail 100 mssql", readyGrep: "SQL Server is now ready for client connections",
      prepareNewDirectory: "chmod 777 /data/db-mssql",
    }),
    connectionString: (c) => `Server=127.0.0.1,${c.port};Database=${c.db};User Id=${c.user};Password=${c.pw};TrustServerCertificate=True`,
  },
};

/** Bootstrap Docker (install + start dockerd) inside the sandbox — needed for
 *  engines that ship as images (SQL Server) and available to the run agent too.
 *  Best-effort; images + data live on the big /data volume. */
export async function ensureDocker(projectId: string): Promise<boolean> {
  const workspaceId = await envWorkspaceId(projectId);
  // Alpine ships Docker as an OpenRC service — `rc-service docker start` does the
  // cgroup/mount setup (raw dockerd doesn't). Pin data-root to /data/docker so
  // images (SQL Server ~1.5GB) live on the big persistent volume, NOT the 1.9GB
  // root. If Docker is already up on the wrong root, restart it to pick up /data.
  const script = `
command -v docker >/dev/null 2>&1 || apk add --no-cache docker >/dev/null 2>&1 || true
mkdir -p /data/docker /etc/docker
printf '{"data-root":"/data/docker"}\\n' > /etc/docker/daemon.json
rc-update add docker boot >/dev/null 2>&1 || true
if docker info 2>/dev/null | grep -q "Docker Root Dir: /data/docker"; then echo DOCKER_READY; exit 0; fi
if docker info >/dev/null 2>&1; then rc-service docker restart >/dev/null 2>&1 || true; else rc-service docker start >/dev/null 2>&1 || true; fi
for i in $(seq 1 30); do docker info 2>/dev/null | grep -q "Docker Root Dir: /data/docker" && break; sleep 2; done
docker info 2>/dev/null | grep -q "Docker Root Dir: /data/docker" && echo DOCKER_READY || { echo "--- docker log ---"; tail -5 /var/log/docker.log 2>/dev/null; echo DOCKER_FAIL; }`;
  const b64 = Buffer.from(script).toString("base64");
  const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | sh`, { timeout: 150_000 }).catch(() => ({ output: "" } as any));
  return (r.output || "").includes("DOCKER_READY");
}

function generatePassword(): string {
  const raw = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  return "Lp" + raw.slice(0, 26) + "9x"; // alnum-only, DB-safe, no shell metachars
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve the project's (RANDOM, unguessable) sandbox workspace id from the DB.
 *  Throws if the project has no sandbox yet (ensureProjectSandbox creates it). */
export async function envWorkspaceId(projectId: string): Promise<string> {
  const [row] = await db.select({ w: projectEnvironments.workspaceId }).from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId));
  if (!row?.w) throw new Error(`no sandbox provisioned for project ${projectId}`);
  return row.w;
}

/** Reuse or wake the existing VM. Only the first DB claimant may create one. */
const ensureProjectFlight = singleFlight<{ workspaceId: string; created: boolean; recreated: boolean }>();
export function ensureProjectSandbox(projectId: string): Promise<{ workspaceId: string; created: boolean; recreated: boolean }> {
  return ensureProjectFlight(projectId, () => ensureProjectSandboxOnce(projectId));
}

async function ensureProjectSandboxOnce(projectId: string): Promise<{ workspaceId: string; created: boolean; recreated: boolean }> {
  const candidateWorkspaceId = `pv-${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  // Persist the creation intent BEFORE the provider call. A crash/timeout must not
  // let a later request submit another creation for the same persistent disk.
  const [claimed] = await db.insert(projectEnvironments)
    .values({ projectId, workspaceId: candidateWorkspaceId, memGb: 8, diskGb: 20, status: "provisioning", lastAwakeAt: new Date() })
    .onConflictDoNothing({ target: projectEnvironments.projectId }).returning();
  const existing = claimed ?? (await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId)))[0];
  if (!existing) throw new Error("Could not resolve the project's sandbox record");
  const workspaceId = existing.workspaceId;
  const { created } = await ensureProjectVm({
    mayCreate: !!claimed || env.SANDBOX_BACKEND === "docker",
    find: async () => {
      const job = await findJob(workspaceId);
      // Local containers have no Magpie disk-attachment lifecycle.
      return env.SANDBOX_BACKEND === "docker" && job?.status !== "running" ? null : job;
    },
    probe: async (job) => {
      console.log(`[project-sandbox] Reusing ${job.status} VM ${job.jobId} for ${workspaceId}`);
      const result = await execOnWorkspace(job.jobId, "echo __vm_alive__", { timeout: 60_000 });
      if (result.exitCode !== 0 || !result.output.includes("__vm_alive__")) {
        throw new Error(`Sandbox wake/health check failed; no replacement was created. ${result.stderr || result.output}`);
      }
    },
    create: () => newWorkspaceV2(workspaceId, {
      vcpus: 4, memoryMb: 8192, diskGb: 20, keepAlive: true,
      rootfsType: process.env.PREVIEW_ROOTFS || "pi",
    }),
  });
  await db.update(projectEnvironments).set({ status: "running", lastAwakeAt: new Date(), updatedAt: new Date() })
    .where(eq(projectEnvironments.projectId, projectId));

  // Move /tmp onto the big /data volume (the 1.9GB root fills up during a .NET
  // build — MSBuild writes scratch to /tmp). Redirect via a symlink so even tools
  // that ignore $TMPDIR (and don't source .env) land on /data. Idempotent.
  await execOnWorkspace(workspaceId, `sh -c 'mkdir -p /data/tmp && chmod 1777 /data/tmp; if [ ! -L /tmp ]; then rm -rf /tmp && ln -s /data/tmp /tmp; fi; echo tmp_ok'`, { timeout: 30_000 }).catch(() => {});

  // (The project_environment row was already claimed/updated via the upsert above.)
  return { workspaceId, created, recreated: false };
}

/** Provider job status alone does not prove that the underlying disk is released. */
export async function restartProjectSandbox(projectId: string): Promise<{ workspaceId: string }> {
  if (env.SANDBOX_BACKEND !== "docker") {
    throw new Error("Automatic VM replacement is disabled: Magpie must confirm the old VM has released the workspace disk. A completed job or successful stop response is not sufficient. Sleeping sandboxes are woken by the normal preview start.");
  }
  // Local Docker containers do not use Magpie's shared-disk replacement path.
  const workspaceId = await envWorkspaceId(projectId);
  await stopWorkspace(workspaceId);
  await newWorkspaceV2(workspaceId, { vcpus: 4, memoryMb: 8192, diskGb: 20 });
  return { workspaceId };
}

/** Run a command inside the project's sandbox. */
export async function execInEnv(projectId: string, cmd: string, timeoutMs = 110_000): Promise<{ output: string; exitCode: number }> {
  const workspaceId = await envWorkspaceId(projectId);
  const r = await execOnWorkspace(workspaceId, cmd, { timeout: timeoutMs });
  return { output: (r.output || "") + (r.stderr ? "\n" + r.stderr : ""), exitCode: r.exitCode };
}

/**
 * Engines that actually have a container in the sandbox, recorded in project_database
 * or not. Recovery has to key off THIS, not the table: an engine that came up but
 * failed to record (the exact state a broken provisioning run leaves behind) is
 * invisible to every table-driven control — precisely when you most need to reset it.
 */
export async function listSandboxEngines(workspaceId: string): Promise<DbEngine[]> {
  const r = await execOnWorkspace(workspaceId, `docker ps -a --format '{{.Names}}' 2>/dev/null`, { timeout: 30_000 }).catch(() => ({ output: "" } as any));
  const names = new Set((r.output || "").split("\n").map((l: string) => l.trim()).filter(Boolean));
  return (Object.keys(ENGINES) as DbEngine[]).filter((e) => names.has(ENGINES[e].container));
}

/**
 * Health-check every provisioned DB by running a live connectivity probe against
 * its container (pg_isready / mysqladmin ping / redis PONG / sqlcmd SELECT 1).
 * Used by the preview post-run verification. Returns per-engine ok + detail.
 */
export async function checkEngineHealth(projectId: string): Promise<Array<{ engine: DbEngine; ok: boolean; detail: string }>> {
  const workspaceId = await envWorkspaceId(projectId).catch(() => null);
  if (!workspaceId) return [];
  const rows = await db.select().from(projectDatabases).where(eq(projectDatabases.projectId, projectId));
  const out: Array<{ engine: DbEngine; ok: boolean; detail: string }> = [];
  for (const r of rows) {
    const engine = r.engine as DbEngine;
    const pw = r.passwordEncrypted ? decryptSecret(r.passwordEncrypted) : "";
    let probe = "";
    if (engine === "postgres") probe = `docker exec postgres pg_isready -U ${r.username} -d ${r.dbName} 2>&1`;
    else if (engine === "mysql") probe = `docker exec mysql mysqladmin ping -uroot -p'${pw}' 2>&1`;
    else if (engine === "redis") probe = `docker exec redis redis-cli -a '${pw}' ping 2>&1`;
    else if (engine === "mssql") probe = `docker exec mssql sh -c "/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '${pw}' -C -Q 'SELECT 1' -b 2>&1 || /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P '${pw}' -Q 'SELECT 1' -b 2>&1" 2>&1`;
    else continue;
    const res = await execOnWorkspace(workspaceId, probe, { timeout: 30_000 }).catch((e: any) => ({ output: String(e?.message ?? e) } as any));
    const o = (res.output || "").trim();
    const ok = engine === "postgres" ? /accepting connections/.test(o)
      : engine === "mysql" ? /alive/.test(o)
      : engine === "redis" ? /PONG/.test(o)
      : /(^|\s)1(\s|$)/.test(o) && !/error|failed|login failed|cannot open/i.test(o); // mssql SELECT 1
    out.push({ engine, ok, detail: ok ? "reachable" : (o.replace(/\s+/g, " ").slice(0, 160) || "no response") });
  }
  return out;
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
 * Turn a bring-up log tail into something a human can act on. Slicing the last N
 * CHARACTERS cut mid-timestamp and surfaced whatever line happened to land there —
 * "redis bring-up failed: :29:46.018 * Server initialized" reads like success. Take
 * whole lines instead, drop our own markers, and lead with the last real one.
 */
// Lines the bring-up script itself prints when it knows what went wrong. These beat the
// container's own log, which describes what the engine was DOING, not why we gave up —
// the reason "Ready to accept connections" ended up presented as a failure.
const BRINGUP_DIAGNOSTICS = /ENGINE_FAILURE:|port is already allocated|address already in use|docker daemon unavailable|no space left|cannot allocate|permission denied/i;

function failureReason(raw: string | undefined): string {
  const lines = (raw || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^ENGINE_(READY|ERROR)$/.test(l) && !/^-{2,}.*-{2,}$/.test(l));
  if (!lines.length) return "no output from the bring-up script (check the sandbox's Docker daemon)";
  const diagnosed = lines.filter((l) => BRINGUP_DIAGNOSTICS.test(l));
  const picked = [...new Set([...diagnosed, ...lines.slice(-3)])];
  return picked.join(" | ").slice(0, 400);
}

/**
 * Ensure a DB engine is installed + running in the project's sandbox and return
 * connection info (localhost). Idempotent — reuses an existing engine + password.
 */
export async function ensureEngine(projectId: string, engine: DbEngine, opts?: { cancelled?: () => boolean; progress?: (elapsedSeconds: number) => void }): Promise<EngineHandle> {
  if (opts?.cancelled?.()) throw new Error("__CANCELLED__");
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`Unsupported engine: ${engine}`);
  await ensureProjectSandbox(projectId);
  const workspaceId = await envWorkspaceId(projectId);

  // Every engine now runs as a Docker container → dockerd must be up first.
  const dockerOk = await ensureDocker(projectId);
  if (!dockerOk) throw new Error(`Docker could not be started in the sandbox — it's required to run the ${engine} database. Check the sandbox's Docker setup and retry.`);

  let [row] = await db.select().from(projectDatabases).where(and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.engine, engine)));
  // Persist credentials before detached provisioning: cancellation must not generate
  // a different password for the same still-starting container on the next run.
  if (!row) {
    await db.insert(projectDatabases).values({ projectId, engine, workspaceId,
      host: "127.0.0.1", port: spec.port, dbName: spec.defaultDb, username: spec.username,
      passwordEncrypted: encryptSecret(generatePassword()), status: "provisioning", memGb: 8, diskGb: 20,
    }).onConflictDoNothing();
    [row] = await db.select().from(projectDatabases).where(and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.engine, engine)));
  }
  if (!row?.passwordEncrypted) throw new Error("Could not persist database provisioning credentials");
  const password = decryptSecret(row.passwordEncrypted);

  // Run the idempotent bring-up in the background; poll a marker (avoids the
  // exec socket timeout on apk install / init / image pull).
  const attempt = crypto.randomUUID();
  const logf = `/data/bringup-${engine}-${attempt}.log`;
  const scriptf = `/data/bringup-${engine}-${attempt}.sh`;
  await execOnWorkspace(workspaceId, `umask 077\ncat > ${scriptf} <<'EOSH'\n${spec.bringup(password)}\nEOSH\n: > ${logf}; nohup sh ${scriptf} >> ${logf} 2>&1 & echo launched`, { timeout: 60_000 });

  // First run pulls the image (blocking inside the bring-up) — budget for it.
  // mssql ~1.5GB, mysql ~600MB, postgres ~150MB, redis ~40MB (poll = 8s each).
  const maxPolls = { mssql: 120, mysql: 100, postgres: 75, redis: 60 }[engine] ?? 60; // ~16 / 13 / 10 / 8 min
  let ready = false;
  for (let i = 0; i < maxPolls; i++) {
    if (opts?.cancelled?.()) throw new Error("__CANCELLED__");
    if (i % 2 === 0) opts?.progress?.(i * 8);
    await sleep(8000);
    if (opts?.cancelled?.()) throw new Error("__CANCELLED__");
    const r = await execOnWorkspace(workspaceId, `tail -1 ${logf} 2>/dev/null`, { timeout: 40_000 }).catch(() => ({ output: "" } as any));
    if ((r.output || "").includes("ENGINE_READY")) { ready = true; break; }
    if ((r.output || "").includes("ENGINE_ERROR")) {
      const log = await execOnWorkspace(workspaceId, `tail -12 ${logf} 2>/dev/null`, { timeout: 20_000 }).catch(() => ({ output: "" } as any));
      throw new Error(`${engine} bring-up failed — ${failureReason((log.output || "").split(password).join("[redacted]"))}`);
    }
  }
  if (!ready) {
    const log = await execOnWorkspace(workspaceId, `tail -12 ${logf} 2>/dev/null`, { timeout: 20_000 }).catch(() => ({ output: "" } as any));
    throw new Error(`${engine} bring-up timed out — ${failureReason((log.output || "").split(password).join("[redacted]"))}`);
  }

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
