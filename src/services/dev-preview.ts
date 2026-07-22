/**
 * Dev Preview — run a CLIENT project (the connected repo, not an Instant app)
 * inside its always-on project sandbox so a developer can see a live,
 * localhost-style version of the app in the Preview tab.
 *
 * Pipeline (setupPreview): ensure sandbox → clone the repo → detect the stack
 * (a saved, editable manifest) → provision the DBs it needs (Postgres/MySQL/
 * Redis, co-located, reached over 127.0.0.1) → write env (DB creds auto-filled +
 * stored project env vars) → install → migrate + seed → run the app on
 * 0.0.0.0:8080 (detached so it survives the exec teardown) → expose a stable
 * Mags URL. Status is streamed over WS and persisted on project_environments.
 *
 * The DB provisioning uses the validated recipes in ./project-sandbox.ts.
 */
import { z } from "zod";
import { generateObject, generateText, stepCountIs, tool, zodSchema } from "ai";
import { and, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projects, projectEnvironmentVariables } from "../db/schema/projects.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { githubTokens, llmApiKeys } from "../db/schema/users.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { getValidGitlabToken } from "./gitlab-token.ts";
import { getModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { decryptSecret, encryptSecret } from "../utils/crypto.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { enableHttpAccess, execOnWorkspace, setStableUrl, startBrowserSession, stopWorkspace } from "./mags.ts";
import { ensureProjectSandbox, ensureEngine, ensureDocker, envWorkspaceId, type EngineHandle } from "./project-sandbox.ts";
import { isS3Enabled, buildS3Key, uploadBinary, getPresignedGetUrl } from "./s3.ts";
import { messages } from "../db/schema/chat.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { spawn } from "node:child_process";

const PROJECT_DIR = "/data/project";
const DEFAULT_PORT = 8080; // fallback ONLY — the real port is decided by the detected manifest per stack

/** A random, unguessable public subdomain for the preview URL — so preview URLs
 *  can't be enumerated from the project id (preview-<hex>.app.lfg.run). Persisted
 *  in stableAlias, so it stays stable for a project once created. */
function randomAlias(): string {
  return `preview-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export type PreviewStatus =
  | "idle" | "detecting" | "provisioning" | "installing" | "seeding" | "starting" | "running" | "error" | "stopped";

// ── Setup PLAN — produced by reading the actual codebase, then saved/editable.
// This is the contract between the "analyze" phase and the "provision + run"
// phases: it says exactly what toolchain, DBs (and how the app connects), schema
// setup, and run command are needed. ────────────────────────────────────────
const CONN_FORMATS = ["url", "dotnet-npgsql", "dotnet-mysql", "dotnet-sqlserver", "keyvalue"] as const;

export const manifestSchema = z.object({
  stack: z.string().describe("Human summary incl. versions, e.g. '.NET 8 / ASP.NET Core, multi-project solution' or 'Next.js 14 + Prisma'."),
  runtime: z.string().describe("e.g. dotnet, node, python, ruby, php, go"),
  framework: z.string().describe("e.g. aspnet-core, next, vite, django, rails, express, laravel; '' if unknown"),
  toolchain: z.array(z.string()).describe("Commands to install the language/runtime toolchain IN ORDER, e.g. ['apk add --no-cache dotnet8-sdk'] or ['apk add --no-cache nodejs npm']. [] if the base image already has it."),
  installCmd: z.string().describe("Install the app's libraries/deps: npm ci / dotnet restore <Solution.sln> / pip install -r requirements.txt / uv sync / bundle install / composer install. '' if none."),
  buildCmd: z.string().describe("Compile/build step needed BEFORE running (compiled stacks): 'dotnet build <sln> -c Release', 'npm run build', 'go build'. '' if none."),
  startupProject: z.string().describe("For a multi-project solution, the WEB/entry project to actually run (e.g. 'Cohire.Web' — the one referencing an ASP.NET Core / web SDK). '' for single-project apps."),
  runCmd: z.string().describe("Command to START the app in the FOREGROUND on `port`, bound to 0.0.0.0. Use the startup project — e.g. 'dotnet run --project Cohire.Web --urls http://0.0.0.0:5000', 'python manage.py runserver 0.0.0.0:8000', 'npm start'."),
  port: z.number().describe("The app's real port, detected from the codebase (launchSettings/appsettings, run scripts, docker-compose, framework default). This exact port is exposed publicly."),
  databases: z.array(z.object({
    engine: z.enum(["postgres", "mysql", "redis", "mssql"]).describe("The DB engine to provision — use the app's REAL engine. 'mssql' = Microsoft SQL Server (run via Docker) — pick it for EF Core SqlServer / T-SQL apps. Do NOT downgrade SQL Server to postgres; they are not wire-compatible."),
    connectionEnvVar: z.string().describe("The EXACT env var / .NET config key the app reads its connection from. ASP.NET Core with appsettings ConnectionStrings:DefaultConnection → 'ConnectionStrings__DefaultConnection'. Rails/Node/Django with a URL → 'DATABASE_URL'. Redis → 'REDIS_URL'."),
    connectionFormat: z.enum(CONN_FORMATS).describe("How to FORMAT the connection string for that var: 'url' = scheme://user:pw@host:port/db (Node/Python/Rails/Prisma); 'dotnet-npgsql' = 'Host=..;Port=..;Database=..;Username=..;Password=..' (.NET+Postgres); 'dotnet-mysql' = 'Server=..;Port=..;Database=..;Uid=..;Pwd=..'; 'dotnet-sqlserver'; 'keyvalue' generic."),
  })).describe("Every database the app connects to AND how it connects — read appsettings*.json ConnectionStrings, docker-compose services, ORM config (Prisma/EF/TypeORM/SQLAlchemy), DATABASE_URL in .env.example. [] if none."),
  migrations: z.array(z.string()).describe("Commands to create/apply the schema IN ORDER, e.g. ['dotnet ef database update --project Cohire.Core'], ['npx prisma migrate deploy'], ['python manage.py migrate']. [] if none."),
  sqlScripts: z.array(z.string()).describe("Raw .sql files the repo ships to build/seed the schema, as paths relative to the repo, IN THE ORDER they must run (e.g. ['Sql Scripts/01_schema.sql','Sql Scripts/02_seed.sql']). [] if none."),
  seedCmd: z.string().describe("Seed command if separate from migrations (e.g. 'npm run seed', 'python manage.py loaddata seed.json'). '' if none."),
  envVars: z.array(z.object({
    key: z.string(),
    required: z.boolean(),
    description: z.string().describe("what this var is / where to get it"),
  })).describe("OTHER env/config the app needs (API keys, feature flags) BEYOND database connections. EXCLUDE the DB connection vars above."),
});
export type PreviewManifest = z.infer<typeof manifestSchema>;
type PlannedDb = PreviewManifest["databases"][number];

// ── Small helpers ────────────────────────────────────────────────────────
async function sh(workspaceId: string, script: string, timeout = 180_000): Promise<{ output: string; exitCode: number }> {
  const b64 = Buffer.from(script).toString("base64");
  const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | bash`, { timeout }).catch(
    (e: any) => ({ output: "", stderr: e?.message ?? String(e), exitCode: -1 })
  );
  return { output: (r.output || "") + (r.stderr ? "\n" + r.stderr : ""), exitCode: r.exitCode ?? 0 };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getEnv(projectId: string) {
  const [row] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId));
  return row ?? null;
}

async function setPreview(
  projectId: string,
  userId: string,
  patch: Partial<{ previewStatus: PreviewStatus; previewError: string | null; appUrl: string | null; appPort: number | null; previewBranch: string; setupManifest: string; setupLog: string }>,
  message?: string,
) {
  await db.update(projectEnvironments)
    .set({ ...patch, setupLog: logBuffers.get(projectId), updatedAt: new Date() })
    .where(eq(projectEnvironments.projectId, projectId));
  broadcastToUser(userId, {
    type: "preview_status",
    projectId: pub(projectId),
    status: patch.previewStatus,
    message: message ?? "",
    previewUrl: patch.appUrl ?? undefined,
    error: patch.previewError ?? undefined,
  });
}

// ── Live setup log — one buffer per project, streamed to the Preview tab as
// `preview_log` and persisted on project_environments.setupLog so it survives a
// reload. This is how the UI shows "pulling repo / installing deps / …" and the
// REAL error output instead of an opaque plumbing message. ────────────────────
const logBuffers = new Map<string, string>();
const logFlushAt = new Map<string, number>(); // last DB-flush time per project

// WS broadcasts go to ALL of a user's open pages, so every preview event MUST
// carry the PUBLIC project id (the one the Preview tab holds) and the client
// filters on it — otherwise, with two projects open, logs/status from one leak
// into the other's Preview tab. We only have the INTERNAL id here, so cache the
// internal→public mapping (populated at each entry point).
const publicIdCache = new Map<string, string>();
function pub(internalId: string): string { return publicIdCache.get(internalId) ?? internalId; }
async function loadPublicId(internalId: string): Promise<void> {
  if (publicIdCache.has(internalId)) return;
  const [p] = await db.select({ pid: projects.projectId }).from(projects).where(eq(projects.id, internalId));
  if (p?.pid) publicIdCache.set(internalId, p.pid);
}

/** Append a human-readable line to the project's setup log (UI + server + DB). */
function plog(projectId: string, userId: string, line: string, opts?: { level?: "info" | "error"; detail?: string }) {
  const ts = new Date().toISOString().slice(11, 19);
  const level = opts?.level ?? "info";
  let entry = `[${ts}] ${line}`;
  if (opts?.detail) entry += "\n" + opts.detail.split("\n").map((l) => "    " + l).join("\n");
  const buf = ((logBuffers.get(projectId) ?? "") + entry + "\n").slice(-80_000); // keep last ~80KB (full prompt + commands)
  logBuffers.set(projectId, buf);
  console.log(`[dev-preview] ${projectId.slice(0, 8)} ${level === "error" ? "ERROR " : ""}${line}${opts?.detail ? " :: " + opts.detail.replace(/\n/g, " ").slice(0, 300) : ""}`);
  broadcastToUser(userId, { type: "preview_log", projectId: pub(projectId), line: entry, level });
  // Also persist to the DB on a throttle so the polling fallback (and a reload)
  // always shows fresh logs even during a long silent phase / if WS drops.
  const now = Date.now();
  if (now - (logFlushAt.get(projectId) ?? 0) > 1500) {
    logFlushAt.set(projectId, now);
    db.update(projectEnvironments).set({ setupLog: buf, updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId)).catch(() => {});
  }
}

function resetLog(projectId: string) { logBuffers.set(projectId, ""); logFlushAt.set(projectId, 0); }

// ── Cancellation ─────────────────────────────────────────────────────────────
// The setup pipeline runs as a fire-and-forget background task; Stop sets this
// flag and the pipeline bails at the next checkpoint (between phases + inside the
// runbook/agent loops), so a stuck/long run can actually be halted.
const cancelledProjects = new Set<string>();
export function cancelPreviewSetup(projectId: string) { cancelledProjects.add(projectId); }
function isCancelled(projectId: string): boolean { return cancelledProjects.has(projectId); }
/** Throws a sentinel if the run was cancelled — callers let it bubble to the catch. */
function throwIfCancelled(projectId: string) { if (cancelledProjects.has(projectId)) throw new Error("__CANCELLED__"); }

