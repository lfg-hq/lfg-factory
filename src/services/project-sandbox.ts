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
 * persists on /data while the VM is up; a hard VM loss means a fresh setup.
 */
import { db } from "../config/db.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { projectDatabases } from "../db/schema/project-databases.ts";
import { and, eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../utils/crypto.ts";
import { newWorkspaceV2, execOnWorkspace, findJob, stopWorkspace } from "./mags.ts";

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
function dockerBringup(o: {
  name: string; image: string; port: number; volume: string;
  env?: string[];       // -e flags (KEY=VAL)
  cmd?: string;         // args appended after the image (e.g. redis-server ...)
  readyProbe: string;   // a `docker exec <name> …` command
  readyGrep: string;    // string that must appear in the probe's output when ready
  authProbe?: string;   // a `docker exec …` that exits 0 ONLY if OUR credentials work
}): string {
  const envFlags = (o.env ?? []).map((e) => `-e ${e}`).join(" ");
  const dataDir = o.volume.split(":")[0];
  const runCmd = `docker run -d --name ${o.name} --restart unless-stopped ${envFlags} -p 127.0.0.1:${o.port}:${o.port} -v ${o.volume} ${o.image} ${o.cmd ?? ""}`;
  return `mkdir -p ${dataDir} 2>/dev/null || true
for i in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 3; done
docker info >/dev/null 2>&1 || { echo "docker daemon unavailable"; echo ENGINE_ERROR; exit 1; }
if docker ps -a --format '{{.Names}}' | grep -qx ${o.name}; then
  docker start ${o.name} >/dev/null 2>&1 || true
else
  # Free the port from any leftover NATIVE daemon (older sandboxes ran these
  # engines natively) so the container's port publish doesn't collide.
  fuser -k ${o.port}/tcp >/dev/null 2>&1 || true; sleep 1
  ${runCmd} >/dev/null 2>&1
fi
# Wait until the server accepts connections.
for i in $(seq 1 90); do ${o.readyProbe} 2>/dev/null | grep -q "${o.readyGrep}" && break; sleep 3; done
${o.authProbe ? `
# Verify OUR credentials actually work. A data dir created OUTSIDE our provisioning
# makes the image "Skipping initialization", so our POSTGRES_/MYSQL_ USER+PASSWORD are
# IGNORED and every app query dies with FATAL: role "app" does not exist. If our creds
# are rejected, the cluster isn't ours — wipe the data dir + re-init a fresh one with
# our creds (preview data is disposable; migrations reseed the schema).
AUTH_OK=""
for i in $(seq 1 12); do ${o.authProbe} >/dev/null 2>&1 && { AUTH_OK=1; break; }; sleep 2; done
if [ -z "$AUTH_OK" ]; then
  echo "existing ${o.name} cluster rejects our credentials (foreign/legacy data dir) — reinitializing a fresh one"
  docker rm -f ${o.name} >/dev/null 2>&1 || true
  rm -rf ${dataDir}/* ${dataDir}/.[!.]* 2>/dev/null || true
  fuser -k ${o.port}/tcp >/dev/null 2>&1 || true; sleep 1
  ${runCmd} >/dev/null 2>&1
  for i in $(seq 1 90); do ${o.readyProbe} 2>/dev/null | grep -q "${o.readyGrep}" && break; sleep 3; done
fi` : ""}
${o.readyProbe} 2>/dev/null | grep -q "${o.readyGrep}" && { echo ENGINE_READY; exit 0; }
echo "--- ${o.name} container logs ---"; docker logs --tail 25 ${o.name} 2>&1; echo ENGINE_ERROR`;
}

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
      // cluster (role "app" does not exist) so it gets re-initialized fresh.
      authProbe: `docker exec -e PGPASSWORD='${pw}' postgres psql -U app -d app -tAc 'select 1'`,
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
      // Real query as our app user — catches a foreign cluster (unknown user) → reinit.
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
    }),
    connectionString: (c) => `redis://${c.user}:${c.pw}@127.0.0.1:${c.port}`,
  },
  mssql: {
    container: "mssql", port: 1433, defaultDb: "app", username: "sa", dataDir: "/data/db-mssql",
    // Readiness from the container log (sqlcmd isn't reliably on PATH inside the
    // image at first boot); the SA login is what apps use.
    bringup: (pw) => `mkdir -p /data/db-mssql && chmod 777 /data/db-mssql
for i in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 3; done
docker info >/dev/null 2>&1 || { echo "docker daemon unavailable"; echo ENGINE_ERROR; exit 1; }
if docker ps -a --format '{{.Names}}' | grep -qx mssql; then docker start mssql >/dev/null 2>&1 || true; else
  docker run -d --name mssql --restart unless-stopped -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=${pw}" -e MSSQL_PID=Developer -p 127.0.0.1:1433:1433 -v /data/db-mssql:/var/opt/mssql mcr.microsoft.com/mssql/server:2022-latest >/dev/null 2>&1
fi
for i in $(seq 1 90); do docker logs mssql 2>&1 | grep -q "SQL Server is now ready for client connections" && break; sleep 4; done
docker logs mssql 2>&1 | grep -q "SQL Server is now ready for client connections" && echo ENGINE_READY || { echo "--- mssql container logs ---"; docker logs --tail 25 mssql 2>&1; echo ENGINE_ERROR; }`,
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

/**
 * Ensure the project's single always-on sandbox exists and is running. ALL runs
 * (main + every ticket branch/worktree) share this ONE VM — we never spin a VM per
 * branch. `created` is true when the VM was NOT already running and we had to
 * launch a fresh one; `recreated` additionally means a sandbox existed before but
 * its VM was gone — so /data (the DB + installed toolchain) was RESET.
 */
export async function ensureProjectSandbox(projectId: string): Promise<{ workspaceId: string; created: boolean; recreated: boolean }> {
  const [existing] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId));
  // Use a RANDOM, unguessable workspace name (not env-<projectId>, which is
  // derivable from the project URL and would let a motivated actor target the VM
  // / its exposed URL). Generated once, then persisted + reused.
  const candidateWorkspaceId = existing?.workspaceId || `pv-${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

  // Atomically CLAIM the single project_environment row (unique on projectId) BEFORE
  // touching the VM. This makes ensureProjectSandbox idempotent + race-safe: setup,
  // ensureEngine, and @preview all call it, so a plain insert would hit the unique
  // constraint (the error you saw). onConflictDoUpdate converges everyone on the
  // SAME workspace instead of racing to insert.
  const [claimed] = await db.insert(projectEnvironments)
    .values({ projectId, workspaceId: candidateWorkspaceId, memGb: 8, diskGb: 20, status: "running", lastAwakeAt: new Date() })
    .onConflictDoUpdate({ target: projectEnvironments.projectId, set: { status: "running", lastAwakeAt: new Date(), updatedAt: new Date() } })
    .returning();
  const workspaceId = claimed?.workspaceId ?? candidateWorkspaceId; // the winner's workspace

  // Resolve the workspace by NAME (findJob), not getJobStatus — the name is
  // long/dashed and getJobStatus would misread it as a request_id.
  const job = await findJob(workspaceId).catch(() => null);
  let alive = job?.status === "running";

  // PHANTOM-VM guard: Mags can reap the underlying microVM (OOM, disk-full, host
  // eviction) while leaving the JOB record reporting "running". We'd then "reuse" a VM
  // that isn't there and every exec fails with "no VM associated with this job" (Docker
  // won't start, `git fetch` dies → "Could not fetch the repo"). So when the job claims
  // running, actually PROBE it; if the probe fails, treat it as dead, clear the zombie
  // job, and fall through to respawn. NOTE: a respawn may come back with a BLANK
  // /data — see the `recreated` note below.
  if (alive) {
    const probe = await execOnWorkspace(workspaceId, "echo __vm_alive__", { timeout: 15_000 })
      .then((r) => ({ ok: /__vm_alive__/.test(r?.output || ""), detail: r?.output || "" }))
      .catch((e) => ({ ok: false, detail: (e as Error)?.message || String(e) }));
    if (!probe.ok) {
      console.warn(`[project-sandbox] Job ${workspaceId} reports running but exec failed (phantom VM — reaped microVM + zombie job): ${probe.detail.slice(0, 120)}. Forcing respawn.`);
      alive = false;
      await stopWorkspace(workspaceId).catch(() => {}); // clear the zombie job before recreate
      await sleep(2000);
    }
  }

  // DO NOT ASSUME /data SURVIVES A RESPAWN. `recreated` means "we had a VM, it wasn't
  // running, so we're booting a new one" — and /data is a PER-VM ext4 volume (`disk_gb`
  // → /dev/vdb). The `workspace_id` we pass to newWorkspaceV2 syncs the SEPARATE
  // /workspace tree via JuiceFS; it does NOT back /data (see the verified note in
  // instant-app.ts's ensureSandbox, and the header of schema/pg/project-environments.ts:
  // data survives "as long as the VM is up"). A sleep/wake keeps the disk; a respawn can
  // hand back a blank one — no checkout, no toolchain, no DB volumes.
  //
  // Callers must therefore PROBE rather than trust: dev-preview's checkoutMissing() +
  // clearSetupCheckpoint() guard does exactly that, and re-runs the full setup (which
  // rebuilds from the repo + app profile + manifest + DB creds held in Postgres) when
  // the disk came back empty. Treating a blank disk as "reattached" is what previously
  // sent a restart into the AI driver with no source and no toolchain on the box.
  const recreated = !alive && !!existing?.workspaceId;
  if (alive) {
    console.log(`[project-sandbox] REUSING running sandbox VM ${workspaceId} for project ${projectId}`);
  } else if (recreated) {
    console.log(`[project-sandbox] Sandbox VM ${workspaceId} was not running (status: ${job?.status ?? "gone"}) — RESPAWNING it. Its /data may come back EMPTY (per-VM volume); callers must probe. project ${projectId}`);
  } else {
    console.log(`[project-sandbox] Creating the project's first sandbox VM ${workspaceId} for project ${projectId}`);
  }
  if (!alive) {
    // Big always-on box via the raw v2 API (the SDK caps RAM at 4GB): 4 vCPU /
    // 8GB / 20GB disk — enough for SQL Server + a .NET build without OOM. keepAlive
    // keeps it up (it hosts the DBs). Data lives on the /data volume.
    // Boot the "pi" rootfs (node 22 + Pi preinstalled), same base as tickets +
    // instant apps — a richer, consistent starting image than the bare default.
    const opts = { vcpus: 4, memoryMb: 8192, diskGb: 20, keepAlive: true, rootfsType: process.env.PREVIEW_ROOTFS || "pi" } as const;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await newWorkspaceV2(workspaceId, opts);
        break;
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        // Already up → success (that's the goal).
        if (/already exists/i.test(msg)) break;
        // Transient Mags provisioning failure (VM ended with status: error /
        // completed, or never started) — terminate the bad VM job and retry.
        // CRITICAL: use stopWorkspace (kills the VM), NOT deleteWorkspace — deleting
        // drops the workspace record itself (its name is the respawn key, and it backs
        // the /workspace JuiceFS tree + the stable URL alias), so a transient hiccup
        // would tear down the whole project sandbox. A plain retry keeps the workspace
        // and reboots into it. (It does NOT guarantee the same /data — that's a per-VM
        // volume; see the `recreated` note above.)
        if (attempt < 3 && /status: error|status: completed|did not start/i.test(msg)) {
          console.warn(`[project-sandbox] VM ${workspaceId} attempt ${attempt} failed (${msg.slice(0, 80)}); stopping the bad VM and retrying (workspace kept)…`);
          await stopWorkspace(workspaceId).catch(() => {});
          await sleep(3000);
          continue;
        }
        throw err;
      }
    }
  }

  // Move /tmp onto the big /data volume (the 1.9GB root fills up during a .NET
  // build — MSBuild writes scratch to /tmp). Redirect via a symlink so even tools
  // that ignore $TMPDIR (and don't source .env) land on /data. Idempotent.
  await execOnWorkspace(workspaceId, `sh -c 'mkdir -p /data/tmp && chmod 1777 /data/tmp; if [ ! -L /tmp ]; then rm -rf /tmp && ln -s /data/tmp /tmp; fi; echo tmp_ok'`, { timeout: 30_000 }).catch(() => {});

  // (The project_environment row was already claimed/updated via the upsert above.)
  return { workspaceId, created: !alive, recreated };
}

