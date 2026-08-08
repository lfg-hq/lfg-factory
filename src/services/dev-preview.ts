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
import { and, eq, isNotNull, or } from "drizzle-orm";
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
import { ensureProjectSandbox, ensureEngine, ensureDocker, envWorkspaceId, checkEngineHealth, type EngineHandle } from "./project-sandbox.ts";
import { probeAppProfile, saveAppProfile, loadAppProfile, deriveManifestFromProfile, missingSecrets, secretsNoticeMessage, applyProfileCorrection, recordProfileLearning, recordDirective, recordConfigPatch, buildConfigPatchScript, profileNotes, resolveUserModel, type AppProfile } from "./app-profile.ts";
import { isS3Enabled, buildS3Key, uploadBinary, getPresignedGetUrl } from "./s3.ts";
import { messages } from "../db/schema/chat.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { spawn } from "node:child_process";

const PROJECT_DIR = "/data/project";
const DEFAULT_PORT = 8080; // fallback ONLY — the real port is decided by the detected manifest per stack

// Machine-specific env vars that must NEVER be persisted or injected — persisting a
// value like PATH="/data/.dotnet:…" (as a driver once did) and re-writing it into
// .env / another VM's shells clobbers the real PATH → `ls`/`node`/`apk` "not found".
// The toolchain PATH is set deterministically by envPrefix instead.
const UNSAFE_ENV_KEYS = new Set(["PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "TERM", "HOSTNAME", "SHLVL", "_", "LD_LIBRARY_PATH", "LD_PRELOAD"]);

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

/**
 * Distil an agent action journal from the setup log: the COMMANDS the setup/
 * preview driver ran (+ their exit codes) and the decisions it made (plan
 * updates, learnings, env persists, how it finished). Fed into the @preview
 * prompt so a follow-up chat can CONTINUE from where the last run left off
 * instead of re-investigating from scratch. Keeps only the last `maxLines`
 * signal lines, so it stays compact even for a long, verbose run. */
function summarizeAgentActions(log: string, maxLines = 60): string {
  if (!log) return "";
  const keep = log.split("\n").filter((l) =>
    /\]\s+\$\s/.test(l) ||                                                     // a command:  [HH:MM:SS] $ …
    /→\s*exit\s/.test(l) ||                                                    // its exit code
    /Updated plan:|Learned:|Persisted env|Driver finished:|Handing off|did not respond|did not come up|App is responding|Preview live/.test(l)
  );
  return keep.slice(-maxLines).join("\n");
}

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
export async function detectManifest(projectId: string, userId: string): Promise<PreviewManifest> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("project not found");
  const workspaceId = await envWorkspaceId(projectId);
  const fingerprint = await gatherFingerprint(workspaceId);

  const model = await resolveUserModel(userId);
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
    // The app runs on plain HTTP but is served over the HTTPS app.lfg.run proxy.
    // Enabling ForwardedHeaders makes ASP.NET Core honor the proxy's
    // X-Forwarded-Proto/Host, so it generates https:// (not http://) absolute URLs
    // for assets/links/redirects — otherwise the browser blocks them as mixed
    // content (broken images) and redirects bounce. No app code change needed.
    vars.ASPNETCORE_FORWARDEDHEADERS_ENABLED = "true";
  }
  Object.assign(vars, provisioned);
  for (const v of stored) {
    if (!v.hasValue) continue;
    if (UNSAFE_ENV_KEYS.has(v.key)) continue; // never let a persisted PATH etc. clobber envPrefix's PATH
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
 * Load the homepage and verify its assets (images/CSS/JS) actually resolve —
 * catches the "broken images / unstyled page" class of problem. Reports assets
 * that 404 (missing files) and absolute http:// asset URLs (mixed-content — a
 * browser blocks these on the HTTPS preview even though curl fetches them).
 */
async function checkAssets(workspaceId: string, port: number): Promise<{ checked: number; missing: string[]; mixed: string[] }> {
  const script = `
BASE="http://127.0.0.1:${port}"
HTML=$(curl -s --max-time 10 "$BASE/" 2>/dev/null)
URLS=$(printf '%s' "$HTML" | grep -oE '(src|href)="[^"]+\\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)([?][^"]*)?"' | sed -E 's/^(src|href)="//; s/"$//' | sort -u | head -60)
CHECKED=0
for u in $URLS; do
  CHECKED=$((CHECKED+1))
  case "$u" in
    http://*) echo "MIXED $u"; continue ;;
    https://*) continue ;;
    //*) TARGET="http:$u" ;;
    /*) TARGET="$BASE$u" ;;
    *) TARGET="$BASE/$u" ;;
  esac
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "$TARGET" 2>/dev/null || echo 000)
  [ "$CODE" != "200" ] && [ "$CODE" != "304" ] && echo "MISS $CODE $u"
done
echo "CHECKED:$CHECKED"
`;
  const { output } = await sh(workspaceId, script, 90_000).catch(() => ({ output: "" }));
  const checked = parseInt((output.match(/CHECKED:(\d+)/) || [])[1] || "0", 10);
  const missing = output.split("\n").filter((l) => l.startsWith("MISS ")).map((l) => l.slice(5).trim()).slice(0, 20);
  const mixed = output.split("\n").filter((l) => l.startsWith("MIXED ")).map((l) => l.slice(6).trim()).slice(0, 20);
  return { checked, missing, mixed };
}

/**
 * Post-run verification: (1) URL responds, (2) images/CSS/JS load, (3) DB
 * connections intact. Builds a chat-ready launch summary and an overall verdict.
 * Assets are skipped when the page is a 5xx (a code/data error, not an asset issue).
 */
async function verifyPreview(projectId: string, userId: string, workspaceId: string, manifest: PreviewManifest, branchLabel: string): Promise<{ summary: string; overall: "ok" | "degraded" | "error"; broken: string[] }> {
  const port = manifest.port;
  plog(projectId, userId, "Verifying the preview (URL, assets, databases)…");
  let brokenAssets: string[] = [];

  // 1. URL
  const code = await httpStatus(workspaceId, port).catch(() => 0);
  const urlDown = code === 0;
  const urlErr = code >= 500;             // serving, but a code/data error
  const urlOk = code >= 200 && code < 500;
  const urlLine = urlDown ? `❌ **URL** (:${port}) — not responding (down)`
    : urlErr ? `⚠️ **URL** (:${port}) — live but returns HTTP ${code} (app/data error)`
    : `✅ **URL** (:${port}) — responding (HTTP ${code})`;

  // 2. Assets — only meaningful when the page renders (not a 5xx).
  let assetLine = "⏭️ **Assets** — skipped (page returned a server error)";
  let assetsBad = false;
  if (urlOk) {
    const a = await checkAssets(workspaceId, port).catch(() => ({ checked: 0, missing: [], mixed: [] }));
    brokenAssets = a.missing;
    if (!a.checked) assetLine = "➖ **Assets** — none found on the homepage";
    else if (!a.missing.length && !a.mixed.length) assetLine = `✅ **Assets** — ${a.checked} images/CSS/JS all load`;
    else { assetsBad = true; assetLine = `⚠️ **Assets** — ${a.mixed.length} mixed-content + ${a.missing.length} missing of ${a.checked}${a.mixed.length ? " (mixed-content = the HTTPS proxy needs ForwardedHeaders/base-url)" : ""}`; }
  }

  // 3. Databases
  const dbs = await checkEngineHealth(projectId).catch(() => []);
  let dbLine: string; let dbBad = false;
  if (!dbs.length) dbLine = "➖ **Databases** — none provisioned";
  else {
    const okDbs = dbs.filter((d) => d.ok).map((d) => d.engine);
    const badDbs = dbs.filter((d) => !d.ok);
    dbBad = badDbs.length > 0;
    dbLine = dbBad
      ? `❌ **Databases** — ${badDbs.map((d) => `${d.engine}: ${d.detail}`).join("; ")}${okDbs.length ? ` (ok: ${okDbs.join(", ")})` : ""}`
      : `✅ **Databases** — ${okDbs.join(", ")} reachable`;
  }

  const overall: "ok" | "degraded" | "error" = urlDown ? "error" : (urlErr || assetsBad || dbBad) ? "degraded" : "ok";
  const verdict = overall === "ok" ? "🟢 **All systems OK**"
    : overall === "error" ? "🔴 **Failed — the app is not responding**"
    : `🟡 **Degraded** — ${[urlErr ? "URL returns a server error" : "", assetsBad ? "some assets broken" : "", dbBad ? "a database is unreachable" : ""].filter(Boolean).join(", ")}`;

  const summary = `🚀 **Preview launch summary** — branch: \`${branchLabel === "(default)" ? "main" : branchLabel}\`\n\n${urlLine}\n${assetLine}\n${dbLine}\n\n${verdict}`;
  plog(projectId, userId, `Verification: ${overall}`, overall === "ok" ? undefined : { level: "error", detail: summary.replace(/\*\*/g, "") });
  return { summary, overall, broken: brokenAssets };
}

/**
 * Self-heal broken assets WITHOUT hardcoding a fix. If the preview audit found
 * 404 assets AND the project has mandatory directives (i.e. the user opted into
 * enforcement — e.g. "assets are case-sensitive on .NET"), hand the broken list
 * to the preview AGENT and let IT investigate the real filenames and fix the
 * references (or rename files), rebuild, and verify. Runs at most ONCE per preview
 * so it can't loop. Returns the re-verified summary if it changed anything.
 */
async function healBrokenAssets(
  projectId: string, userId: string, conversationId: string | null | undefined,
  workspaceId: string, manifest: PreviewManifest, branchLabel: string, broken: string[],
): Promise<{ summary: string } | null> {
  if (!broken.length) return null;
  const directives = (await loadAppProfile(projectId).catch(() => null))?.profile.directives ?? [];
  if (!directives.length) return null; // enforcement is opt-in via directives

  plog(projectId, userId, `Assets broken (${broken.length}) — handing to the agent to fix per your directives…`);
  const list = broken.slice(0, 15).map((u) => `- ${u}`).join("\n");
  const instruction = `The running app has BROKEN assets — these URLs return 404 on the homepage:\n${list}\n\n` +
    `Your MANDATORY DIRECTIVES (which you MUST satisfy) include rules about assets. The most common cause is a case mismatch between the reference and the real filename (this stack is case-sensitive). For EACH broken asset: find the actual file on disk (search case-insensitively under the web root), then fix the REFERENCE in the source (.cshtml/.css/.js/layout) to match the real filename EXACTLY — or rename the file if that's clearly correct. Do not touch unrelated code. ` +
    `If a rebuild is needed for the change to take effect, rebuild and restart the app. Then re-fetch each formerly-broken URL and confirm it now returns 200. Report exactly which references you fixed.`;

  try {
    const res = await runPreviewChat({ projectId, publicProjectId: pub(projectId), userId, conversationId: conversationId ?? null, instruction, noCommit: true });
    plog(projectId, userId, `Asset self-heal: ${res.status}`, res.reply ? { detail: res.reply.slice(0, 800) } : undefined);
    // Re-verify so the summary reflects reality after the fix.
    const again = await verifyPreview(projectId, userId, workspaceId, manifest, branchLabel).catch(() => null);
    if (again) return { summary: again.summary };
  } catch (e) {
    plog(projectId, userId, `Asset self-heal failed: ${(e as Error).message}`, { level: "error" });
  }
  return null;
}

/** Post the launch summary into the main chat (persist if a conversation is known). */
async function publishSummary(userId: string, conversationId: string | null | undefined, content: string): Promise<void> {
  if (conversationId) await db.insert(messages).values({ conversationId, role: "assistant", content }).catch(() => {});
  broadcastToUser(userId, { type: "message", sender: "assistant", message: content, conversation_id: conversationId ?? undefined });
}