// ── Analyze: read the ACTUAL codebase (not a shallow fingerprint) so the plan
// knows the real DB, connection config, versions, schema scripts, and — for
// multi-project solutions — the entry project. ──────────────────────────────
async function gatherFingerprint(workspaceId: string): Promise<string> {
  const script = `
cd ${PROJECT_DIR} 2>/dev/null || exit 0
echo "=== TREE (2 levels) ==="; find . -maxdepth 2 -not -path '*/.git/*' -not -path '*/node_modules/*' | head -120
echo "=== .NET: solution ==="; cat *.sln 2>/dev/null | head -c 3000
echo "=== .NET: csproj files (full) ==="; for f in $(find . -maxdepth 3 -name '*.csproj' 2>/dev/null | head -12); do echo "--- $f"; cat "$f" 2>/dev/null | head -c 2000; done
echo "=== .NET: appsettings (CONNECTION STRINGS live here) ==="; for f in $(find . -maxdepth 3 -iname 'appsettings*.json' 2>/dev/null | head -8); do echo "--- $f"; cat "$f" 2>/dev/null | head -c 2500; done
echo "=== .NET: launchSettings ==="; for f in $(find . -maxdepth 4 -iname 'launchSettings.json' 2>/dev/null | head -4); do echo "--- $f"; cat "$f" 2>/dev/null | head -c 1500; done
echo "=== .NET/other: global.json / Dockerfile ==="; cat global.json 2>/dev/null | head -c 600; head -c 1500 Dockerfile 2>/dev/null
echo "=== node: package.json ==="; cat package.json 2>/dev/null | head -c 4000
echo "=== python: requirements/pyproject ==="; head -c 2000 requirements.txt 2>/dev/null; head -c 2000 pyproject.toml 2>/dev/null; test -f manage.py && echo '[django manage.py present]'
echo "=== ruby/php/go ==="; head -c 1500 Gemfile 2>/dev/null; head -c 1500 composer.json 2>/dev/null; head -c 800 go.mod 2>/dev/null
echo "=== docker-compose (declares DB services) ==="; head -c 3000 docker-compose.yml 2>/dev/null; head -c 3000 docker-compose.yaml 2>/dev/null
echo "=== ORM config ==="; head -c 2000 prisma/schema.prisma 2>/dev/null; find . -maxdepth 3 -iname 'ormconfig*' -o -maxdepth 3 -iname 'knexfile*' 2>/dev/null | head
echo "=== SQL scripts shipped in the repo (schema/seed) ==="; find . -maxdepth 3 -iname '*.sql' -not -path '*/node_modules/*' 2>/dev/null | head -40
echo "=== migration dirs ==="; find . -maxdepth 3 -type d \\( -iname 'migrations' -o -iname 'migrate' \\) 2>/dev/null | head
echo "=== .env example ==="; head -c 2500 .env.example 2>/dev/null; head -c 2500 .env.sample 2>/dev/null
echo "=== README setup ==="; head -c 2500 README.md 2>/dev/null; head -c 1500 README* 2>/dev/null
`.trim();
  const { output } = await sh(workspaceId, script, 90_000);
  return output.slice(0, 24_000);
}

/** Detect (or re-detect) the setup manifest. Merges project custom overrides. */
export async function detectManifest(projectId: string): Promise<PreviewManifest> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("project not found");
  const workspaceId = await envWorkspaceId(projectId);
  const fingerprint = await gatherFingerprint(workspaceId);

  const model = getModel(DEFAULT_MODEL_KEY, undefined, { allowEnvFallback: true });
  const { object } = await generateObject({
    model,
    schema: manifestSchema,
    prompt: `You are a senior build engineer preparing a SETUP PLAN to run this EXISTING repository inside a fresh sandbox so a developer can preview it live. You have a full read of the codebase below (solution/project files, appsettings, docker-compose, ORM config, SQL scripts, env examples, README). Produce a COMPLETE, concrete plan — everything needed to get this specific app serving HTTP. Do NOT be vague; do NOT assume; base every field on what the code actually shows.

ENVIRONMENT: the sandbox is ALPINE LINUX (musl libc, apk package manager, OpenRC, busybox). Every command MUST be Alpine-compatible: use \`apk add --no-cache <pkg>\` (NEVER apt/apt-get/yum/dnf), start system services with \`rc-service <svc> start\` (NEVER systemctl), and note that glibc-only prebuilt binaries may need \`apk add gcompat\`. Docker is ALREADY installed and running (use it for SQL Server). Package names are Alpine's (e.g. dotnet8-sdk, nodejs, npm, python3, py3-pip, postgresql-client).

Work out and fill in:
- stack / runtime / framework / versions — read .csproj <TargetFramework>, global.json, package.json engines, etc.
- toolchain — exact apk/install commands to get the language + runtime (e.g. ['apk add --no-cache dotnet8-sdk'], ['apk add --no-cache nodejs npm'], ['apk add --no-cache python3 py3-pip']). [] only if truly preinstalled.
- installCmd — restore the app's libraries (dotnet restore <the .sln you saw>, npm ci, pip install -r requirements.txt, uv sync, bundle install, composer install).
- buildCmd — for COMPILED stacks, the build BEFORE running (dotnet build <sln> -c Release). '' for interpreted stacks.
- startupProject + runCmd + port — for a MULTI-PROJECT solution, identify the WEB entry project (the .csproj referencing Microsoft.NET.Sdk.Web / ASP.NET Core) and run THAT (e.g. 'dotnet run --project Cohire.Web --urls http://0.0.0.0:<port>'). Detect the real port from launchSettings/appsettings/config. Bind 0.0.0.0.
- databases — CRITICAL: find EVERY database the app connects to and HOW. Look at appsettings*.json "ConnectionStrings" (the .NET connection lives there, NOT in .env), docker-compose db services, ORM configs, DATABASE_URL in .env.example. For each: the engine to provision — use the app's REAL engine among postgres/mysql/redis/mssql (mssql = Microsoft SQL Server, which we run via Docker; pick it for EF Core SqlServer / T-SQL apps — do NOT downgrade to postgres), the EXACT env var/config key the app reads (e.g. 'ConnectionStrings__DefaultConnection', 'DATABASE_URL', 'REDIS_URL'), and the connectionFormat (SQL Server → 'dotnet-sqlserver'; .NET+Postgres → 'dotnet-npgsql'; .NET+MySQL → 'dotnet-mysql'; URL-based stacks → 'url'). We will provision the DB and inject the string into that exact var. If the app declares the SAME connection under several keys, list each key.
- migrations — commands to create the schema (EF: 'dotnet ef database update --project <proj>'; Prisma/Django/Rails equivalents). []
- sqlScripts — if the repo ships .sql schema/seed files (e.g. a "Sql Scripts" folder), list their paths IN RUN ORDER so we apply them to the provisioned DB. []
- seedCmd / envVars — any other seed step / real external config (API keys) the app needs. EXCLUDE the DB connection vars (handled above).

Full codebase read:
${fingerprint}`,
  });

  // Project-level manual overrides win (customInstallCmd/customDevCmd/customDefaultPort).
  const manifest: PreviewManifest = {
    ...object,
    installCmd: project.customInstallCmd || object.installCmd,
    runCmd: project.customDevCmd || object.runCmd,
    port: project.customDefaultPort || object.port || DEFAULT_PORT,
  };
  return manifest;
}

// ── Env file ───────────────────────────────────────────────────────────────
/** Format a provisioned DB connection the way the app expects to read it. */
function formatConnection(db: PlannedDb, h: EngineHandle): string {
  const { host, port, dbName, username, password, engine } = h;
  // SQL Server always uses the ADO.NET keyword syntax regardless of what format
  // the plan guessed — a url would be wrong for it.
  if (engine === "mssql") return `Server=${host},${port};Database=${dbName};User Id=${username};Password=${password};TrustServerCertificate=True`;
  switch (db.connectionFormat) {
    case "dotnet-npgsql":
      return `Host=${host};Port=${port};Database=${dbName};Username=${username};Password=${password}`;
    case "dotnet-mysql":
      return `Server=${host};Port=${port};Database=${dbName};Uid=${username};Pwd=${password}`;
    case "dotnet-sqlserver":
      return `Server=${host},${port};Database=${dbName};User Id=${username};Password=${password};TrustServerCertificate=True`;
    case "keyvalue":
      return `Host=${host};Port=${port};Database=${dbName};Username=${username};Password=${password}`;
    case "url":
    default:
      if (engine === "redis") return `redis://${username}:${password}@${host}:${port}`;
      return `${engine === "mysql" ? "mysql" : "postgresql"}://${username}:${password}@${host}:${port}/${dbName}`;
  }
}

async function writeEnvFile(workspaceId: string, projectId: string, manifest: PreviewManifest, provisioned: Record<string, string>) {
  const port = manifest.port;
  // Stored project env vars (decrypted) + provisioned DB creds + generic run hints.
  const stored = await db.select().from(projectEnvironmentVariables).where(eq(projectEnvironmentVariables.projectId, projectId));
  // PORT/HOST are near-universal hints (frameworks that don't read them ignore
  // them); the manifest runCmd is authoritative for the actual bind. Anything
  // stack-specific is only added when that stack is actually detected.
  const runtime = (manifest.runtime || "").toLowerCase();
  const framework = (manifest.framework || "").toLowerCase();
  // Route every package/build cache onto the big persistent /data volume so
  // restores (NuGet can be GBs) survive restart and don't fill the 1.9GB root.
  const vars: Record<string, string> = {
    PORT: String(port), HOST: "0.0.0.0",
    // Temp dirs on /data too — MSBuild/dotnet write scratch to $TMPDIR, and the
    // 1.9GB root fills up ("No space left on device") if it stays on /tmp.
    TMPDIR: "/data/tmp", TMP: "/data/tmp", TEMP: "/data/tmp",
    NUGET_PACKAGES: "/data/.nuget", DOTNET_CLI_HOME: "/data/.dotnet",
    npm_config_cache: "/data/.npm-cache", PIP_CACHE_DIR: "/data/.pip-cache",
    GOPATH: "/data/go", COMPOSER_CACHE_DIR: "/data/.composer",
  };
  if (runtime.includes("dotnet") || framework.includes("dotnet") || framework.includes("asp")) {
    vars.ASPNETCORE_URLS = `http://0.0.0.0:${port}`;
  }
  Object.assign(vars, provisioned);
  for (const v of stored) {
    if (!v.hasValue) continue;
    try { vars[v.key] = decryptSecret(v.encryptedValue); } catch { /* skip unreadable */ }
  }
  // Always double-quote (values like .NET connection strings contain ';', spaces,
  // '=' — which break `set -a; . ./.env` sourcing if unquoted). Escape ", \, $, `.
  const body = Object.entries(vars)
    .map(([k, val]) => `${k}="${String(val).replace(/(["\\$`])/g, "\\$1")}"`)
    .join("\n");
  const b64 = Buffer.from(body).toString("base64");
  await sh(workspaceId, `cd ${PROJECT_DIR} && echo ${b64} | base64 -d > .env && echo WROTE_ENV`, 30_000);
}

// ── Run the app (detached, survives exec teardown) ──────────────────────────
async function checkServer(workspaceId: string, port: number, tries: number): Promise<boolean> {
  let served5xx = false;
  for (let i = 0; i < tries; i++) {
    const { output } = await sh(workspaceId, `curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:${port}/ 2>/dev/null || echo 000`, 15_000);
    const code = parseInt((output.match(/\d{3}/) || ["000"])[0], 10);
    // 2xx/3xx = serving, 4xx = up (e.g. API-only app with no route at /). A 5xx
    // means the app IS running but errors on the request — usually an APPLICATION
    // or DATA problem (a SQL error, an unseeded/mismatched DB schema, a null-ref in
    // a controller) that the sandbox can't fix. We still count it as "up" so the
    // preview goes live and the user can navigate (other pages may work) and see
    // the real error — instead of looping forever trying to fix a data/code bug.
    if (code >= 200 && code < 500) return true;
    if (code >= 500) served5xx = true;
    await sleep(3000);
  }
  return served5xx;
}