/**
 * Force a FRESH VM boot for the project, keeping the workspace (its name, /workspace
 * tree and stable URL). Use when the VM is reachable but its runtime is degraded —
 * e.g. after an OOM cascade `git-remote-https` starts segfaulting (signal 11) on every
 * fresh fetch. A phantom-guard `echo` probe passes on such a VM, so we can't rely on
 * ensureProjectSandbox's liveness check; this kills the VM outright and respawns it
 * with clean RAM.
 *
 * The new VM may boot a BLANK /data (per-VM volume — see the `recreated` note above),
 * so the caller must probe for the checkout afterwards and fall back to a full setup.
 * rebuildPreviewSandbox does this by routing through restartPreview's guard.
 */
export async function restartProjectSandbox(projectId: string): Promise<{ workspaceId: string }> {
  const [existing] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId));
  if (existing?.workspaceId) {
    // stopWorkspace (NOT deleteWorkspace) kills the VM but keeps the workspace, so the
    // respawn reuses the same name/URL instead of tearing the sandbox down.
    await stopWorkspace(existing.workspaceId).catch(() => {});
    await db.update(projectEnvironments).set({ status: "stopped", updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId)).catch(() => {});
    await sleep(3000); // let Mags settle the job to a non-running state before respawn
  }
  // ensureProjectSandbox now sees it as not-running → respawns a fresh VM (same name).
  const { workspaceId } = await ensureProjectSandbox(projectId);
  return { workspaceId };
}