/** Run the asset check and log a clear warning listing any broken/mixed-content assets. */
async function warnBrokenAssets(projectId: string, userId: string, workspaceId: string, port: number): Promise<void> {
  const { checked, missing, mixed } = await checkAssets(workspaceId, port);
  if (!checked) return;
  if (!missing.length && !mixed.length) {
    plog(projectId, userId, `Asset check ✓ — ${checked} images/CSS/JS all load`);
    return;
  }
  const detail = [
    mixed.length ? `MIXED CONTENT (absolute http:// blocked on the HTTPS preview — needs ForwardedHeaders/base-url fix):\n${mixed.map((u) => "  " + u).join("\n")}` : "",
    missing.length ? `MISSING (404 — file not in the repo/build):\n${missing.map((u) => "  " + u).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  plog(projectId, userId, `⚠ Asset check: ${mixed.length} mixed-content + ${missing.length} missing of ${checked} — images/styles may be broken`, { level: "error", detail });
}

/**
 * Wait for the app to answer on `port`, STREAMING new lines from its log the whole
 * time so the user sees the build/run progress (and any failure) instead of a blank
 * screen. Returns true as soon as the port serves, false at the deadline.
 */
// The app has explicitly announced it's serving. Kestrel (.NET), most Node
// frameworks, uvicorn, etc. print one of these once the socket is bound — a far
// more reliable "up" signal than a single curl that can race a slow cold-start.
const LISTENING_BANNER = /Now listening on|Application started|Started .* in \d|Listening on|listening on port|running on (?:http|port)|server started|started server on|Local:\s+http/i;

async function waitForAppUp(projectId: string, userId: string, workspaceId: string, port: number, logFile: string, maxMs: number): Promise<boolean> {
  const start = Date.now();
  const deadline = start + maxMs;
  let off = 0;
  let lastMsgAt = start;
  let sawBanner = false;
  while (Date.now() < deadline) {
    throwIfCancelled(projectId);
    const r = await sh(workspaceId, `tail -c +${off + 1} ${logFile} 2>/dev/null`, 15_000).catch(() => ({ output: "" }));
    const out = r.output || "";
    if (out.trim()) {
      off += Buffer.byteLength(out, "utf8");
      plog(projectId, userId, out.trim().split("\n").slice(-1)[0]!.slice(0, 200), { detail: out.trim().slice(-1200) });
      lastMsgAt = Date.now();
      if (LISTENING_BANNER.test(out)) sawBanner = true;
    } else if (Date.now() - lastMsgAt > 12_000) {
      // Heartbeat so a silent build (e.g. a hung restore that prints nothing) still
      // shows liveness + elapsed time instead of a frozen spinner.
      plog(projectId, userId, `…waiting for the app on port ${port} (${Math.round((Date.now() - start) / 1000)}s, no output yet)`);
      lastMsgAt = Date.now();
    }
    // If the app SAID it's listening, give the port a couple more tries — a slow
    // cold-start (dotnet JIT / EF model build) can bind a few seconds after the
    // banner. This kills the false-negative "did not come up" on a live app.
    if (await checkServer(workspaceId, port, sawBanner ? 3 : 1)) return true;
    await sleep(6000);
  }
  // Deadline hit. Last-chance rescue: if the log shows the app announced it's
  // listening, trust one final generous port check before declaring failure.
  const tailR = await sh(workspaceId, `tail -c 4000 ${logFile} 2>/dev/null`, 15_000).catch(() => ({ output: "" }));
  if (sawBanner || LISTENING_BANNER.test(tailR.output || "")) {
    plog(projectId, userId, `App logged it's listening on port ${port} but the readiness window elapsed — doing a final check…`);
    if (await checkServer(workspaceId, port, 5)) return true;
  }
  return false;
}

/**
 * The port(s) the app ACTUALLY bound, parsed from its own startup banner in
 * preview.log — e.g. Kestrel's `Now listening on: http://0.0.0.0:5123` or a Node
 * framework's `Local: http://localhost:3000`. Used to diagnose (and self-heal)
 * the "app is running but the expected port is dead" case: a .NET app whose
 * appsettings `Kestrel:Endpoints`/`applicationUrl` overrides ASPNETCORE_URLS and
 * binds a different port than we told it to. Returns distinct ports in log order.
 */
async function detectBoundPorts(workspaceId: string, logFile: string): Promise<number[]> {
  const r = await sh(workspaceId, `grep -aoiE '(now listening on|listening on|local:|running on)[^0-9]*https?://[^ ]*:[0-9]+' ${logFile} 2>/dev/null | tail -20`, 15_000).catch(() => ({ output: "" }));
  const ports: number[] = [];
  for (const m of (r.output || "").matchAll(/:(\d{2,5})(?:\D|$)/g)) {
    const p = parseInt(m[1]!, 10);
    if (p > 0 && p < 65536 && !ports.includes(p)) ports.push(p);
  }
  return ports;
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
  // Read the file stripping a leading UTF-8 BOM (EF BB BF) — many .NET-shipped
  // .sql files have one, and it makes sqlcmd/psql/mysql fail on the FIRST
  // statement ("Incorrect syntax near '...'"). od/head/tail are busybox-available.
  const read = `{ if [ "$(head -c3 "${f}" | od -An -tx1 | tr -d ' \\n')" = efbbbf ]; then tail -c +4 "${f}"; else cat "${f}"; fi; }`;
  // SKIP a full-database RESTORE from a .bak file — CoHire-style repos ship a
  // "db Restore.sql" that does `RESTORE DATABASE … FROM DISK='D:\…\x.bak'`. That
  // backup lives on the original dev machine, never in the repo/sandbox, so it can
  // ONLY fail (and it switches context to master, disrupting the real DB). The
  // schema is built from the migrations + the other scripts instead.
  const skipRestore = `if grep -qiE 'RESTORE[[:space:]]+DATABASE' "${f}" && grep -qiE 'FROM[[:space:]]+DISK' "${f}"; then echo "SKIPPED — full-DB RESTORE from a .bak not present in the sandbox; schema comes from migrations + the other scripts"; exit 0; fi; `;
  if (ms) return `${skipRestore}${read} | docker exec -i mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -S localhost -U ${ms.username} -P "${ms.password}" -C -d ${ms.dbName} -b || /opt/mssql-tools/bin/sqlcmd -S localhost -U ${ms.username} -P "${ms.password}" -d ${ms.dbName} -b'`;
  if (pg) return `${read} | docker exec -i -e PGPASSWORD='${pg.password}' postgres psql -U ${pg.username} -d ${pg.dbName} -v ON_ERROR_STOP=0`;
  if (my) return `${read} | docker exec -i mysql mysql -u${my.username} -p'${my.password}' ${my.dbName}`;
  return `echo "no SQL engine provisioned to apply ${file}"`;
}

/** Rewrite absolute PROJECT_DIR (/data/project) references in a RECORDED command to
 *  the actual run dir, so a command the driver recorded on main (which may contain
 *  hardcoded `/data/project/...` paths, e.g. a `mv .../wwwroot/CohireFiles ...`
 *  NETSDK1022 workaround) operates on the FEATURE-BRANCH worktree — not on main. */
function localizeCmd(cmd: string, dir: string): string {
  return dir === PROJECT_DIR ? cmd : (cmd || "").split(PROJECT_DIR).join(dir);
}