/** The homepage HTTP status (0 = down), so callers can warn when the app serves 5xx. */
async function httpStatus(workspaceId: string, port: number): Promise<number> {
  const { output } = await sh(workspaceId, `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}/ 2>/dev/null || echo 000`, 15_000);
  return parseInt((output.match(/\d{3}/) || ["0"])[0], 10);
}

/**
 * Wait for the app to answer on `port`, STREAMING new lines from its log the whole
 * time so the user sees the build/run progress (and any failure) instead of a blank
 * screen. Returns true as soon as the port serves, false at the deadline.
 */
async function waitForAppUp(projectId: string, userId: string, workspaceId: string, port: number, logFile: string, maxMs: number): Promise<boolean> {
  const start = Date.now();
  const deadline = start + maxMs;
  let off = 0;
  let lastMsgAt = start;
  while (Date.now() < deadline) {
    throwIfCancelled(projectId);
    const r = await sh(workspaceId, `tail -c +${off + 1} ${logFile} 2>/dev/null`, 15_000).catch(() => ({ output: "" }));
    const out = r.output || "";
    if (out.trim()) {
      off += Buffer.byteLength(out, "utf8");
      plog(projectId, userId, out.trim().split("\n").slice(-1)[0]!.slice(0, 200), { detail: out.trim().slice(-1200) });
      lastMsgAt = Date.now();
    } else if (Date.now() - lastMsgAt > 12_000) {
      // Heartbeat so a silent build (e.g. a hung restore that prints nothing) still
      // shows liveness + elapsed time instead of a frozen spinner.
      plog(projectId, userId, `…waiting for the app on port ${port} (${Math.round((Date.now() - start) / 1000)}s, no output yet)`);
      lastMsgAt = Date.now();
    }
    if (await checkServer(workspaceId, port, 1)) return true;
    await sleep(6000);
  }
  return false;
}

async function startApp(workspaceId: string, manifest: PreviewManifest): Promise<boolean> {
  const port = manifest.port;
  const buildStep = manifest.buildCmd ? `${manifest.buildCmd} >> preview.log 2>&1 || echo BUILD_FAILED >> preview.log` : "true";
  const script = `
export PATH=/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export NODE_OPTIONS="--max-old-space-size=1536"
cd ${PROJECT_DIR} || exit 1
# free the app's port
fuser -k ${port}/tcp 2>/dev/null; pkill -f ':${port}' 2>/dev/null; sleep 1
${buildStep}
CMD='set -a; [ -f ./.env ] && . ./.env; set +a; export PORT=${port} HOST=0.0.0.0; cd ${PROJECT_DIR}; exec ${manifest.runCmd.replace(/'/g, "'\\''")}'
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c "$CMD" </dev/null >> preview.log 2>&1 &
else
  nohup sh -c "$CMD" </dev/null >> preview.log 2>&1 &
fi
echo LAUNCHED
`;
  await sh(workspaceId, script, 300_000);
  return checkServer(workspaceId, port, 20); // ~60s
}

// ── Master-slave sandbox driver ──────────────────────────────────────────────
// WE (the server) are the master; the sandbox is the slave. An AI on OUR side
// drives it by issuing shell commands through a `run` tool that we execute in the
// sandbox via execOnWorkspace — reading each command's real output and deciding
// the next step — instead of handing a black-box prompt to an agent inside the
// VM (Pi), which quit early / looped / got guillotined by a blind timeout.

/** The user's chat model for the AI SDK (+ their provider keys). */
async function resolveDriverModel(userId: string) {
  const [sel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId));
  const modelKey = sel?.selectedModel ?? DEFAULT_MODEL_KEY;
  const [keys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, userId));
  const userApiKeys = keys ? {
    anthropic: keys.anthropicApiKey ?? undefined, openai: keys.openaiApiKey ?? undefined,
    google: keys.googleApiKey ?? undefined, kimi: keys.kimiApiKey ?? undefined,
    deepseek: keys.deepseekApiKey ?? undefined, glm: keys.glmApiKey ?? undefined,
  } : undefined;
  try {
    return { model: getModel(modelKey, userApiKeys, { allowEnvFallback: true }), modelKey };
  } catch {
    return null; // no key for this model → deterministic fallback
  }
}

// ── Checkpointed runbook ─────────────────────────────────────────────────────
// The plan is compiled into an ORDERED list of commands (a runbook). We run them
// one by one, log pass/fail against each, and PERSIST the statuses after every
// step — so a restart resumes from the first not-done step instead of the top.
export interface RunStep {
  id: string;
  phase: "prepare" | "toolchain" | "install" | "build" | "schema" | "run";
  label: string;
  command: string;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  optional?: boolean; // schema steps: a failure is logged but doesn't block
}

/** Build the shell command that applies a raw .sql file to the provisioned DB.
 *  Every engine runs as a Docker container, so we pipe the host file into the
 *  container's own client via `docker exec -i` (no DB client needed on the host). */
function sqlApplyCommand(engines: EngineHandle[], file: string): string {
  const f = `${PROJECT_DIR}/${file.replace(/"/g, '\\"')}`;
  const ms = engines.find((e) => e.engine === "mssql");
  const pg = engines.find((e) => e.engine === "postgres");
  const my = engines.find((e) => e.engine === "mysql");
  if (ms) return `cat "${f}" | docker exec -i mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -S localhost -U ${ms.username} -P "${ms.password}" -C -d ${ms.dbName} -b || /opt/mssql-tools/bin/sqlcmd -S localhost -U ${ms.username} -P "${ms.password}" -d ${ms.dbName} -b'`;
  if (pg) return `cat "${f}" | docker exec -i -e PGPASSWORD='${pg.password}' postgres psql -U ${pg.username} -d ${pg.dbName} -v ON_ERROR_STOP=0`;
  if (my) return `cat "${f}" | docker exec -i mysql mysql -u${my.username} -p'${my.password}' ${my.dbName}`;
  return `echo "no SQL engine provisioned to apply ${file}"`;
}