/** Run a command inside the project's sandbox. */
export async function execInEnv(projectId: string, cmd: string, timeoutMs = 110_000): Promise<{ output: string; exitCode: number }> {
  const workspaceId = await envWorkspaceId(projectId);
  const r = await execOnWorkspace(workspaceId, cmd, { timeout: timeoutMs });
  return { output: (r.output || "") + (r.stderr ? "\n" + r.stderr : ""), exitCode: r.exitCode };
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
 * Ensure a DB engine is installed + running in the project's sandbox and return
 * connection info (localhost). Idempotent — reuses an existing engine + password.
 */
export async function ensureEngine(projectId: string, engine: DbEngine): Promise<EngineHandle> {
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`Unsupported engine: ${engine}`);
  await ensureProjectSandbox(projectId);
  const workspaceId = await envWorkspaceId(projectId);

  // Every engine now runs as a Docker container → dockerd must be up first.
  const dockerOk = await ensureDocker(projectId);
  if (!dockerOk) throw new Error(`Docker could not be started in the sandbox — it's required to run the ${engine} database. Check the sandbox's Docker setup and retry.`);

  const [row] = await db.select().from(projectDatabases).where(and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.engine, engine)));
  const password = row?.passwordEncrypted ? decryptSecret(row.passwordEncrypted) : generatePassword();

  // Run the idempotent bring-up in the background; poll a marker (avoids the
  // exec socket timeout on apk install / init / image pull).
  const logf = `/data/bringup-${engine}.log`;
  const scriptf = `/data/bringup-${engine}.sh`;
  await execOnWorkspace(workspaceId, `cat > ${scriptf} <<'EOSH'\n${spec.bringup(password)}\nEOSH\n: > ${logf}; nohup sh ${scriptf} >> ${logf} 2>&1 & echo launched`, { timeout: 60_000 });

  // First run pulls the image (blocking inside the bring-up) — budget for it.
  // mssql ~1.5GB, mysql ~600MB, postgres ~150MB, redis ~40MB (poll = 8s each).
  const maxPolls = { mssql: 120, mysql: 100, postgres: 75, redis: 60 }[engine] ?? 60; // ~16 / 13 / 10 / 8 min
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