/** The detached app-start command (self-contained: cd + source .env + run). */
function appStartCommand(manifest: PreviewManifest, dir: string = PROJECT_DIR): string {
  const port = manifest.port;
  const runCmd = localizeCmd(manifest.runCmd, dir).replace(/'/g, `'\\''`);
  // NOT `exec ${runCmd}`: recorded run commands often carry leading env-var
  // assignments (e.g. `ASPNETCORE_URLS=… ASPNETCORE_ENVIRONMENT=Development dotnet
  // run …`). `exec VAR=value cmd` makes exec treat `VAR=value` as the PROGRAM name
  // → "exec: not found" and the app never starts. Running it as a plain command
  // lets the shell apply the assignments correctly; setsid already detaches it.
  return `fuser -k ${port}/tcp 2>/dev/null; pkill -f ':${port}' 2>/dev/null; sleep 1; ` +
    `setsid sh -c 'cd ${dir}; set -a; . ./.env 2>/dev/null; set +a; ${runCmd}' </dev/null > ${dir}/preview.log 2>&1 & echo STARTED`;
}

/**
 * Deterministic RULE (not a fixed find/replace): rewrite EVERY SQL Server
 * connection string in EVERY appsettings*.json under `dir` (all modules — Web,
 * Admin, …) that points at a NON-local host (a dev machine like SHABEER-PC-2, a
 * prod server) to the provisioned local MSSQL — keeping each connection's own
 * database name. Idempotent (skips ones already on 127.0.0.1). This makes the
 * "app has DB creds hardcoded in appsettings pointing at some dev's box" problem
 * a non-issue on the FIRST run, for every project — no note or patch needed.
 * Returns "" if there's no mssql engine. Needs python3 (on the pi rootfs).
 */
function buildAppsettingsRewriteScript(engines: EngineHandle[], dir: string): string {
  const ms = engines.find((e) => e.engine === "mssql");
  if (!ms) return "";
  const conf = Buffer.from(JSON.stringify({ host: ms.host, port: ms.port, user: ms.username, pw: ms.password })).toString("base64");
  return `echo ${conf} | base64 -d > /tmp/_msconf.json 2>/dev/null && python3 - "${dir}" <<'PYEOF' 2>&1 || true
import json, os, re, sys
base = sys.argv[1]
try:
    c = json.load(open("/tmp/_msconf.json"))
except Exception:
    sys.exit(0)
host, port, user, pw = c["host"], c["port"], c["user"], c["pw"]
# A SQL Server connection string value: has (Data Source|Server)= AND (Initial Catalog|Database)=.
rx = re.compile(r'"([^"\\n]*(?:Data Source|Server)\\s*=[^"\\n]*(?:Initial Catalog|Database)\\s*=[^"\\n]*)"')
def dbname(s):
    m = re.search(r'(?:Initial Catalog|Database)\\s*=\\s*([^;"]+)', s, re.I)
    return (m.group(1).strip() if m else "app")
def islocal(s):
    return bool(re.search(r'(?:Data Source|Server)\\s*=\\s*(?:127\\.0\\.0\\.1|localhost)\\b', s, re.I))
def newconn(s):
    return "Server=%s,%s;Database=%s;User Id=%s;Password=%s;TrustServerCertificate=True;MultipleActiveResultSets=True;" % (host, port, dbname(s), user, pw)
count = 0
for root, dirs, files in os.walk(base):
    dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "bin", "obj")]
    for fn in files:
        if not (fn.lower().startswith("appsettings") and fn.lower().endswith(".json")):
            continue
        fp = os.path.join(root, fn)
        try:
            txt = open(fp, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        hit = [0]
        def repl(m):
            val = m.group(1)
            if islocal(val):
                return m.group(0)
            hit[0] += 1
            return '"' + newconn(val) + '"'
        out = rx.sub(repl, txt)
        if hit[0]:
            open(fp, "w", encoding="utf-8").write(out)
            count += 1
            print("repointed %d connection(s) -> local MSSQL in %s" % (hit[0], os.path.relpath(fp, base)))
if count == 0:
    print("appsettings: no non-local SQL connections to repoint")
PYEOF`;
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
  resumeSteps: RunStep[] | null, prelude: RunStep[] = [], configNotes: string[] = [],
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
          const up = await driveSandbox(projectId, userId, workspaceId, manifest, engines, model, PROJECT_DIR, configNotes);
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
    const up = await driveSandbox(projectId, userId, workspaceId, manifest, engines, model, PROJECT_DIR, configNotes);
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

function buildDriverSystemPrompt(manifest: PreviewManifest, engines: EngineHandle[], workDir: string = PROJECT_DIR, configNotes: string[] = [], directives: string[] = []): string {
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

${directives.length ? `MANDATORY DIRECTIVES (project-specific rules — you MUST verify EACH is satisfied and make it so; do NOT skip any, and do NOT call finish until they hold):\n${directives.map((d) => `  ▣ ${d}`).join("\n")}\n\n` : ""}SETUP PLAN (from analyzing the codebase — follow it, but verify against reality and adapt when a command fails):
${plan}
${configNotes.length ? `\nCONFIG QUIRKS (discovered by the probe — RESPECT these, they prevent the exact failures that made past runs thrash):\n${configNotes.map((n) => `  ⚠ ${n}`).join("\n")}\n` : ""}
GOAL: the app must serve HTTP on 0.0.0.0:${port} and actually respond.

HOW TO WORK:
- The SETUP PLAN above is a best-effort guess from reading the code — it is NOT authoritative. VERIFY it against reality and OVERRIDE it whenever a command fails or a better approach exists. You are the one who figures out how to make this app run; the plan is just a starting hint.
- Install the toolchain, then dependencies. If a plan command (e.g. \`apk add dotnet8-sdk\`) is unavailable, broken, or the wrong version, use whatever works instead (e.g. \`curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir /data/.dotnet\`).
- For compiled stacks: restore → BUILD → run. For a multi-project solution, run the startup project named above.
- Apply migrations, then the SQL scripts in order (SQL Server runs in Docker — use \`docker exec\` with sqlcmd inside the mssql container, or a client you install; the connection string is in .env).
- Start the APP SERVER detached so it keeps running after the command returns: \`setsid sh -c 'cd ${workDir}; <run command>' </dev/null > ${workDir}/preview.log 2>&1 &\` — it must bind 0.0.0.0:${port}. (This is the ONLY case where you background a command yourself.)
- VERIFY for real: \`curl -sS -i http://127.0.0.1:${port}/\`. A real 2xx/3xx/4xx = up → \`finish\` ready. 000/connection-refused = down → read ${workDir}/preview.log, diagnose, fix, retry.
- WINDOWS → LINUX CASE SENSITIVITY: this app was likely developed on Windows (case-INsensitive filesystem) but runs here on Linux (case-SENSITIVE). If static assets 404 (broken images/CSS/JS — e.g. HTML references \`/images/…\` or \`/js/cohyremodification.js\` but the real files are \`wwwroot/Images/…\`, \`wwwroot/js/CohyreModification.js\`), it's a case mismatch, NOT a missing file. Fix it in the preview by adding case-bridging SYMLINKS in the web root (e.g. \`cd ${workDir}/<web>/wwwroot && ln -s Images images && ln -s CohyreModification.js js/cohyremodification.js\`) so the referenced paths resolve, then re-check. Call \`noteLearning\` with the exact symlinks so the next run + branches reapply them. (The proper fix — correcting the casing in the .cshtml views — belongs in a ticket, not here.) Be mindful of case in every path you reference.
- A 500 needs judgement: the app IS serving (running), but errored on the request. Read the error in ${workDir}/preview.log.
  • ENVIRONMENT issue in your remit (missing/wrong connection string, a service that isn't up, a missing env var) → fix it and retry.
  • A SCHEMA error ("Invalid column name", "Invalid object name", "relation does not exist", "Unknown column", a missing table/column — Postgres/MySQL/SQL Server alike) is almost always a schema that FAILED TO BUILD — and building the schema IS your job, so do NOT give up on it. (DB clients: SQL Server → \`docker exec -i mssql …sqlcmd…\`, list with \`SELECT name FROM sys.tables\`; Postgres → \`docker exec -i postgres psql\`, list with \`\\dt\` / information_schema.tables; MySQL → \`docker exec -i mysql mysql\`, \`SHOW TABLES\`.) First look at the Steps: did migration/schema steps FAIL (crossed out)? They usually did, for fixable reasons: (a) a SQL file has a UTF-8 BOM/encoding that breaks the first statement — re-apply stripping the BOM (\`tail -c +4 file | …\` if the first 3 bytes are EF BB BF); (b) the migration ran against a DIFFERENT database than the app (NEVER hardcode a DB name — use the .env connection the app uses; verify the app's DB actually has the tables); (c) wrong order — a script ALTERs a table an earlier failed step should have created, so fix the earlier step first; (d) a bad migration (e.g. drops a column before its table exists) — mark it applied in the ORM's migration-history table to skip it, per what you learn. (e) a script that RESTORES a whole database FROM DISK='…\\x.bak' — that backup lives on the original dev machine and is NOT in the repo/sandbox; SKIP it entirely (do not try to find, download, or recreate the .bak, and do not restore over the app's DB), the schema comes from the migrations + the other scripts. Re-apply the failed schema steps against the SAME DB the app uses, then restart and re-check the page. Call \`noteLearning\` for each fix so the next run has it.
  • If the app does NOT come up on the port AT ALL and preview.log is empty/short, it likely blocked/crashed DURING STARTUP — a logging sink or health check that can't reach a service (e.g. a Serilog MSSqlServer sink that reads its connection from appsettings.json and hangs/throws if it can't connect). Read the very first lines of preview.log, fix the startup blocker (point that sink/setting at the provisioned DB, or disable it for the preview), and restart. An app that won't start is IN your remit.
  • ONLY after the schema builds CLEANLY (all scripts applied to the app's DB with no errors) and the page STILL 500s on a missing column should you conclude it's a genuine app/repo bug (the app queries a column no migration/script creates) — THEN call \`finish\` "ready" and state precisely which column/table and that a clean schema build still lacks it. You may do up to ~2 full schema-repair passes; do not loop endlessly on the same failing command.

PERSISTING WHAT YOU LEARN (so the next run doesn't repeat your work):
- Each \`run\` command starts a FRESH shell, so a bare \`export FOO=bar\` does NOT carry to the next command. For an environment fix that must stick (an env var, a cert/CA path, a package source), call the \`setEnv\` tool — it stores the var on the project (encrypted) AND writes it into .env now, so it is re-applied on every future setup and SURVIVES a VM rebuild. (Appending to ./.env only lasts while this VM lives — if the VM is recreated you'd have to rediscover the fix.)
- When you discover the PLAN itself was wrong and found what works — a different toolchain install, install/build/run command, startup project, or port — call \`updatePlan\` to persist the corrected value. Do this AFTER you've confirmed the new command works. This is how the checklist self-heals: the next preview run skips straight to the working commands. IMPORTANT: in a build/run command you persist, use paths RELATIVE to the working dir (e.g. \`Cohire.Web/wwwroot/CohireFiles\`), NOT absolute \`${PROJECT_DIR}/...\` — the same command is later run in FEATURE-BRANCH worktrees, and a hardcoded ${PROJECT_DIR} path would touch main instead of the worktree.
- When you learn a FACT that no plan field captures — a schema/ordering rule (migration MUST run before a SQL script), a missing client (\`sqlcmd\` isn't installed → use \`docker exec\`), a config gotcha — call \`noteLearning\` so the next run and every feature branch see it up front. Record it the moment you learn it; this is what stops the "figure the same thing out for 2 hours every run" loop.
- When you EDIT A CONFIG FILE for the app to run (e.g. repoint a connection string in appsettings.json from a dead dev/prod host to the provisioned localhost DB, or a Serilog sink connection the app reads from the file), use \`persistConfigPatch\` — NOT a bare sed/echo. A plain edit is a change to a TRACKED file, so a git branch switch / fresh checkout / rebuild RESETS it and the app breaks again; persistConfigPatch re-applies it automatically after every checkout, so branches and rebuilds inherit it. (Env fixes → setEnv; tracked-file config fixes → persistConfigPatch.)

RUNNING COMMANDS — IMPORTANT:
- The \`run\` tool already runs each command DETACHED and polls it to completion, so restore/build/install take as long as they need — you do NOT need to background them, add \`&\`, nohup, or your own timeout wrapper. Just run the plain command (e.g. \`dotnet build Cohire.sln -c Release\`).
- Pass a large \`timeoutSec\` (~1500) for restore/build. If a command returns exitCode -2 ("still running after Ns"), it is STILL RUNNING — do NOT restart it; call \`run\` again (e.g. \`sleep 5\` or re-issue with a bigger timeoutSec) to keep waiting for it to finish. Never kill and restart a build that's progressing.
- If a command returns exitCode -4, we KILLED it: it produced NO output for ~4 min and looked stuck (commonly a hung network/TLS/DNS op — e.g. a package restore that can't validate a source's certificate even though \`curl\` to it works). Do NOT re-run the identical command. Diagnose the hang and change the approach (fix certs/CA path, a different package source or install method, offline/cached packages), then retry.
- RUN IN "LOG MODE" — surface the REAL error on the FIRST run. Errors are expected; the point is to see WHAT failed immediately, not to re-run to find out. So for any command that can fail (build/restore/migrate/install): keep \`2>&1\`, and use the tool's VERBOSE/diagnostic flag so the actual error prints inline. Concretely:
  • \`dotnet ef database update …\` hides errors ("Build failed. Use dotnet build to see the errors.") — ALWAYS add \`-v\` (verbose) so the build error is shown, OR run \`dotnet build <sln> -c Release\` FIRST to get the real error, then re-run ef once it builds.
  • Use \`--verbosity normal\`/\`-v\` for dotnet, \`-x\`/\`--verbose\` where a tool offers it, \`npm ... --loglevel verbose\`, etc.
  • Do NOT pipe output through \`grep\`/\`head\` in a way that hides the actual error + its context — you'll just have to re-run. Read the full tail we return.
  This avoids the wasteful "run → vague failure → re-run to see the error" cycle.

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
  configNotes: string[] = [],
): Promise<boolean> {
  const port = manifest.port;
  let finished: { status: "ready" | "failed"; detail: string } | undefined;
  // Load the project's MANDATORY DIRECTIVES (user-authored + agent-appended must-dos).
  const directives = (await loadAppProfile(projectId).catch(() => null))?.profile.directives ?? [];

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
        // Persist the correction into the PROFILE too — the manifest is re-derived
        // from the profile each run, so a manifest-only fix would be clobbered.
        await applyProfileCorrection(projectId, field, value, reason).catch(() => {});
        const shown = field === "toolchain" ? manifest.toolchain.join("; ") : String((manifest as any)[field]);
        plog(projectId, userId, `Updated plan: ${field} → ${shown}`, { detail: reason });
        return "plan updated — the next run will use this.";
      },
    }),
    noteLearning: tool({
      description: "Record a non-obvious FACT you learned about running THIS app that a plan field can't capture, so the NEXT run (and feature branches) get it up front instead of rediscovering it. Use for: schema/ordering rules (e.g. 'the EF migration MUST run before the Sql Scripts or the app 500s on Invalid column'), a required client/tool ('sqlcmd isn't installed — use `docker exec mssql`'), a config gotcha ('appsettings.json is JSONC — inject via env, never edit it'), or any workaround. It's stored on the profile and shown to future agents as a CONFIG QUIRK. Call it the moment you learn something worth not repeating.",
      inputSchema: zodSchema(z.object({
        note: z.string().describe("One concrete, actionable sentence — what's true and what to do about it."),
      })),
      execute: async ({ note }: { note: string }) => {
        const ok = await recordProfileLearning(projectId, note).catch(() => false);
        plog(projectId, userId, `Learned: ${note}`);
        return ok ? "recorded — future runs and branches will see this." : "noted (no profile to attach it to yet).";
      },
    }),
    addDirective: tool({
      description: "Add a MANDATORY DIRECTIVE — a must-do rule that EVERY future run/preview of this project must verify and satisfy (stronger than noteLearning, which is only advisory). Use ONLY after you've SOLVED a significant blocker that must not regress, and phrase it as an imperative the next agent can check + enforce — e.g. 'Every appsettings*.json SQL connection must point at the local MSSQL, not a dev/prod host', 'The EF migration for CohyredemoDBEntities MUST run before applying the SQL Scripts'. These are shown to every future agent as MANDATORY DIRECTIVES it cannot skip.",
      inputSchema: zodSchema(z.object({
        directive: z.string().describe("One imperative, checkable rule the next run must satisfy."),
      })),
      execute: async ({ directive }: { directive: string }) => {
        const ok = await recordDirective(projectId, directive).catch(() => false);
        plog(projectId, userId, `Added mandatory directive: ${directive}`);
        return ok ? "recorded — every future run must satisfy this." : "noted (no profile yet).";
      },
    }),
    persistConfigPatch: tool({
      description: "Persist an edit to a CONFIG FILE so it SURVIVES a git branch switch, a fresh checkout, and a rebuild (like setEnv does for env vars, but for a tracked file that a checkout would otherwise reset). Use this — NOT a bare sed/echo — whenever you must edit a config file (NOT application source logic) for the app to RUN in the sandbox: e.g. repoint a connection string in appsettings.json from a dead dev/prod host to the provisioned localhost DB, or a Serilog sink connection that the app reads from the file. Give the EXACT literal text to find + its replacement. It's applied NOW and auto-re-applied after every future checkout/branch-switch, so branches and rebuilds never rediscover it.",
      inputSchema: zodSchema(z.object({
        file: z.string().describe("Path relative to the working dir, e.g. 'Cohire.Web/appsettings.json'."),
        find: z.string().describe("EXACT literal substring currently in the file to replace (copy it verbatim)."),
        replace: z.string().describe("The replacement text."),
        reason: z.string().optional(),
      })),
      execute: async ({ file, find, replace, reason }: { file: string; find: string; replace: string; reason?: string }) => {
        const script = buildConfigPatchScript([{ file, find, replace }], workDir);
        if (script) await sh(workspaceId, script, 30_000).catch(() => {});
        const ok = await recordConfigPatch(projectId, { file, find, replace, note: reason }).catch(() => false);
        plog(projectId, userId, `Persisted config patch to ${file}`, { detail: reason });
        return ok ? "applied + persisted — it re-applies after every checkout/branch-switch." : "applied now, but couldn't persist (no profile yet).";
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
        if (UNSAFE_ENV_KEYS.has(key)) {
          return `Refused: ${key} is machine-specific and must NOT be persisted — a persisted ${key} gets injected into other VMs and clobbers their real ${key} (breaking ls/node/apk). The toolchain PATH is already set for every command. To use a tool, reference its absolute path or install it via updatePlan's toolchain step instead.`;
        }
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
      stopWhen: stepCountIs(150), // generous step budget — schema-heavy apps (30+ scripts) need room to repair AND start
      system: buildDriverSystemPrompt(manifest, engines, workDir, configNotes, directives),
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
  /** Auto-invoked flows (e.g. asset self-heal) set this so the agent fixes the
   *  LIVE preview but NEVER git commit/push — auto-committing to the user's branch
   *  is a surprise they explicitly don't want. */
  noCommit?: boolean;
}): Promise<{ reply: string; status: "ok" | "error" | "stuck" }> {
  const { projectId, publicProjectId, userId, instruction, abortSignal, noCommit } = opts;
  publicIdCache.set(projectId, publicProjectId); // WS routing for plog

  const driver = await resolveDriverModel(userId);
  if (!driver) return { reply: "I can't reach an AI model — add an API key in Settings to use the preview agent.", status: "error" };

  let workspaceId: string;
  try { ({ workspaceId } = await ensureProjectSandbox(projectId)); }
  catch { return { reply: "There's no preview sandbox for this project yet. Open the **Preview** tab and run setup first, then ask me again.", status: "error" }; }

  const row = await getEnv(projectId);
  const manifest = row?.setupManifest ? (JSON.parse(row.setupManifest) as PreviewManifest) : null;
  const port = manifest?.port ?? DEFAULT_PORT;
  const runCmd = row?.runCommand || manifest?.runCmd || "";
  const savedProfile = await loadAppProfile(projectId);
  const configNotes = savedProfile ? profileNotes(savedProfile.profile) : [];
  const directives = savedProfile?.profile.directives ?? [];
  // What the last setup/preview run already did — captured BEFORE this chat runs
  // any commands of its own, so a follow-up @preview continues from where the
  // previous run left off instead of re-investigating from scratch.
  const priorActions = summarizeAgentActions(logBuffers.get(projectId) || row?.setupLog || "");

  // Operate on whatever branch is CURRENTLY being previewed — a ticket's git
  // worktree if a branch is live, else main's /data/project. Otherwise @preview
  // would act on main while you're looking at a ticket branch.
  let workDir = PROJECT_DIR;
  let branchNote = "the default branch";
  const tm = (row?.previewBranch || "").match(/^feature\/ticket-(.+)$/);
  if (tm?.[1]) {
    const wt = ticketWorktreeDir(tm[1]);
    const chk = await sh(workspaceId, `test -d ${wt} && test -e ${wt}/.git && echo OK || echo NO`, 20_000);
    if (chk.output.includes("OK")) { workDir = wt; branchNote = `ticket branch ${row!.previewBranch} (worktree)`; }
  }

  plog(projectId, userId, `@preview (${branchNote}): ${instruction}`);

  let reply = "";
  let replyStatus: "ok" | "error" | "stuck" = "ok";
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
        const r = await runDetachedPolled(projectId, userId, workspaceId, command, maxMs, { stallMs: 240_000, workDir });
        plog(projectId, userId, `  → exit ${r.exitCode}`, r.output ? { detail: r.output.slice(-1800), level: r.exitCode === 0 ? "info" : "error" } : undefined);
        return { exitCode: r.exitCode, output: r.output.slice(-6000) || "(no output)" };
      },
    }),
    setEnv: tool({
      description: "PERSIST an environment fix so it's applied on EVERY future preview/setup AND inherited by ticket branches — not just this live app. Use this whenever you fix something via an env var (a cert/CA path, ASPNETCORE_FORWARDEDHEADERS_ENABLED, a base URL, a runtime flag) INSTEAD of only echoing to .env. Stored (encrypted) on the project + written to .env now. This is how a fix you make on main automatically reaches feature branches and the next rebuild.",
      inputSchema: zodSchema(z.object({ key: z.string(), value: z.string(), reason: z.string().optional() })),
      execute: async ({ key, value, reason }: { key: string; value: string; reason?: string }) => {
        if (UNSAFE_ENV_KEYS.has(key)) {
          return `Refused: ${key} is machine-specific and must NOT be persisted — it gets injected into other VMs and clobbers their real ${key}. Reference the tool's absolute path instead.`;
        }
        try {
          await db.insert(projectEnvironmentVariables)
            .values({ projectId, key, encryptedValue: encryptSecret(value), isSecret: false, hasValue: true, description: reason || "preview fix" })
            .onConflictDoUpdate({ target: [projectEnvironmentVariables.projectId, projectEnvironmentVariables.key], set: { encryptedValue: encryptSecret(value), hasValue: true, updatedAt: new Date() } });
          const line = `${key}="${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
          const b64 = Buffer.from(line).toString("base64");
          for (const d of [...new Set([workDir, PROJECT_DIR])]) {
            await sh(workspaceId, `cd ${d} 2>/dev/null && (grep -v '^${key}=' .env 2>/dev/null > .env.tmp; echo ${b64} | base64 -d >> .env.tmp; mv .env.tmp .env) && echo SET_ENV`, 30_000);
          }
          plog(projectId, userId, `Persisted env ${key} (applies to future runs + branches)`, { detail: reason });
          return `persisted ${key} — future setups and branches inherit it.`;
        } catch (e) { return `failed to persist env: ${(e as Error).message}`; }
      },
    }),
    updatePlan: tool({
      description: "PERSIST a correction to the saved setup plan (toolchain/install/build/run/port/startupProject) so the next preview build uses the working command, and branches inherit it. Use after you've confirmed the corrected command works.",
      inputSchema: zodSchema(z.object({
        field: z.enum(["toolchain", "installCmd", "buildCmd", "runCmd", "port", "startupProject"]),
        value: z.string().describe("Corrected value. For 'toolchain', full command sequence one per line. For 'port', the number as a string."),
        reason: z.string().optional(),
      })),
      execute: async ({ field, value, reason }: { field: string; value: string; reason?: string }) => {
        if (!manifest) return "no saved plan to update yet — run a full setup first.";
        if (field === "toolchain") manifest.toolchain = value.split("\n").map((s) => s.trim()).filter(Boolean);
        else if (field === "port") { const p = parseInt(value, 10); if (p > 0) manifest.port = p; }
        else (manifest as any)[field] = value;
        await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId)).catch(() => {});
        await applyProfileCorrection(projectId, field, value, reason).catch(() => {});
        plog(projectId, userId, `Updated plan: ${field}`, { detail: reason });
        return "plan updated — future builds + branches use this.";
      },
    }),
    noteLearning: tool({
      description: "Record a non-obvious FACT you learned about running THIS app that a plan field can't capture (a schema/ordering rule, a missing client, a config gotcha, a workaround) so future previews AND feature branches get it up front instead of rediscovering it. Persisted on the profile and shown to future agents as a CONFIG QUIRK.",
      inputSchema: zodSchema(z.object({ note: z.string().describe("One concrete, actionable sentence.") })),
      execute: async ({ note }: { note: string }) => {
        const ok = await recordProfileLearning(projectId, note).catch(() => false);
        plog(projectId, userId, `Learned: ${note}`);
        return ok ? "recorded — future runs and branches will see this." : "noted (no profile yet).";
      },
    }),
    addDirective: tool({
      description: "Add a MANDATORY DIRECTIVE — a must-do rule every future run/preview must verify + satisfy (stronger than noteLearning). Use after solving a blocker that must never regress, phrased as an imperative the next agent can check.",
      inputSchema: zodSchema(z.object({ directive: z.string() })),
      execute: async ({ directive }: { directive: string }) => {
        const ok = await recordDirective(projectId, directive).catch(() => false);
        plog(projectId, userId, `Added mandatory directive: ${directive}`);
        return ok ? "recorded — every future run must satisfy this." : "noted (no profile yet).";
      },
    }),
    persistConfigPatch: tool({
      description: "Persist a CONFIG-FILE edit so it SURVIVES a git branch switch / fresh checkout / rebuild (like setEnv for env vars, but for a tracked file). Use whenever you must edit a config file (NOT app source) for the app to RUN — e.g. repoint an appsettings.json connection from a dead host to the provisioned localhost DB. Exact literal find + replace. Applied now AND re-applied after every future checkout, so branches inherit it.",
      inputSchema: zodSchema(z.object({ file: z.string(), find: z.string(), replace: z.string(), reason: z.string().optional() })),
      execute: async ({ file, find, replace, reason }: { file: string; find: string; replace: string; reason?: string }) => {
        const script = buildConfigPatchScript([{ file, find, replace }], workDir);
        if (script) await sh(workspaceId, script, 30_000).catch(() => {});
        const ok = await recordConfigPatch(projectId, { file, find, replace, note: reason }).catch(() => false);
        plog(projectId, userId, `Persisted config patch to ${file}`, { detail: reason });
        return ok ? "applied + persisted — re-applies after every checkout/branch-switch." : "applied now (no profile to persist to yet).";
      },
    }),
    reply: tool({
      description: "Call ONCE when you've finished. Give a concise chat summary (markdown ok). Set status: 'ok' = you succeeded/verified the fix; 'error' = it failed or can't be done; 'stuck' = partially done / needs the user. If you made a fix, say whether you PERSISTED it (setEnv/updatePlan) and whether you committed code.",
      inputSchema: zodSchema(z.object({
        status: z.enum(["ok", "error", "stuck"]).describe("Outcome for the chat banner colour (green/red/yellow)."),
        summary: z.string(),
      })),
      execute: async ({ status, summary }: { status: "ok" | "error" | "stuck"; summary: string }) => { reply = summary; replyStatus = status; return "acknowledged"; },
    }),
  };

  const startHint = `setsid sh -c 'cd ${workDir}; set -a; . ./.env 2>/dev/null; set +a; ${runCmd || "<run command>"}' </dev/null > ${workDir}/preview.log 2>&1 &`;
  const canEditCode = workDir !== PROJECT_DIR; // only on a ticket's isolated branch
  const system = `You are the LFG **Preview agent** for this project. You have FULL shell control of the project's LIVE Alpine sandbox (musl, apk, OpenRC/rc-service, busybox — Docker is available) via the \`run\` tool: one command per call, run detached + polled so long commands are fine. You are working in **${branchNote}** at ${workDir}; its .env is sourced before every command; the toolchain + /data caches are already on PATH.

CODE CHANGES: ${canEditCode
    ? (noCommit
      ? `You ARE previewing a ticket's isolated feature branch (worktree at ${workDir}), so you MAY edit the app's SOURCE CODE here to fix the issue so the LIVE preview renders correctly. After editing: rebuild if it's a compiled stack (${manifest?.buildCmd || "the project's build command"}), restart the app (see below), and verify with curl. **DO NOT run git commit, git push, git merge, or git checkout of another branch** — this fix is for the live preview only; the user decides whether to persist it. In your reply, list exactly which files you changed so they can persist it if they want.`
      : `You ARE previewing a ticket's isolated feature branch (worktree at ${workDir}), so you MAY edit the app's SOURCE CODE here to fulfil the request (e.g. fix a .cshtml/CSS/JS UI issue). After editing: rebuild if it's a compiled stack (${manifest?.buildCmd || "the project's build command"}), restart the app (see below), verify with curl, and then COMMIT so the change persists on the branch: \`cd ${workDir} && git add -A && git commit -m "preview: <what you changed>" && git push 2>&1 || true\`. Tell the user in your reply exactly which files you changed.`)
    : `You are previewing the DEFAULT branch (${PROJECT_DIR}). Do NOT edit application SOURCE CODE here — code changes belong in a ticket/build, not on main. If the user asks for a code/UI change, say so in your reply and suggest they create/rebuild a ticket, or preview the ticket's branch (pick it in the branch selector) and ask again there.`}

${manifest ? `App: ${manifest.stack || `${manifest.runtime}/${manifest.framework}`}. Run command: \`${runCmd || "(unknown)"}\`. Port: ${port}. Databases: ${manifest.databases.length ? manifest.databases.map((d) => `${d.engine} (127.0.0.1, connection in .env as ${d.connectionEnvVar})`).join(", ") : "none"}.` : "This preview has not been fully set up yet — the app may not be running."}
${directives.length ? `\nMANDATORY DIRECTIVES (project rules you MUST honor and, if the request relates to them, verify/enforce):\n${directives.map((d) => `  ▣ ${d}`).join("\n")}\n` : ""}${configNotes.length ? `\nCONFIG QUIRKS (from the probe — RESPECT these; they prevent the exact mistakes that broke past runs, e.g. corrupting a JSONC appsettings.json):\n${configNotes.map((n) => `  ⚠ ${n}`).join("\n")}\n` : ""}
${priorActions ? `\nWHAT THE LAST RUN ALREADY DID (the setup/preview agent's most recent COMMANDS + exit codes + decisions — CONTINUE from here; do NOT redo steps that already succeeded, and start from the point it failed/stopped):\n${priorActions}\n` : ""}

The app server (if running) listens on 127.0.0.1:${port}. To (re)start it, launch it DETACHED:
  ${startHint}
then VERIFY for real: \`curl -sS -i http://127.0.0.1:${port}/\` (2xx/3xx/4xx = up; 000/refused/5xx = not up → read ${workDir}/preview.log).

SCOPE — do ONLY what the user asked, nothing more:
- If it's a DIAGNOSTIC question (why/what/check/is-it-working/where): INVESTIGATE with read-only commands (curl, cat, grep, ls, head, docker logs, SQL SELECTs) and REPORT the finding via \`reply\`. Do NOT rebuild, re-restore packages, re-run migrations, re-seed the DB, or restart the app for a diagnostic question — that wastes hours and isn't what was asked. Find the cause, explain it, and suggest the fix.
- Only take mutating/expensive actions (build, restore, migrate, seed, restart, install) when the user EXPLICITLY asks you to fix/change/restart/set something up. When unsure, investigate and report rather than mutate.
- The app is usually ALREADY set up and running — assume the toolchain, DB, and build exist; verify before assuming they don't. Do not redo setup.
- RUN IN "LOG MODE" so an error shows the FIRST time — don't run a command that hides the error and forces a re-run. Keep \`2>&1\` and add the tool's verbose flag (e.g. \`dotnet ef … -v\` — plain ef only says "Build failed. Use dotnet build to see the errors."; use \`--verbosity normal\`/\`npm --loglevel verbose\`). Don't \`grep\`/\`head\` away the real error + its context. Errors are expected — the goal is to see WHAT failed immediately.
- CASE SENSITIVITY: Windows-developed apps 404 their own assets on Linux (case-sensitive) — e.g. HTML asks for \`/images/…\` but the file is \`wwwroot/Images/…\`. That's a case mismatch, not a missing file: add bridging symlinks in the web root (\`ln -s Images images\`, etc.), then \`noteLearning\` the exact symlinks so future runs + branches reapply them. Be mindful of case in every path.

PERSIST YOUR FIXES (critical — otherwise they're lost and branches don't get them):
- When you fix something with an ENV var (a cert/CA path, ASPNETCORE_FORWARDEDHEADERS_ENABLED for a reverse-proxy/HTTPS asset issue, a base URL, a runtime flag), call \`setEnv\` — do NOT just \`echo >> .env\`. setEnv records it on the project so EVERY future setup AND every ticket branch inherits it. An echo-only fix works for this one live app and then vanishes.
- When you find a plan command was wrong and confirm the right one, call \`updatePlan\`.
- When you learn a FACT no field captures (a schema/ordering rule, a missing client like sqlcmd, a config gotcha), call \`noteLearning\` so the next run + branches see it.
- When you EDIT A CONFIG FILE for the app to run (repoint an appsettings.json connection off a dead host, fix a Serilog sink connection), use \`persistConfigPatch\` — a bare edit is reset by a branch switch / checkout; persistConfigPatch re-applies it after every checkout so branches inherit it.
- This is exactly how a fix you make on main automatically reaches the feature branches.

RULES: source-code edits follow the CODE CHANGES policy above (allowed only on a ticket branch). Installing tools/deps, editing ./.env and config is fine when asked. Verify with real commands — never claim success without checking. When finished, ALWAYS call \`reply\` with status (ok/error/stuck) + a short summary of what you found/did (and whether you persisted/committed it). Never print secrets.`;

  try {
    await generateText({ model: driver.model, tools, stopWhen: stepCountIs(40), system, prompt: instruction, abortSignal });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (abortSignal?.aborted || /abort/i.test(msg)) return { reply: reply || "Stopped.", status: "stuck" };
    plog(projectId, userId, `Preview agent error: ${msg}`, { level: "error" });
    return { reply: reply || `I ran into an error: ${msg.slice(0, 300)}`, status: "error" };
  }
  if (reply) return { reply, status: replyStatus };
  // Fallback: the agent ended WITHOUT calling reply. Do NOT dump raw log lines
  // (that's the incoherent "here's the last SQL output" mess) — instead do one
  // quick summarize pass over what it actually ran, so the chat gets a coherent,
  // human answer with the finding + next step.
  // Use the RAW recent log (commands AND their outputs) so the summarizer can see
  // the actual findings — e.g. the SQL results proving a column is missing.
  const rawTail = (logBuffers.get(projectId) || "").slice(-9000);
  if (rawTail.trim()) {
    try {
      const { object } = await generateObject({
        model: driver.model,
        schema: zodSchema(z.object({
          status: z.enum(["ok", "error", "stuck"]).describe("ok = fixed/verified; error = can't run; stuck = needs the user or is a genuine code/data bug"),
          summary: z.string().describe("2-5 sentences, markdown ok. The finding, the ROOT CAUSE, and the recommended next step. Do NOT paste raw SQL/console output."),
        })),
        prompt: `You are the LFG Preview agent. You just investigated "${instruction}" on the live sandbox but didn't leave a summary. From the commands you ran and THEIR OUTPUTS below, write a concise, coherent chat reply for the user: what you found, the root cause, and what to do next. If the schema is fine but the app's own code queries a column/table that doesn't exist, say clearly it's an application/repo bug (name the exact column/table) that needs a code or migration fix — not something the preview can fix.\n\nRecent commands + outputs:\n${rawTail}`,
      });
      return { reply: object.summary, status: object.status };
    } catch { /* fall through to the plain message */ }
  }
  return { reply: "I investigated but couldn't produce a clean summary — open the Preview tab logs for the details.", status: "stuck" };
}

// ── Public API ───────────────────────────────────────────────────────────────
export interface SetupOptions { userId: string; branch?: string; rebuildManifest?: boolean; ticketId?: string; conversationId?: string | null }

/** The worktree directory for a ticket's branch inside the preview sandbox. Must
 *  match the name the ticket executor creates: `wt-ticket-<ticketId first 12>`. */
function ticketWorktreeDir(ticketId: string): string { return `/data/wt-ticket-${ticketId.slice(0, 12)}`; }

/** Resolve a token-embedded clone URL for the project's repo (GitHub or GitLab),
 *  with a FRESH token — so a `git fetch` works even if the remote's baked-in token
 *  from the original clone has since expired. Used to reconstruct a ticket worktree. */
async function resolveAuthedRepoUrl(projectId: string): Promise<{ authUrl: string; provider: string } | { error: string }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return { error: "project not found" };
  const columnProvider = (project.repoProvider || "github").toLowerCase();
  const repoUrl = project.repoUrl || (project.repoOwner && project.repoName
    ? `https://${columnProvider === "gitlab" ? "gitlab.com" : "github.com"}/${project.repoOwner}/${project.repoName}.git`
    : "");
  if (!repoUrl) return { error: "This project has no connected repository." };
  const provider = /gitlab\.com|\/gitlab\b/i.test(repoUrl) ? "gitlab" : /github\.com/i.test(repoUrl) ? "github" : columnProvider;
  let token = "";
  if (provider === "gitlab") {
    token = (await getValidGitlabToken(project.ownerId)) || "";
    if (!token) return { error: "No GitLab token — reconnect GitLab in settings." };
  } else {
    const [t] = await db.select().from(githubTokens).where(eq(githubTokens.userId, project.ownerId)).limit(1);
    token = t?.accessToken || "";
    if (!token) return { error: "No GitHub token — connect GitHub in settings." };
  }
  const cred = provider === "gitlab" ? `oauth2:${token}` : `x-access-token:${token}`;
  return { authUrl: repoUrl.replace(/^https:\/\//, `https://${cred}@`), provider };
}

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
    // Persist an in-progress status IMMEDIATELY — BEFORE the slow ensureProjectSandbox
    // — so a client poll can't read the stale pre-run status (idle/stopped) and flash
    // the idle screen before the pipeline's first real status write lands.
    await setPreview(projectId, userId, { previewStatus: "detecting", previewError: null, previewBranch: branch || "(default)" }, "Starting…");
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

    // 2. Build (or reuse) the APP PROFILE (deep probe), then derive the plan.
    // The profile is the persisted source of truth — a thorough one-time read of
    // the repo (stack, versions, ordered schema recipe, env/secrets, config
    // quirks) — and the runbook is DERIVED from it, so runs are deterministic
    // instead of the agent re-investigating from scratch each time.
    await prep("plan", "running");
    const existing = await getEnv(projectId);
    let manifest: PreviewManifest | null = null;
    let profile: AppProfile | null = null;

    if (!opts.rebuildManifest) {
      const loaded = await loadAppProfile(projectId);
      if (loaded) {
        profile = loaded.profile;
        plog(projectId, userId, `Using saved run profile v${loaded.version} (${profile.stack || profile.runtime})`);
      }
    }
    if (!profile) {
      const prior = await loadAppProfile(projectId); // carry learnings across a re-probe
      const pac = new AbortController();
      const pw = setInterval(() => { if (isCancelled(projectId)) pac.abort(); }, 1000);
      try {
        profile = await probeAppProfile({
          workspaceId,
          userId,
          onLog: (l, d) => plog(projectId, userId, l, d ? { detail: d } : undefined),
          abortSignal: pac.signal,
        });
      } finally { clearInterval(pw); }
      if (profile) {
        // A re-probe rewrites the plan but must NOT forget hard-won run learnings.
        if (prior?.profile.learnings?.length) {
          profile.learnings = [...prior.profile.learnings, ...(profile.learnings ?? [])].slice(-40);
        }
        await saveAppProfile(projectId, profile);
      }
    }
    throwIfCancelled(projectId);

    if (profile) {
      manifest = deriveManifestFromProfile(profile);
      await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
      plog(projectId, userId, `Plan (from profile): ${manifest.stack || manifest.runtime}`, {
        detail: [
          manifest.startupProject && `run project: ${manifest.startupProject}`,
          `port: ${manifest.port}`,
          manifest.toolchain?.length && `toolchain: ${manifest.toolchain.join("; ")}`,
          `install: ${manifest.installCmd || "(none)"}`,
          manifest.buildCmd && `build: ${manifest.buildCmd}`,
          `databases: ${manifest.databases.length ? manifest.databases.map((d) => `${d.engine}→${d.connectionEnvVar}`).join(", ") : "none"}`,
          manifest.migrations?.length && `migrations: ${manifest.migrations.join("; ")}`,
          manifest.sqlScripts?.length && `sql scripts: ${manifest.sqlScripts.length} in dependency order`,
          profile.configQuirks.length && `config notes: ${profile.configQuirks.length}`,
          `run: ${manifest.runCmd}`,
        ].filter(Boolean).join("\n"),
      });

      // OPTIONAL secrets — NON-blocking. The app runs with its checked-in/default
      // config, so we NEVER stop the run for these; we just note (once) which
      // external credentials the user MAY add for full functionality and CONTINUE.
      // The user can add them in env settings and Restart whenever they want.
      const missing = await missingSecrets(projectId, profile);
      if (missing.length) {
        await publishSummary(userId, opts.conversationId, secretsNoticeMessage(missing)).catch(() => {});
        plog(projectId, userId, `Note: ${missing.length} optional secret(s) not set (${missing.map((m) => m.key).join(", ")}) — continuing; add them + Restart for full functionality.`);
      }
    }

    // Fallback: the probe produced nothing (rare) — use the lighter detection so
    // preview still functions.
    if (!manifest) {
      plog(projectId, userId, "Probe produced no profile — falling back to quick detection…");
      manifest = await detectManifest(projectId, userId);
      await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
      plog(projectId, userId, `Plan: ${manifest.stack || manifest.runtime}`);
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
    // Deterministic RULE: repoint every hardcoded non-local SQL connection in EVERY
    // appsettings*.json (Web, Admin, …) to the provisioned local MSSQL — so the app
    // doesn't crash on a dead dev/prod host baked into the config, on the FIRST run.
    const rewriteScript = buildAppsettingsRewriteScript(engineHandles, PROJECT_DIR);
    if (rewriteScript) {
      const r = await sh(workspaceId, rewriteScript, 60_000).catch(() => ({ output: "" }));
      plog(projectId, userId, "Repointed appsettings SQL connections → local MSSQL", { detail: (r.output || "").slice(-500) });
    }
    // Re-apply persisted config-file patches (any app-specific fixes beyond the above).
    if (profile?.configPatches?.length) {
      const patchScript = buildConfigPatchScript(profile.configPatches, PROJECT_DIR);
      if (patchScript) { await sh(workspaceId, patchScript, 60_000).catch(() => {}); plog(projectId, userId, `Re-applied ${profile.configPatches.length} saved config patch(es)`); }
    }
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
      const configNotes = profile ? profileNotes(profile) : [];
      const result = await executeRunbook(projectId, userId, workspaceId, manifest, engineHandles, driver?.model, resumeSteps, prelude, configNotes);
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
    // SELF-HEAL (same as restartPreview): if the app is up but bound a DIFFERENT
    // port than requested (a .NET appsettings Kestrel/applicationUrl override of
    // ASPNETCORE_URLS), expose the port it actually announced in its log.
    let effectivePort = manifest.port;
    if (!up) {
      const bound = await detectBoundPorts(workspaceId, `${PROJECT_DIR}/preview.log`);
      const alt = bound.find((p) => p !== manifest.port && ![80, 443].includes(p));
      if (alt && await checkServer(workspaceId, alt, 2)) {
        effectivePort = alt; up = true;
        plog(projectId, userId, `App bound port ${alt} (not ${manifest.port}) — appsettings/code overrode ASPNETCORE_URLS. Exposing ${alt} instead.`);
      }
    }
    if (!up) {
      const bound = await detectBoundPorts(workspaceId, `${PROJECT_DIR}/preview.log`);
      const log = await sh(workspaceId, `tail -40 ${PROJECT_DIR}/preview.log 2>/dev/null`, 20_000);
      const detail = (log.output || "").trim() || "(no log output captured)";
      const portNote = bound.length ? ` The app's log says it's listening on port ${bound.join(", ")}, not ${manifest.port} — it's binding a port from appsettings (Kestrel:Endpoints/applicationUrl) or code (UseUrls) that overrides ASPNETCORE_URLS. Point it at ${manifest.port}.` : "";
      plog(projectId, userId, `The app did not respond on port ${manifest.port}${bound.length ? ` (it bound ${bound.join(", ")})` : ""}`, { level: "error", detail });
      return failed(projectId, userId, `The app did not come up on port ${manifest.port}.${portNote}\n\n${detail.slice(-1000)}`);
    }
    plog(projectId, userId, "App is responding ✓");

    // 7. Expose the app's OWN port publicly. The app is CONFIRMED up, so a
    // transient Mags "job not found" here must NOT throw away a working preview —
    // retry the exposure (the VM name just needs a moment to re-resolve).
    plog(projectId, userId, `Exposing port ${effectivePort} as a public URL…`);
    const alias = existing?.stableAlias || randomAlias();
    let previewUrl = "";
    let exposeErr = "";
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await enableHttpAccess(workspaceId, effectivePort);
        try { previewUrl = await setStableUrl(alias, workspaceId); }
        catch { previewUrl = await enableHttpAccess(workspaceId, effectivePort); }
        if (previewUrl) break;
      } catch (e) {
        exposeErr = (e as Error).message ?? String(e);
        plog(projectId, userId, `Exposure attempt ${attempt}/5 failed (${exposeErr.slice(0, 60)}); retrying…`);
        await sleep(5000);
      }
    }
    if (!previewUrl) {
      return failed(projectId, userId, `The app is running on port ${effectivePort}, but exposing the public URL failed: ${exposeErr}. Try again.`);
    }

    await db.update(projectEnvironments).set({ stableAlias: alias, updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
    plog(projectId, userId, `Preview live: ${previewUrl}`);
    await setPreview(projectId, userId, { previewStatus: "running", appUrl: previewUrl, appPort: effectivePort, previewError: null }, "Preview is live");
    // Post-run verification (URL + assets + DB) → publish the launch summary to chat.
    const vManifest = effectivePort === manifest.port ? manifest : { ...manifest, port: effectivePort };
    const v = await verifyPreview(projectId, userId, workspaceId, vManifest, branch || "(default)").catch(() => null);
    if (v) await publishSummary(userId, opts.conversationId, `${v.summary}\n\n🔗 ${previewUrl}`).catch(() => {});
    // Self-heal broken assets via the agent (opt-in through directives), then re-summarize.
    if (v?.broken?.length) {
      const healed = await healBrokenAssets(projectId, userId, opts.conversationId, workspaceId, vManifest, branch || "(default)", v.broken).catch(() => null);
      if (healed) await publishSummary(userId, opts.conversationId, `${healed.summary}\n\n🔗 ${previewUrl}`).catch(() => {});
    }
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
 * Re-run the PROBE against the cloned repo and save a fresh profile (keeping the
 * accumulated learnings). Used by the "Re-probe" button in the Profile panel.
 * Fire-and-forget: streams to the preview log and broadcasts `preview_profile`
 * with the new profile when done. Requires the repo to already be cloned.
 */
export async function reprobeProfile(projectId: string, userId: string): Promise<void> {
  await loadPublicId(projectId);
  resetLog(projectId);
  let workspaceId: string;
  try { ({ workspaceId } = await ensureProjectSandbox(projectId)); }
  catch { plog(projectId, userId, "Re-probe failed: no sandbox — run Set up preview first.", { level: "error" }); return; }

  const has = await sh(workspaceId, `test -e ${PROJECT_DIR}/.git && echo OK || echo NO`, 20_000);
  if (!has.output.includes("OK")) {
    plog(projectId, userId, "Re-probe failed: the repo isn't cloned yet — run Set up preview first.", { level: "error" });
    broadcastToUser(userId, { type: "preview_profile", projectId: pub(projectId), profile: null, error: "Repo not cloned yet — run Set up preview first." });
    return;
  }

  const prior = await loadAppProfile(projectId);
  const profile = await probeAppProfile({
    workspaceId,
    userId,
    onLog: (l, d) => plog(projectId, userId, l, d ? { detail: d } : undefined),
  });
  if (!profile) {
    plog(projectId, userId, "Re-probe produced no profile.", { level: "error" });
    broadcastToUser(userId, { type: "preview_profile", projectId: pub(projectId), profile: null, error: "The probe produced nothing — check the logs." });
    return;
  }
  // Keep hard-won learnings across the re-probe.
  if (prior?.profile.learnings?.length) profile.learnings = [...prior.profile.learnings, ...(profile.learnings ?? [])].slice(-40);
  await saveAppProfile(projectId, profile);
  // Refresh the derived manifest so the next run uses the new plan.
  const manifest = deriveManifestFromProfile(profile);
  await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
  plog(projectId, userId, "Re-probe complete — profile updated.");
  broadcastToUser(userId, { type: "preview_profile", projectId: pub(projectId), profile });
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
 * every ticket that has a feature branch we can preview. Two sources:
 *  - live git worktrees in THIS sandbox (shared builds), and
 *  - tickets that were BUILT + PUSHED (isolated builds) — those run in a
 *    throwaway VM that's since destroyed, so there's no local worktree row, but
 *    the branch lives on the remote and the preview reconstructs it on select.
 * Powers the preview branch selector.
 */
export async function getPreviewBranches(projectId: string): Promise<Array<{ id: string; label: string; ticketId: string | null; branch: string }>> {
  const out: Array<{ id: string; label: string; ticketId: string | null; branch: string }> = [
    { id: "default", label: "Default branch", ticketId: null, branch: "(default)" },
  ];
  const seen = new Set<string>();
  const add = (ticketId: string, name: string | null, key: string | null, branch: string) => {
    if (!ticketId || seen.has(ticketId)) return;
    seen.add(ticketId);
    const label = `${key ? key + " — " : ""}${name ?? "ticket"}`.slice(0, 60);
    out.push({ id: ticketId, label, ticketId, branch });
  };

  // 1) Ticket worktrees are recorded as sandbox rows (workspaceType
  // "ticket-worktree") pointing at this project's preview workspace.
  const wtRows = await db
    .select({ ticketId: sandboxes.ticketId, name: projectTickets.name, key: projectTickets.ticketKey })
    .from(sandboxes)
    .leftJoin(projectTickets, eq(sandboxes.ticketId, projectTickets.id))
    .where(and(eq(sandboxes.projectId, projectId), eq(sandboxes.workspaceType, "ticket-worktree")));
  for (const r of wtRows) if (r.ticketId) add(r.ticketId, r.name, r.key, `feature/ticket-${r.ticketId}`);

  // 2) Tickets that were built + pushed (isolated builds destroy their VM, so
  // there's no worktree row — but the branch exists on the remote).
  const builtRows = await db
    .select({ id: projectTickets.id, name: projectTickets.name, key: projectTickets.ticketKey, branch: projectTickets.githubBranch })
    .from(projectTickets)
    .where(and(
      eq(projectTickets.projectId, projectId),
      or(isNotNull(projectTickets.githubBranch), isNotNull(projectTickets.githubCommitSha)),
    ));
  for (const r of builtRows) add(r.id, r.name, r.key, r.branch || `feature/ticket-${r.id}`);

  return out;
}

/**
 * Compute the git diff of a ticket's feature branch vs a base branch (default
 * main), using the sandbox's clone (which has all remote branches fetched).
 * Returns the branch list (for the base selector), per-file +/- counts, and the
 * unified diff text. `base...head` = what this ticket changed since it diverged.
 */
export async function getTicketDiff(projectId: string, ticketId: string, base: string): Promise<{
  branches: string[]; base: string; head: string;
  files: Array<{ path: string; added: number; removed: number }>; diff: string;
  commits: Array<{ sha: string; when: number; subject: string }>; error?: string;
}> {
  // Prefer the ticket's actually-pushed branch; fall back to the convention.
  const [tk] = await db.select({ gb: projectTickets.githubBranch }).from(projectTickets).where(eq(projectTickets.id, ticketId));
  const head = tk?.gb || `feature/ticket-${ticketId}`;
  const b = (base || "main").replace(/[^\w./-]/g, "") || "main";
  let workspaceId: string;
  try { ({ workspaceId } = await ensureProjectSandbox(projectId)); }
  catch { return { branches: [], base: b, head, files: [], diff: "", commits: [], error: "No preview sandbox yet — open the Preview tab and set it up first." }; }

  // Isolated builds push the branch from a throwaway VM that's since destroyed,
  // so this long-lived preview sandbox has no local copy. Fetch it from the
  // remote first — with auth, since the repo may be private (GitLab/GitHub).
  const auth = await resolveAuthedRepoUrl(projectId);
  const authUrl = "error" in auth ? "" : auth.authUrl;

  const script = `
cd ${PROJECT_DIR} 2>/dev/null || { echo "NO_REPO"; exit 1; }
[ -e .git ] || { echo "NO_REPO"; exit 1; }
${authUrl ? `git remote set-url origin "${authUrl}" 2>/dev/null || true` : ""}
git fetch --no-tags origin "${head}" "${b}" >/dev/null 2>&1 || true
git fetch origin --prune >/dev/null 2>&1 || true
echo "===BRANCHES==="
git for-each-ref --format='%(refname:short)' refs/remotes/origin 2>/dev/null | sed 's#^origin/##' | grep -v '^HEAD$' | sort -u
echo "===REFS==="
BASE=$(git rev-parse --verify -q origin/${b} >/dev/null 2>&1 && echo origin/${b} || echo ${b})
HEAD=$(git rev-parse --verify -q origin/${head} >/dev/null 2>&1 && echo origin/${head} || echo ${head})
git rev-parse --verify -q "$HEAD" >/dev/null 2>&1 || { echo "NO_HEAD"; exit 0; }
echo "===COMMITS==="
git log --format='%h|%ct|%s' "$BASE".."$HEAD" 2>/dev/null | head -100
echo "===NUMSTAT==="
git diff --numstat "$BASE"..."$HEAD" 2>/dev/null | head -500
echo "===DIFF==="
git diff "$BASE"..."$HEAD" 2>/dev/null | head -c 300000
`;
  const { output } = await sh(workspaceId, script, 90_000);
  if (output.includes("NO_REPO")) return { branches: [], base: b, head, files: [], diff: "", commits: [], error: "The repo isn't cloned in the sandbox — set up the preview first." };
  const sect = (name: string) => {
    const start = output.indexOf(`===${name}===`);
    if (start < 0) return "";
    const from = start + `===${name}===`.length;
    const rest = output.slice(from);
    const next = rest.search(/\n===[A-Z]+===/);
    return (next < 0 ? rest : rest.slice(0, next)).trim();
  };
  const branches = sect("BRANCHES").split("\n").map((s) => s.trim()).filter(Boolean);
  if (output.includes("NO_HEAD")) return { branches, base: b, head, files: [], diff: "", commits: [], error: `Branch ${head} not found — rebuild the ticket to create/push it.` };
  const commits = sect("COMMITS").split("\n").filter(Boolean).map((l) => {
    const [sha, ct, ...rest] = l.split("|");
    return { sha: (sha || "").trim(), when: parseInt(ct || "0", 10) || 0, subject: rest.join("|").trim() };
  }).filter((c) => c.sha);
  const files = sect("NUMSTAT").split("\n").filter(Boolean).map((l) => {
    const parts = l.split("\t"); const added = parseInt(parts[0]!, 10); const removed = parseInt(parts[1]!, 10);
    return { path: parts.slice(2).join("\t"), added: isNaN(added) ? 0 : added, removed: isNaN(removed) ? 0 : removed };
  }).filter((f) => f.path);
  const diff = output.split("===DIFF===")[1]?.trim() || "";
  return { branches, base: b, head, files, diff, commits };
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
  const savedProfile = await loadAppProfile(projectId);
  const configNotes = savedProfile ? profileNotes(savedProfile.profile) : [];
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
    const [projRow] = await db.select({ mode: projects.previewBranchMode }).from(projects).where(eq(projects.id, projectId));
    const checkoutMode = (projRow?.mode || "worktree") === "checkout";
    if (ticketId) {
      // The remote branch: the ticket's recorded branch, else the convention.
      const [tk] = await db.select({ gb: projectTickets.githubBranch }).from(projectTickets).where(eq(projectTickets.id, ticketId));
      const remoteBranch = tk?.gb || `feature/ticket-${ticketId}`;
      branchLabel = remoteBranch;
      const auth = await resolveAuthedRepoUrl(projectId);
      if ("error" in auth) { await setStep("locate", "failed"); return failed(projectId, userId, auth.error); }

      if (checkoutMode) {
        // CHECKOUT mode: run the branch by SWITCHING the single main checkout to it
        // — no worktree dirs pile up. Stash local (tracked) changes first so the
        // workstation stays clean; .env (gitignored) is preserved. Stop the app so
        // we can switch source cleanly.
        runDir = PROJECT_DIR;
        await setPreview(projectId, userId, { previewStatus: "starting", previewBranch: remoteBranch }, `Switching to ${remoteBranch}…`);
        plog(projectId, userId, `Preview mode "checkout": stashing local changes + switching the main checkout to ${remoteBranch}…`);
        const sw = await sh(workspaceId, `
cd ${PROJECT_DIR} 2>/dev/null || { echo NO_MAIN; exit 0; }
git remote set-url origin "${auth.authUrl}" 2>/dev/null
fuser -k ${manifest.port}/tcp 2>/dev/null; pkill -f ':${manifest.port}' 2>/dev/null; sleep 1
git stash push -m lfg-preview-autostash 2>&1 | tail -1
git fetch --no-tags origin "${remoteBranch}" 2>&1 | tail -3
git checkout -B "${remoteBranch}" "origin/${remoteBranch}" 2>&1 | tail -3
# Nuke stale build output so Release recompiles the Razor views (see worktree path).
rm -rf ${PROJECT_DIR}/bin ${PROJECT_DIR}/obj ${PROJECT_DIR}/*/bin ${PROJECT_DIR}/*/obj ${PROJECT_DIR}/*/*/bin ${PROJECT_DIR}/*/*/obj 2>/dev/null || true
echo "HEAD=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
`, 240_000);
        if (sw.output.includes("NO_MAIN")) { await setStep("locate", "failed"); return failed(projectId, userId, `The base checkout isn't set up on this sandbox yet — run the default-branch preview once, then preview this ticket.`); }
        if (!sw.output.includes(`HEAD=${remoteBranch}`)) { await setStep("locate", "failed"); return failed(projectId, userId, `Couldn't switch the checkout to \`${remoteBranch}\` — is the branch pushed?\n\n${sw.output.slice(-500)}`); }
        plog(projectId, userId, `Main checkout is now on ${remoteBranch} ✓ (local changes stashed)`);
      } else {
        // WORKTREE mode (default): a separate dir; the main checkout is untouched.
        runDir = ticketWorktreeDir(ticketId);
        // ALWAYS fetch + hard-sync the worktree to the LATEST pushed commit — an
        // existing worktree can be at a STALE commit (the ticket was rebuilt), which
        // is why "I don't see the new changes". Also repair the INVERTED layout where
        // the main checkout (/data/project) is sitting ON the ticket branch (a prior
        // build ran in the preview VM and switched it) — that blocks `git worktree add`.
        await setPreview(projectId, userId, { previewStatus: "starting", previewBranch: remoteBranch }, `Syncing ${remoteBranch} to the latest commit…`);
        plog(projectId, userId, `Preparing worktree for ${remoteBranch} (fetch + sync to the latest pushed commit)…`);
        const prep = await sh(workspaceId, `
cd ${PROJECT_DIR} 2>/dev/null || { echo NO_MAIN; exit 0; }
git remote set-url origin "${auth.authUrl}" 2>/dev/null
git fetch --no-tags --force origin "${remoteBranch}" 2>&1 | tail -3
# If the MAIN checkout is on the target branch (inverted/corrupted), move it back to
# the default branch so the branch is free to own in a worktree.
CUR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$CUR" = "${remoteBranch}" ]; then
  git remote set-head origin -a >/dev/null 2>&1
  DEF=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's@^origin/@@'); [ -z "$DEF" ] && DEF=main
  git checkout -f "$DEF" 2>&1 | tail -1 || true
fi
git worktree prune 2>/dev/null
if [ -e "${runDir}/.git" ]; then
  # Existing worktree → hard-reset to the LATEST pushed commit (picks up new changes).
  git -C "${runDir}" fetch --no-tags --force origin "${remoteBranch}" 2>&1 | tail -1
  git -C "${runDir}" reset --hard "origin/${remoteBranch}" 2>&1 | tail -2
  git -C "${runDir}" clean -fd 2>&1 | tail -1
else
  rm -rf "${runDir}" 2>/dev/null
  git worktree add -f -B "${remoteBranch}" "${runDir}" "origin/${remoteBranch}" 2>&1 | tail -4
fi
# CRITICAL: remove stale build output. In Release, ASP.NET compiles .cshtml Razor
# views INTO <App>.Views.dll at BUILD time — an incremental build can keep serving
# the OLD compiled views (the page renders old code even though the source is new).
# bin/obj are gitignored, so 'git clean -fd' does NOT remove them; nuke them so the
# rebuild recompiles the views. (NuGet cache lives on /data, so restore stays fast.)
rm -rf ${runDir}/bin ${runDir}/obj ${runDir}/*/bin ${runDir}/*/obj ${runDir}/*/*/bin ${runDir}/*/*/obj 2>/dev/null || true
echo "cleaned build output (bin/obj) so Razor views recompile"
test -e "${runDir}/.git" && echo "WT_OK $(git -C "${runDir}" log -1 --oneline 2>/dev/null)" || echo WT_FAIL
`, 240_000);
        if (prep.output.includes("NO_MAIN")) {
          await setStep("locate", "failed");
          return failed(projectId, userId, `The base checkout isn't set up on this sandbox yet — run the default-branch preview once, then preview this ticket.`);
        }
        if (!prep.output.includes("WT_OK")) {
          await setStep("locate", "failed");
          return failed(projectId, userId, `Couldn't prepare the ticket branch \`${remoteBranch}\` — is it pushed? Rebuild the ticket to (re)create it.\n\n${prep.output.slice(-600)}`);
        }
        const headLine = prep.output.match(/WT_OK\s+(.+)/)?.[1]?.trim();
        plog(projectId, userId, `Worktree ready on ${remoteBranch} ✓ (HEAD: ${headLine || "synced to origin"})`);
        // Share the preview's DB creds/run config: copy the default .env into the worktree.
        await sh(workspaceId, `cp ${PROJECT_DIR}/.env ${runDir}/.env 2>/dev/null || true; echo env`, 20_000);
      }
    } else {
      // Default branch. In CHECKOUT mode the main checkout may currently be on a
      // ticket branch (from a prior branch preview) — switch it back to the default.
      if (checkoutMode) {
        plog(projectId, userId, "Ensuring the main checkout is on the default branch…");
        await sh(workspaceId, `
cd ${PROJECT_DIR} 2>/dev/null || exit 0
fuser -k ${manifest.port}/tcp 2>/dev/null; pkill -f ':${manifest.port}' 2>/dev/null; sleep 1
git stash push -m lfg-preview-autostash 2>&1 | tail -1
git remote set-head origin -a >/dev/null 2>&1
DEF=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's@^origin/@@'); [ -z "$DEF" ] && DEF=main
git checkout "$DEF" 2>&1 | tail -2 || git checkout master 2>&1 | tail -2
echo "HEAD=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
`, 120_000);
      }
      plog(projectId, userId, "Restarting the app server (default branch)…");
    }
    await setStep("locate", "done");

    // Deterministic RULE: repoint every non-local SQL connection in the run dir's
    // appsettings*.json (Web, Admin, …) to the provisioned local MSSQL, so a fresh
    // branch checkout doesn't crash on a hardcoded dead host (e.g. Admin still
    // pointing at SHABEER on the branch). Runs on the worktree OR the switched checkout.
    if ((manifest.databases || []).some((d) => d.engine === "mssql")) {
      const ms = await ensureEngine(projectId, "mssql").catch(() => null);
      const rw = ms ? buildAppsettingsRewriteScript([ms], runDir) : "";
      if (rw) { const r = await sh(workspaceId, rw, 60_000).catch(() => ({ output: "" })); plog(projectId, userId, "Repointed appsettings SQL connections → local MSSQL", { detail: (r.output || "").slice(-400) }); }
    }
    // Re-apply persisted config-file patches to the run dir — this is what makes a
    // branch switch / worktree / fresh checkout inherit the connection repoints etc.
    // (they'd otherwise be reset by the checkout), so branches don't re-investigate.
    if (savedProfile?.profile.configPatches?.length) {
      const patchScript = buildConfigPatchScript(savedProfile.profile.configPatches, runDir);
      if (patchScript) { await sh(workspaceId, patchScript, 60_000).catch(() => {}); plog(projectId, userId, `Re-applied ${savedProfile.profile.configPatches.length} saved config patch(es) to ${runDir === PROJECT_DIR ? "the checkout" : "the worktree"}`); }
    }

    await setStep("run", "running");
    const startingMsg = ticketId ? `Starting the preview on ${branchLabel}…` : "Restarting the app…";
    await setPreview(projectId, userId, { previewStatus: "starting", previewError: null, previewBranch: branchLabel }, startingMsg);
    const compiled = !!manifest.buildCmd || /dotnet|asp|java|go|rust|maven|gradle/i.test(`${manifest.runtime} ${manifest.framework}`);

    // FAST DETERMINISTIC PATH: run the RECORDED build + run commands directly (they're
    // known-good from the last successful setup, and the deps/DB/config are already
    // set up on the persistent disk). Only if one of them ERRORS do we hand off to the
    // AI driver — so a normal restart just builds (incremental, fast) + runs, instead
    // of the driver re-investigating the whole plan (restore/migrate/PATH) every time.
    let up = false;
    let buildFailed = false;
    if (compiled && manifest.buildCmd) {
      // Localize any hardcoded /data/project paths in the recorded build to THIS run
      // dir, so a branch worktree build acts on the worktree (not on main's files).
      const buildCmd = localizeCmd(manifest.buildCmd, runDir);
      plog(projectId, userId, `Building (recorded): ${buildCmd}`);
      const br = await runDetachedPolled(projectId, userId, workspaceId, buildCmd, 1_200_000, { stallMs: 240_000, workDir: runDir });
      if (br.exitCode !== 0) {
        buildFailed = true;
        plog(projectId, userId, `Recorded build failed (exit ${br.exitCode}) — handing to the AI driver to investigate`, { level: "error", detail: br.output.slice(-1200) });
      } else {
        plog(projectId, userId, "Build ✓");
      }
    }
    if (!buildFailed) {
      plog(projectId, userId, `Starting the app from ${branchLabel}…`);
      await runDetachedPolled(projectId, userId, workspaceId, appStartCommand(manifest, runDir), 30_000);
      up = await waitForAppUp(projectId, userId, workspaceId, manifest.port, `${runDir}/preview.log`, ticketId ? 120_000 : 90_000);
    }

    // The port we'll actually expose. Normally manifest.port, but see the
    // port-mismatch self-heal below (a .NET app that ignores ASPNETCORE_URLS).
    let effectivePort = manifest.port;

    // SELF-HEAL: the app may be RUNNING but on a different port than we asked for
    // — e.g. a .NET app whose appsettings `Kestrel:Endpoints`/`applicationUrl`
    // overrides ASPNETCORE_URLS, so it binds (say) 5123 while the proxy on 5000
    // sees nothing ("app is up in the logs, but the URL errors out"). Read the
    // port the app ITSELF announced; if it's different and reachable, expose THAT
    // instead of failing. Generic — works whatever set the port (config or code).
    if (!up) {
      const bound = await detectBoundPorts(workspaceId, `${runDir}/preview.log`);
      const alt = bound.find((p) => p !== manifest.port && ![80, 443].includes(p));
      if (alt && await checkServer(workspaceId, alt, 2)) {
        effectivePort = alt;
        up = true;
        plog(projectId, userId, `App bound port ${alt} (not ${manifest.port}) — likely an appsettings Kestrel/applicationUrl override of ASPNETCORE_URLS. Exposing ${alt} instead.`, { level: "info" });
      }
    }

    // Only if the recorded build/run didn't bring it up → hand off to the driver to
    // investigate (it reuses the warm toolchain/cache/DB + persisted fixes, streams
    // its steps, fixes what's actually broken, and persists new fixes via setEnv).
    if (!up) {
      const driver = await resolveDriverModel(userId);
      if (driver) {
        plog(projectId, userId, "Recorded build/run didn't bring the app up — handing to the AI driver to investigate…");
        await setPreview(projectId, userId, { previewStatus: "starting", previewBranch: branchLabel }, `Investigating & starting ${branchLabel} (AI driver)…`);
        up = await driveSandbox(projectId, userId, workspaceId, manifest, [], driver.model, runDir, configNotes);
      }
    }
    if (!up) {
      await setStep("run", "failed");
      const bound = await detectBoundPorts(workspaceId, `${runDir}/preview.log`);
      const portNote = bound.length ? `\n\nThe app's log says it's listening on port ${bound.join(", ")} — but the preview expects ${manifest.port}. It's probably binding a port from appsettings (Kestrel:Endpoints/applicationUrl) or code (UseUrls) that overrides ASPNETCORE_URLS=…:${manifest.port}. Point it at ${manifest.port}.` : "";
      const tail = await sh(workspaceId, `tail -40 ${runDir}/preview.log 2>/dev/null`, 20_000).catch(() => ({ output: "" }));
      plog(projectId, userId, `The app did not come up on port ${manifest.port}${bound.length ? ` (it bound ${bound.join(", ")})` : ""}`, { level: "error", detail: (tail.output || "(no output — the app may have failed to build)").slice(-1500) });
      return failed(projectId, userId, `The app did not come back up on port ${manifest.port}.${portNote}\n\n${(tail.output || "").slice(-800)}`);
    }
    await setStep("run", "done");
    plog(projectId, userId, `App running ✓ (${branchLabel}${effectivePort !== manifest.port ? ` on port ${effectivePort}` : ""})`);
    // Re-expose (idempotent) and mark running — on the port the app actually bound.
    await enableHttpAccess(workspaceId, effectivePort).catch(() => {});
    const alias = row.stableAlias || randomAlias();
    let previewUrl = row.appUrl || "";
    try { previewUrl = await setStableUrl(alias, workspaceId); } catch { /* keep existing */ }
    await setPreview(projectId, userId, { previewStatus: "running", appUrl: previewUrl, appPort: effectivePort, previewError: null, previewBranch: branchLabel }, "Preview is live");
    // Post-run verification (URL + assets + DB) → publish the launch summary to chat.
    const vManifest = effectivePort === manifest.port ? manifest : { ...manifest, port: effectivePort };
    const v = await verifyPreview(projectId, userId, workspaceId, vManifest, branchLabel).catch(() => null);
    if (v) await publishSummary(userId, opts.conversationId, `${v.summary}\n\n🔗 ${previewUrl}`).catch(() => {});
    // Self-heal broken assets via the agent (opt-in through directives), then re-summarize.
    if (v?.broken?.length) {
      const healed = await healBrokenAssets(projectId, userId, opts.conversationId, workspaceId, vManifest, branchLabel, v.broken).catch(() => null);
      if (healed) await publishSummary(userId, opts.conversationId, `${healed.summary}\n\n🔗 ${previewUrl}`).catch(() => {});
    }
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