/** The detached app-start command (self-contained: cd + source .env + exec). */
function appStartCommand(manifest: PreviewManifest, dir: string = PROJECT_DIR): string {
  const port = manifest.port;
  const runCmd = manifest.runCmd.replace(/'/g, `'\\''`);
  return `fuser -k ${port}/tcp 2>/dev/null; pkill -f ':${port}' 2>/dev/null; sleep 1; ` +
    `setsid sh -c 'cd ${dir}; set -a; . ./.env 2>/dev/null; set +a; exec ${runCmd}' </dev/null > ${dir}/preview.log 2>&1 & echo STARTED`;
}

/** Compile the manifest into an ordered runbook. */
function buildRunbook(manifest: PreviewManifest, engines: EngineHandle[]): RunStep[] {
  const steps: RunStep[] = [];
  (manifest.toolchain || []).forEach((c, i) => steps.push({ id: `toolchain-${i}`, phase: "toolchain", label: c, command: c, status: "pending" }));
  if (manifest.installCmd) steps.push({ id: "install", phase: "install", label: manifest.installCmd, command: manifest.installCmd, status: "pending" });
  if (manifest.buildCmd) steps.push({ id: "build", phase: "build", label: manifest.buildCmd, command: manifest.buildCmd, status: "pending" });
  (manifest.migrations || []).forEach((c, i) => steps.push({ id: `migrate-${i}`, phase: "schema", label: c, command: c, status: "pending", optional: true }));
  (manifest.sqlScripts || []).forEach((file, i) => steps.push({ id: `sql-${i}`, phase: "schema", label: `apply ${file}`, command: sqlApplyCommand(engines, file), status: "pending", optional: true }));
  if (manifest.seedCmd) steps.push({ id: "seed", phase: "schema", label: manifest.seedCmd, command: manifest.seedCmd, status: "pending", optional: true });
  steps.push({ id: "run", phase: "run", label: manifest.runCmd, command: appStartCommand(manifest), status: "pending" });
  return steps;
}

const PHASE_STATUS: Record<RunStep["phase"], PreviewStatus> = {
  prepare: "provisioning", toolchain: "installing", install: "installing", build: "installing", schema: "seeding", run: "starting",
};

// ── Pipeline prelude — the infra phases that run BEFORE the manifest runbook
// (VM, Docker, clone, plan, DBs, env). Surfaced as checklist steps too, so the
// Steps view shows the WHOLE pipeline, not just the build commands. ────────────
function buildPrelude(): RunStep[] {
  return [
    { id: "vm", phase: "prepare", label: "Launch the sandbox VM", command: "", status: "pending" },
    { id: "docker", phase: "prepare", label: "Install + start Docker", command: "", status: "pending" },
    { id: "clone", phase: "prepare", label: "Pull the codebase", command: "", status: "pending" },
    { id: "plan", phase: "prepare", label: "Analyze the codebase & build the plan", command: "", status: "pending" },
    { id: "db", phase: "prepare", label: "Provision databases", command: "", status: "pending" },
    { id: "env", phase: "prepare", label: "Write environment (.env)", command: "", status: "pending" },
  ];
}

/** Persist + broadcast the full step list (prelude + runbook). */
async function persistSteps(projectId: string, userId: string, steps: RunStep[]) {
  await db.update(projectEnvironments)
    .set({ setupSteps: JSON.stringify(steps), setupLog: logBuffers.get(projectId), updatedAt: new Date() })
    .where(eq(projectEnvironments.projectId, projectId)).catch(() => {});
  broadcastToUser(userId, { type: "preview_steps", projectId, steps });
}

/**
 * Execute the runbook with checkpoints. Resumes from `resumeSteps` (skips steps
 * already done). Deterministic happy path; on a critical failure or if the app
 * doesn't come up, hands off to the AI driver (which sees the partial state).
 * Returns { up, steps } — steps is the final checkpoint.
 */
async function executeRunbook(
  projectId: string, userId: string, workspaceId: string,
  manifest: PreviewManifest, engines: EngineHandle[], model: any,
  resumeSteps: RunStep[] | null, prelude: RunStep[] = [],
): Promise<{ up: boolean; steps: RunStep[] }> {
  const port = manifest.port;
  // Prepend the (already-completed) infra prelude so the Steps view shows the
  // whole pipeline; the loop below skips them (phase "prepare").
  const steps = [...prelude, ...buildRunbook(manifest, engines)];
  // Resume: carry over 'done' from a prior checkpoint (by id). The run step never
  // stays "done" — the app may have stopped, so we always re-verify/restart it.
  if (resumeSteps?.length) {
    const done = new Set(resumeSteps.filter((s) => s.status === "done").map((s) => s.id));
    for (const s of steps) if (s.phase !== "run" && done.has(s.id)) s.status = "done";
  }

  const persist = async () => {
    await db.update(projectEnvironments)
      .set({ setupSteps: JSON.stringify(steps), setupLog: logBuffers.get(projectId), updatedAt: new Date() })
      .where(eq(projectEnvironments.projectId, projectId));
    broadcastToUser(userId, { type: "preview_steps", projectId: pub(projectId), steps });
  };
  const timeoutFor = (s: RunStep) => s.phase === "schema" ? 600_000 : s.phase === "run" ? 60_000 : 1_800_000;

  await persist();

  // ── Setup steps (everything except the infra prelude and the app start) ──
  for (const step of steps) {
    if (step.phase === "prepare" || step.phase === "run") continue;
    throwIfCancelled(projectId);
    if (step.status === "done") { plog(projectId, userId, `✓ (already done) ${step.label}`); continue; }
    step.status = "running"; step.error = undefined; await persist();
    await setPreview(projectId, userId, { previewStatus: PHASE_STATUS[step.phase] }, step.label);
    plog(projectId, userId, `▶ ${step.phase}: ${step.command}`);
    // Schema (SQL restores) can be legitimately silent for long stretches → no
    // stall guard; toolchain/install/build should stream progress → kill if they
    // go silent for 4 min (a hung network/TLS op) and let the AI driver recover.
    const r = await runDetachedPolled(projectId, userId, workspaceId, step.command, timeoutFor(step), { stallMs: step.phase === "schema" ? 0 : 240_000 });
    if (r.exitCode === 0) {
      step.status = "done";
      plog(projectId, userId, `  ✓ ${step.label}`, r.output && r.output !== "(no output)" ? { detail: r.output.slice(-700) } : undefined);
    } else {
      step.error = r.output.slice(-1200);
      plog(projectId, userId, `  ✗ ${step.label} (exit ${r.exitCode})`, { level: "error", detail: r.output.slice(-1200) });
      if (step.optional) {
        step.status = "failed"; // logged, but don't block — schema scripts are often idempotent/partial
      } else {
        step.status = "failed"; await persist();
        // Critical step failed → hand the rest to the AI driver (it sees state).
        if (model) {
          plog(projectId, userId, `Handing off to the AI driver to recover "${step.label}"…`);
          const up = await driveSandbox(projectId, userId, workspaceId, manifest, engines, model);
          if (up) { for (const s of steps) if (s.status !== "done") s.status = "done"; await persist(); return { up: true, steps }; }
        }
        await persist();
        return { up: false, steps };
      }
    }
    await persist();
  }

  // ── Start the app ──
  const runStep = steps.find((s) => s.phase === "run")!;
  runStep.status = "running"; runStep.error = undefined; await persist();
  await setPreview(projectId, userId, { previewStatus: "starting" }, "Starting the app…");
  plog(projectId, userId, `▶ start app: ${manifest.runCmd}`);
  await runDetachedPolled(projectId, userId, workspaceId, runStep.command, 60_000);
  if (await checkServer(workspaceId, port, 20)) { runStep.status = "done"; await persist(); return { up: true, steps }; }

  // App didn't come up → AI driver recovery (schema/config/runtime issues).
  const tail = await sh(workspaceId, `tail -20 ${PROJECT_DIR}/preview.log 2>/dev/null`, 20_000).catch(() => ({ output: "" }));
  plog(projectId, userId, "App did not respond after start — handing to the AI driver to diagnose…", { level: "error", detail: tail.output.slice(-800) });
  if (model) {
    const up = await driveSandbox(projectId, userId, workspaceId, manifest, engines, model);
    if (up) { runStep.status = "done"; await persist(); return { up: true, steps }; }
  }
  runStep.status = "failed"; runStep.error = tail.output.slice(-1000); await persist();
  return { up: false, steps };
}

/** Prefix that puts the toolchain on PATH, caches on /data, and loads .env. The
 *  toolchain + NuGet cache live on the shared /data volume, so a worktree run gets
 *  the SAME environment the main-branch run used (`dir` selects which checkout). */
function envPrefix(dir: string = PROJECT_DIR): string {
  return `export PATH="/data/.dotnet:/data/.dotnet/tools:/root/.dotnet/tools:/usr/local/bin:/usr/bin:/bin:/sbin:$PATH"; ` +
    `export DOTNET_ROOT=/data/.dotnet DOTNET_CLI_HOME=/data/.dotnet NUGET_PACKAGES=/data/.nuget ` +
    `DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 TMPDIR=/data/tmp; mkdir -p /data/tmp; ` +
    `cd ${dir} 2>/dev/null; set -a; [ -f ./.env ] && . ./.env; set +a; `;
}

function buildDriverSystemPrompt(manifest: PreviewManifest, engines: EngineHandle[], workDir: string = PROJECT_DIR): string {
  const port = manifest.port;
  const isBranch = workDir !== PROJECT_DIR;
  const dbLines = engines.length
    ? manifest.databases.map((d, i) => `  - ${d.engine} on 127.0.0.1:${engines[i]?.port ?? "?"} (db "${engines[i]?.dbName ?? "app"}") — connection string ALREADY in .env as ${d.connectionEnvVar}`).join("\n")
    : "  - none";
  const list = (label: string, items: string[]) => items.length ? `- ${label}:\n${items.map((s) => `    • ${s}`).join("\n")}` : "";
  const one = (label: string, v: string) => (v ? `- ${label}: \`${v}\`` : "");
  const plan = [
    `- stack: ${manifest.stack || `${manifest.runtime}/${manifest.framework}`}`,
    list("toolchain (install first if missing)", manifest.toolchain || []),
    one("install libraries", manifest.installCmd),
    one("build (BEFORE running — compiled stacks)", manifest.buildCmd),
    manifest.startupProject ? `- startup project (run THIS one): ${manifest.startupProject}` : "",
    list("apply DB migrations", manifest.migrations || []),
    list("apply these SQL files to the DB in order", manifest.sqlScripts || []),
    one("seed", manifest.seedCmd),
    one("run (foreground, bind 0.0.0.0)", manifest.runCmd),
    `- port: ${port}`,
  ].filter(Boolean).join("\n");

  return `You are an expert DevOps engineer bringing an EXISTING application up so it can be previewed live. You DRIVE a remote Alpine Linux sandbox by calling the \`run\` tool with shell commands — one command per call — and reading the real output before deciding the next. When the app is confirmed serving, call \`finish\`.

SANDBOX: Alpine Linux (musl, apk, OpenRC/rc-service, busybox) — NOT Debian. Use \`apk add --no-cache <pkg>\` (never apt/yum), \`rc-service <svc> start\` (never systemctl). Docker is installed and running. Every \`run\` command ALREADY has: the .NET toolchain on PATH (if installed to /data/.dotnet), caches pointed at /data (NUGET_PACKAGES, DOTNET_CLI_HOME, TMPDIR — keep everything on /data, the 20GB volume; the root fs is tiny), and the .env in your working dir sourced. You are in ${workDir}.
${isBranch ? `\nIMPORTANT — you are running a FEATURE BRANCH from a git worktree at ${workDir}. The MAIN branch already ran successfully on this same VM, so the toolchain (/data/.dotnet) and the package cache (/data/.nuget) are ALREADY installed and warm — do NOT reinstall the toolchain or re-fix things the main run already fixed; reuse them. The DB connection strings + any env fixes are already in this worktree's .env. You likely just need: restore (fast, cache is warm) → build → start the app. Work in ${workDir} (cd there for every command).\n` : ""}
The repo is already cloned. The databases below are already installed + running (do NOT install/start any DB); their connection strings are already in .env:
${dbLines}

SETUP PLAN (from analyzing the codebase — follow it, but verify against reality and adapt when a command fails):
${plan}

GOAL: the app must serve HTTP on 0.0.0.0:${port} and actually respond.

HOW TO WORK:
- The SETUP PLAN above is a best-effort guess from reading the code — it is NOT authoritative. VERIFY it against reality and OVERRIDE it whenever a command fails or a better approach exists. You are the one who figures out how to make this app run; the plan is just a starting hint.
- Install the toolchain, then dependencies. If a plan command (e.g. \`apk add dotnet8-sdk\`) is unavailable, broken, or the wrong version, use whatever works instead (e.g. \`curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir /data/.dotnet\`).
- For compiled stacks: restore → BUILD → run. For a multi-project solution, run the startup project named above.
- Apply migrations, then the SQL scripts in order (SQL Server runs in Docker — use \`docker exec\` with sqlcmd inside the mssql container, or a client you install; the connection string is in .env).
- Start the APP SERVER detached so it keeps running after the command returns: \`setsid sh -c 'cd ${workDir}; <run command>' </dev/null > ${workDir}/preview.log 2>&1 &\` — it must bind 0.0.0.0:${port}. (This is the ONLY case where you background a command yourself.)
- VERIFY for real: \`curl -sS -i http://127.0.0.1:${port}/\`. A real 2xx/3xx/4xx = up → \`finish\` ready. 000/connection-refused = down → read ${workDir}/preview.log, diagnose, fix, retry.
- A 500 needs judgement: the app IS serving (running), but errored on the request. Read the error in ${workDir}/preview.log. If it's an ENVIRONMENT issue in YOUR remit (missing/wrong connection string, a service that isn't up, a missing env var) → fix it and retry. If it's an APPLICATION or DATA problem — a SQL error (e.g. "Invalid column name", "Invalid object name", a missing table/column), an unseeded/mismatched DB schema, or a bug in the app's own code — then the app is RUNNING and this is NOT yours to fix (you must not edit app source or seed data). Call \`finish\` with status "ready" and clearly state the runtime error (e.g. "App is up on :${port} but the homepage returns 500 from SQL error 207 'Invalid column name' — the DB schema is incomplete/mismatched"). Do NOT loop on it.

PERSISTING WHAT YOU LEARN (so the next run doesn't repeat your work):
- Each \`run\` command starts a FRESH shell, so a bare \`export FOO=bar\` does NOT carry to the next command. For an environment fix that must stick (an env var, a cert/CA path, a package source), call the \`setEnv\` tool — it stores the var on the project (encrypted) AND writes it into .env now, so it is re-applied on every future setup and SURVIVES a VM rebuild. (Appending to ./.env only lasts while this VM lives — if the VM is recreated you'd have to rediscover the fix.)
- When you discover the PLAN itself was wrong and found what works — a different toolchain install, install/build/run command, startup project, or port — call \`updatePlan\` to persist the corrected value. Do this AFTER you've confirmed the new command works. This is how the checklist self-heals: the next preview run skips straight to the working commands.

RUNNING COMMANDS — IMPORTANT:
- The \`run\` tool already runs each command DETACHED and polls it to completion, so restore/build/install take as long as they need — you do NOT need to background them, add \`&\`, nohup, or your own timeout wrapper. Just run the plain command (e.g. \`dotnet build Cohire.sln -c Release\`).
- Pass a large \`timeoutSec\` (~1500) for restore/build. If a command returns exitCode -2 ("still running after Ns"), it is STILL RUNNING — do NOT restart it; call \`run\` again (e.g. \`sleep 5\` or re-issue with a bigger timeoutSec) to keep waiting for it to finish. Never kill and restart a build that's progressing.
- If a command returns exitCode -4, we KILLED it: it produced NO output for ~4 min and looked stuck (commonly a hung network/TLS/DNS op — e.g. a package restore that can't validate a source's certificate even though \`curl\` to it works). Do NOT re-run the identical command. Diagnose the hang and change the approach (fix certs/CA path, a different package source or install method, offline/cached packages), then retry.

RULES:
- Do NOT modify the application's SOURCE CODE. You may install tools/deps, set env, choose commands, fix host/port, edit ./.env. If it genuinely needs a code change to run, call \`finish\` with status "failed" and the exact reason.
- When a command genuinely fails (a real non-zero exit with an error), read the error and fix the ENVIRONMENT, then continue. Keep going until the app responds or it truly cannot run — do not give up after one failed attempt.
- One command per \`run\` call. Never print secrets.`;
}

/**
 * Run a command in the sandbox that may take LONGER than the ~120s Cloudflare
 * gateway limit on Mags' /exec endpoint (which 524s any single HTTP call past
 * ~120s). We launch the command DETACHED (setsid) writing to a log + an
 * exit-code marker, then poll with SHORT exec calls until it finishes. Each HTTP
 * call stays well under the gateway cap, so a 20-min build works fine.
 */
async function runDetachedPolled(
  projectId: string, userId: string, workspaceId: string, command: string, maxMs: number,
  opts?: { stallMs?: number; workDir?: string },
): Promise<{ exitCode: number; output: string }> {
  const id = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e7).toString(36)}`;
  const dir = "/data/.run";
  const logf = `${dir}/${id}.log`, donef = `${dir}/${id}.done`, scriptf = `${dir}/${id}.sh`;
  // The actual work script (env prefix + the model's command).
  const workB64 = Buffer.from(`${envPrefix(opts?.workDir ?? PROJECT_DIR)}\n${command}`).toString("base64");
  // Launcher: write the script, run it detached, record exit code in the marker.
  const launcher =
    `mkdir -p ${dir}; echo ${workB64} | base64 -d > ${scriptf}; ` +
    `setsid sh -c 'sh ${scriptf} > ${logf} 2>&1; echo $? > ${donef}' </dev/null >/dev/null 2>&1 & echo LAUNCHED`;
  const lb64 = Buffer.from(launcher).toString("base64");
  const launch = await execOnWorkspace(workspaceId, `echo ${lb64} | base64 -d | bash`, { timeout: 30_000 })
    .catch((e: any) => ({ output: "", stderr: String(e?.message ?? e), exitCode: -1 }));
  if (!/LAUNCHED/.test(launch.output || "")) {
    return { exitCode: -1, output: `failed to launch: ${(launch.output || "") + ((launch as any).stderr || "")}`.slice(-2000) };
  }

  // Stall detection: a command that produces NO new output for `stallMs` is
  // treated as stuck (e.g. a network op hanging on a TLS/DNS failure) and killed,
  // so the driver gets fast feedback (~minutes) instead of burning the full
  // maxMs. 0 = disabled (for genuinely-silent steps like SQL restores).
  const stallMs = opts?.stallMs ?? 0;
  const deadline = Date.now() + maxMs;
  let interval = 3000;
  let lastSize = -1;
  let lastGrowthAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(interval);
    interval = Math.min(interval + 2000, 15000); // back off: 3s,5s,7s…15s
    // Cancelled → kill the detached command's process tree and bail.
    if (isCancelled(projectId)) {
      await execOnWorkspace(workspaceId, `pkill -9 -f ${id} 2>/dev/null; echo cancelled`, { timeout: 20_000 }).catch(() => {});
      return { exitCode: -3, output: "(cancelled)" };
    }
    // One call: the done-marker AND the current log size (for stall detection).
    const chk = await execOnWorkspace(workspaceId, `if [ -f ${donef} ]; then printf 'DONE:'; cat ${donef}; else echo RUNNING; fi; printf ' SIZE:'; wc -c < ${logf} 2>/dev/null || printf 0`, { timeout: 30_000 })
      .catch(() => ({ output: "RUNNING SIZE:0", stderr: "", exitCode: 0 }));
    const chkOut = chk.output || "";
    if (chkOut.includes("DONE:")) {
      const code = parseInt((chkOut.match(/DONE:(-?\d+)/) || [])[1] ?? "-1", 10);
      const out = await execOnWorkspace(workspaceId, `tail -c 6000 ${logf} 2>/dev/null`, { timeout: 30_000 })
        .catch(() => ({ output: "", stderr: "", exitCode: 0 }));
      return { exitCode: code, output: (out.output || "").trim() || "(no output)" };
    }
    if (stallMs > 0) {
      const size = parseInt((chkOut.match(/SIZE:(\d+)/) || [])[1] ?? "0", 10);
      if (size > lastSize) { lastSize = size; lastGrowthAt = Date.now(); }
      else if (Date.now() - lastGrowthAt > stallMs) {
        const tail = await execOnWorkspace(workspaceId, `pkill -9 -f ${id} 2>/dev/null; tail -c 2000 ${logf} 2>/dev/null`, { timeout: 30_000 }).catch(() => ({ output: "" }));
        return { exitCode: -4, output: `(killed — no output for ${Math.round(stallMs / 1000)}s, command appears stuck. Do NOT re-run the same command; try a DIFFERENT approach. Recent output:\n${(tail as any).output || ""})`.slice(-4000) };
      }
    }
  }
  // Timed out — leave it running (a build may still finish); tell the model.
  const tail = await execOnWorkspace(workspaceId, `tail -c 2000 ${logf} 2>/dev/null`, { timeout: 30_000 }).catch(() => ({ output: "" }));
  return { exitCode: -2, output: `(still running after ${Math.round(maxMs / 1000)}s; poll again later. Recent output:\n${tail.output || ""})`.slice(-4000) };
}

async function driveSandbox(
  projectId: string,
  userId: string,
  workspaceId: string,
  manifest: PreviewManifest,
  engines: EngineHandle[],
  model: any,
  workDir: string = PROJECT_DIR,
): Promise<boolean> {
  const port = manifest.port;
  let finished: { status: "ready" | "failed"; detail: string } | undefined;

  const tools = {
    run: tool({
      description: "Run one shell command in the Alpine sandbox (bash). The toolchain PATH, /data caches, and the project's .env are already set up. The command runs to completion no matter how long it takes (build/restore are fine) — we run it detached and poll, so you don't need to background it yourself. Returns exit code + combined stdout/stderr (last 6KB). exitCode -2 = still running after your timeout (call run again to keep polling — do NOT restart it). exitCode -4 = we KILLED it because it produced no output for ~4 min (stuck, e.g. a hung network/TLS op) — do NOT re-run the same command, change the approach.",
      inputSchema: zodSchema(z.object({
        command: z.string().describe("The shell command to run (one command; use && or a heredoc for multi-step). Run it in the FOREGROUND — do NOT add '&'/nohup/setsid yourself; we detach it for you. EXCEPTION: the app server itself must be started detached (setsid ... &) so it keeps running."),
        timeoutSec: z.number().optional().describe("How long to wait for THIS command before returning control (default 600, max 1800). For a big restore/build use ~1500. If it returns exitCode -2 (still running), call run again with the same/again to keep waiting."),
      })),
      execute: async ({ command, timeoutSec }: { command: string; timeoutSec?: number }) => {
        throwIfCancelled(projectId); // Stop pressed → abort the agent loop
        const maxMs = Math.min(Math.max(timeoutSec ?? 600, 10), 1800) * 1000;
        plog(projectId, userId, `$ ${command}`);
        setPreview(projectId, userId, { previewStatus: "starting" }, `$ ${command.slice(0, 110)}`).catch(() => {});
        // Kill a command that goes silent for 4 min (stuck) so the agent iterates
        // fast instead of burning the full timeout on a hang.
        const r = await runDetachedPolled(projectId, userId, workspaceId, command, maxMs, { stallMs: 240_000, workDir });
        plog(projectId, userId, `  → exit ${r.exitCode}`, r.output ? { detail: r.output.slice(-1800), level: r.exitCode === 0 ? "info" : "error" } : undefined);
        return { exitCode: r.exitCode, output: r.output.slice(-6000) || "(no output)" };
      },
    }),
    updatePlan: tool({
      description: "Persist a correction to the saved SETUP PLAN (the checklist) so the NEXT run uses the working approach instead of repeating the failed one. Call this the moment you discover a plan command is wrong and you found what works — e.g. the toolchain 'apk add dotnet8-sdk' fails so you installed the runtime a different way, or the install/build/run command, startup project, or port in the plan is wrong. This does NOT run anything; it just rewrites the checklist. (For an environment fix that must persist across steps/restarts — an env var, a cert path, a package source — append it to ./.env instead; it is sourced before every command.)",
      inputSchema: zodSchema(z.object({
        field: z.enum(["toolchain", "installCmd", "buildCmd", "runCmd", "port", "startupProject"]).describe("Which plan field to correct."),
        value: z.string().describe("The corrected value. For 'toolchain', the FULL working command sequence, one command per line (replaces the old toolchain). For 'port', the number as a string. Otherwise the exact command/name."),
        reason: z.string().describe("Briefly: what was wrong and what you changed it to."),
      })),
      execute: async ({ field, value, reason }: { field: string; value: string; reason: string }) => {
        if (field === "toolchain") manifest.toolchain = value.split("\n").map((s) => s.trim()).filter(Boolean);
        else if (field === "port") { const p = parseInt(value, 10); if (p > 0) manifest.port = p; }
        else (manifest as any)[field] = value;
        await db.update(projectEnvironments)
          .set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() })
          .where(eq(projectEnvironments.projectId, projectId)).catch(() => {});
        const shown = field === "toolchain" ? manifest.toolchain.join("; ") : String((manifest as any)[field]);
        plog(projectId, userId, `Updated plan: ${field} → ${shown}`, { detail: reason });
        return "plan updated — the next run will use this.";
      },
    }),
    setEnv: tool({
      description: "PERSIST an environment variable the app/build needs so it SURVIVES a sandbox rebuild (a VM crash gives a fresh /data — .env and installed tools are lost). Use this for any env fix you discover — a cert/CA path (e.g. SSL_CERT_FILE), a package source, a required runtime flag — INSTEAD of only echoing to .env. It's stored (encrypted) on the project and re-written into .env on every future setup, so the next build won't rediscover it. Also writes it into the CURRENT .env immediately.",
      inputSchema: zodSchema(z.object({
        key: z.string().describe("Env var name, e.g. SSL_CERT_FILE"),
        value: z.string().describe("Its value"),
        reason: z.string().optional().describe("Why it's needed"),
      })),
      execute: async ({ key, value, reason }: { key: string; value: string; reason?: string }) => {
        try {
          await db.insert(projectEnvironmentVariables)
            .values({ projectId, key, encryptedValue: encryptSecret(value), isSecret: false, hasValue: true, description: reason || "preview setup fix" })
            .onConflictDoUpdate({ target: [projectEnvironmentVariables.projectId, projectEnvironmentVariables.key], set: { encryptedValue: encryptSecret(value), hasValue: true, updatedAt: new Date() } });
          const line = `${key}="${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
          const b64 = Buffer.from(line).toString("base64");
          // Write into the current working dir's .env (a worktree during a branch
          // recovery) AND the default checkout's .env, so it applies now and later.
          const dirs = [...new Set([workDir, PROJECT_DIR])];
          for (const d of dirs) {
            await sh(workspaceId, `cd ${d} 2>/dev/null && (grep -v '^${key}=' .env 2>/dev/null > .env.tmp; echo ${b64} | base64 -d >> .env.tmp; mv .env.tmp .env) && echo SET_ENV`, 30_000);
          }
          plog(projectId, userId, `Persisted env ${key} (survives VM rebuild)`, { detail: reason });
          return `persisted ${key} — it will be re-applied on every setup.`;
        } catch (e) {
          return `failed to persist env: ${(e as Error).message}`;
        }
      },
    }),
    finish: tool({
      description: "Call ONCE when the app is confirmed serving on the port (status 'ready'), or when it genuinely cannot run without a source-code change (status 'failed').",
      inputSchema: zodSchema(z.object({
        status: z.enum(["ready", "failed"]),
        detail: z.string().describe("For 'ready': the URL/port. For 'failed': the concrete blocking reason incl. the real error."),
      })),
      execute: async ({ status, detail }: { status: "ready" | "failed"; detail: string }) => {
        finished = { status, detail };
        plog(projectId, userId, `Driver finished: ${status}`, { detail, level: status === "ready" ? "info" : "error" });
        return "acknowledged";
      },
    }),
  };

  // Stop → abort the agent loop cleanly (AbortController), instead of every
  // command throwing __CANCELLED__ back to the model (which reads it as "the
  // sandbox went unresponsive" and flails). A watcher fires abort on cancel.
  const ac = new AbortController();
  const watch = setInterval(() => { if (isCancelled(projectId)) ac.abort(); }, 1000);
  try {
    await generateText({
      model,
      tools,
      stopWhen: stepCountIs(80), // generous step budget — we control the loop, not a blind timer
      system: buildDriverSystemPrompt(manifest, engines, workDir),
      prompt: `Bring the app up and verify it serves on 0.0.0.0:${port} (working dir: ${workDir}). Begin.`,
      abortSignal: ac.signal,
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    // A cancel-driven abort is expected — don't surface it as a scary error.
    if (!isCancelled(projectId) && !/abort/i.test(msg)) {
      plog(projectId, userId, `Driver loop error: ${msg}`, { level: "error" });
    }
  } finally {
    clearInterval(watch);
  }

  // Trust reality, not the model's word: confirm the port actually serves.
  if (await checkServer(workspaceId, port, 8)) return true;
  if (finished?.status === "failed") {
    plog(projectId, userId, "App could not be brought up", { level: "error", detail: finished.detail });
  }
  return false;
}

// ── Interactive preview agent (@preview in chat) ──────────────────────────────
// Full shell control of the project's LIVE sandbox, driven by a chat request
// ("@preview restart the app", "@preview why is postgres failing?"). Same `run`
// loop as the setup driver, but the goal is the user's instruction and it replies
// with a chat summary. Commands stream into the Preview tab log; abort via the
// chat Stop. Does NOT re-run setup — it acts on the already-provisioned sandbox.
export async function runPreviewChat(opts: {
  projectId: string;          // internal id
  publicProjectId: string;
  userId: string;
  conversationId: string | null;
  instruction: string;
  abortSignal?: AbortSignal;
}): Promise<{ reply: string }> {
  const { projectId, publicProjectId, userId, instruction, abortSignal } = opts;
  publicIdCache.set(projectId, publicProjectId); // WS routing for plog

  const driver = await resolveDriverModel(userId);
  if (!driver) return { reply: "I can't reach an AI model — add an API key in Settings to use the preview agent." };

  let workspaceId: string;
  try { ({ workspaceId } = await ensureProjectSandbox(projectId)); }
  catch { return { reply: "There's no preview sandbox for this project yet. Open the **Preview** tab and run setup first, then ask me again." }; }

  const row = await getEnv(projectId);
  const manifest = row?.setupManifest ? (JSON.parse(row.setupManifest) as PreviewManifest) : null;
  const port = manifest?.port ?? DEFAULT_PORT;
  const runCmd = row?.runCommand || manifest?.runCmd || "";

  plog(projectId, userId, `@preview: ${instruction}`);

  let reply = "";
  const tools = {
    run: tool({
      description: "Run one shell command in the project's live Alpine sandbox (bash). Runs detached + polled, so long commands are fine. Returns exit code + combined stdout/stderr (last 6KB). exitCode -2 = still running (call again to keep waiting); -4 = we killed it after ~4 min of no output (stuck — change approach).",
      inputSchema: zodSchema(z.object({
        command: z.string().describe("One shell command (use && or a heredoc for multi-step). Run in the FOREGROUND — do NOT add '&'/nohup/setsid yourself; we detach it. EXCEPTION: the app server must be launched detached (setsid ... &) so it keeps running."),
        timeoutSec: z.number().optional().describe("Seconds to wait before returning control (default 600, max 1800)."),
      })),
      execute: async ({ command, timeoutSec }: { command: string; timeoutSec?: number }) => {
        const maxMs = Math.min(Math.max(timeoutSec ?? 600, 10), 1800) * 1000;
        plog(projectId, userId, `$ ${command}`);
        const r = await runDetachedPolled(projectId, userId, workspaceId, command, maxMs, { stallMs: 240_000 });
        plog(projectId, userId, `  → exit ${r.exitCode}`, r.output ? { detail: r.output.slice(-1800), level: r.exitCode === 0 ? "info" : "error" } : undefined);
        return { exitCode: r.exitCode, output: r.output.slice(-6000) || "(no output)" };
      },
    }),
    reply: tool({
      description: "Call ONCE when you've finished the user's request. Give a concise, friendly chat summary of what you did or found (markdown ok). If you confirmed something works, say how you verified it.",
      inputSchema: zodSchema(z.object({ summary: z.string() })),
      execute: async ({ summary }: { summary: string }) => { reply = summary; return "acknowledged"; },
    }),
  };

  const startHint = `setsid sh -c 'cd ${PROJECT_DIR}; set -a; . ./.env 2>/dev/null; set +a; exec ${runCmd || "<run command>"}' </dev/null > ${PROJECT_DIR}/preview.log 2>&1 &`;
  const system = `You are the LFG **Preview agent** for this project. You have FULL shell control of the project's LIVE Alpine sandbox (musl, apk, OpenRC/rc-service, busybox — Docker is available) via the \`run\` tool: one command per call, run detached + polled so long commands are fine. The repo is at ${PROJECT_DIR}; its .env is sourced before every command; the toolchain + /data caches are already on PATH.

${manifest ? `App: ${manifest.stack || `${manifest.runtime}/${manifest.framework}`}. Run command: \`${runCmd || "(unknown)"}\`. Port: ${port}. Databases: ${manifest.databases.length ? manifest.databases.map((d) => `${d.engine} (127.0.0.1, connection in .env as ${d.connectionEnvVar})`).join(", ") : "none"}.` : "This preview has not been fully set up yet — the app may not be running."}

The app server (if running) listens on 127.0.0.1:${port}. To (re)start it, launch it DETACHED:
  ${startHint}
then VERIFY for real: \`curl -sS -i http://127.0.0.1:${port}/\` (2xx/3xx/4xx = up; 000/refused/5xx = not up → read ${PROJECT_DIR}/preview.log).

Do exactly what the user asked — inspect logs, fix env/deps, (re)start the app, run DB queries/scripts, check status, diagnose failures. RULES: do NOT edit the application's SOURCE CODE (installing tools/deps, editing ./.env and config is fine). Make persistent env fixes by appending to ${PROJECT_DIR}/.env (sourced before every command + on restart). Verify with real commands — never claim success without checking. Keep going until the request is done or genuinely can't be. When finished, call \`reply\` with a short summary for the chat. Never print secrets.`;

  try {
    await generateText({ model: driver.model, tools, stopWhen: stepCountIs(40), system, prompt: instruction, abortSignal });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (abortSignal?.aborted || /abort/i.test(msg)) return { reply: reply || "Stopped." };
    plog(projectId, userId, `Preview agent error: ${msg}`, { level: "error" });
    return { reply: reply || `I ran into an error: ${msg.slice(0, 300)}` };
  }
  return { reply: reply || "Done — but I didn't produce a summary. Check the Preview tab logs for details." };
}

// ── Public API ───────────────────────────────────────────────────────────────
export interface SetupOptions { userId: string; branch?: string; rebuildManifest?: boolean; ticketId?: string }

/** The worktree directory for a ticket's branch inside the preview sandbox. Must
 *  match the name the ticket executor creates: `wt-ticket-<ticketId first 12>`. */
function ticketWorktreeDir(ticketId: string): string { return `/data/wt-ticket-${ticketId.slice(0, 12)}`; }

/**
 * Full setup: bring the client app up live in its sandbox and return a preview
 * URL. Long-running — call in the background and stream status over WS.
 */
export async function setupPreview(projectId: string, opts: SetupOptions): Promise<{ previewUrl: string } | { error: string }> {
  const { userId } = opts;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return { error: "project not found" };
  if (project.projectId) publicIdCache.set(projectId, project.projectId); // for WS routing
  const branch = opts.branch || ""; // "" → use the repo's default branch

  resetLog(projectId);
  cancelledProjects.delete(projectId); // fresh run
  // Pipeline steps (infra prelude) — surfaced in the Steps view as they progress.
  const prelude = buildPrelude();
  const prep = async (id: string, status: RunStep["status"]) => {
    const s = prelude.find((p) => p.id === id); if (s) s.status = status;
    await persistSteps(projectId, userId, prelude);
  };
  try {
    await prep("vm", "running");
    plog(projectId, userId, "Starting the project's sandbox…");
    const { workspaceId, recreated } = await ensureProjectSandbox(projectId);
    plog(projectId, userId, recreated
      ? "Sandbox VM was respawned (its persistent /data — repo, toolchain, DBs — is reattached)"
      : "Sandbox ready — reusing the existing VM (Alpine Linux, 8GB, Docker-capable)");
    await prep("vm", "done");
    await setPreview(projectId, userId, { previewStatus: "detecting", previewError: null, previewBranch: branch || "(default)" }, "Preparing sandbox…");

    // 0. Install + start Docker UP FRONT (before pulling the code) so it's ready
    // for any Docker-based DB (SQL Server) and for the run agent. Alpine → OpenRC.
    await prep("docker", "running");
    plog(projectId, userId, "Installing + starting Docker…");
    const dockerReady = await ensureDocker(projectId);
    plog(projectId, userId, dockerReady ? "Docker ready ✓" : "Docker did not start (only fatal if a Docker-based DB is needed)", dockerReady ? undefined : { level: "error" });
    await prep("docker", dockerReady ? "done" : "failed");

    // 1. Resolve the repo URL + provider auth (GitHub or GitLab), then clone/update.
    // Prefer the URL host as the source of truth (dual-provider app) and fall
    // back to the stored repoProvider column when there's no explicit URL.
    const columnProvider = (project.repoProvider || "github").toLowerCase();
    const repoUrl = project.repoUrl || (project.repoOwner && project.repoName
      ? `https://${columnProvider === "gitlab" ? "gitlab.com" : "github.com"}/${project.repoOwner}/${project.repoName}.git`
      : "");
    if (!repoUrl) return failed(projectId, userId, "This project has no connected repository to preview.");
    const provider = /gitlab\.com|\/gitlab\b/i.test(repoUrl) ? "gitlab" : /github\.com/i.test(repoUrl) ? "github" : columnProvider;

    let token = "";
    if (provider === "gitlab") {
      token = (await getValidGitlabToken(project.ownerId)) || "";
      if (!token) return failed(projectId, userId, "No GitLab token — reconnect GitLab in settings to preview this project.");
    } else {
      const [ghToken] = await db.select().from(githubTokens).where(eq(githubTokens.userId, project.ownerId)).limit(1);
      token = ghToken?.accessToken || "";
      if (!token) return failed(projectId, userId, "No GitHub token — connect GitHub to preview this project.");
    }
    // GitLab OAuth clones auth as oauth2:<token>@; GitHub as x-access-token:<token>@.
    const cred = provider === "gitlab" ? `oauth2:${token}` : `x-access-token:${token}`;
    const authUrl = repoUrl.replace(/^https:\/\//, `https://${cred}@`);
    const coBranch = branch ? `git checkout ${branch} 2>/dev/null || true` : "true";

    await prep("clone", "running");
    plog(projectId, userId, `Pulling repo from ${provider === "gitlab" ? "GitLab" : "GitHub"} (${repoUrl.replace(/^https:\/\//, "")})${branch ? ` @ ${branch}` : ""}…`);
    await setPreview(projectId, userId, { previewStatus: "detecting" }, "Fetching the code…");
    const clone = await sh(workspaceId, `
export PATH=/root/node/current/bin:/usr/local/bin:/usr/bin:/bin:$PATH
apk add --no-cache git ca-certificates >/dev/null 2>&1 || true
mkdir -p /data
if [ -d ${PROJECT_DIR}/.git ]; then
  cd ${PROJECT_DIR} && git remote set-url origin "${authUrl}" && git fetch origin 2>&1 && { ${coBranch}; git pull --ff-only >/dev/null 2>&1; echo CLONE_OK; }
else
  rm -rf ${PROJECT_DIR}; git clone "${authUrl}" ${PROJECT_DIR} 2>&1 | tail -3; if [ -d ${PROJECT_DIR}/.git ]; then cd ${PROJECT_DIR} && (${coBranch}) && echo CLONE_OK; fi
fi`, 240_000);
    if (!clone.output.includes("CLONE_OK")) {
      // Scrub any credential that leaked into git's error text before showing it.
      const safe = clone.output.replace(/\/\/[^@\s]+@/g, "//***@").slice(-500);
      plog(projectId, userId, "Could not fetch the repo", { level: "error", detail: safe });
      await prep("clone", "failed");
      return failed(projectId, userId, `Could not fetch the repo:\n${safe}`);
    }
    await prep("clone", "done");
    plog(projectId, userId, "Repo fetched ✓");

    // 2. Detect (or reuse) the setup manifest.
    await prep("plan", "running");
    const existing = await getEnv(projectId);
    let manifest: PreviewManifest | null = null;
    // Reuse a saved plan only if it matches the CURRENT schema (old shallow plans
    // lack databases/toolchain → re-analyze instead of crashing).
    if (!opts.rebuildManifest && existing?.setupManifest) {
      const parsed = manifestSchema.safeParse(JSON.parse(existing.setupManifest));
      if (parsed.success) {
        manifest = parsed.data;
        plog(projectId, userId, `Using saved plan (${manifest.stack || manifest.runtime}, port ${manifest.port}, ${manifest.databases.length} db)`);
      }
    }
    if (!manifest) {
      plog(projectId, userId, "Analyzing the codebase to build a setup plan…");
      manifest = await detectManifest(projectId);
      await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
      plog(projectId, userId, `Plan: ${manifest.stack || manifest.runtime}`, {
        detail: [
          manifest.startupProject && `run project: ${manifest.startupProject}`,
          `port: ${manifest.port}`,
          manifest.toolchain?.length && `toolchain: ${manifest.toolchain.join("; ")}`,
          `install: ${manifest.installCmd || "(none)"}`,
          manifest.buildCmd && `build: ${manifest.buildCmd}`,
          `databases: ${manifest.databases.length ? manifest.databases.map((d) => `${d.engine}→${d.connectionEnvVar}`).join(", ") : "none"}`,
          manifest.migrations?.length && `migrations: ${manifest.migrations.join("; ")}`,
          manifest.sqlScripts?.length && `sql scripts: ${manifest.sqlScripts.join(", ")}`,
          `run: ${manifest.runCmd}`,
        ].filter(Boolean).join("\n"),
      });
    }
    await prep("plan", "done");

    // 3. Provision the DBs the plan calls for, and inject each connection string
    // into the EXACT env var the app reads it from (per the plan).
    await prep("db", manifest.databases.length ? "running" : "done");
    const provisioned: Record<string, string> = {};
    const engineHandles: EngineHandle[] = [];
    if (manifest.databases.length) {
      await setPreview(projectId, userId, { previewStatus: "provisioning" }, `Provisioning ${manifest.databases.map((d) => d.engine).join(", ")}…`);
      for (const dbSpec of manifest.databases) {
        plog(projectId, userId, `Provisioning ${dbSpec.engine} → ${dbSpec.connectionEnvVar}…`);
        const h = await ensureEngine(projectId, dbSpec.engine);
        engineHandles.push(h);
        provisioned[dbSpec.connectionEnvVar] = formatConnection(dbSpec, h);
        plog(projectId, userId, `${dbSpec.engine} ready at 127.0.0.1:${h.port} (db "${h.dbName}") → ${dbSpec.connectionEnvVar} ✓`);
      }
      await prep("db", "done");
    }

    // 4. Write env: the plan's DB connection vars + PORT/HOST(/ASPNETCORE_URLS) +
    // stored project vars.
    await prep("env", "running");
    await writeEnvFile(workspaceId, projectId, manifest, provisioned);
    plog(projectId, userId, `Wrote .env (${Object.keys(provisioned).length} DB connection var(s) + run config)`);
    await prep("env", "done");

    // 5. Get the app running + VERIFIED via the CHECKPOINTED RUNBOOK. The plan is
    // an ordered command list; we run each with a checkpoint, so a restart resumes
    // from the first not-done step. FAST PATH: if setup already completed on a
    // prior run, just (re)start the app directly.
    const driver = await resolveDriverModel(userId);
    let up = false;

    const alreadyRun = existing?.setupComplete === 1 && !!existing?.runCommand;
    if (alreadyRun && !opts.rebuildManifest) {
      plog(projectId, userId, "Setup already complete — starting the app directly…");
      await setPreview(projectId, userId, { previewStatus: "starting" }, "Starting the app…");
      if (await checkServer(workspaceId, manifest.port, 2)) {
        up = true; plog(projectId, userId, "App is already running ✓");
      } else {
        await runDetachedPolled(projectId, userId, workspaceId, appStartCommand(manifest), 60_000);
        up = await checkServer(workspaceId, manifest.port, 20);
      }
    }

    if (!up) {
      await setPreview(projectId, userId, { previewStatus: "installing" }, "Setting up & running the app…");
      const resumeSteps: RunStep[] | null = existing?.setupSteps ? (JSON.parse(existing.setupSteps) as RunStep[]) : null;
      const result = await executeRunbook(projectId, userId, workspaceId, manifest, engineHandles, driver?.model, resumeSteps, prelude);
      up = result.up;
      // Mark setup complete + store the run command so the next click is a fast run.
      const setupDone = result.steps.filter((s) => s.phase !== "run").every((s) => s.status === "done" || s.optional);
      await db.update(projectEnvironments).set({
        setupComplete: up && setupDone ? 1 : 0,
        runCommand: manifest.runCmd,
        updatedAt: new Date(),
      }).where(eq(projectEnvironments.projectId, projectId));
    }

    // 6. Confirm the app is actually serving on its port (reality check).
    plog(projectId, userId, `Verifying the app responds on 127.0.0.1:${manifest.port}…`);
    if (!up) {
      const log = await sh(workspaceId, `tail -40 ${PROJECT_DIR}/preview.log 2>/dev/null`, 20_000);
      const detail = (log.output || "").trim() || "(no log output captured)";
      plog(projectId, userId, `The app did not respond on port ${manifest.port}`, { level: "error", detail });
      return failed(projectId, userId, `The app did not come up on port ${manifest.port}.\n\n${detail.slice(-1000)}`);
    }
    plog(projectId, userId, "App is responding ✓");

    // 7. Expose the app's OWN port publicly. The app is CONFIRMED up, so a
    // transient Mags "job not found" here must NOT throw away a working preview —
    // retry the exposure (the VM name just needs a moment to re-resolve).
    plog(projectId, userId, `Exposing port ${manifest.port} as a public URL…`);
    const alias = existing?.stableAlias || randomAlias();
    let previewUrl = "";
    let exposeErr = "";
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await enableHttpAccess(workspaceId, manifest.port);
        try { previewUrl = await setStableUrl(alias, workspaceId); }
        catch { previewUrl = await enableHttpAccess(workspaceId, manifest.port); }
        if (previewUrl) break;
      } catch (e) {
        exposeErr = (e as Error).message ?? String(e);
        plog(projectId, userId, `Exposure attempt ${attempt}/5 failed (${exposeErr.slice(0, 60)}); retrying…`);
        await sleep(5000);
      }
    }
    if (!previewUrl) {
      return failed(projectId, userId, `The app is running on port ${manifest.port}, but exposing the public URL failed: ${exposeErr}. Try again.`);
    }

    await db.update(projectEnvironments).set({ stableAlias: alias, updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
    plog(projectId, userId, `Preview live: ${previewUrl}`);
    await setPreview(projectId, userId, { previewStatus: "running", appUrl: previewUrl, appPort: manifest.port, previewError: null }, "Preview is live");
    return { previewUrl };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg === "__CANCELLED__" || isCancelled(projectId)) {
      cancelledProjects.delete(projectId);
      plog(projectId, userId, "Setup cancelled by user");
      await setPreview(projectId, userId, { previewStatus: "stopped", appUrl: null, previewError: null }, "Preview stopped");
      return { error: "cancelled" };
    }
    plog(projectId, userId, "Setup failed", { level: "error", detail: msg });
    return failed(projectId, userId, msg);
  } finally {
    cancelledProjects.delete(projectId);
  }
}

async function failed(projectId: string, userId: string, error: string): Promise<{ error: string }> {
  console.error(`[dev-preview] ${projectId}: ${error}`);
  await setPreview(projectId, userId, { previewStatus: "error", previewError: error.slice(0, 4000) }, "Preview failed").catch(() => {});
  return { error };
}

/** Current preview state for the Preview tab. */
export async function getPreviewState(projectId: string) {
  const row = await getEnv(projectId);
  if (!row) return { previewStatus: "idle" as PreviewStatus, previewUrl: null, manifest: null, error: null, branch: null, log: "", steps: [], setupComplete: false };
  return {
    previewStatus: (row.previewStatus as PreviewStatus) ?? "idle",
    previewUrl: row.appUrl ?? null,
    manifest: row.setupManifest ? JSON.parse(row.setupManifest) : null,
    error: row.previewError ?? null,
    branch: row.previewBranch ?? null,
    log: logBuffers.get(projectId) ?? row.setupLog ?? "",
    steps: row.setupSteps ? (JSON.parse(row.setupSteps) as RunStep[]) : [],
    setupComplete: row.setupComplete === 1,
  };
}

/**
 * Capture a screenshot of the LIVE preview (via a headless browser hitting the
 * public URL), store it in S3, and post it into the chat conversation.
 */
export async function capturePreviewScreenshot(
  projectId: string, userId: string, publicProjectId: string, conversationId: string | null,
): Promise<{ url: string } | { error: string }> {
  const row = await getEnv(projectId);
  const previewUrl = row?.appUrl;
  if (!previewUrl || row?.previewStatus !== "running") return { error: "The preview isn't running — start it first." };
  if (!isS3Enabled) return { error: "File storage (S3) isn't configured." };

  // 1. Headless browser → screenshot (Node subprocess; Playwright hangs on Bun).
  let session: { requestId: string; wsEndpoint: string } | null = null;
  let dataB64 = "";
  try {
    session = await startBrowserSession({ timeout: 120_000 });
    dataB64 = await new Promise<string>((resolve, reject) => {
      const child = spawn("node", [`${process.cwd()}/scripts/screenshot-worker.mjs`], { stdio: ["pipe", "pipe", "inherit"] });
      let buf = ""; let err: string | null = null;
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString(); let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          try { const m = JSON.parse(line); if (m.type === "shot") resolve(m.dataB64); else if (m.type === "error") err = m.message; } catch { /* ignore */ }
        }
      });
      child.on("error", reject);
      child.on("exit", () => { if (err) reject(new Error(err)); else if (!buf) reject(new Error("no screenshot produced")); });
      child.stdin.write(JSON.stringify({ wsEndpoint: session!.wsEndpoint, url: previewUrl, width: 1440, height: 900 }));
      child.stdin.end();
    });
  } catch (e) {
    if (session) await stopWorkspace(session.requestId).catch(() => {});
    return { error: `Could not capture the screenshot: ${(e as Error).message}` };
  }
  await stopWorkspace(session.requestId).catch(() => {});

  // 2. Upload to S3 + get a durable (7-day) URL.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = buildS3Key(publicProjectId, "preview-screenshots", `preview-${stamp}.png`);
  await uploadBinary(key, Buffer.from(dataB64, "base64"), "image/png");
  const url = await getPresignedGetUrl(key, 7 * 24 * 3600);

  // 3. Post it into the chat conversation as a markdown image.
  if (conversationId) {
    const when = new Date().toISOString().slice(0, 16).replace("T", " ");
    const content = `📸 **Preview screenshot** — captured ${when}\n\n[![Preview screenshot](${url})](${url})`;
    await db.insert(messages).values({ conversationId, role: "assistant", content });
    // Live-render in the open chat (shape the chat expects: sender + message).
    broadcastToUser(userId, { type: "message", sender: "assistant", message: content, conversation_id: conversationId });
  }
  return { url };
}

/**
 * The branches that can be previewed: the DEFAULT checkout (/data/project) plus
 * every ticket that still has a live git worktree in this sandbox (kept until the
 * ticket is approved → Done). Powers the preview branch selector.
 */
export async function getPreviewBranches(projectId: string): Promise<Array<{ id: string; label: string; ticketId: string | null; branch: string }>> {
  const out: Array<{ id: string; label: string; ticketId: string | null; branch: string }> = [
    { id: "default", label: "Default branch", ticketId: null, branch: "(default)" },
  ];
  // Ticket worktrees are recorded as sandbox rows (workspaceType "ticket-worktree")
  // pointing at this project's preview workspace. Join tickets for a readable label.
  const rows = await db
    .select({ ticketId: sandboxes.ticketId, name: projectTickets.name, key: projectTickets.ticketKey })
    .from(sandboxes)
    .leftJoin(projectTickets, eq(sandboxes.ticketId, projectTickets.id))
    .where(and(eq(sandboxes.projectId, projectId), eq(sandboxes.workspaceType, "ticket-worktree")));
  for (const r of rows) {
    if (!r.ticketId) continue;
    const label = `${r.key ? r.key + " — " : ""}${r.name ?? "ticket"}`.slice(0, 60);
    out.push({ id: r.ticketId, label, ticketId: r.ticketId, branch: `feature/ticket-${r.ticketId}` });
  }
  return out;
}

/**
 * Restart the app SERVER (kill + re-run the stored run command). Fast — does NOT
 * reinstall or rebuild. Falls back to a full setup if we have no run command.
 * If `opts.ticketId` is set, runs the app from THAT ticket's git worktree (its
 * feature branch) instead of the default /data/project checkout — so you can
 * preview individual tickets. The DB creds/.env are shared (same sandbox).
 */
export async function restartPreview(projectId: string, opts: SetupOptions): Promise<{ previewUrl: string } | { error: string }> {
  const { userId, ticketId } = opts;
  const row = await getEnv(projectId);
  if (!row?.setupManifest || !row?.runCommand || row?.setupComplete !== 1) {
    // Nothing to restart yet → run the full setup (default branch only).
    if (ticketId) return { error: "Set up the preview first, then you can run a ticket's branch." };
    return setupPreview(projectId, opts);
  }
  const manifest = JSON.parse(row.setupManifest) as PreviewManifest;
  resetLog(projectId);
  await loadPublicId(projectId); // for WS routing

  // A restart/branch run has its OWN 2-step checklist (locate → start) so the Steps
  // view reflects THIS run, not the stale full-setup prep list.
  const branchLabel0 = ticketId ? `feature/ticket-${ticketId}` : "(default)";
  const steps: RunStep[] = [
    { id: "locate", phase: "prepare", label: ticketId ? `Locate the ticket worktree (${branchLabel0})` : "Use the default checkout", command: "", status: "pending" },
    { id: "run", phase: "run", label: `Start the app — ${manifest.runCmd}`, command: "", status: "pending" },
  ];
  const setStep = async (id: string, s: RunStep["status"]) => {
    const st = steps.find((x) => x.id === id); if (st) st.status = s;
    await persistSteps(projectId, userId, steps);
  };

  try {
    const { recreated } = await ensureProjectSandbox(projectId);
    const workspaceId = await envWorkspaceId(projectId);

    // The VM had stopped and was respawned — but the workspace is persistent, so its
    // /data (repo clone, toolchain, DB volumes, ticket worktrees) is REATTACHED, not
    // lost. We only need to bring Docker back so the DB containers (restart
    // unless-stopped) come up with their persisted data before we run the app.
    if (recreated) {
      plog(projectId, userId, "Sandbox VM was respawned (its /data persists) — restarting Docker + databases…");
      await ensureDocker(projectId).catch(() => {});
    }

    // Pick the run directory: a ticket's worktree, or the default checkout.
    let runDir = PROJECT_DIR;
    let branchLabel = "(default)";
    await setStep("locate", "running");
    if (ticketId) {
      runDir = ticketWorktreeDir(ticketId);
      branchLabel = `feature/ticket-${ticketId}`;
      // The worktree is removed when the ticket is approved (Done). If it's gone,
      // tell the user to rebuild rather than silently running the default branch.
      const chk = await sh(workspaceId, `test -d ${runDir} && test -e ${runDir}/.git && echo OK || echo MISSING`, 20_000);
      if (!chk.output.includes("OK")) {
        await setStep("locate", "failed");
        return failed(projectId, userId, `That ticket's build workspace no longer exists (it's removed once a ticket is approved). Rebuild the ticket to preview its branch again.`);
      }
      plog(projectId, userId, `Running ticket branch ${branchLabel} from its worktree…`);
      // Share the preview's DB creds/run config: copy the default .env into the worktree.
      await sh(workspaceId, `cp ${PROJECT_DIR}/.env ${runDir}/.env 2>/dev/null || true; echo env`, 20_000);
    } else {
      plog(projectId, userId, "Restarting the app server (default branch)…");
    }
    await setStep("locate", "done");

    await setStep("run", "running");
    const startingMsg = ticketId ? `Starting the preview on ${branchLabel}…` : "Restarting the app…";
    await setPreview(projectId, userId, { previewStatus: "starting", previewError: null, previewBranch: branchLabel }, startingMsg);
    const compiled = !!manifest.buildCmd || /dotnet|asp|java|go|rust|maven|gradle/i.test(`${manifest.runtime} ${manifest.framework}`);
    // Try a quick plain start first (fast for interpreted apps or an already-built
    // tree). A worktree isn't pre-built, so a COMPILED app builds on first run and
    // that output can be silent (a hung NuGet restore shows nothing) — so we only
    // wait briefly here, then hand to the AI DRIVER, which runs restore→build→run as
    // EXPLICIT, streamed steps you can watch, reusing the warm toolchain/cache.
    plog(projectId, userId, `Launching the app from ${branchLabel}${compiled ? " (a compiled app builds on first run — you'll see the driver's build steps if the quick start doesn't take)" : ""}…`);
    const waitMs = ticketId ? 90_000 : 60_000;
    await runDetachedPolled(projectId, userId, workspaceId, appStartCommand(manifest, runDir), 30_000);
    let up = await waitForAppUp(projectId, userId, workspaceId, manifest.port, `${runDir}/preview.log`, waitMs);

    // Didn't come up quickly → hand off to the SAME AI driver that got main working,
    // pointed at this worktree. It reuses the warm toolchain + NuGet cache + persisted
    // env fixes, runs restore/build/run as streamed steps, fixes anything
    // branch-specific, and persists new fixes (setEnv) so it's not redone.
    if (!up) {
      const driver = await resolveDriverModel(userId);
      if (driver) {
        plog(projectId, userId, "Handing to the AI driver — it will build + start the branch step by step (reusing the main-branch toolchain/cache)…");
        await setPreview(projectId, userId, { previewStatus: "starting", previewBranch: branchLabel }, `Building & starting ${branchLabel} (AI driver)…`);
        up = await driveSandbox(projectId, userId, workspaceId, manifest, [], driver.model, runDir);
      }
    }
    if (!up) {
      await setStep("run", "failed");
      const tail = await sh(workspaceId, `tail -40 ${runDir}/preview.log 2>/dev/null`, 20_000).catch(() => ({ output: "" }));
      plog(projectId, userId, `The app did not come up on port ${manifest.port}`, { level: "error", detail: (tail.output || "(no output — the app may have failed to build)").slice(-1500) });
      return failed(projectId, userId, `The app did not come back up on port ${manifest.port}.\n\n${(tail.output || "").slice(-800)}`);
    }
    await setStep("run", "done");
    plog(projectId, userId, `App running ✓ (${branchLabel})`);
    // If the app serves but the homepage 500s, it's LIVE but has a runtime/data
    // error (e.g. an incomplete DB schema) — surface it; the user can still
    // navigate to pages that work (like the one this ticket changed).
    const homeCode = await httpStatus(workspaceId, manifest.port).catch(() => 0);
    if (homeCode >= 500) {
      const tail = await sh(workspaceId, `tail -15 ${runDir}/preview.log 2>/dev/null`, 15_000).catch(() => ({ output: "" }));
      plog(projectId, userId, `⚠ The app is LIVE but its homepage returns HTTP ${homeCode} — a runtime/data error in the app (not a build/env problem). Other pages may load fine. Recent error:`, { level: "error", detail: (tail.output || "").slice(-900) });
    }
    // Re-expose (idempotent) and mark running.
    await enableHttpAccess(workspaceId, manifest.port).catch(() => {});
    const alias = row.stableAlias || randomAlias();
    let previewUrl = row.appUrl || "";
    try { previewUrl = await setStableUrl(alias, workspaceId); } catch { /* keep existing */ }
    await setPreview(projectId, userId, { previewStatus: "running", appUrl: previewUrl, appPort: manifest.port, previewError: null, previewBranch: branchLabel }, "Preview is live");
    return { previewUrl };
  } catch (err) {
    return failed(projectId, userId, (err as Error).message ?? String(err));
  }
}

/** Stop the running app (leaves the sandbox + DBs up). */
export async function stopPreview(projectId: string, userId: string): Promise<void> {
  await loadPublicId(projectId); // for WS routing
  // Signal any in-flight setup to abort at its next checkpoint (Stop during setup).
  cancelPreviewSetup(projectId);
  plog(projectId, userId, "Stop requested — cancelling…");
  await setPreview(projectId, userId, { previewStatus: "stopped", appUrl: null }, "Stopping…");
  const workspaceId = await envWorkspaceId(projectId).catch(() => null);
  if (!workspaceId) return; // no sandbox provisioned → nothing running to kill
  const row = await getEnv(projectId);
  const port = row?.appPort
    ?? (row?.setupManifest ? (JSON.parse(row.setupManifest) as PreviewManifest).port : undefined)
    ?? DEFAULT_PORT;
  // Kill the app port + any lingering build/install processes started for this run.
  await sh(workspaceId, `fuser -k ${port}/tcp 2>/dev/null; pkill -f ':${port}' 2>/dev/null; pkill -f 'dotnet' 2>/dev/null; pkill -f 'npm ' 2>/dev/null; echo stopped`, 30_000).catch(() => {});
  await setPreview(projectId, userId, { previewStatus: "stopped", appUrl: null }, "Preview stopped");
}
