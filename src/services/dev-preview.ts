import {assertPreviewBranch,previewCheckoutDir,refreshPreviewCheckout,runtimeFingerprintCommand,cleanPreviewBuildCommand,cachedInstallCommand} from './preview-checkout.ts';
import { backgroundProcessSchema, discoverBackgroundProcesses, previewWorkerCommand } from "./preview-workers.ts";
import { compilePreviewInspection } from './preview-inspection-command.ts';
import {DEVELOPMENT_ACCESS_INSTRUCTION} from '../ai/prompts/development-access.ts';
import { ensureManagedDatabaseWithRecovery } from "./managed-database-recovery.ts";
import { DEVELOPMENT_DATABASE_RECOVERY_INSTRUCTION } from "./development-database-recovery-policy.ts";
import { PreviewRecoveryBudget } from "./preview-recovery-budget.ts";
import { executeSandboxScript } from "./sandbox-script.ts";
import { targetedSqlCommand } from "./preview-sql-target.ts";
import { PREVIEW_SOURCE_POLICY, previewPublicationBlocked, assertPreviewRuntimePatches } from "./preview-source-policy.ts";
import { replaceVerifiedPatches, consolidatePatchScript } from "./preview-patch-recovery.ts";
import { databaseRecoveryScripts, backupThenReset } from "./preview-db-recovery.ts";
import { compileRuntimePlan, previewAvailabilityCommand } from "./runtime-plan.ts";
import { UNSAFE_ENV_KEYS, environmentFingerprint, environmentChanges, requiresEnvironmentBuild, environmentPatchCommand } from "./preview-environment.ts";
import { restartWorktree, restartServerCommand, waitForRestart } from "./preview-restart.ts";
import { PreviewRunQueue } from "./preview-run-queue.ts";
import { previewDataTools, previewDataWorkspaceCommand, PREVIEW_DATA_INSTRUCTION, PREVIEW_DATA_MAINTENANCE_INSTRUCTION } from "./preview-data-operations.ts";
import { PreviewWorkerMaintenance } from './preview-worker-maintenance.ts';
import { branchDatabaseScript } from "./preview-isolation.ts";
import { validateSchemaTargets, assetCaseCheck, schemaStepSchema, replayActionSchema, orderedSchema, mergeKnowledge, failureSummary, failureKey, executeSteps, shellQuote, type PlanStep } from "./preview-plan.ts";
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
import { githubTicketDiff, parseAuthedGithubUrl } from "./ticket-diff-github.ts";
import { z } from "zod";
import { generateObject, generateText, stepCountIs, tool, zodSchema, type LanguageModel } from "ai";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projects, projectEnvironmentVariables } from "../db/schema/projects.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { epics } from "../db/schema/epics.ts";
import { projectDatabases } from "../db/schema/project-databases.ts";
import { githubTokens, llmApiKeys } from "../db/schema/users.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { getValidGitlabToken } from "./gitlab-token.ts";
import { resolveGitActor } from "./git-access.ts";
import { resolveLlmGrants, llmKeyUserId } from "./llm-access.ts";
import { getModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { decryptSecret, encryptSecret } from "../utils/crypto.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { enableHttpAccess, execOnWorkspace, setStableUrl, startBrowserSession, stopWorkspace } from "./mags.ts";
import { ensureProjectSandbox, restartProjectSandbox, ensureDocker, envWorkspaceId, checkEngineHealth, listSandboxEngines, ENGINES, type EngineHandle, type DbEngine } from "./project-sandbox.ts";
import { probeAppProfile, saveAppProfile, loadAppProfile, deriveManifestFromProfile, syncDetectedEnv, applyProfileCorrection, recordProfileLearning, recordDirective, buildConfigPatchScript, profileNotes, resolveUserModel, appProfileSchema, type AppProfile } from "./app-profile.ts";
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
  backgroundProcesses: z.array(backgroundProcessSchema).optional().describe("Required long-running background workers, schedulers or queue consumers found in repository scripts/configuration. Managed with the web app using the same selected-checkout environment. Do not launch these from install, build, seed or replay actions. Omit if none."),
  services: z.array(z.object({
    name: z.string().describe("Short slug for this app, e.g. 'web', 'admin', 'api'. Used for its subdomain (preview-<hash>-<name>) and env var (<NAME>_BASE_URL)."),
    runCmd: z.string().describe("Command to START this app in the FOREGROUND on ITS port, bound to 0.0.0.0."),
    buildCmd: z.string().optional().describe("Build step for THIS app if not covered by the shared buildCmd (e.g. a distinct .csproj). '' when the shared build already produces it."),
    port: z.number().describe("This app's real port (from launchSettings/appsettings/run scripts)."),
    primary: z.boolean().optional().describe("true for the MAIN app — it gets the default preview URL and always runs. Exactly ONE service is primary."),
    enabled: z.boolean().optional().describe("Companions default false (off); the user toggles them on. The primary is always run regardless."),
    dir: z.string().optional().describe("Subfolder (relative to the repo root) this app runs from, e.g. 'apps/admin'. Omit when it runs from the repo root."),
    manual: z.boolean().optional().describe("true when a user added this app by hand (not auto-detected) — so the UI offers Remove."),
  })).optional().describe("MULTIPLE runnable apps in ONE repo (monorepo — e.g. a public site + an admin portal that run on different ports). Populate this ONLY when the repo genuinely has 2+ separately-runnable web apps; OMIT it for a normal single-app repo (runCmd/port cover that). Skip class libraries. The primary runs by default; each companion is toggled on and gets its own subdomain bound to its port."),
  databases: z.array(z.object({
    engine: z.enum(["postgres", "mysql", "redis", "mssql"]).describe("The DB engine to provision — use the app's REAL engine. 'mssql' = Microsoft SQL Server (run via Docker) — pick it for EF Core SqlServer / T-SQL apps. Do NOT downgrade SQL Server to postgres; they are not wire-compatible."),
    databaseName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    connectionEnvVar: z.string().describe("The EXACT env var / .NET config key the app reads its connection from. ASP.NET Core with appsettings ConnectionStrings:DefaultConnection → 'ConnectionStrings__DefaultConnection'. Rails/Node/Django with a URL → 'DATABASE_URL'. Redis → 'REDIS_URL'."),
    connectionFormat: z.enum(CONN_FORMATS).describe("How to FORMAT the connection string for that var: 'url' = scheme://user:pw@host:port/db (Node/Python/Rails/Prisma); 'dotnet-npgsql' = 'Host=..;Port=..;Database=..;Username=..;Password=..' (.NET+Postgres); 'dotnet-mysql' = 'Server=..;Port=..;Database=..;Uid=..;Pwd=..'; 'dotnet-sqlserver'; 'keyvalue' generic."),
  })).describe("Every database the app connects to AND how it connects — read appsettings*.json ConnectionStrings, docker-compose services, ORM config (Prisma/EF/TypeORM/SQLAlchemy), DATABASE_URL in .env.example. [] if none."),
  schemaSteps: z.array(schemaStepSchema).optional(),
  replayActions: z.array(replayActionSchema).optional(),
  verificationPaths: z.array(z.string().regex(/^\/(?!\/)/)).optional(),
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
export type ServiceSpec = NonNullable<PreviewManifest["services"]>[number];

// ── Small helpers ────────────────────────────────────────────────────────
async function sh(workspaceId: string, script: string, timeout = 180_000): Promise<{ output: string; exitCode: number }> {
  const r = await executeSandboxScript(script, timeout, (command, commandTimeout) => execOnWorkspace(workspaceId, command, { timeout: commandTimeout })).catch(
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

// ── Serialize preview runs per project ──────────────────────────────────────
// setup/restart both build + run heavy things (git clone/fetch, npm/dotnet build,
// Docker) INSIDE one microVM. If a second run starts while the first is still
// churning — which is exactly what rapid branch-switching + Cancel + re-click does —
// the two clones/builds run concurrently and exhaust the VM's memory: `git-remote-
// https died of signal 11` (segfault/OOM) and Docker fails to start. Cancelling only
// flips a flag; it can't recall an already-dispatched execOnWorkspace. So a NEW run
// must signal the current one to abort, WAIT for it to actually unwind, and only then
// take over. The cancel flag is cleared for the new run ONLY after the old one has
// released — otherwise the new run's clear revives the run it just cancelled.
const previewRunQueue = new PreviewRunQueue();
async function acquirePreviewAccess(projectId:string):Promise<()=>void> {
  const release=await previewRunQueue.acquire(projectId);
  try {
    const releaseShared=(await import('./shared-lanes.ts')).reservePreviewProject(projectId);
    return ()=>{releaseShared();release();};
  }catch(e){release();throw e;}
}
async function acquirePreviewRun(projectId: string): Promise<() => void> {
  cancelledProjects.add(projectId);                 // tell the in-flight run (if any) to abort
  let release:()=>void;
  try { release=await acquirePreviewAccess(projectId); } catch(e) {cancelledProjects.delete(projectId);throw e;}
  cancelledProjects.delete(projectId);              // fresh flag for OUR run
  return release;
}

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

// Runtime/system vars the sandbox sets itself — never surface these as "app env".
const ENV_DENYLIST = new Set([
  "PORT", "HOST", "HOSTNAME", "PATH", "HOME", "PWD", "USER", "SHELL", "LANG", "LC_ALL", "TERM",
  "TMPDIR", "TMP", "TEMP", "NODE_ENV", "NODE_OPTIONS", "RAILS_ENV", "FLASK_ENV", "DJANGO_SETTINGS_MODULE",
  "PYTHONUNBUFFERED", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "ASPNETCORE_URLS", "ASPNETCORE_ENVIRONMENT",
  "ASPNETCORE_FORWARDEDHEADERS_ENABLED", "DOTNET_RUNNING_IN_CONTAINER", "DOTNET_CLI_TELEMETRY_OPTOUT",
  "CI", "VERCEL", "NUGET_PACKAGES", "GOPATH", "GOCACHE", "GEM_HOME", "BUNDLE_PATH",
  // Toolchain cache/install dirs — must stay on /data (never let a stored value send them to /root).
  "GOMODCACHE", "GOENV", "GOTMPDIR", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME",
  "UV_CACHE_DIR", "CARGO_HOME", "RUSTUP_HOME", "PLAYWRIGHT_BROWSERS_PATH", "PIP_CACHE_DIR",
  "COMPOSER_CACHE_DIR", "npm_config_cache", "NPM_CONFIG_CACHE", "DOTNET_CLI_HOME",
]);

/**
 * Deterministically scan the cloned repo for env-var READS (process.env.X, os.Getenv,
 * import.meta.env.X, ENV["X"], os.environ, .env.example keys, …) so setup never MISSES a
 * variable the app actually references just because the LLM detection didn't list it
 * (e.g. SENDGRID_API_KEY). Returns the UPPER_SNAKE keys found, minus runtime/system noise.
 * Best-effort — returns [] on any failure.
 */
async function grepEnvKeys(workspaceId: string): Promise<string[]> {
  const script = `
cd ${PROJECT_DIR} 2>/dev/null || exit 0
# Alpine's default grep is busybox (no --exclude-dir); install GNU grep so the scan works.
apk add --no-cache grep >/dev/null 2>&1 || true
{
grep -rhoE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=vendor --exclude-dir=dist --exclude-dir=build --exclude-dir=.next --exclude-dir=target \\
  -e 'process\\.env\\.[A-Za-z_][A-Za-z0-9_]*' \\
  -e 'process\\.env\\[.[A-Za-z_][A-Za-z0-9_]*' \\
  -e 'import\\.meta\\.env\\.[A-Za-z_][A-Za-z0-9_]*' \\
  -e '[gG]etenv\\(.[A-Za-z_][A-Za-z0-9_]*' \\
  -e 'LookupEnv\\(.[A-Za-z_][A-Za-z0-9_]*' \\
  -e 'environ\\[.[A-Za-z_][A-Za-z0-9_]*' \\
  -e 'environ\\.get\\(.[A-Za-z_][A-Za-z0-9_]*' \\
  -e 'ENV\\[.[A-Za-z_][A-Za-z0-9_]*' \\
  . 2>/dev/null
grep -rhoE '^[A-Za-z_][A-Za-z0-9_]*' .env.example .env.sample .env.template 2>/dev/null
} | head -5000
`.trim();
  const { output } = await sh(workspaceId, script, 45_000).catch(() => ({ output: "" }));
  const keys = new Set<string>();
  for (const line of (output || "").split("\n")) {
    const m = line.trim().match(/[A-Za-z_][A-Za-z0-9_]*$/); // trailing identifier = the env name
    if (!m) continue;
    const k = m[0];
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(k) && !ENV_DENYLIST.has(k)) keys.add(k);
  }
  return [...keys];
}

/**
 * Deterministic DB-engine detection — a backstop for the LLM plan, which sometimes
 * omits a database the app clearly needs (→ "none provisioned" and the app then gets
 * ECONNREFUSED). Reads the strong, unambiguous declaration files (ORM config, package
 * manifests, docker-compose, .env examples) and infers the engines from them. Returns
 * the engines found; the caller unions these into the manifest so they get provisioned.
 */
async function detectDbSignals(projectId: string, dir = PROJECT_DIR): Promise<DbEngine[]> {
  const workspaceId = await envWorkspaceId(projectId).catch(() => null);
  if (!workspaceId) return [];
  // Concatenate the declaration files (lower-cased) and pattern-match. Bounded output.
  const script = `cd ${dir} 2>/dev/null || exit 0
{ cat package.json requirements.txt pyproject.toml Gemfile go.mod 2>/dev/null;
  cat drizzle.config.* prisma/schema.prisma 2>/dev/null;
  cat docker-compose*.y*ml compose*.y*ml 2>/dev/null;
  cat .env .env.example .env.sample .env.template appsettings*.json 2>/dev/null;
} 2>/dev/null | tr 'A-Z' 'a-z' | head -c 200000`;
  const { output } = await sh(workspaceId, script, 20_000).catch(() => ({ output: "" }));
  const o = output || "";
  const engines: DbEngine[] = [];
  if (/"pg"|"postgres"|node-postgres|psycopg|pgx|postgresql:\/\/|postgres:\/\/|dialect:\s*["']?postgres|provider\s*=\s*"postgresql"|image:\s*["']?postgres|\bpostgres_(db|user|password)\b/.test(o)) engines.push("postgres");
  if (/"mysql2?"|mysql:\/\/|dialect:\s*["']?mysql|provider\s*=\s*"mysql"|image:\s*["']?mysql|\bmysql_(database|user|root_password)\b/.test(o)) engines.push("mysql");
  if (/"ioredis"|"redis"|redis:\/\/|image:\s*["']?redis|\bredis_url\b/.test(o)) engines.push("redis");
  if (/microsoft\.data\.sqlclient|system\.data\.sqlclient|server=.*(sql|mssql)|image:\s*["']?mcr\.microsoft\.com\/mssql/.test(o)) engines.push("mssql");
  return engines;
}

/** Pull host+port out of a connection string (URL form or .NET keyword form). */
function parseHostPort(conn: string): { host: string; port: string } | null {
  const url = conn.match(/\/\/(?:[^@/]*@)?([^:/?]+):(\d+)/); // scheme://user:pw@host:port/db
  if (url) return { host: url[1]!, port: url[2]! };
  const host = conn.match(/(?:Host|Server|Data Source)\s*=\s*([^;,]+)/i)?.[1]?.trim();
  const port = conn.match(/Port\s*=\s*(\d+)/i)?.[1] || conn.match(/(?:Server|Data Source)\s*=\s*[^;,]+,\s*(\d+)/i)?.[1];
  if (host) return { host: host.replace(/^tcp:/i, ""), port: port || "" };
  return null;
}

/**
 * Actually HIT the DB the connection string points at (TCP connect) to decide whether
 * it's a real, reachable database. Used to tell "user brought their own (reachable)
 * DB → don't provision" apart from "this is a localhost placeholder with nothing
 * listening → we must provision" — a stored DATABASE_URL existing is NOT proof a DB is
 * there. Returns true only if something is actually accepting connections on host:port.
 */
async function connectionReachable(workspaceId: string, conn: string, fallbackPort: number): Promise<boolean> {
  const hp = parseHostPort(conn);
  if (!hp) return false; // unparseable → treat as not reachable → provision
  const host = hp.host, port = hp.port || String(fallbackPort);
  const r = await sh(workspaceId, `(nc -z -w 3 ${host} ${port} 2>/dev/null && echo OPEN) || (timeout 3 sh -c ': < /dev/tcp/${host}/${port}' 2>/dev/null && echo OPEN) || echo CLOSED`, 15_000).catch(() => ({ output: "CLOSED" }));
  return (r.output || "").includes("OPEN");
}

/**
 * Decide whether to use a user-provided connection var (skip provisioning) vs provision
 * our own. Rule:
 *   • explicit "Use my DB" (provided) → respect the user's var.
 *   • auto + var points at LOCALHOST → NEVER trust it: it's a placeholder for the DB we
 *     own, and its creds are often blank/stale (→ SASL "client password must be a
 *     string" or "role app does not exist"). Provision ours and inject the real string.
 *   • auto + var points at an EXTERNAL host → hit it (TCP) to confirm it's reachable; if
 *     so it's the user's real DB → use it, else provision a local one.
 */
async function shouldUseProvidedDb(workspaceId: string, projectId: string, userId: string, dbSpec: PlannedDb, providedVal: string, dbMode: string): Promise<boolean> {
  if (!providedVal) {
    if (dbMode === "provided") plog(projectId, userId, `DB mode is "Use my DB" but ${dbSpec.connectionEnvVar} isn't set — set it in the Environment tab + Restart, or switch to auto.`, { level: "error" });
    return false;
  }
  if (dbMode === "provided") { plog(projectId, userId, `${dbSpec.engine}: using your provided ${dbSpec.connectionEnvVar} (Use-my-DB mode).`); return true; }
  const hp = parseHostPort(providedVal);
  const isLocal = !!hp && /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/i.test(hp.host);
  if (isLocal) { plog(projectId, userId, `${dbSpec.engine}: your ${dbSpec.connectionEnvVar} points at localhost — provisioning our own local DB and injecting its connection (ignoring the placeholder creds).`); return false; }
  const reachable = await connectionReachable(workspaceId, providedVal, ENGINES[dbSpec.engine].port).catch(() => false);
  plog(projectId, userId, `${dbSpec.engine}: probing your external ${dbSpec.connectionEnvVar} → ${reachable ? "reachable, using it (not provisioning)" : "NOT reachable, provisioning a local one"}.`);
  return reachable;
}

/**
 * Reconcile a manifest's `databases` before provisioning — the reliability layer behind
 * "the preview identifies the services and keeps them running". Unions:
 *   • STICKY — every engine already provisioned (projectDatabases row), so a flaky
 *     re-probe can never un-provision a DB the app depends on.
 *   • SIGNALS — engines with strong deterministic declarations in the repo the LLM plan
 *     missed (detectDbSignals).
 * Returns a manifest whose `databases` the normal provisioning path (setup or reapplyEnv
 * on restart) will bring up via ensureEngine + inject the connection var for. Persists
 * the reconciled manifest so it sticks.
 */
async function reconcileDatabases(projectId: string, userId: string, manifest: PreviewManifest, dir = PROJECT_DIR): Promise<PreviewManifest> {
  const have = new Map<string, PlannedDb>(manifest.databases.map((d) => [d.connectionEnvVar, d]));
  const before = have.size;
  const sticky = (await db.select({ engine: projectDatabases.engine }).from(projectDatabases).where(eq(projectDatabases.projectId, projectId))).map((r) => r.engine as DbEngine);
  const signals = await detectDbSignals(projectId, dir).catch(() => [] as DbEngine[]);
  // Always report what the DB check saw — so "why don't I see it checking DBs?" is answered.
  plog(projectId, userId, `Checking databases — plan lists: [${manifest.databases.map((d) => d.engine).join(", ") || "none"}], already provisioned: [${sticky.join(", ") || "none"}], detected in code: [${signals.join(", ") || "none"}].`);
  const defEnvVar: Record<DbEngine, string> = { postgres: "DATABASE_URL", mysql: "DATABASE_URL", redis: "REDIS_URL", mssql: "ConnectionStrings__DefaultConnection" };
  const defFmt: Record<DbEngine, PlannedDb["connectionFormat"]> = { postgres: "url", mysql: "url", redis: "keyvalue", mssql: "dotnet-sqlserver" };
  for (const e of new Set([...sticky, ...signals])) {
    if ([...have.values()].some(d => d.engine === e)) continue;
    have.set(defEnvVar[e], { engine: e, connectionEnvVar: defEnvVar[e], connectionFormat: defFmt[e] });
    plog(projectId, userId, `→ adding ${e} to the plan (${sticky.includes(e) ? "already provisioned" : "detected in code"}) — will provision it → ${defEnvVar[e]}.`);
  }
  if (have.size === before) return manifest;
  const reconciled = { ...manifest, databases: [...have.values()] };
  await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(reconciled), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId)).catch(() => {});
  return reconciled;
}

/**
 * Regenerate the app's .env from the CURRENT stored project env vars (+ reused DB
 * connections, honoring dbMode). Called on RESTART so keys the user just edited in the
 * Environment tab actually reach the app — writeEnvFile alone runs only in full setup.
 * ensureEngine is idempotent, so reusing an already-up DB is fast. Writes to the main
 * checkout's .env; the caller copies it into a worktree runDir if needed.
 */
async function reapplyEnv(projectId: string, userId: string, workspaceId: string, manifest: PreviewManifest): Promise<void> {
  const provisioned: Record<string, string> = {};
  if (manifest.databases.length) {
    const [projRow] = await db.select({ dbMode: projects.dbMode }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const dbMode = projRow?.dbMode ?? "auto";
    const providedVals = new Map(
      (await db.select({ key: projectEnvironmentVariables.key, v: projectEnvironmentVariables.encryptedValue })
        .from(projectEnvironmentVariables)
        .where(and(eq(projectEnvironmentVariables.projectId, projectId), eq(projectEnvironmentVariables.hasValue, true))))
        .map((r) => { let val = ""; try { val = decryptSecret(r.v); } catch { /* unreadable */ } return [r.key, val] as const; }),
    );
    for (const dbSpec of manifest.databases) {
      const providedVal = providedVals.get(dbSpec.connectionEnvVar) || "";
      const useProvided = await shouldUseProvidedDb(workspaceId, projectId, userId, dbSpec, providedVal, dbMode);
      if (useProvided) continue;
      plog(projectId, userId, `Starting ${dbSpec.engine} (docker) — pulling image + creating the container if needed…`);
      const h = await ensurePreviewEngine(projectId, userId, dbSpec.engine, dbSpec);
      if (h) { provisioned[dbSpec.connectionEnvVar] = formatConnection(dbSpec, h); plog(projectId, userId, `${dbSpec.engine} running ✓ (127.0.0.1:${h.port}) → ${dbSpec.connectionEnvVar} injected.`); }
    }
  }
  await writeEnvFile(workspaceId, projectId, manifest, provisioned);
  plog(projectId, userId, `Re-applied environment variables from your settings${Object.keys(provisioned).length ? ` (+${Object.keys(provisioned).length} DB connection var(s))` : ""}.`);
}

/**
 * Apply the DB schema on restart (migrations + seed). Setup runs these in its pipeline,
 * but a plain restart didn't — so after a FRESH DB (re)init the schema is empty and the
 * app 500s with 'relation "user" does not exist'. Idempotent commands (drizzle push /
 * migrate, prisma migrate deploy, CREATE IF NOT EXISTS) make this safe to run every time.
 * Falls back to a sensible ORM default when the plan gave no migration command. Runs in
 * runDir with .env sourced (DATABASE_URL) via envPrefix.
 */
/**
 * Tail the RUNNING app's own stdout/stderr (preview.log in the VM) — the app's live
 * runtime output (auth errors, email attempts, request logs), distinct from LFG's setup
 * driver log. Picks the most-recently-written preview.log (default checkout or a ticket
 * worktree). Best-effort — returns "" if the sandbox/log isn't reachable.
 */
export async function getAppRuntimeLog(projectId: string, lines = 500, service?: string): Promise<string> {
  try {
    const workspaceId = await envWorkspaceId(projectId);
    const {dir}=await resolvePreviewWorkDir(projectId,workspaceId);
    const row=await getEnv(projectId);const manifest=row?.setupManifest?JSON.parse(row.setupManifest) as PreviewManifest:null;
    const svc=service&&service!=='app'?service.replace(/[^\w-]/g,''):'';
    const files=[{label:svc||'Web server',file:svc?`preview-${svc}.log`:'preview.log'},...(!svc?(manifest?.backgroundProcesses||[]).map(w=>({label:`Worker: ${w.name}`,file:`preview-worker-${w.name}.log`})) :[])];
    const command=files.map(f=>`printf '%s\\n' ${shellQuote('── '+f.label+' ──')}; tail -n ${Math.min(1000,Math.max(1,lines))} ${shellQuote(dir+'/'+f.file)} 2>/dev/null || true`).join('\n');
    const {output}=await sh(workspaceId,command,20000);
    // The microVM was reaped (OOM/eviction) while the stored workspace id lingers → the exec
    // layer returns "no ... VM found". Make it actionable instead of cryptic.
    if (/no (running|sleeping|associated).*VM|no VM associated/i.test(output || "")) {
      return "The preview sandbox isn't reachable right now (its VM was reclaimed). Restart the preview (⋮ → Restart) to bring it back, then this log will fill in.";
    }
    return output || "";
  } catch {
    return "";
  }
}

/** Logs of each provisioned DB container (docker logs) — shown alongside the app log. */
export async function getDbLogs(projectId: string, lines = 200): Promise<Array<{ engine: string; log: string }>> {
  const workspaceId = await envWorkspaceId(projectId).catch(() => null);
  if (!workspaceId) return [];
  // Union the recorded rows with the containers actually present. An engine that came
  // up but never recorded its row still has logs worth reading — and showing its tab is
  // what puts a Reset DB button in reach of the person staring at the failure.
  const rows = await db.select({ engine: projectDatabases.engine }).from(projectDatabases).where(eq(projectDatabases.projectId, projectId));
  const live = await listSandboxEngines(workspaceId).catch(() => [] as DbEngine[]);
  const engines = [...new Set([...rows.map((r) => r.engine), ...live])].map((engine) => ({ engine }));
  const out: Array<{ engine: string; log: string }> = [];
  for (const { engine } of engines) {
    const container = ENGINES[engine as DbEngine]?.container;
    if (!container) continue;
    const r = await sh(workspaceId, `docker logs --tail ${lines} ${container} 2>&1 | tail -n ${lines}`, 20_000).catch(() => ({ output: "" }));
    out.push({ engine, log: (r.output || "").trim() || "(no output)" });
  }
  return out;
}

/**
 * Reset a provisioned database: remove its container + wipe its data dir so the next
 * run re-inits a FRESH cluster with our creds (migrations reseed). Then restart the
 * preview so it comes back up + re-migrates. `engine` optional → reset all.
 */
export async function resetDatabase(projectId: string, userId: string, engine?: string): Promise<{ ok: boolean; error?: string; reset: string[] }> {
  const workspaceId = await envWorkspaceId(projectId).catch(() => null);
  if (!workspaceId) return { ok: false, error: "No sandbox for this project yet.", reset: [] };
  // Reset has to reach containers the table doesn't know about — an engine that ran but
  // failed to record is exactly the one needing a wipe, and keying off rows alone left
  // it with no button anywhere in the UI.
  const rows = await db.select({ engine: projectDatabases.engine }).from(projectDatabases).where(eq(projectDatabases.projectId, projectId));
  const live = await listSandboxEngines(workspaceId).catch(() => [] as DbEngine[]);
  const all = [...new Set([...rows.map((r) => r.engine), ...live])] as DbEngine[];
  const targets = engine ? all.filter((e) => e === engine) : all;
  if (!targets.length) return { ok: false, error: "No provisioned database to reset.", reset: [] };
  await loadPublicId(projectId);
  for (const e of targets) {
    const spec = ENGINES[e];
    if (!spec) continue;
    plog(projectId, userId, `Resetting ${e} — removing the container and wiping ${spec.dataDir}…`, { level: "error" });
    await sh(workspaceId, `docker rm -f ${spec.container} 2>/dev/null; rm -rf ${spec.dataDir}/* ${spec.dataDir}/.[!.]* 2>/dev/null; echo reset_${e}`, 60_000).catch(() => {});
    // The row holds the password of a cluster that no longer exists. Drop it so the next
    // run provisions fresh rather than probing a new container with a stale credential.
    await db.delete(projectDatabases).where(and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.engine, e))).catch(() => {});
  }
  // Restart re-provisions (fresh initdb with our creds) + re-runs migrations to reseed.
  restartPreview(projectId, { userId }).catch((e) => console.error("[preview] reset-db restart failed:", e));
  return { ok: true, reset: targets };
}

/** Detect (or re-detect) the setup manifest. Merges project custom overrides. */
/** The exact JSON shape we want back — spelled out for models that don't do native
 *  structured output, so they don't return e.g. envVars as an object or drop a field. */
const MANIFEST_SHAPE = `{
  "stack": "string", "runtime": "string", "framework": "string",
  "toolchain": ["string"], "installCmd": "string", "buildCmd": "string",
  "startupProject": "string", "runCmd": "string", "port": 3000,
  "databases": [{ "engine": "postgres|mysql|redis|mssql", "connectionEnvVar": "string", "connectionFormat": "url|dotnet-npgsql|dotnet-mysql|dotnet-sqlserver|keyvalue" }],
  "migrations": ["string"], "sqlScripts": ["string"], "seedCmd": "string",
  "envVars": [{ "key": "string", "required": true, "description": "string" }]
}`;

/** Coerce a model's loosely-shaped JSON toward the manifest schema before strict Zod
 *  validation — weak models drop required fields or return arrays as objects. This fixes
 *  the common deviations (envVars object→array, missing connectionEnvVar, string port,
 *  bad enum) so an otherwise-good plan isn't rejected over a formatting nit. */
function coerceManifest(raw: any): unknown {
  const o = raw && typeof raw === "object" ? raw : {};
  const str = (v: any, d = "") => (typeof v === "string" ? v : v == null ? d : String(v));
  const strArr = (v: any) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);

  let envVars: any[] = [];
  if (Array.isArray(o.envVars)) {
    envVars = o.envVars.map((e: any) =>
      typeof e === "string"
        ? { key: e, required: false, description: "" }
        : { key: str(e?.key), required: !!e?.required, description: str(e?.description) },
    );
  } else if (o.envVars && typeof o.envVars === "object") {
    envVars = Object.entries(o.envVars).map(([key, v]: [string, any]) => ({
      key,
      required: v && typeof v === "object" ? !!v.required : false,
      description: v && typeof v === "object" ? str(v.description) : str(v),
    }));
  }
  envVars = envVars.filter((e) => e.key);

  const VALID_ENGINES = ["postgres", "mysql", "redis", "mssql"];
  const databases = (Array.isArray(o.databases) ? o.databases : [])
    .map((d: any) => ({
      engine: VALID_ENGINES.includes(d?.engine) ? d.engine : undefined,
      connectionEnvVar: str(d?.connectionEnvVar, "DATABASE_URL"),
      connectionFormat: (CONN_FORMATS as readonly string[]).includes(d?.connectionFormat) ? d.connectionFormat : "url",
    }))
    .filter((d: any) => d.engine);

  // services[] — only kept when it names 2+ runnable apps (a single "service" is just the
  // normal single-app path, so we drop it). name → a safe subdomain slug; exactly one primary.
  const slug = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  let services = (Array.isArray(o.services) ? o.services : [])
    .map((s: any) => ({
      name: slug(str(s?.name)),
      runCmd: str(s?.runCmd),
      buildCmd: str(s?.buildCmd) || undefined,
      port: typeof s?.port === "number" ? s.port : parseInt(str(s?.port), 10) || 0,
      primary: !!s?.primary,
      enabled: s?.enabled === undefined ? undefined : !!s.enabled,
    }))
    .filter((s: any) => s.name && s.runCmd && s.port);
  if (services.length < 2) {
    services = undefined; // single (or zero) app → the plain runCmd/port path
  } else if (!services.some((s: any) => s.primary)) {
    services[0].primary = true; // guarantee exactly one primary
  }

  return {
    stack: str(o.stack),
    runtime: str(o.runtime),
    framework: str(o.framework),
    toolchain: strArr(o.toolchain),
    installCmd: str(o.installCmd),
    buildCmd: str(o.buildCmd),
    startupProject: str(o.startupProject),
    runCmd: str(o.runCmd),
    port: typeof o.port === "number" ? o.port : parseInt(str(o.port), 10) || DEFAULT_PORT,
    services,
    databases,
    migrations: strArr(o.migrations),
    sqlScripts: strArr(o.sqlScripts),
    seedCmd: str(o.seedCmd),
    envVars,
  };
}

/**
 * Fallback for models without reliable native structured output (Kimi/DeepSeek/GLM):
 * ask for a JSON object as TEXT, then coerce + validate it against the manifest schema.
 * Kimi K3 returns clean JSON in `content` (reasoning is a separate field), and this
 * avoids the AI SDK's generateObject negotiation that Moonshot rejects. Retries once.
 */
async function generateManifestFromJson(model: LanguageModel, basePrompt: string) {
  const jsonPrompt =
    basePrompt +
    `\n\nOUTPUT FORMAT: reply with ONLY a single JSON object — no markdown, no code fences, no commentary — matching EXACTLY this shape (types matter):\n${MANIFEST_SHAPE}\n` +
    `Rules: "envVars" is an ARRAY of objects (never an object map). Every "databases" entry MUST include "connectionEnvVar". Use [] for empty arrays and "" for empty strings. "port" is a number.`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text } = await generateText({
      model,
      prompt:
        attempt === 1
          ? jsonPrompt
          : jsonPrompt + `\n\n(Your previous reply did not match. Return ONLY the JSON object in the exact shape above — nothing before or after it.)`,
    });
    const m = text.match(/\{[\s\S]*\}/); // strip any stray prose/fences around the object
    if (m) {
      try {
        return manifestSchema.parse(coerceManifest(JSON.parse(m[0])));
      } catch (e) {
        lastErr = e;
      }
    } else {
      lastErr = new Error("no JSON object in model output");
    }
  }
  throw new Error(`could not parse a valid manifest from the model: ${(lastErr as Error)?.message ?? "unknown"}`);
}

export async function detectManifest(projectId: string, userId: string): Promise<PreviewManifest> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("project not found");
  const workspaceId = await envWorkspaceId(projectId);
  const fingerprint = await gatherFingerprint(workspaceId);

  const { model, supportsStructured } = await resolveUserModel(userId);
  const promptText = `You are a senior build engineer preparing a SETUP PLAN to run this EXISTING repository inside a fresh sandbox so a developer can preview it live. You have a full read of the codebase below (solution/project files, appsettings, docker-compose, ORM config, SQL scripts, env examples, README). Produce a COMPLETE, concrete plan — everything needed to get this specific app serving HTTP. Do NOT be vague; do NOT assume; base every field on what the code actually shows.

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
${fingerprint}`;
  // Native structured output (generateObject) is reliable on anthropic/openai/google.
  // Kimi/DeepSeek/GLM negotiate it poorly ("response did not match schema"), so for those
  // we ask for JSON text and parse it against the same schema (K3 returns clean JSON in
  // `content` — reasoning is a separate field, so a plain parse works).
  const object = supportsStructured
    ? (await generateObject({ model, schema: manifestSchema, prompt: promptText })).object
    : await generateManifestFromJson(model, promptText);

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
  const { host, port, username, password, engine } = h;
  const dbName = db.databaseName ?? h.dbName;
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
      if (engine === "redis") return `${host}:${port},password=${password}`;
      return `Host=${host};Port=${port};Database=${dbName};Username=${username};Password=${password}`;
    case "url":
    default:
      if (engine === "redis") return `redis://${username}:${password}@${host}:${port}`;
      return `${engine === "mysql" ? "mysql" : "postgresql"}://${username}:${password}@${host}:${port}/${dbName}`;
  }
}

// Capture the exact settings read for a run, never whatever happens to be saved
// when that run finishes. A concurrent edit must remain pending.
const preparedEnvironment = new WeakMap<PreviewManifest, Record<string, string>>();
function environmentBranch(branch?: string | null) { return !branch || branch === "(default)" ? "default" : branch; }
async function readProjectEnvironment(projectId: string) {
  const rows = await db.select().from(projectEnvironmentVariables).where(eq(projectEnvironmentVariables.projectId, projectId));
  const values: Record<string, string> = Object.create(null);
  for (const row of rows) {
    if (!row.hasValue || UNSAFE_ENV_KEYS.has(row.key)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key)) throw new Error("Invalid saved environment variable name");
    try { values[row.key] = decryptSecret(row.encryptedValue); }
    catch { throw new Error(`Could not read saved variable ${row.key}. Save its value again.`); }
  }
  return values;
}
async function recordAppliedEnvironment(projectId: string, branch: string, values?: Record<string, string>) {
  if (!values) return;
  const loaded = await loadAppProfile(projectId, branch) || await loadAppProfile(projectId);
  if (!loaded) throw new Error("Could not record the applied environment; runtime profile is missing.");
  loaded.profile.appliedProjectEnvironment = { values, appliedAt: new Date().toISOString() };
  delete loaded.profile.pendingProjectEnvironment;
  await saveAppProfile(projectId, loaded.profile, branch);
}
export async function getEnvironmentApplyStatus(projectId: string) {
  const row = await getEnv(projectId);
  const loaded = await loadAppProfile(projectId, environmentBranch(row?.previewBranch));
  const current = environmentFingerprint(await readProjectEnvironment(projectId));
  const previous = loaded?.profile.appliedProjectEnvironment;
  const changedKeys = [...new Set([...environmentChanges(current, previous), ...(loaded?.profile.pendingProjectEnvironment?.keys || [])])];
  const databaseKeys = new Set((loaded?.profile.databases || []).map(d => d.connectionEnvVar));
  return {
    pending: changedKeys.length > 0 || !!loaded?.profile.pendingProjectEnvironment,
    changedKeys,
    requiresPreparation: !!previous && changedKeys.some(key => databaseKeys.has(key)),
    requiresBuild: !!loaded?.profile.pendingProjectEnvironment?.requiresBuild || requiresEnvironmentBuild(changedKeys, loaded?.profile.buildEnvironmentKeys),
    appliedAt: previous?.appliedAt || null,
    prepared: !!(row?.setupManifest && row?.runCommand),
    status: row?.previewStatus || "idle",
  };
}

async function writeEnvFile(workspaceId: string, projectId: string, manifest: PreviewManifest, provisioned: Record<string, string>) {
  const port = manifest.port;
  // Stored project env vars (decrypted) + provisioned DB creds + generic run hints.
  const savedValues = await readProjectEnvironment(projectId);
  // PORT/HOST are near-universal hints (frameworks that don't read them ignore
  // them); the manifest runCmd is authoritative for the actual bind. Anything
  // stack-specific is only added when that stack is actually detected.
  const runtime = (manifest.runtime || "").toLowerCase();
  const framework = (manifest.framework || "").toLowerCase();
  // Route every package/build cache onto the big persistent /data volume so
  // restores (NuGet can be GBs) survive restart and don't fill the 1.9GB root.
  const vars: Record<string, string> = {
    PORT: String(port), HOST: "0.0.0.0",
    // EVERY toolchain cache/download on /data, never the tiny root fs — MSBuild/dotnet,
    // Go (modules + build cache + TOOLCHAIN downloads), pip/uv/cargo/npm, and generic
    // XDG caches all default to $HOME=/root and fill / ("No space left on device").
    TMPDIR: "/data/tmp", TMP: "/data/tmp", TEMP: "/data/tmp",
    NUGET_PACKAGES: "/data/.nuget", DOTNET_CLI_HOME: "/data/.dotnet",
    npm_config_cache: "/data/.npm-cache", PIP_CACHE_DIR: "/data/.pip-cache",
    GOPATH: "/data/go", COMPOSER_CACHE_DIR: "/data/.composer",
    GOMODCACHE: "/data/go/pkg/mod", GOCACHE: "/data/.cache/go-build",
    GOENV: "/data/.config/go/env", GOTMPDIR: "/data/tmp",
    XDG_CACHE_HOME: "/data/.cache", XDG_DATA_HOME: "/data/.local/share",
    XDG_CONFIG_HOME: "/data/.config", UV_CACHE_DIR: "/data/.cache/uv",
    CARGO_HOME: "/data/.cargo", RUSTUP_HOME: "/data/.rustup",
    PLAYWRIGHT_BROWSERS_PATH: "/data/.cache/ms-playwright",
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
  Object.assign(vars, savedValues);
  // Provisioned DB connection strings WIN over a stored value — when we provisioned a
  // local DB it's because the stored one was a placeholder / unreachable, so our fresh
  // connection (matching creds) must override it. Applied last on purpose.
  Object.assign(vars, provisioned);
  // Always double-quote (values like .NET connection strings contain ';', spaces,
  // '=' — which break `set -a; . ./.env` sourcing if unquoted). Escape ", \, $, `.
  const body = Object.entries(vars)
    .map(([k, val]) => `${k}="${String(val).replace(/(["\\$`])/g, "\\$1")}"`)
    .join("\n");
  const b64 = Buffer.from(body).toString("base64");
  const snapshot = environmentFingerprint(savedValues);
  const branch = environmentBranch((await getEnv(projectId))?.previewBranch);
  const loaded = await loadAppProfile(projectId, branch) || await loadAppProfile(projectId);
  if (loaded) {
    loaded.profile.pendingProjectEnvironment = {
      keys: [...new Set([...environmentChanges(snapshot, loaded.profile.appliedProjectEnvironment), ...(loaded.profile.pendingProjectEnvironment?.keys || [])])],
      requiresBuild: !!manifest.buildCmd || !!loaded.profile.pendingProjectEnvironment?.requiresBuild,
    };
    await saveAppProfile(projectId, loaded.profile, branch);
  }
  const written = await sh(workspaceId, `cd ${PROJECT_DIR} && umask 077 && echo ${b64} | base64 -d > .env && echo WROTE_ENV`, 30_000);
  if (written.exitCode !== 0) throw new Error("Could not write preview environment settings.");
  preparedEnvironment.set(manifest, snapshot);
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
 * connections intact. Builds a preview-log summary and an overall verdict.
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
  const verdict = overall === "ok" ? "🟢 **Preview smoke checks passed**"
    : overall === "error" ? "🔴 **Failed — the app is not responding**"
    : `🟡 **Degraded** — ${[urlErr ? "URL returns a server error" : "", assetsBad ? "some assets broken" : "", dbBad ? "a database is unreachable" : ""].filter(Boolean).join(", ")}`;

  const summary = `🚀 **Preview launch summary** — branch: \`${branchLabel === "(default)" ? "repository default" : branchLabel}\`\n\n${urlLine}\n${assetLine}\n${dbLine}\n\n${verdict}`;
  plog(projectId, userId, `Verification: ${overall}`, overall === "ok" ? undefined : { level: "error", detail: summary.replace(/\*\*/g, "") });
  return { summary, overall, broken: brokenAssets };
}

/** Preview audits report source defects; only a ticket may implement their repair. */
async function healBrokenAssets(
  projectId: string, userId: string, _conversationId: string | null | undefined,
  _workspaceId: string, _manifest: PreviewManifest, _branchLabel: string, broken: string[],
): Promise<{ summary: string } | null> {
  if (broken.length) plog(projectId, userId, `Assets broken (${broken.length}) — source repair requires ticket execution.`, {
    level: "error", detail: broken.slice(0, 15).join("\n"),
  });
  return null;
}

async function publishConfigurationNotice(userId: string, conversationId: string | null | undefined, content: string, publicProjectId?: string): Promise<void> {
  if (!conversationId) return;
  await db.insert(messages).values({ conversationId, role: "assistant", content }).catch(() => {});
  broadcastToUser(userId, { type: "message", sender: "assistant", message: content, conversation_id: conversationId, project_id: publicProjectId, build_status: true });
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
      if (/Unhandled exception|Application start-up failed|Application startup exception|PendingModelChangesWarning/.test(out)) return false;
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
async function resolveDriverModel(userId: string, projectId?: string) {
  const { selectedSubscriptionModel } = await import("./subscription-execution.ts");
  const subscription = await selectedSubscriptionModel(userId, projectId);
  if (subscription) return { model: subscription, modelKey: `chatgpt/${subscription.modelId}` };
  const [sel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId));
  const modelKey = sel?.selectedModel ?? DEFAULT_MODEL_KEY;
  // Fine-grained LLM: a collaborator granted "use my API keys" drives the preview on the
  // OWNER's keys; else their own. Model CHOICE stays the acting user's (sel above).
  let keyUserId = userId;
  if (projectId) {
    const [proj] = await db.select({ id: projects.id, ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (proj) keyUserId = llmKeyUserId(await resolveLlmGrants(proj, userId), userId);
  }
  const [keys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, keyUserId));
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
export type RunStep = PlanStep;
const activeProfileBranches = new Map<string, string>();

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
  if (ms) return `${skipRestore}${read} | docker exec -i mssql sh -c 'client=/opt/mssql-tools18/bin/sqlcmd; test -x "$client" || client=/opt/mssql-tools/bin/sqlcmd; exec "$client" -S localhost -U ${ms.username} -P "${ms.password}" -C -d ${ms.dbName} -b'`;
  if (pg) return `${read} | docker exec -i -e PGPASSWORD='${pg.password}' postgres psql -U ${pg.username} -d ${pg.dbName} -v ON_ERROR_STOP=1`;
  if (my) return `${read} | docker exec -i mysql mysql -u${my.username} -p'${my.password}' ${my.dbName}`;
  return `echo "No SQL engine provisioned to apply this script"; exit 1`;
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

/** Start command for a COMPANION service on its own port, logging to its own file
 *  (preview-<name>.log) so the Preview switcher can show per-service logs. Same detached
 *  shape as the primary. */
function serviceStartCommand(service: ServiceSpec, dir: string = PROJECT_DIR): string {
  const runCmd = localizeCmd(service.runCmd, dir).replace(/'/g, `'\\''`);
  // A subfolder app (monorepo): source the ROOT .env, then cd into its dir before starting.
  const sub = service.dir ? `cd '${service.dir.replace(/'/g, `'\\''`)}' 2>/dev/null || true; ` : "";
  // COMPANION ENV ISOLATION: a companion sources the PRIMARY's root .env (so it gets the
  // shared DB connection + user vars), but that .env can carry app-INSTANCE config that
  // assumes the primary's appsettings shape — e.g. Serilog__WriteTo__1__* injects a sink at
  // array index 1, which is a valid override for Cohire.Web (its appsettings defines
  // WriteTo[1].Name) but FATAL for Cohire.Admin (no Serilog section → a nameless sink →
  // startup crash). Strip Serilog__* after sourcing so a second app is never poisoned by the
  // first app's logging config. (A companion's own Serilog config lives in its appsettings.)
  const isolate = `unset $(env | grep "^Serilog__" | cut -d= -f1) 2>/dev/null; `;
  return `fuser -k ${service.port}/tcp 2>/dev/null; pkill -f ':${service.port}' 2>/dev/null; sleep 1; ` +
    `setsid sh -c 'cd ${dir}; set -a; . ./.env 2>/dev/null; set +a; ${isolate}${sub}${runCmd}' </dev/null > ${dir}/preview-${service.name}.log 2>&1 & echo STARTED`;
}

/** Bring up ONE companion service: build (only if it has its own buildCmd — the shared
 *  build usually produced its DLL already), start it on its port, expose that port on its
 *  OWN subdomain (baseAlias-<name>, bound to the port via Mags per-alias port), and
 *  health-check. Returns its public URL, or "" if it didn't come up. */
async function exposeService(
  projectId: string, userId: string, workspaceId: string,
  service: ServiceSpec, runDir: string, baseAlias: string,
): Promise<{ name: string; url: string; port: number; ok: boolean }> {
  const buildDir = service.dir ? `${runDir}/${service.dir}` : runDir; // subfolder app builds in its own dir
  if (service.buildCmd) {
    plog(projectId, userId, `Building companion "${service.name}": ${service.buildCmd}`);
    const bc = localizeCmd(service.buildCmd, buildDir);
    const br = await runDetachedPolled(projectId, userId, workspaceId, bc, 1_800_000, { stallMs: 900_000, workDir: buildDir })
      .catch(() => ({ exitCode: -1, output: "" }));
    if (br.exitCode !== 0) {
      plog(projectId, userId, `Companion "${service.name}" build failed (exit ${br.exitCode})`, { level: "error", detail: br.output.slice(-800) });
      return {name:service.name,url:"",port:service.port,ok:false};
    }
  }
  plog(projectId, userId, `Starting companion "${service.name}" on :${service.port}…`);
  await runDetachedPolled(projectId, userId, workspaceId, serviceStartCommand(service, runDir), 30_000);
  const ok = await waitForAppUp(projectId, userId, workspaceId, service.port, `${runDir}/preview-${service.name}.log`, 120_000);
  let url = "";
  if (ok) {
    await enableHttpAccess(workspaceId, service.port).catch(() => {});
    try { url = await setStableUrl(`${baseAlias}-${service.name}`, workspaceId, service.port); }
    catch (e) { plog(projectId, userId, `Companion "${service.name}" URL alias failed: ${(e as Error).message?.slice(0, 100)}`, { level: "error" }); }
    plog(projectId, userId, `Companion "${service.name}" is live${url ? ` at ${url}` : ""} ✓`);
  } else {
    plog(projectId, userId, `Companion "${service.name}" did not come up on :${service.port}`, { level: "error" });
  }
  return { name: service.name, url, port: service.port, ok };
}

/** Write/replace a single var in the live sandbox .env (so a sibling app picks it up on
 *  its next start). Value is quote-escaped for `set -a; . ./.env` sourcing. */
async function writeLiveEnvVar(workspaceId: string, key: string, value: string, runDir = PROJECT_DIR): Promise<void> {
  const line = `${key}="${value.replace(/(["\\$`])/g, "\\$1")}"`;
  const b64 = Buffer.from(line).toString("base64");
  await sh(workspaceId, `cd ${shellQuote(runDir)} || exit 1; (grep -v '^${key}=' .env 2>/dev/null > .env.tmp || true); echo ${b64} | base64 -d >> .env.tmp; mv .env.tmp .env; echo OK`, 20_000);
}

/** Inject <NAME>_BASE_URL for a companion so sibling apps that read a base URL from config
 *  reach the PREVIEW URL, not prod. Respects a value the user set themselves; persists it
 *  (survives restarts) and writes it to the live .env now. */
async function persistServiceBaseUrl(projectId: string, workspaceId: string, name: string, url: string, runDir = PROJECT_DIR): Promise<void> {
  const key = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`;
  const [existing] = await db.select().from(projectEnvironmentVariables)
    .where(and(eq(projectEnvironmentVariables.projectId, projectId), eq(projectEnvironmentVariables.key, key))).limit(1);
  if (existing?.hasValue) {
    // User override wins — but make sure the current value is in the live .env.
    const cur = (() => { try { return decryptSecret(existing.encryptedValue); } catch { return url; } })();
    await writeLiveEnvVar(workspaceId, key, cur, runDir).catch(() => {});
    return;
  }
  await db.insert(projectEnvironmentVariables)
    .values({ projectId, key, encryptedValue: encryptSecret(url), isSecret: false, hasValue: true, description: `Preview base URL for the ${name} app (auto-injected)` })
    .onConflictDoUpdate({ target: [projectEnvironmentVariables.projectId, projectEnvironmentVariables.key], set: { encryptedValue: encryptSecret(url), hasValue: true, updatedAt: new Date() } });
  await writeLiveEnvVar(workspaceId, key, url, runDir).catch(() => {});
}

/** After the primary is live, bring up every ENABLED companion + expose each on its own
 *  subdomain, inject its <NAME>_BASE_URL, broadcast the service list for the Preview
 *  switcher, and return a chat-summary snippet. No-op for single-app previews. */
async function runEnabledCompanions(
  projectId: string, userId: string, workspaceId: string,
  manifest: PreviewManifest, runDir: string, baseAlias: string, primaryUrl: string,
): Promise<string> {
  const svcs = manifest.services || [];
  if (svcs.length < 2) return "";
  const primary = svcs.find((s) => s.primary) || svcs[0];
  if (!primary) return "";
  const companions = svcs.filter((s) => s !== primary && s.enabled);
  const out: Array<{ name: string; url: string; port: number; ok: boolean; primary: boolean }> = [
    { name: primary.name, url: primaryUrl, port: primary.port, ok: true, primary: true },
  ];
  for (const c of companions) {
    const r = await exposeService(projectId, userId, workspaceId, c, runDir, baseAlias);
    out.push({ ...r, primary: false });
    if (r.url) await persistServiceBaseUrl(projectId, workspaceId, c.name, r.url, runDir).catch(() => {});
  }
  // Live list for the Preview tab switcher (every service + whether it's enabled/up).
  broadcastToUser(userId, { type: "preview_services", projectId: pub(projectId), services: svcs.map((s) => {
    const r = out.find((o) => o.name === s.name);
    return { name: s.name, port: s.port, primary: !!s.primary, enabled: !!s.primary || !!s.enabled, url: r?.url || "", up: r?.ok ?? false };
  }) });
  const lines = out.filter((r) => r.url).map((r) => `- ${r.primary ? `**${r.name}** (primary)` : r.name}: ${r.url}${r.ok ? "" : " ⚠️ not up"}`);
  return companions.length ? `\n\n**Apps in this preview:**\n${lines.join("\n")}` : "";
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
async function resolvePreviewWorkers(projectId:string,workspaceId:string,manifest:PreviewManifest,dir:string) {
  workerHealthCache.delete(projectId);
  const result=await sh(workspaceId,`cat ${shellQuote(dir+'/package.json')} 2>/dev/null`,15000);
  let pkg:{}={};if(result.exitCode===0){try{pkg=JSON.parse(result.output);}catch{throw new Error('Cannot read package.json to identify required background processes');}}
  manifest.backgroundProcesses=discoverBackgroundProcesses(pkg,manifest.backgroundProcesses);
  // Record literal startup readiness from the actual entrypoint when available.
  for(const worker of manifest.backgroundProcesses){
    if(worker.entrypoint && !worker.readyLog){
      const source=await sh(workspaceId,`cat ${shellQuote(dir+'/'+worker.entrypoint)} 2>/dev/null`,15000);
      const ready=source.output.match(/console\.log\(["']([^"'\n]*[Rr]eady[^"'\n]*)["']\)/)?.[1];
      if(ready)worker.readyLog=ready;
    }
  }
  const branch=environmentBranch((await getEnv(projectId))?.previewBranch);
  const profile=await loadAppProfile(projectId,branch);
  if(profile){profile.profile.backgroundProcesses=manifest.backgroundProcesses;await saveAppProfile(projectId,profile.profile,branch);}
  await db.update(projectEnvironments).set({setupManifest:JSON.stringify(manifest)}).where(eq(projectEnvironments.projectId,projectId));
}

function buildRunbook(manifest: PreviewManifest, engines: EngineHandle[], dir = PROJECT_DIR): RunStep[] {
  const steps = compileRuntimePlan(manifest, {
    purpose: "preview",
    dir, localize: c => localizeCmd(c, dir), configure: "", start: appStartCommand(manifest, dir),
    sql: (file, step) => {
      if (!step.connectionKey) return sqlApplyCommand(engines, file);
      const target = manifest.databases.find(d => d.connectionEnvVar === step.connectionKey);
      return target ? targetedSqlCommand(file, step.connectionKey, target.engine, target.engine, engines.find(e=>e.engine===target.engine)?.port ?? 0) : "echo 'Unknown SQL connectionKey in schemaSteps'; exit 1";
    },
    http: path => previewAvailabilityCommand(manifest.port, path),
  });
  steps.push({id:"workers",phase:"run",label:"Start required background workers with selected preview settings",command:previewWorkerCommand('start',dir,manifest.backgroundProcesses,manifest.databases.map(d=>d.connectionEnvVar),{webPort:manifest.port}),status:"pending"});
  steps.push({ id: "assets", phase: "verify", label: "Verify assets and database health", command: "", status: "pending" });
  return steps;
}

const PHASE_STATUS: Record<RunStep["phase"], PreviewStatus> = {
  prepare: "provisioning", toolchain: "installing", install: "installing", build: "installing", schema: "seeding", run: "starting", verify: "starting", recovery: "starting",
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
  broadcastToUser(userId, { type: "preview_steps", projectId: pub(projectId), steps });
}

/**
 * Execute the shared plan with assertions and one bounded recovery attempt.
 * Recovery is qualified in a clean checkout before replaying the selected checkout.
 * No previous status is accepted as proof that a step is still valid.
 */
async function executeRunbook(
  projectId: string, userId: string, workspaceId: string,
  manifest: PreviewManifest, engines: EngineHandle[], model: any,
  _resumeSteps: RunStep[] | null, prelude: RunStep[] = [], configNotes: string[] = [], dir = PROJECT_DIR,
): Promise<{ up: boolean; steps: RunStep[]; error?: string }> {
  const branch = activeProfileBranches.get(projectId) ?? "default";
  const head = await sh(workspaceId, `git -C ${shellQuote(dir)} rev-parse HEAD`, 15_000);
  const revision = head.output.trim();
  const loaded = await loadAppProfile(projectId, branch);
  const omittedSeeds = orderedSchema(manifest).filter(s => s.kind === "seed" && (!s.requiredBy?.trim() || !s.verify?.trim()));
  if (omittedSeeds.length) plog(projectId, userId, `Skipped ${omittedSeeds.length} seed step(s): preview initialization requires a repository requirement and a read-only existence check.`);
  // Include plan content so a corrected command/config invalidates a previous blocker.
  const envHash = await sh(workspaceId, `sha256sum ${shellQuote(dir + "/.env")} | cut -d ' ' -f1`, 15_000);
  // Invalidate blockers recorded before consolidated patch recovery was available.
  const identity = "replay-feedback-v1:" + revision + envHash.output.trim() + JSON.stringify([manifest, loaded?.profile.configPatches, loaded?.profile.environmentOverrides]);
  await resolvePreviewWorkers(projectId,workspaceId,manifest,dir);
  const stoppedWorkers=await sh(workspaceId,previewWorkerCommand('stop',dir,manifest.backgroundProcesses),30000);
  if(stoppedWorkers.exitCode!==0)throw new Error('Could not stop previous preview workers');
  let executionDir = dir;
  let steps: RunStep[] = [...prelude, ...buildRunbook(manifest, engines, dir)];
  const persist = () => persistSteps(projectId, userId, steps);
  const run = async (step: RunStep, command: string) => {
    await setPreview(projectId, userId, { previewStatus: PHASE_STATUS[step.phase] }, step.label);
    plog(projectId, userId, `▶ ${step.phase}: ${step.label}`);
    if (step.id === "configuration") {
      validateSchemaTargets(orderedSchema(manifest), manifest.databases);
      const profile = await loadAppProfile(projectId, branch);
      if (profile) {
        const captured = preparedEnvironment.get(manifest);
        if (captured && profile.profile.appliedProjectEnvironment) {
          const edited = new Set(environmentChanges(captured, profile.profile.appliedProjectEnvironment));
          profile.profile.environmentOverrides = (profile.profile.environmentOverrides || []).filter(v => !edited.has(v.key));
          await saveAppProfile(projectId, profile.profile, branch);
        }
        await applyBranchEnvironment(workspaceId, profile.profile, executionDir);
        await applySavedPatches(projectId, userId, workspaceId, profile.profile, executionDir);
      }
      if (branch !== "default" || manifest.databases.some(d => d.databaseName)) {
        const isolated = await sh(workspaceId, branchDatabaseScript(executionDir, branch, engines), 180_000);
        if (isolated.exitCode !== 0) return isolated;
        const databases = JSON.parse(isolated.output.trim()) as Array<{engine:string;database:string}>;
        for (const engine of engines) {
          const matches = databases.filter(d => d.engine === engine.engine);
          if (matches.length === 1) engine.dbName = matches[0]!.database;
          else if (matches.length > 1 && orderedSchema(manifest).some(s => s.kind === "sqlScript" && !s.connectionKey)) throw new Error("SQL_TARGET_REQUIRED: Multiple logical databases detected. FIRST updatePlan schemaSteps: retain migration order and give EVERY sqlScript a connectionKey matching databases[].connectionEnvVar. Available keys: " + manifest.databases.map(d=>d.connectionEnvVar).join(", ") + ". Do not repair schemas until this routing is saved.");
        }
        const currentProfile=await loadAppProfile(projectId,branch);
        if(currentProfile){currentProfile.profile.databaseIdentities=databases;await saveAppProfile(projectId,currentProfile.profile,branch);}
        plog(projectId, userId, 'Selected branch databases: '+databases.map(d=>d.engine+': '+d.database).join(', '));
      }
      return { exitCode: 0, output: "Configuration verified" };
    }
    if (step.id.startsWith("schema-") && command === step.command) {
      const recipe = orderedSchema(manifest)[Number(step.id.slice(7))];
      if (recipe?.kind === "sqlScript" && recipe.verify && !recipe.connectionKey) command = localizeCmd(sqlApplyCommand(engines, recipe.command), executionDir);
    }
    if (step.id === "assets") {
      const checked = await verifyPreview(projectId, userId, workspaceId, manifest, branch);
      return { exitCode: checked.overall === "ok" ? 0 : 1, output: checked.summary + (checked.broken.length ? "\nBroken assets: " + checked.broken.join(", ") : "") };
    }
    const r = await runDetachedPolled(projectId, userId, workspaceId, step.id === "install" ? cachedInstallCommand(executionDir,command) : command,
      step.phase === "run" ? 60_000 : step.phase === "schema" ? 600_000 : 1_800_000,
      { stallMs: step.phase === "schema" ? 0 : 900_000, workDir: executionDir });
    throwIfCancelled(projectId);
    if (step.phase === "run" && r.exitCode === 0) {
      if (await waitForAppUp(projectId, userId, workspaceId, manifest.port, `${executionDir}/preview.log`, 120_000)) return r;
      const log = await sh(workspaceId, `head -c 16000 ${shellQuote(`${executionDir}/preview.log`)}; tail -c 8000 ${shellQuote(`${executionDir}/preview.log`)}`, 20_000);
      return { exitCode: 1, output: failureSummary(log.output) || `App did not respond on port ${manifest.port}` };
    }
    return r;
  };
  // Every failure, including qualification, returns through the same recovery gate.
  const budget = new PreviewRecoveryBudget(3);
  let pendingFailure: RunStep | null = null;
  try {
  for (;;) {
    throwIfCancelled(projectId);
    const failedStep = pendingFailure ?? await executeSteps(steps, { run, persist, cancelled: () => isCancelled(projectId) });
    pendingFailure = null;
    if (!failedStep) {
      const current = await loadAppProfile(projectId, branch);
      if (current) {
        delete current.profile.blockedFailure;
        current.profile.verifiedRevision = revision;
        await saveAppProfile(projectId, current.profile, branch);
      }
      return { up: true, steps };
    }
    // A later availability check can fail after workers start. Do not let those
    // workers consume jobs while recovery changes the checkout/environment.
    await sh(workspaceId,previewWorkerCommand('stop',dir,manifest.backgroundProcesses),30000);
    const latest = await loadAppProfile(projectId, branch);
    const recipeIdentity = JSON.stringify([manifest, latest?.profile.configPatches, latest?.profile.environmentOverrides]);
    const normalizedFailure = {...failedStep, command: failedStep.command.replace(/\/data\/preview-check-[a-f0-9-]+/g, dir)};
    const key = failureKey(identity + recipeIdentity, normalizedFailure, (failedStep.error ?? "").replace(/\/data\/preview-check-[a-f0-9-]+/g, dir));
    const stopReason = budget.next(key);
    if (stopReason || !model || loaded?.profile.blockedFailure?.key === key) {
      const detail = `${failedStep.error || failedStep.label}\n${stopReason || (!model ? "No recovery model is available." : "This unchanged failure was already investigated.")}`;
      const current = await loadAppProfile(projectId, branch);
      if (current) {
        current.profile.blockedFailure = { revision, key, detail };
        await saveAppProfile(projectId, current.profile, branch);
      }
      return { up: false, steps, error: detail };
    }
    const recovery: RunStep = { id: "recovery", phase: "recovery", label: `Repair ${failedStep.label}`, command: "", status: "running", startedAt: new Date().toISOString() };
    steps.push(recovery); await persist();
    await sh(workspaceId, `fuser -k ${manifest.port}/tcp 2>/dev/null || true`, 20_000);
    const outcome = await driveSandbox(projectId, userId, workspaceId, manifest, engines, model, dir,
      [...configNotes, `FAILED STEP ${failedStep.id} (${failedStep.phase}): ${failedStep.error}. Failed command: ${failedStep.command}. If this came from clean replay, the working sandbox was insufficient: repair the runtime recipe; report required source changes for ticket execution. The failed scratch checkout has been removed; reproduce in this selected checkout and save the fix. Do not merely restart the server or claim ready without persisting the missing work. For SQL_TARGET_REQUIRED, FIRST persist schemaSteps with connectionKey on every raw SQL file, preserving migrations before dependent scripts and their verify assertions. Do not run ad-hoc migrations until the mapping is saved. For stale patches, FIRST inspectSavedPatches and replaceSavedPatches; do not start unrelated database work before reconciling configuration. For SQL failures, correct runtime ordering only when the existing repository scripts support it; script contents or identity-handling defects require a ticket repair. Use resetDevelopmentDatabase when clean replay is needed; never drop a database without a verified backup. Repair and PERSIST the recipe. The executor will replay it; merely starting a process is not sufficient.`]);
    throwIfCancelled(projectId);
    recovery.status = outcome ? "done" : "failed"; recovery.finishedAt = new Date().toISOString();
    await persist();
    if (!outcome) {
      const current = await loadAppProfile(projectId, branch);
      const detail = driverFailures.get(projectId) || failedStep.error || "Recovery failed";
      if (current) { current.profile.blockedFailure = { revision, key, detail }; await saveAppProfile(projectId, current.profile, branch); }
      return { up: false, steps, error: detail };
    }
    try {
      await saveConsolidatedPatches(projectId,userId,workspaceId,branch,dir,engines);
    } catch (error) {
      recovery.status = "failed";
      recovery.error = `Saved repair normalization failed: ${(error as Error).message}`;
      await persist();
      pendingFailure = {id:"repair-normalization", phase:"install", command:"normalize saved repairs", label:"Normalize saved repairs", status:"failed", error:recovery.error};
      plog(projectId,userId,"Saved repair verification failed — returning the error to recovery",{detail:recovery.error});
      continue;
    }
    const current = await loadAppProfile(projectId, branch);
    if (current) {
      Object.assign(manifest, deriveManifestFromProfile(current.profile));

    }
    // A warm worktree can hide unrecorded repairs. Qualify in a new detached
    // checkout before replaying the original one. Database steps use their assertions.
    const cleanDir = `/data/preview-check-${crypto.randomUUID()}`;
    const clean: RunStep = { id: "clean-replay", phase: "recovery", label: "Verify saved repairs from a clean checkout", command: "", status: "running" };
    steps.push(clean); await persist();
    let replayFailure: RunStep | null = null;
    try {
      const created = await sh(workspaceId, `git -C ${shellQuote(dir)} worktree add --detach ${shellQuote(cleanDir)} HEAD && cp ${shellQuote(dir + "/.env")} ${shellQuote(cleanDir + "/.env")}`, 60_000);
      if (created.exitCode !== 0) throw new Error(failureSummary(created.output));
      const rewrite = branch === "default" ? buildAppsettingsRewriteScript(engines, cleanDir) : "";
      if (rewrite) { const r = await sh(workspaceId, rewrite, 60_000); if (r.exitCode !== 0) throw new Error("Clean checkout configuration failed"); }

      // A repair that needed reset must qualify against an empty database again;
      // a successful warm run cannot prove that the saved schema recipe is complete.
      const previousBackupIds = new Set((loaded?.profile.recoveryBackups ?? []).map(b=>b.id));
      for (const backup of current?.profile.recoveryBackups ?? []) {
        if(previousBackupIds.has(backup.id) || backup.workspaceId!==workspaceId) continue;
        const engine=engines.find(e=>e.engine==="mssql");
        if(!engine || !backup.connectionKey) throw new Error("Cannot qualify repaired database from its recorded backup");
        const scripts=databaseRecoveryScripts({engine,database:backup.database,connectionKey:backup.connectionKey,dir:cleanDir,backupId:backup.id});
        plog(projectId,userId,`Verifying repaired schema from an empty database; original backup retained at ${backup.path}`);
        const reset=await runDetachedPolled(projectId,userId,workspaceId,scripts.reset,180_000,{stallMs:0,workDir:cleanDir});
        if(reset.exitCode!==0 || !/^DATABASE_RESET$/m.test(reset.output)) throw new Error("Clean database qualification reset failed; verified backup retained");
      }
      executionDir = cleanDir;
      const cleanSteps = buildRunbook(manifest, engines, cleanDir).filter(step=>step.id!=="workers");
      const previousSteps = steps;
      steps = [...prelude, recovery, clean, ...cleanSteps];
      const invalid = await executeSteps(cleanSteps, { run, persist, cancelled: () => isCancelled(projectId) });
      if (invalid) { replayFailure = {...invalid}; throw new Error(invalid.error || `Failed replay step: ${invalid.id}`); }
      steps = previousSteps;
      clean.status = "done";
    } catch (error) {
      if ((error as Error).message === "__CANCELLED__") throw error;
      clean.status = "failed"; clean.error = failureSummary((error as Error).message); await persist();
      pendingFailure = replayFailure ?? {id:"clean-checkout",phase:"install",command:"prepare clean replay",label:"Prepare clean replay",status:"failed",error:clean.error};
      plog(projectId,userId,"Clean replay failed — returning the failed step and error to recovery",{detail:clean.error});
      continue;
    } finally {
      executionDir = dir;
      // Workers have no listening port: stop every process rooted in this
      // generated verification checkout before deleting it.
      await sh(workspaceId,previewWorkerCommand('cleanup',cleanDir),30000).catch(()=>{});
      // Stop only the scratch app, then remove only our generated checkout.
      await sh(workspaceId, `fuser -k ${manifest.port}/tcp 2>/dev/null || true; git -C ${shellQuote(dir)} worktree remove --force ${shellQuote(cleanDir)}`, 30_000).catch(() => {});
    }
    plog(projectId, userId, "Clean replay passed — restarting from the saved plan in the selected checkout.");
    steps = [...prelude, recovery, clean, ...buildRunbook(manifest, engines, dir)];
  }
  } catch (error) {
    await sh(workspaceId,previewWorkerCommand('stop',dir,manifest.backgroundProcesses),30000).catch(()=>{});
    throw error;
  }
}
const driverFailures = new Map<string, string>();

async function ensurePreviewEngine(projectId: string, userId: string, engine: DbEngine, spec?: PlannedDb) {
  const handle = await ensureManagedDatabaseWithRecovery({
    projectId, userId, engine, cancelled: () => isCancelled(projectId),
    progress: message => plog(projectId, userId, message),
  });
  if (spec) {
    const value = formatConnection(spec, handle);
    await db.insert(projectEnvironmentVariables)
      .values({ projectId, key: spec.connectionEnvVar, encryptedValue: encryptSecret(value), isSecret: true, hasValue: true, description: "Managed development database connection" })
      .onConflictDoUpdate({ target: [projectEnvironmentVariables.projectId, projectEnvironmentVariables.key], set: { encryptedValue: encryptSecret(value), isSecret: true, hasValue: true, updatedAt: new Date() } });
  }
  return handle;
}

async function applyBranchEnvironment(workspaceId: string, profile: AppProfile, dir: string) {
  const lines = (profile.environmentOverrides ?? []).filter(v => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key) && !UNSAFE_ENV_KEYS.has(v.key))
    .map(v => [v.key, `${v.key}=${shellQuote(decryptSecret(v.encryptedValue))}`]);
  if (!lines.length) return;
  const payload = Buffer.from(JSON.stringify(lines)).toString("base64");
  const r = await sh(workspaceId, `python3 - ${shellQuote(dir + "/.env")} ${shellQuote(payload)} <<'PYEOF'
import base64, json, sys
path = sys.argv[1]
values = dict(json.loads(base64.b64decode(sys.argv[2])))
lines = [line for line in open(path).read().splitlines() if line.split("=", 1)[0] not in values]
with open(path, "w") as f: f.write("\\n".join(lines + list(values.values())) + "\\n")
PYEOF`, 30_000);
  if (r.exitCode !== 0) throw new Error("Could not apply branch environment overrides");
}

/** Normalize recorded edits against the same baseline used by clean replay. */
async function saveConsolidatedPatches(projectId:string,userId:string,workspaceId:string,branch:string,dir:string,engines:EngineHandle[] | undefined, extra?:NonNullable<AppProfile["configPatches"]>[number]) {
  if (!engines) {
    const rows = await db.select().from(projectDatabases).where(and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.workspaceId, workspaceId)));
    engines = rows.filter(r => r.host && r.port && r.username && r.passwordEncrypted).map(r => ({engine:r.engine as DbEngine,host:r.host!,port:r.port!,username:r.username!,password:decryptSecret(r.passwordEncrypted!),dbName:r.dbName ?? "",connectionString:""}));
  }
  const loaded=await loadAppProfile(projectId,branch);
  if(!loaded) throw new Error("No profile available to save preview repairs");
  const patches=[...(loaded.profile.configPatches??[]),...(extra?[extra]:[])];
  assertPreviewRuntimePatches(patches);
  if(!patches.length) return;
  const clean=`/data/patch-normalize-${crypto.randomUUID()}`;
  try {
    const created=await sh(workspaceId,`git -C ${shellQuote(dir)} worktree add --detach ${shellQuote(clean)} HEAD`,60000);
    if(created.exitCode!==0) throw new Error("Cannot create patch normalization checkout");
    const rewrite=branch==="default"?buildAppsettingsRewriteScript(engines,clean):"";
    if(rewrite) { const r=await sh(workspaceId,rewrite,60000); if(r.exitCode!==0) throw new Error("Cannot prepare patch baseline"); }
    const captured=await sh(workspaceId,consolidatePatchScript(patches,clean,dir),60000);
    if(captured.exitCode!==0) throw new Error(failureSummary(captured.output));
    const candidate=appProfileSchema.shape.configPatches.parse(JSON.parse(captured.output))??[];
    const verify=async(target:string)=>{ const script=buildConfigPatchScript(candidate,target,true); if(!script)return; const r=await sh(workspaceId,script,60000); if(r.exitCode!==0)throw new Error(failureSummary(r.output)); };
    await replaceVerifiedPatches(candidate,{verifyClean:()=>verify(clean),verifyCurrent:()=>verify(dir),save:async()=>{
      loaded.profile.configPatches=candidate;
      delete loaded.profile.verifiedRevision; delete loaded.profile.blockedFailure;
      await saveAppProfile(projectId,loaded.profile,branch);
    }});
    plog(projectId,userId,`Saved ${candidate.length} consolidated preview repair(s); clean and current files verified`);
  } finally { await sh(workspaceId,`git -C ${shellQuote(dir)} worktree remove --force ${shellQuote(clean)}`,30000).catch(()=>{}); }
}

async function applySavedPatches(projectId: string, userId: string, workspaceId: string, profile: AppProfile, dir: string) {
  assertPreviewRuntimePatches(profile.configPatches);
  const script = buildConfigPatchScript(profile.configPatches, dir);
  if (!script) return;
  const result = await sh(workspaceId, script, 60_000);
  if (result.exitCode !== 0) throw new Error(`Saved patch verification failed: ${failureSummary(result.output)}`);
  plog(projectId, userId, "Saved patches applied and verified", { detail: result.output });
}

/** Prefix that puts the toolchain on PATH, caches on /data, and loads .env. The
 *  toolchain + NuGet cache live on the shared /data volume, so a worktree run gets
 *  the SAME environment the main-branch run used (`dir` selects which checkout). */
function envPrefix(dir: string = PROJECT_DIR): string {
  return `mkdir -p /data/.apk-cache; ln -sf /data/.apk-cache /etc/apk/cache 2>/dev/null || true; ` +
    // Go + .NET toolchains and ALL their caches live on the PERSISTENT /data volume (NOT
    // the ephemeral root fs), so `go`/`dotnet` and the module/build caches survive a VM
    // sleep/respawn and branch previews don't hit "go: not found". /data/go-toolchain is
    // installed by ensureGoToolchainOnData.
    `export PATH="/data/go-toolchain/bin:/data/go/bin:/data/.dotnet:/data/.dotnet/tools:/root/.dotnet/tools:/usr/local/bin:/usr/bin:/bin:/sbin:$PATH"; ` +
    `export DOTNET_ROOT=/data/.dotnet DOTNET_CLI_HOME=/data/.dotnet NUGET_PACKAGES=/data/.nuget ` +
    `DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 ` +
    `GOROOT=/data/go-toolchain GOPATH=/data/go GOMODCACHE=/data/go/pkg/mod GOCACHE=/data/.cache/go-build GOENV=/data/.config/go/env GOTOOLCHAIN=auto ` +
    `TMPDIR=/data/tmp; mkdir -p /data/tmp /data/go /data/.cache/go-build /data/.config/go; ` +
    `cd ${dir} 2>/dev/null; set -a; [ -f ./.env ] && . ./.env; set +a; `;
}

/** apk-installed toolchain (gcc, musl-dev, the language SDK) lives on the EPHEMERAL root
 *  fs — NOT /data — so a VM sleep/respawn between the main run and a branch run drops it,
 *  and the recorded build then dies with "gcc not found" and bounces to the AI driver
 *  (+ a slow network re-download). Re-assert JUST the apk steps before the build: it's
 *  idempotent (instant no-op when already present) and, with the persistent /data apk
 *  cache (envPrefix), restores them offline + fast when the root fs was reset. We skip
 *  non-apk toolchain steps (e.g. curl → /data/.dotnet) since those install to /data and
 *  already persist — re-running them would needlessly re-download. This is how a branch
 *  preview reliably inherits main's warmth. */
async function ensureApkToolchain(projectId: string, userId: string, workspaceId: string, manifest: PreviewManifest, runDir: string): Promise<void> {
  const apkSteps = (manifest.toolchain || []).filter((c) => /\bapk\s+add\b/.test(c))
    // Go itself goes on /data via ensureGoToolchainOnData (NOT apk → root fs). Strip a
    // bare `go` package from any apk step so we don't reinstall it to the ephemeral fs;
    // keep the C toolchain (gcc/musl-dev) which apk owns.
    .map((c) => c.replace(/\s--no-cache\b/g, "").replace(/(\bapk\s+add\b[^\n]*?)\bgo\b/g, "$1").replace(/\s{2,}/g, " ").trim())
    .filter((c) => /\bapk\s+add\b\s+\S/.test(c)); // drop steps that became just "apk add"
  for (const cmd of apkSteps) {
    await runDetachedPolled(projectId, userId, workspaceId, cmd, 600_000, { stallMs: 180_000, workDir: runDir }).catch(() => {});
  }
}

/** Install the Go toolchain onto the PERSISTENT /data volume (NOT apk → ephemeral root
 *  fs), so `go` survives a VM sleep/respawn and branch previews never hit "go: not
 *  found". The official linux-amd64 tarball's binaries are statically linked and run on
 *  Alpine/musl. Version comes from go.mod (GOTOOLCHAIN=auto then fetches a newer one to
 *  /data if the module needs it). No-op for non-Go apps or when already installed. */
async function ensureGoToolchainOnData(projectId: string, userId: string, workspaceId: string, manifest: PreviewManifest, runDir: string): Promise<void> {
  const isGo = /\bgo(lang)?\b/i.test(`${manifest.runtime} ${manifest.stack} ${manifest.framework}`)
    || /\bgo\s+(build|run|mod|install)\b/i.test(manifest.buildCmd || "")
    || (manifest.toolchain || []).some((c) => /\bapk\s+add\b[^\n]*\bgo\b/.test(c));
  if (!isGo) return;
  // Static, idempotent installer: default to a recent Go, override from go.mod, extract to
  // /data/go-toolchain. GOTOOLCHAIN=auto (envPrefix) then pulls the exact version go.mod
  // wants into /data/go/pkg/mod if it differs — also persistent.
  const script =
    `if [ ! -x /data/go-toolchain/bin/go ]; then ` +
    `GOVER=$(grep -oE '^go [0-9]+(\\.[0-9]+){1,2}' ${runDir}/go.mod 2>/dev/null | awk '{print $2}'); ` +
    `[ -z "$GOVER" ] && GOVER=1.24.0; ` +
    `case "$GOVER" in *.*.*) : ;; *) GOVER="$GOVER.0" ;; esac; ` +
    `mkdir -p /data/tmp /data/go-toolchain; ` +
    `echo "Installing Go $GOVER to /data/go-toolchain (persistent)..."; ` +
    `curl -sSL "https://go.dev/dl/go$GOVER.linux-amd64.tar.gz" -o /data/tmp/go.tgz && ` +
    `tar -xzf /data/tmp/go.tgz -C /data/go-toolchain --strip-components=1 && rm -f /data/tmp/go.tgz; ` +
    `fi; ` +
    `/data/go-toolchain/bin/go version 2>&1 | head -1 || echo GO_TOOLCHAIN_MISSING`;
  await runDetachedPolled(projectId, userId, workspaceId, script, 600_000, { stallMs: 240_000, workDir: runDir }).catch(() => {});
}

// ── Read-only preview inspection (for the normal product/Analyst chat agent) ──
// The chat agent can READ code but has no window into the LIVE sandbox — so it can't see
// a real DB migration error, a 500, or which DB the app actually connects to. This tool
// gives it a strictly READ-ONLY exec into the project's preview VM to gather real
// evidence. Anything that mutates (rebuild, restart, migrations, writes, mutating SQL)
// belongs to ticket execution, apart from the explicit app restart operation.
/** Which checkout on the sandbox a preview action should operate on: the ticket
 *  worktree for the branch currently being previewed, else the default checkout.
 *  Resolves the branch → ticket by BOTH the feature/ticket-<id> convention and the
 *  ticket's recorded githubBranch (custom branch names are the common case), then
 *  verifies the worktree actually exists on the VM. */
async function resolvePreviewWorkDir(projectId: string, workspaceId: string): Promise<{ dir: string; note: string }> {
  const row = await getEnv(projectId);
  const trees = await sh(workspaceId, `git -C ${shellQuote(PROJECT_DIR)} worktree list --porcelain`, 20_000);
  if (trees.exitCode !== 0) throw new Error("Cannot identify the selected preview checkout.");
  return {dir: restartWorktree(trees.output, row?.previewBranch ?? null), note: `selected branch ${row?.previewBranch || '(default)'}`};
}

/** Conversation inspection is always read-only. The legacy shell setting cannot override it. */
export async function createPreviewInspectTool(params: { projectId?: string }): Promise<Record<string, unknown>> {
  const { projectId } = params;
  // Conversation inspection never escalates to a writable shell, even when the
  // project enables shell access for other execution contexts.
  return {
    inspectPreview: tool({
      description:
        "READ-ONLY window into this project's LIVE preview sandbox — use it to DIAGNOSE runtime issues you cannot see from source alone (a database migration error, a 500, why an asset 404s, which DB the app really connects to). Runs ONE shell command on the preview VM and returns its output. Gather REAL evidence instead of guessing: curl the app (GET only), tail the app log, `docker logs`, inspect migration files, or use read-only git (`git status`, `git log`, `git diff`, `git worktree list`) to see what a checkout actually contains. By DEFAULT it runs in whatever checkout the preview is currently serving — a ticket's worktree when a ticket branch is live — so what you inspect matches what the user is looking at; pass `workdir` to inspect the main checkout or another ticket's worktree instead. You CANNOT mutate — no writes, rebuilds, restarts, migrations, or mutating SQL; route application changes through the existing ticket. Branch switching is not allowed. handlePreview supports prepared-app restart and manage_data for authorized account/data operations, including worker pause/resume and atomic multi-table cleanup. Source changes require tickets. Only works when a preview sandbox exists for this project.",
      inputSchema: zodSchema(z.object({
        command: z.string().describe("One shell command, e.g. `curl -s -i http://localhost:8080/`, `tail -n 100 preview.log`, `docker logs --tail 100 postgres`, `git log --oneline -5`, `grep -rn \"func.*Migrate\" internal/database`."),
        workdir: z.string().optional().describe("Which checkout to run in: \"preview\" (default) = the one the preview is currently serving; \"main\" = the default-branch checkout (/data/project); \"ticket:<ticketId>\" = that ticket's worktree; or an absolute path under /data."),
        reason: z.string().optional().describe("One line: what you're trying to find out."),
      })),
      execute: async ({ command, workdir }: { command: string; workdir?: string; reason?: string }) => {
        if (!projectId) return { error: "inspectPreview only works inside a project chat (no project context here)." };
        let workspaceId: string;
        try { workspaceId = await envWorkspaceId(projectId); }
        catch { return { error: "No preview sandbox exists for this project yet. Ask the user to start a preview (Run default branch), then inspection will work." }; }

        // Resolve the selected checkout for inspection only; never switch its branch.
        let dir: string;
        let note: string;
        const w = (workdir || "preview").trim();
        if (w === "main") { dir = PROJECT_DIR; note = "the default checkout"; }
        else if (w.startsWith("ticket:")) { const t = w.slice(7).trim(); dir = ticketWorktreeDir(t); note = `the worktree for ticket ${t}`; }
        else if (w.startsWith("/")) {
          if (!/^\/data\/[\w./-]*$/.test(w)) return { error: 'workdir must be "preview", "main", "ticket:<id>", or an absolute path under /data.' };
          dir = w; note = w;
        } else {
          ({ dir, note } = await resolvePreviewWorkDir(projectId, workspaceId));
        }

        const check = compilePreviewInspection(command);
        if (!check.ok) return { error: `Refused (read-only inspection): ${check.reason}. Route code changes through the ticket workflow. Use handlePreview manage_data for authorized data changes, worker controls and transactional cleanup; restart_app for a restart.` };
        try {
          const res = await sh(workspaceId, `${envPrefix(dir)}${check.command}`, 45_000);
          const output = (res.output || "").slice(-6000).trim();
          return { workdir: dir, ran_in: note, exitCode: res.exitCode, output: output || "(no output)" };
        } catch (e) {
          const msg = (e as Error).message || String(e);
          if (/no VM associated|not found|unreachable/i.test(msg)) return { error: "The preview sandbox isn't running right now — ask the user to start/restart the preview, then I can inspect it." };
          return { error: `Inspect failed: ${msg.slice(0, 200)}` };
        }
      },
    }),
  };
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

  return `${DEVELOPMENT_DATABASE_RECOVERY_INSTRUCTION}

${DEVELOPMENT_ACCESS_INSTRUCTION}

You are an expert DevOps engineer bringing an EXISTING application up so it can be previewed live. You DRIVE a remote Alpine Linux sandbox by calling the \`run\` tool with shell commands — one command per call — and reading the real output before deciding the next. When the app is confirmed serving, call \`finish\`.

SANDBOX: Alpine Linux (musl, apk, OpenRC/rc-service, busybox) — NOT Debian. Use \`apk add --no-cache <pkg>\` (never apt/yum), \`rc-service <svc> start\` (never systemctl). Docker is installed and running. Every \`run\` command ALREADY has: the .NET toolchain on PATH (if installed to /data/.dotnet), caches pointed at /data (NUGET_PACKAGES, DOTNET_CLI_HOME, TMPDIR — keep everything on /data, the 20GB volume; the root fs is tiny), and the .env in your working dir sourced. You are in ${workDir}.
${isBranch ? `\nIMPORTANT — you are running a FEATURE BRANCH from a git worktree at ${workDir}. The MAIN branch already ran successfully on this same VM, so the toolchain (/data/.dotnet) and the package cache (/data/.nuget) are ALREADY installed and warm — do NOT reinstall the toolchain or re-fix things the main run already fixed; reuse them. The DB connection strings + any env fixes are already in this worktree's .env. You likely just need: restore (fast, cache is warm) → build → start the app. Work in ${workDir} (cd there for every command).\n` : ""}
The repo is already cloned. The databases below passed provisioning checks; verify their current state when an error occurs and recover the local development service using the recovery policy above. Reuse their configured credentials, ports, and data directories. Their connection strings are in .env:
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
- CASE SENSITIVITY: Report incorrect asset references and the canonical tracked filenames for a ticket repair. Do not edit source, create aliases, or save source patches in preview.
- A 500 needs judgement: the app IS serving (running), but errored on the request. Read the error in ${workDir}/preview.log.
  • ENVIRONMENT issue in your remit (missing/wrong connection string, a service that isn't up, a missing env var) → fix it and retry.
  • A SCHEMA error ("Invalid column name", "Invalid object name", "relation does not exist", "Unknown column", a missing table/column — Postgres/MySQL/SQL Server alike) is almost always a schema that FAILED TO BUILD — and building the schema IS your job, so do NOT give up on it. (DB clients: SQL Server → \`docker exec -i mssql …sqlcmd…\`, list with \`SELECT name FROM sys.tables\`; Postgres → \`docker exec -i postgres psql\`, list with \`\\dt\` / information_schema.tables; MySQL → \`docker exec -i mysql mysql\`, \`SHOW TABLES\`.) First look at the Steps: did migration/schema steps FAIL (crossed out)? They usually did, for fixable reasons: (a) a SQL file has a UTF-8 BOM/encoding that breaks the first statement — re-apply stripping the BOM (\`tail -c +4 file | …\` if the first 3 bytes are EF BB BF); (b) the migration ran against a DIFFERENT database than the app (NEVER hardcode a DB name — use the .env connection the app uses; verify the app's DB actually has the tables); (c) wrong order — a script ALTERs a table an earlier failed step should have created, so fix the earlier step first; (d) a bad migration (e.g. drops a column before its table exists) — report the actual schema conflict and repair the migration on the isolated branch; never forge migration history. (e) a script that RESTORES a whole database FROM DISK='…\\x.bak' — that backup lives on the original dev machine and is NOT in the repo/sandbox; SKIP it entirely (do not try to find, download, or recreate the .bak, and do not restore over the app's DB), the schema comes from the migrations + the other scripts. Re-apply the failed schema steps against the SAME DB the app uses, then restart and re-check the page. Call \`noteLearning\` for each fix so the next run has it.
  • If the app does NOT come up on the port AT ALL and preview.log is empty/short, it likely blocked/crashed DURING STARTUP — a logging sink or health check that can't reach a service (e.g. a Serilog MSSqlServer sink that reads its connection from appsettings.json and hangs/throws if it can't connect). Read the very first lines of preview.log, fix the startup blocker (point that sink/setting at the provisioned DB, or disable it for the preview), and restart. An app that won't start is IN your remit.
  • ONLY after the schema builds CLEANLY (all scripts applied to the app's DB with no errors) and the page STILL 500s on a missing column should you conclude it's a genuine app/repo bug (the app queries a column no migration/script creates) — THEN call \`finish\` "ready" and state precisely which column/table and that a clean schema build still lacks it. You may do up to ~2 full schema-repair passes; do not loop endlessly on the same failing command.

PERSISTING WHAT YOU LEARN (so the next run doesn't repeat your work):
- Each \`run\` command starts a FRESH shell, so a bare \`export FOO=bar\` does NOT carry to the next command. For an environment fix that must stick (an env var, a cert/CA path, a package source), call the \`setEnv\` tool — it stores the var on the project (encrypted) AND writes it into .env now, so it is re-applied on every future setup and SURVIVES a VM rebuild. (Appending to ./.env only lasts while this VM lives — if the VM is recreated you'd have to rediscover the fix.)
- When you discover the PLAN itself was wrong and found what works — a different toolchain install, install/build/run command, startup project, or port — call \`updatePlan\` to persist the corrected value. Do this AFTER you've confirmed the new command works. This is how the checklist self-heals: the next preview run skips straight to the working commands. IMPORTANT: in a build/run command you persist, use paths RELATIVE to the working dir (e.g. \`Cohire.Web/wwwroot/CohireFiles\`), NOT absolute \`${PROJECT_DIR}/...\` — the same command is later run in FEATURE-BRANCH worktrees, and a hardcoded ${PROJECT_DIR} path would touch main instead of the worktree.
- When you learn a FACT that no plan field captures — a schema/ordering rule (migration MUST run before a SQL script), a missing client (\`sqlcmd\` isn't installed → use \`docker exec\`), a config gotcha — call \`noteLearning\` so the next run and every feature branch see it up front. Record it the moment you learn it; this is what stops the "figure the same thing out for 2 hours every run" loop.
- Persist supported runtime configuration overrides with \`persistConfigPatch\`; prefer environment settings. Application source repairs belong to tickets. Never persist account mutations or test scripts.

RUNNING COMMANDS — IMPORTANT:
- The \`run\` tool already runs each command DETACHED and polls it to completion, so restore/build/install take as long as they need — you do NOT need to background them, add \`&\`, nohup, or your own timeout wrapper. Just run the plain command (e.g. \`dotnet build Cohire.sln -c Release\`).
- Pass a large timeoutSec (~1500) for restore/build. A deadline terminates the process (exit -2); inspect the error and change the approach before retrying. Cancellation (exit -3) stops recovery immediately.
- If a command returns exitCode -4, we KILLED it: it produced NO output for ~4 min and looked stuck (commonly a hung network/TLS/DNS op — e.g. a package restore that can't validate a source's certificate even though \`curl\` to it works). Do NOT re-run the identical command. Diagnose the hang and change the approach (fix certs/CA path, a different package source or install method, offline/cached packages), then retry.
- RUN IN "LOG MODE" — surface the REAL error on the FIRST run. Errors are expected; the point is to see WHAT failed immediately, not to re-run to find out. So for any command that can fail (build/restore/migrate/install): keep \`2>&1\`, and use the tool's VERBOSE/diagnostic flag so the actual error prints inline. Concretely:
  • \`dotnet ef database update …\` hides errors ("Build failed. Use dotnet build to see the errors.") — ALWAYS add \`-v\` (verbose) so the build error is shown, OR run \`dotnet build <sln> -c Release\` FIRST to get the real error, then re-run ef once it builds.
  • Use \`--verbosity normal\`/\`-v\` for dotnet, \`-x\`/\`--verbose\` where a tool offers it, \`npm ... --loglevel verbose\`, etc.
  • Do NOT pipe output through \`grep\`/\`head\` in a way that hides the actual error + its context — you'll just have to re-run. Read the full tail we return.
  This avoids the wasteful "run → vague failure → re-run to see the error" cycle.

RULES:
- Inspect repository SQL schema/seed scripts and dependencies before execution. Runtime ordering may be corrected in schemaSteps, but script, model and migration changes require ticket execution. Never save SQL source patches, hide database drops in scripts, disable migrations, suppress PendingModelChangesWarning, or mark unapplied migrations as applied. Do not treat noteLearning or a successful second run on a partially seeded database as a source fix. ${PREVIEW_SOURCE_POLICY}
- When a command genuinely fails (a real non-zero exit with an error), read the error and fix the ENVIRONMENT, then continue. Keep going until the app responds or it truly cannot run — do not give up after one failed attempt.
- Required background workers belong in backgroundProcesses, never detached shell commands or replay actions. The runtime starts/stops them with the selected web app and environment. Never launch workers in a preview-check checkout.
- Preview owns runtime preparation and basic availability only. Do not install browser-test tools or run login/feature/acceptance tests during preview setup or recovery. These belong to ticket validation, even if old learnings/directives or replayActions say otherwise. A failed login test is not proof the server cannot start.
- Do not bootstrap administrator accounts or reset passwords as a startup habit. Only initialize data explicitly required by the repository, using its existing seed/bootstrap command. Record the source requirement in schemaSteps.requiredBy and a read-only existence assertion in verify; when the data already exists, skip the seed. Never compare passwords as an existence check. Requested test-account creation/reset uses the separate preview data operation, without a ticket build or a recurring startup action.
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
  opts?: { stallMs?: number; workDir?: string; onActivity?: () => void; abortSignal?: AbortSignal; onProgress?: (detail: string) => void },
): Promise<{ exitCode: number; output: string }> {
  opts?.abortSignal?.throwIfAborted();
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
  const startedAt = Date.now();
  const deadline = startedAt + maxMs;
  let interval = 3000;
  let lastSize = -1;
  let lastGrowthAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(interval);
    opts?.onActivity?.(); // keep the caller's idle watchdog alive during a long command
    interval = Math.min(interval + 2000, 15000); // back off: 3s,5s,7s…15s
    // Cancelled → kill the detached command's process tree and bail.
    if (isCancelled(projectId) || opts?.abortSignal?.aborted) {
      await execOnWorkspace(workspaceId, `pkill -9 -f ${id} 2>/dev/null; echo cancelled`, { timeout: 20_000 }).catch(() => {});
      return { exitCode: -3, output: "(cancelled)" };
    }
    // One call: the done-marker AND the current log size (for stall detection).
    const chk = await execOnWorkspace(workspaceId, `if [ -f ${donef} ]; then printf 'DONE:'; cat ${donef}; else echo RUNNING; fi; printf ' SIZE:'; wc -c < ${logf} 2>/dev/null || printf 0`, { timeout: 30_000 })
      .catch(() => ({ output: "RUNNING SIZE:0", stderr: "", exitCode: 0 }));
    const chkOut = chk.output || "";
    if (chkOut.includes("DONE:")) {
      const code = parseInt((chkOut.match(/DONE:(-?\d+)/) || [])[1] ?? "-1", 10);
      const out = await execOnWorkspace(workspaceId, `{ head -c 12000 ${logf}; tail -c 6000 ${logf}; } 2>/dev/null`, { timeout: 30_000 })
        .catch(() => ({ output: "", stderr: "", exitCode: 0 }));
      return { exitCode: code, output: (out.output || "").trim() || "(no output)" };
    }
    opts?.onProgress?.(`Preview command still running (${Math.round((Date.now() - startedAt) / 1000)}s elapsed).`);
    if (stallMs > 0) {
      const size = parseInt((chkOut.match(/SIZE:\s*(\d+)/) || [])[1] ?? "0", 10);
      if (size > lastSize) { lastSize = size; lastGrowthAt = Date.now(); }
      else if (Date.now() - lastGrowthAt > stallMs) {
        const tail = await execOnWorkspace(workspaceId, `pkill -9 -f ${id} 2>/dev/null; tail -c 2000 ${logf} 2>/dev/null`, { timeout: 30_000 }).catch(() => ({ output: "" }));
        return { exitCode: -4, output: `(killed — no output for ${Math.round(stallMs / 1000)}s, command appears stuck. Do NOT re-run the same command; try a DIFFERENT approach. Recent output:\n${(tail as any).output || ""})`.slice(-4000) };
      }
    }
  }
  // Deadline reached: terminate before recovery so a second build cannot race it.
  const tail = await execOnWorkspace(workspaceId, `pkill -9 -f ${id} 2>/dev/null; tail -c 2000 ${logf} 2>/dev/null`, { timeout: 30_000 }).catch(() => ({ output: "" }));
  return { exitCode: -2, output: `(terminated after ${Math.round(maxMs / 1000)}s deadline; no process remains running. Recent output:\n${tail.output || ""})`.slice(-4000) };
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
  const profileBranch = activeProfileBranches.get(projectId) ?? "default";
  driverFailures.delete(projectId);
  let finished: { status: "ready" | "failed"; detail: string } | undefined;
  // Load the project's MANDATORY DIRECTIVES (user-authored + agent-appended must-dos).
  const directives = (await loadAppProfile(projectId, profileBranch).catch(() => null))?.profile.directives ?? [];

  const failedCommands = new Set<string>();
  const resets = new Set<string>();
  const reconcilePatches = async (patches: NonNullable<AppProfile["configPatches"]>, reason: string) => {
    assertPreviewRuntimePatches(patches);
    const check = async (target: string) => {
      const script = buildConfigPatchScript(patches, target, true);
      if (!script) return;
      const result = await sh(workspaceId, script, 60_000);
      if (result.exitCode !== 0) throw new Error(failureSummary(result.output));
    };
    await replaceVerifiedPatches(patches, {
      verifyClean: async () => {
        const clean = `/data/patch-check-${crypto.randomUUID()}`;
        try {
          const created = await sh(workspaceId, `git -C ${shellQuote(workDir)} worktree add --detach ${shellQuote(clean)} HEAD`, 60_000);
          if (created.exitCode !== 0) throw new Error("Cannot create patch verification checkout");
          const rewrite = profileBranch === "default" ? buildAppsettingsRewriteScript(engines, clean) : "";
          if (rewrite) {
            const result = await sh(workspaceId, rewrite, 60_000);
            if (result.exitCode !== 0) throw new Error("Cannot prepare clean configuration");
          }
          await check(clean);
        } finally {
          await sh(workspaceId, `git -C ${shellQuote(workDir)} worktree remove --force ${shellQuote(clean)}`, 30_000).catch(() => {});
        }
      },
      verifyCurrent: async () => check(workDir),
      save: async () => {
        const loaded = await loadAppProfile(projectId, profileBranch);
        if (!loaded) throw new Error("Profile disappeared during patch repair");
        loaded.profile.configPatches = patches;
        delete loaded.profile.blockedFailure; delete loaded.profile.verifiedRevision;
        await saveAppProfile(projectId, loaded.profile, profileBranch);
        await applySavedPatches(projectId, userId, workspaceId, loaded.profile, workDir);
      },
    });
    plog(projectId, userId, "Replaced stale patch recipe; current and clean checkouts verified", {detail:reason});
    return "Replacement saved. Full clean replay must still pass before preview is ready.";
  };
  const tools = {
    inspectSavedPatches: tool({
      description: "Read this branch's saved patch list before repairing a stale patch. Compare it with the actual file; do not append a replacement behind an obsolete patch.",
      inputSchema: zodSchema(z.object({})),
      execute: async () => (await loadAppProfile(projectId, profileBranch))?.profile.configPatches ?? [],
    }),
    replaceSavedPatches: tool({
      description: "Replace the FULL saved patch list after inspecting the current file and clean baseline. Preserve unrelated valid patches, retire obsolete ones with a reason, and consolidate to one patch per file. Include unchanged context for deletions. Both current and clean checkouts must verify before saving. An empty list explicitly retires all patches; full app validation still follows.",
      inputSchema: zodSchema(z.object({patches:appProfileSchema.shape.configPatches.unwrap(),reason:z.string().min(1)})),
      execute: async ({patches,reason}) => { try { return await reconcilePatches(patches,reason); } catch(e) { return `Patch replacement rejected: ${(e as Error).message}`; } },
    }),
    resetDevelopmentDatabase: tool({
      description: "Back up and reset one managed local SQL Server development database when schema repair needs a clean replay. Specify its active .env connection key and exact database. Saves full schema+data backup plus original tracked source, verifies backup, persists location, then resets. External connections and system databases are refused. At most once per database per recovery. Use only existing repository scripts with corrected runtime ordering; source changes require ticket execution. Do not mark success on a partially repaired database.",
      inputSchema:zodSchema(z.object({database:z.string(),connectionKey:z.string(),reason:z.string().min(1)})),
      execute: async ({database,connectionKey,reason}) => {
        if(resets.has(database)) return "Database reset already attempted in this recovery; stop repeating it and repair the recipe.";
        const engine = engines.find(e=>e.engine==="mssql");
        if(!engine) return "No managed SQL Server engine available; automatic reset refused.";
        try {
          const id=crypto.randomUUID();
          const scripts=databaseRecoveryScripts({engine,database,connectionKey,dir:workDir,backupId:id});
          resets.add(database);
          await backupThenReset({
            backup:()=>runDetachedPolled(projectId,userId,workspaceId,scripts.backup,600_000,{stallMs:0,workDir}),
            record:async()=>{
              throwIfCancelled(projectId);
              const loaded=await loadAppProfile(projectId,profileBranch);
              if(!loaded) throw new Error("Cannot save backup location; reset blocked");
              loaded.profile.recoveryBackups=[...(loaded.profile.recoveryBackups??[]),{id,workspaceId,database,connectionKey,path:scripts.path,createdAt:new Date().toISOString(),reason}];
              await saveAppProfile(projectId,loaded.profile,profileBranch);
              plog(projectId,userId,`Verified original schema and data backup: ${scripts.path}`,{detail:reason});
            },
            reset:async()=>{throwIfCancelled(projectId);return runDetachedPolled(projectId,userId,workspaceId,scripts.reset,180_000,{stallMs:0,workDir});},
          });
          return `Database reset. Original schema+data: ${scripts.path}/database.bak; source: ${scripts.path}/source.tar. Fix and persist the schema recipe, then replay it from the beginning.`;
        } catch(e) { return `Database recovery blocked: ${(e as Error).message}`; }
      },
    }),
    run: tool({
      description: "Run one shell command in the Alpine sandbox (bash). The toolchain PATH, /data caches, and the project's .env are already set up. The command runs to completion no matter how long it takes (build/restore are fine) — we run it detached and poll, so you don't need to background it yourself. Returns exit code + combined stdout/stderr (last 6KB). exitCode -2 = terminated at the deadline; diagnose before retrying. exitCode -4 = we KILLED it because it produced no output for ~4 min (stuck, e.g. a hung network/TLS op) — do NOT re-run the same command, change the approach.",
      inputSchema: zodSchema(z.object({
        command: z.string().describe("The shell command to run (one command; use && or a heredoc for multi-step). Run it in the FOREGROUND — do NOT add '&'/nohup/setsid yourself; we detach it for you. EXCEPTION: the app server itself must be started detached (setsid ... &) so it keeps running."),
        timeoutSec: z.number().optional().describe("How long to wait for THIS command before returning control (default 600, max 1800). For a big restore/build use ~1500. A timeout terminates the process before returning; do not launch duplicate work."),
      })),
      execute: async ({ command, timeoutSec }: { command: string; timeoutSec?: number }) => {
        if (previewPublicationBlocked(command)) return {exitCode:1,output:"Preview repairs must never be checked in or pushed. Application repairs belong to ticket execution."};
        if (/\bDROP\s+DATABASE\b|\bdropdb\b/i.test(command)) return {exitCode:1,output:"Direct database drops are blocked. Use resetDevelopmentDatabase so a verified original backup is saved first."};
        const state = await sh(workspaceId, `cd ${shellQuote(workDir)} && { git diff HEAD; sha256sum .env 2>/dev/null; } | sha256sum`, 15_000);
        const commandKey = command + state.output.trim();
        if (failedCommands.has(commandKey)) return { exitCode: 1, output: "This exact command already failed with the same source/environment. Change the repair before retrying; no duplicate command was started." };
        throwIfCancelled(projectId); // Stop pressed → abort the agent loop
        const maxMs = Math.min(Math.max(timeoutSec ?? 600, 10), 1800) * 1000;
        plog(projectId, userId, `$ ${command}`);
        setPreview(projectId, userId, { previewStatus: "starting" }, `$ ${command.slice(0, 110)}`).catch(() => {});
        // Kill a command that goes silent for 4 min (stuck) so the agent iterates
        // fast instead of burning the full timeout on a hang.
        const r = await runDetachedPolled(projectId, userId, workspaceId, command, maxMs, { stallMs: 240_000, workDir });
        throwIfCancelled(projectId);
        if (r.exitCode !== 0) failedCommands.add(commandKey);
        plog(projectId, userId, `  → exit ${r.exitCode}`, r.output ? { detail: r.output.slice(-1800), level: r.exitCode === 0 ? "info" : "error" } : undefined);
        return { exitCode: r.exitCode, output: r.exitCode === 0 ? r.output.slice(-6000) || "(no output)" : failureSummary(r.output, 6000) };
      },
    }),
    updatePlan: tool({
      description: "Persist a correction to the saved SETUP PLAN (the checklist) so the NEXT run uses the working approach instead of repeating the failed one. Call this the moment you discover a plan command is wrong and you found what works — e.g. the toolchain 'apk add dotnet8-sdk' fails so you installed the runtime a different way, or the install/build/run command, startup project, or port in the plan is wrong. This does NOT run anything; it just rewrites the checklist. (For an environment fix that must persist across steps/restarts — an env var, a cert path, a package source — append it to ./.env instead; it is sourced before every command.)",
      inputSchema: zodSchema(z.object({
        field: z.enum(["toolchain", "installCmd", "buildCmd", "runCmd", "port", "startupProject", "schemaSteps", "replayActions", "verificationPaths", "configPatches"]).describe("Which plan field to correct."),
        value: z.string().describe("The corrected value. For 'toolchain', the FULL working command sequence, one command per line (replaces the old toolchain). For 'port', the number as a string. Otherwise the exact command/name."),
        reason: z.string().describe("Briefly: what was wrong and what you changed it to."),
      })),
      execute: async ({ field, value, reason }: { field: string; value: string; reason: string }) => {
        if (field === "toolchain") manifest.toolchain = value.split("\n").map((s) => s.trim()).filter(Boolean);
        else if (field === "port") { const p = parseInt(value, 10); if (p > 0) manifest.port = p; }
        else if (field === "configPatches") { return await reconcilePatches(appProfileSchema.shape.configPatches.parse(JSON.parse(value)) ?? [], reason); }
        else if (field === "schemaSteps") {
          const next=z.array(schemaStepSchema).parse(JSON.parse(value));
          try { validateSchemaTargets(next,manifest.databases); } catch(error) { return (error as Error).message; }
          manifest.schemaSteps=next;
        }
        else if (field === "replayActions") manifest.replayActions = z.array(replayActionSchema).parse(JSON.parse(value));
        else if (field === "verificationPaths") manifest.verificationPaths = z.array(z.string().regex(/^\/(?!\/)/)).parse(JSON.parse(value));
        else (manifest as any)[field] = value;
        await db.update(projectEnvironments)
          .set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() })
          .where(eq(projectEnvironments.projectId, projectId)).catch(() => {});
        // Persist the correction into the PROFILE too — the manifest is re-derived
        // from the profile each run, so a manifest-only fix would be clobbered.
        await applyProfileCorrection(projectId, field, value, reason, profileBranch);
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
        const ok = await recordProfileLearning(projectId, note, profileBranch).catch(() => false);
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
        const ok = await recordDirective(projectId, directive, profileBranch).catch(() => false);
        plog(projectId, userId, `Added mandatory directive: ${directive}`);
        return ok ? "recorded — every future run must satisfy this." : "noted (no profile yet).";
      },
    }),
    persistConfigPatch: tool({
      description: "Persist a supported runtime configuration override (appsettings.json or application.yml/properties). Prefer setEnv. Source, login/UI, scripts and dependency changes must go through tickets and cannot be replayed as preview patches.",
      inputSchema: zodSchema(z.object({
        file: z.string().describe("Path relative to the working dir, e.g. 'Cohire.Web/appsettings.json'."),
        find: z.string().describe("EXACT literal substring currently in the file to replace (copy it verbatim)."),
        replace: z.string().describe("The replacement text."),
        reason: z.string().optional(),
        create: z.boolean().optional().describe("Create a sandbox-only file; find must be empty."),
      })),
      execute: async ({ file, find, replace, reason, create }: { file: string; find: string; replace: string; reason?: string; create?: boolean }) => {
        assertPreviewRuntimePatches([{file}]);
        const script = buildConfigPatchScript([{ file, find, replace, create }], workDir);
        if (script) { const r = await sh(workspaceId, script, 30_000); if (r.exitCode !== 0) return `Patch failed: ${failureSummary(r.output)}`; }
        try {
        await saveConsolidatedPatches(projectId,userId,workspaceId,profileBranch,workDir,engines,{file,find,replace,note:reason,create});
        } catch (error) { return `Repair applied locally but NOT saved: ${(error as Error).message}. Reconcile the saved patches before reporting ready.`; }
        const ok = true;
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
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return "Invalid environment variable name";
        if (UNSAFE_ENV_KEYS.has(key)) {
          return `Refused: ${key} is machine-specific and must NOT be persisted — a persisted ${key} gets injected into other VMs and clobbers their real ${key} (breaking ls/node/apk). The toolchain PATH is already set for every command. To use a tool, reference its absolute path or install it via updatePlan's toolchain step instead.`;
        }
        try {
          if (profileBranch !== "default") {
            const current = await loadAppProfile(projectId, profileBranch);
            if (!current) return "No branch profile to persist the environment repair";
            current.profile.environmentOverrides = [...(current.profile.environmentOverrides ?? []).filter(v => v.key !== key), { key, encryptedValue: encryptSecret(value) }];
            await saveAppProfile(projectId, current.profile, profileBranch);
            await applyBranchEnvironment(workspaceId, current.profile, workDir);
            return `Persisted ${key} on this branch only`;
          }
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
      stopWhen: stepCountIs(40), // generous step budget — schema-heavy apps (30+ scripts) need room to repair AND start
      system: buildDriverSystemPrompt(manifest, engines, workDir, configNotes, directives),
      prompt: `Profile scope: ${profileBranch}. schemaSteps/replayActions/verificationPaths corrections must be JSON arrays. Persist every repair; do not use unrecorded shell workarounds. Database drops must use resetDevelopmentDatabase so the original schema and data are backed up first. Correct runtime script ordering when appropriate. Report SQL source or identity-insert defects for ticket execution; do not save source patches or rely on rerunning a partially failed script until it works. Never commit or push to main from preview recovery. Bring the app up and verify it serves on 0.0.0.0:${port} (working dir: ${workDir}). Begin.`,
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

  // An EXPLICIT failure is authoritative — do NOT let a stale process mask it. On the
  // ONE shared preview VM, an old build (e.g. main's server from a prior run, or a
  // different branch) is often still bound to :${port}. If the driver reported it
  // CANNOT bring THIS run up (source change needed, or the exec channel is dead —
  // every command returned exit -1), a 200 from that lingering process is NOT this
  // build serving. Returning true here silently served the WRONG/old page under this
  // run's summary ("App running ✓" on a branch that never actually built). Trust the
  // explicit failed over a port that merely answers.
  if (finished?.status === "failed") {
    plog(projectId, userId, "App could not be brought up", { level: "error", detail: finished.detail });
    driverFailures.set(projectId, finished.detail);
    return false;
  }
  // Otherwise trust reality over the model's word: confirm the port actually serves
  // (covers the case where the model forgot to call finish but the app is genuinely up).
  if (await checkServer(workspaceId, manifest.port, 8)) return true;
  return false;
}

/** Structured operations on the selected preview database; no shell agent. */
export async function runPreviewDataOperation(opts: {
  projectId:string; publicProjectId:string; userId:string; conversationId:string;
  instruction:string; abortSignal?:AbortSignal; onActivity?:()=>void; onProgress?:(detail:string)=>void;
}): Promise<{status:'ok'|'error';reply:string}> {
  // Share the preview lifecycle queue so branch switches/restarts cannot race a
  // multi-table data transaction. Unlike acquirePreviewRun, do not cancel work.
  const selected=await getEnv(opts.projectId);
  if(selected?.previewStatus!=='running')return {status:'error',reply:'The selected preview must be running before changing its account or data. No ticket was started.'};
  const release=await acquirePreviewAccess(opts.projectId);
  try {
  opts.abortSignal?.throwIfAborted();
  const row=await getEnv(opts.projectId);
  if(row?.previewBranch!==selected.previewBranch||row?.appUrl!==selected.appUrl)return {status:'error',reply:'The selected preview changed while waiting. No data operation was started on the new branch.'};
  if(row?.previewStatus!=='running'||!row.appUrl||!row.setupManifest)return {status:'error',reply:'The selected preview must be running before changing its account or data. No ticket was started.'};
  const workspaceId=await envWorkspaceId(opts.projectId);
  const {dir}=await resolvePreviewWorkDir(opts.projectId,workspaceId);
  const manifest=manifestSchema.parse(JSON.parse(row.setupManifest));
  const driver=await resolveDriverModel(opts.userId,opts.projectId);
  if(!driver)return {status:'error',reply:'No model is available for this preview operation.'};
  let reply='';let status:'ok'|'error'='error';
  const checkSelection=async()=>{
    const current=await getEnv(opts.projectId);
    if(current?.previewStatus!=='running'||current.previewBranch!==row.previewBranch||current.appUrl!==row.appUrl)throw new Error('The selected preview changed. Operation stopped; no automatic retry on another branch.');
  };
  const maintenance=new PreviewWorkerMaintenance(manifest.backgroundProcesses||[],async(action,workers)=>{
    await checkSelection();
    opts.onProgress?.(action==='status'?'Checking background workers':action==='stop'?'Pausing background workers':'Resuming background workers');
    const r=await sh(workspaceId,previewWorkerCommand(action,dir,workers,manifest.databases.map(d=>d.connectionEnvVar),{webPort:row.appPort||manifest.port}),45000);
    if(r.exitCode!==0)throw Error(`Worker ${action} failed: ${r.output.slice(-1500)}`);
    workerHealthCache.delete(opts.projectId);
    return JSON.parse(r.output);
  });
  const tools={...previewDataTools({
    saveAccount:async(account)=>{await checkSelection(); const {storePreviewAccount}=await import('./preview-accounts.ts');await storePreviewAccount(opts.projectId,environmentBranch(row.previewBranch),account);},
    recallAccounts:async(identity)=>{await checkSelection();const {recallPreviewAccounts}=await import('./preview-accounts.ts');return recallPreviewAccounts(opts.projectId,environmentBranch(row.previewBranch),identity);},
    previewUrl:row.appUrl,connectionKeys:manifest.databases.map(d=>d.connectionEnvVar),workers:async(action)=>{
    opts.abortSignal?.throwIfAborted();throwIfCancelled(opts.projectId);
    return action==='pause'?maintenance.pause():action==='resume'?maintenance.resume():maintenance.status();
  },run:async(command,activity)=>{
    opts.abortSignal?.throwIfAborted();throwIfCancelled(opts.projectId);
    await checkSelection();
    opts.onActivity?.();opts.onProgress?.(activity||'Checking the app');
    // No command/output logging: generated test credentials stay within this chat.
    const result=await execOnWorkspace(workspaceId,previewDataWorkspaceCommand(dir,command),{timeout:45000});
    opts.onActivity?.();
    return {exitCode:result.exitCode,output:((result.output||'')+(result.stderr||'')).slice(-12000)};
  }}),reply:tool({description:'Report the actual result. Success requires evidence; return generated test credentials when requested. Never claim a ticket was needed or started.',inputSchema:zodSchema(z.object({status:z.enum(['ok','error']),summary:z.string()})),execute:async(args:{status:'ok'|'error';summary:string})=>{reply=args.summary;status=args.status;return 'acknowledged';}})};
  try{await generateText({model:driver.model,tools,system:PREVIEW_DATA_INSTRUCTION+'\n'+PREVIEW_DATA_MAINTENANCE_INSTRUCTION+`\nSelected branch: ${row.previewBranch}. Read code from ${dir}. Registered database keys: ${manifest.databases.map(d=>d.connectionEnvVar).join(', ')}.`,prompt:opts.instruction,stopWhen:stepCountIs(40),abortSignal:opts.abortSignal,onStepFinish:()=>opts.onActivity?.()});}
  catch(e){status='error';reply=opts.abortSignal?.aborted?'Preview data operation stopped.':`Preview data operation failed: ${(e as Error).message}`;}
  finally {
    // Restoration must run even after cancellation. An explicit Stop/changed
    // preview is checked by the adapter and is never silently restarted here.
    try{await maintenance.resume();}catch(e){status='error';reply+=` Worker restoration did not complete: ${(e as Error).message}. Data changes already committed, if any, remain committed.`;}
  }
  return {status,reply:reply||'The preview data operation did not produce a verified result. No ticket was started.'};
  } finally {release();}
}

/**
 * Park uncommitted work before a hard reset, keeping exactly ONE autostash per context.
 *
 * `-u` is the point: without it, NEW files aren't stashed, and the `git clean -fd` that
 * follows every reset deletes them outright — so a source file the preview agent wrote
 * but didn't commit was gone for good. (`-u` takes untracked files only; ignored ones —
 * .env, node_modules, bin/obj — are left alone, which is what we want. That needs `-a`.)
 *
 * The single-entry cap is deliberate. Uncommitted changes in a sandbox are throwaway
 * fixups to make the app run here (connection-string repoints and the like, re-applied
 * from the saved profile on every run), so this is a one-deep undo, not an archive —
 * stashes must not pile up on a long-lived box. Older entries for the same context, and
 * any from the previous naming scheme, are dropped.
 */
function autostash(dir: string, tag: string): string {
  const t = `lfg-autostash:${tag}`;
  return `
git -C "${dir}" stash push -u -m "${t}" >/dev/null 2>&1 || true
# Keep only the newest entry for this context (index 0 is newest, so drop from the tail),
# and clear out any left by the older single-name scheme.
while [ "$(git -C "${dir}" stash list 2>/dev/null | grep -cF "${t}")" -gt 1 ]; do
  _old=$(git -C "${dir}" stash list 2>/dev/null | grep -F "${t}" | tail -1 | cut -d: -f1)
  [ -n "$_old" ] || break
  git -C "${dir}" stash drop "$_old" >/dev/null 2>&1 || break
done
while git -C "${dir}" stash list 2>/dev/null | grep -qF "lfg-preview-autostash"; do
  _leg=$(git -C "${dir}" stash list 2>/dev/null | grep -F "lfg-preview-autostash" | tail -1 | cut -d: -f1)
  [ -n "$_leg" ] || break
  git -C "${dir}" stash drop "$_leg" >/dev/null 2>&1 || break
done`.trim();
}

// ── Public API ───────────────────────────────────────────────────────────────
export interface SetupOptions { expectedBranch?: string; cleanBuild?: boolean; userId: string; branch?: string; rebuildManifest?: boolean; ticketId?: string; conversationId?: string | null }

/** The worktree directory for a ticket's branch inside the preview sandbox. Must
 *  match the name the ticket executor creates: `wt-ticket-<ticketId first 12>`. */
function ticketWorktreeDir(ticketId: string): string { return `/data/wt-ticket-${ticketId.slice(0, 12)}`; }

/** Resolve a token-embedded clone URL for the project's repo (GitHub or GitLab),
 *  with a FRESH token — so a `git fetch` works even if the remote's baked-in token
 *  from the original clone has since expired. Used to reconstruct a ticket worktree. */
/** Self-heal a missing project→repo link. The build creates the GitHub repo but the
 *  project row's repoUrl can end up unset (a persistence gap) — so preview reports "no
 *  repository" even though the repo exists on GitHub. We look up the repo by the SAME
 *  derived name the build used (createGitHubRepo's sanitizer) and, if it EXISTS, back-fill
 *  the project. READ-ONLY — never creates a repo (so a genuinely-unbuilt project still
 *  reports "no repo" instead of getting an empty one). Returns the repoUrl or "". */
async function recoverProjectRepoLink(project: { id: string; ownerId: string; name: string; providedName?: string | null; repoProvider?: string | null }): Promise<string> {
  if ((project.repoProvider || "github").toLowerCase() === "gitlab") return ""; // GitLab isn't auto-created this way
  const [t] = await db.select().from(githubTokens).where(eq(githubTokens.userId, project.ownerId)).limit(1);
  const githubToken = t?.accessToken || "";
  if (!githubToken) return "";
  // Same sanitizer createGitHubRepo uses, so we resolve the exact repo the build made.
  const sanitized = (project.providedName || project.name || "").toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (!sanitized) return "";
  const headers = { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "User-Agent": "lfg-preview" };
  try {
    const userResp = await fetch("https://api.github.com/user", { headers });
    if (!userResp.ok) return "";
    const { login } = (await userResp.json()) as { login: string };
    const repoResp = await fetch(`https://api.github.com/repos/${login}/${sanitized}`, { headers });
    if (!repoResp.ok) return ""; // repo doesn't exist → genuinely no repo, do NOT create one
    const repo = (await repoResp.json()) as { html_url: string; name: string; owner: { login: string } };
    await db.update(projects).set({ repoUrl: repo.html_url, repoOwner: repo.owner.login, repoName: repo.name, updatedAt: new Date() }).where(eq(projects.id, project.id)).catch(() => {});
    console.log(`[preview] recovered repo link for project ${project.id} → ${repo.owner.login}/${repo.name}`);
    return repo.html_url;
  } catch (e) {
    console.warn(`[preview] repo-link recovery failed: ${(e as Error).message?.slice(0, 140)}`);
    return "";
  }
}

async function resolveAuthedRepoUrl(projectId: string, actingUserId?: string): Promise<{ authUrl: string; provider: string } | { error: string }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return { error: "project not found" };
  const columnProvider = (project.repoProvider || "github").toLowerCase();
  let repoUrl = project.repoUrl || (project.repoOwner && project.repoName
    ? `https://${columnProvider === "gitlab" ? "gitlab.com" : "github.com"}/${project.repoOwner}/${project.repoName}.git`
    : "");
  if (!repoUrl) repoUrl = await recoverProjectRepoLink(project); // build may have created the repo but not linked it
  if (!repoUrl) return { error: "This project has no repository yet — build a ticket first (that creates the repo + branch), then preview." };
  const provider = /gitlab\.com|\/gitlab\b/i.test(repoUrl) ? "gitlab" : /github\.com/i.test(repoUrl) ? "github" : columnProvider;
  // Fine-grained Git: fetch with the acting user's effective token (owner's when they're
  // the owner or shareGitAccess is ON; else the collaborator's own).
  const { gitUserId, usingOwnCollaboratorToken } = resolveGitActor(project, actingUserId);
  const ownHint = usingOwnCollaboratorToken ? " This project doesn't share the owner's Git — connect your own, or ask the owner to enable “Share Git access”." : "";
  let token = "";
  if (provider === "gitlab") {
    token = (await getValidGitlabToken(gitUserId)) || "";
    if (!token) return { error: `No GitLab token — reconnect GitLab in settings.${ownHint}` };
  } else {
    const [t] = await db.select().from(githubTokens).where(eq(githubTokens.userId, gitUserId)).limit(1);
    token = t?.accessToken || "";
    if (!token) return { error: `No GitHub token — connect GitHub in settings.${ownHint}` };
  }
  const cred = provider === "gitlab" ? `oauth2:${token}` : `x-access-token:${token}`;
  return { authUrl: repoUrl.replace(/^https:\/\//, `https://${cred}@`), provider };
}

/**
 * DISK-GENERATION GUARD (part 1 of 2): is this VM's /data still the one our
 * checkpoint describes?
 *
 * /data is a PER-VM ext4 volume (`disk_gb` → /dev/vdb); `workspace_id` only syncs
 * the separate /workspace via JuiceFS. So a respawned microVM can come back with a
 * BLANK /data — no checkout, no toolchain, no DB volumes — and we must not assume
 * either way. Probe instead of trusting.
 *
 * Exec failures are deliberately NOT treated as "wiped": they say nothing about the
 * disk, and the normal path surfaces the real error.
 */
async function checkoutMissing(workspaceId: string): Promise<boolean> {
  const probe = await sh(workspaceId, `test -d ${PROJECT_DIR}/.git && echo REPO_OK || echo NO_REPO`, 60_000)
    .catch(() => ({ output: "" } as { output: string }));
  return probe.output.includes("NO_REPO");
}

/**
 * DISK-GENERATION GUARD (part 2 of 2): drop the checkpoint that describes a disk
 * that no longer exists.
 *
 * Everything needed to rebuild from nothing is in Postgres — repo URL + token, the
 * app profile (stack, schemaSteps, configPatches), setupManifest's install/build/run
 * commands, projectDatabases' engines + passwords, and the env vars. But the two
 * checkpoint columns are keyed to the PROJECT, not to the disk they were achieved
 * on, and both suppress that rebuild:
 *   • setupComplete=1 → setupPreview "starts the app directly", skipping the runbook.
 *   • setupSteps      → executeRunbook marks those steps "✓ (already done)" and skips
 *                       install / toolchain / build / schema.
 * On a blank disk that lands straight in the AI driver with no source and no
 * toolchain (which is exactly the failure this guard exists to prevent). Clearing
 * them makes the next run do the full clone → DBs → env → install → build → schema.
 */
async function clearSetupCheckpoint(projectId: string): Promise<void> {
  await db.update(projectEnvironments)
    .set({ setupComplete: 0, setupSteps: null, updatedAt: new Date() })
    .where(eq(projectEnvironments.projectId, projectId)).catch(() => {});
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
  const branch = opts.branch && opts.branch !== "(default)" ? opts.branch : "";
  if(branch)assertPreviewBranch(branch); // "" → use the repo's default branch

  // Serialize: cancel + wait out any run already using this project's VM so two
  // clones/builds never overlap (→ OOM/segfault). Clears the cancel flag for us.
  const releaseRun = await acquirePreviewRun(projectId);

  resetLog(projectId);
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
      ? "Sandbox VM was respawned — checking what survived on its /data…"
      : "Sandbox ready — reusing the existing VM (Alpine Linux, 8GB, Docker-capable)");
    await prep("vm", "done");
    // Disk-generation guard: a respawned VM can come back with a blank /data, and the
    // checkpoint columns would still claim install/build/schema are done — so the
    // runbook below would skip them and start an app that isn't there. Invalidate it
    // BEFORE the getEnv() read that decides what to skip.
    if (await checkoutMissing(workspaceId)) {
      await clearSetupCheckpoint(projectId);
      plog(projectId, userId, "This sandbox has no checkout — its /data was reset. Rebuilding from scratch: clone → databases → env → install → build → schema.");
    }
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
    let repoUrl = project.repoUrl || (project.repoOwner && project.repoName
      ? `https://${columnProvider === "gitlab" ? "gitlab.com" : "github.com"}/${project.repoOwner}/${project.repoName}.git`
      : "");
    // The build may have created the GitHub repo but not persisted the link back to the
    // project — recover it (idempotent) so preview works instead of "no repository".
    if (!repoUrl) {
      repoUrl = await recoverProjectRepoLink(project);
      if (repoUrl) { project.repoUrl = repoUrl; plog(projectId, userId, "Recovered the GitHub repo link for this project — continuing…"); }
    }
    if (!repoUrl) return failed(projectId, userId, "This project has no repository yet, so there's nothing to preview. The repo is created when you build your FIRST ticket — that scaffolds the app, creates the Git repo, and pushes the branch. Build a ticket (\"start building\" / the Build button), then preview that ticket's branch from its Preview tab. (\"Run default branch\" only works once code exists on the default branch.)");
    const provider = /gitlab\.com|\/gitlab\b/i.test(repoUrl) ? "gitlab" : /github\.com/i.test(repoUrl) ? "github" : columnProvider;

    // Fine-grained Git: clone with the acting user's effective token (owner's when
    // they're the owner or shareGitAccess is ON; else the collaborator's own).
    const { gitUserId, usingOwnCollaboratorToken } = resolveGitActor(project, userId);
    const ownHint = usingOwnCollaboratorToken ? " This project doesn't share the owner's Git — connect your own under Settings → Integrations, or ask the owner to enable “Share Git access”." : "";
    let token = "";
    if (provider === "gitlab") {
      token = (await getValidGitlabToken(gitUserId)) || "";
      if (!token) return failed(projectId, userId, `No GitLab token — reconnect GitLab in settings to preview this project.${ownHint}`);
    } else {
      const [ghToken] = await db.select().from(githubTokens).where(eq(githubTokens.userId, gitUserId)).limit(1);
      token = ghToken?.accessToken || "";
      if (!token) return failed(projectId, userId, `No GitHub token — connect GitHub to preview this project.${ownHint}`);
    }
    // GitLab OAuth clones auth as oauth2:<token>@; GitHub as x-access-token:<token>@.
    const cred = provider === "gitlab" ? `oauth2:${token}` : `x-access-token:${token}`;
    const authUrl = repoUrl.replace(/^https:\/\//, `https://${cred}@`);
    const coBranch = branch
      ? `git check-ref-format --branch ${shellQuote(branch)} >/dev/null && git checkout ${shellQuote(branch)} && test "$(git branch --show-current)" = ${shellQuote(branch)}`
      : `git remote set-head origin -a && DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD) && git checkout "\${DEFAULT_BRANCH#origin/}"`;

    await prep("clone", "running");
    plog(projectId, userId, `Pulling repo from ${provider === "gitlab" ? "GitLab" : "GitHub"} (${repoUrl.replace(/^https:\/\//, "")})${branch ? ` @ ${branch}` : ""}…`);
    await setPreview(projectId, userId, { previewStatus: "detecting" }, "Fetching the code…");
    const clone = await sh(workspaceId, `
export PATH=/root/node/current/bin:/usr/local/bin:/usr/bin:/bin:$PATH
apk add --no-cache git ca-certificates >/dev/null 2>&1 || true
mkdir -p /data
if [ -d ${PROJECT_DIR}/.git ]; then
  cd ${PROJECT_DIR} && git remote set-url origin ${shellQuote(authUrl)} && git fetch --prune origin 2>&1 && { ${coBranch} && git pull --ff-only && test "$(git rev-parse HEAD)" = "$(git rev-parse @{upstream})" && echo CLONE_OK; }
else
  if test -d ${PROJECT_DIR} && test -n "$(ls -A ${PROJECT_DIR})"; then echo 'Existing unregistered checkout preserved; restore its Git metadata before setup'; exit 1; fi
  git clone ${shellQuote(authUrl)} ${PROJECT_DIR} && cd ${PROJECT_DIR} && (${coBranch}) && test "$(git rev-parse HEAD)" = "$(git rev-parse @{upstream})" && echo CLONE_OK
fi`, 240_000);
    if (clone.exitCode !== 0 || !clone.output.includes("CLONE_OK")) {
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

    const committedRecipe = await sh(workspaceId, `git -C ${PROJECT_DIR} show HEAD:.lfg-validation.json`, 15_000);
    if (committedRecipe.exitCode === 0 && committedRecipe.output.trim()) {
      profile = appProfileSchema.parse(JSON.parse(committedRecipe.output));
      plog(projectId, userId, "Using the runtime recipe committed with this branch.");
    }
    if (!profile && !opts.rebuildManifest) {
      const loaded = await loadAppProfile(projectId);
      if (loaded) {
        profile = loaded.profile;
        plog(projectId, userId, `Using saved run profile v${loaded.version} (${profile.stack || profile.runtime})`);
      }
    }
    if (!profile) {
      {
        const prior = await loadAppProfile(projectId); // carry learnings across a re-probe
        const pac = new AbortController();
        const pw = setInterval(() => { if (isCancelled(projectId)) pac.abort(); }, 1000);
        try {
          profile = await probeAppProfile({
            workspaceId,
            userId,
            knowledge: prior ? [...(prior.profile.directives ?? []), ...profileNotes(prior.profile)] : [],
            onLog: (l, d) => plog(projectId, userId, l, d ? { detail: d } : undefined),
            abortSignal: pac.signal,
          });
        } finally { clearInterval(pw); }
        if (profile) {
          // A re-probe rewrites the plan but must NOT forget hard-won run learnings.
          profile = mergeKnowledge(profile, prior?.profile);
          await saveAppProfile(projectId, profile);
        }
      }
    }
    throwIfCancelled(projectId);

    if (profile) {
      const fingerprint = await sh(workspaceId, runtimeFingerprintCommand(PROJECT_DIR), 15_000);
      profile.inputFingerprint = fingerprint.output.trim();
      await saveAppProfile(projectId, profile);
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

    }

    // Fallback: the probe produced nothing (rare) — use the lighter detection so
    // preview still functions.
    if (!manifest) {
      plog(projectId, userId, "Probe produced no profile — falling back to quick detection…");
      manifest = await detectManifest(projectId, userId);
      await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
      plog(projectId, userId, `Plan: ${manifest.stack || manifest.runtime}`);
      // Even quick detection needs a durable home for subsequent repairs.
      profile = appProfileSchema.parse({ ...manifest, runtimeVersion: "", buildQuirks: [], configQuirks: [],
        schemaSteps: orderedSchema(manifest), autoEnvVars: [], secretsRequired: [], directives: [], learnings: [] });
      await saveAppProfile(projectId, profile);
    }
    await prep("plan", "done");

    // Persist the env the detected app needs into the Environment tab: auto-generate
    // self-contained secrets (session/JWT/…), placeholder the external keys the user
    // must provide (SendGrid/Stripe/…). NON-blocking — the app runs regardless; the
    // user fills the placeholders and Restarts for full functionality.
    const detectedEnv = [
      ...(manifest.envVars ?? []).map((e) => ({ key: e.key, required: e.required, description: e.description })),
      ...((profile?.secretsRequired ?? []).map((s) => ({ key: s.key, required: true, description: s.description }))),
    ];
    // Deterministic backfill: grep the repo for env READS so we don't miss a var the app
    // references but the LLM detection skipped (e.g. SENDGRID_API_KEY). DB connection vars
    // are handled by provisioning, so exclude them here.
    const grepped = await grepEnvKeys(workspaceId).catch(() => [] as string[]);
    const dbVars = new Set(manifest.databases.map((d) => d.connectionEnvVar));
    const known = new Set(detectedEnv.map((e) => e.key));
    for (const k of grepped) {
      if (known.has(k) || dbVars.has(k)) continue;
      detectedEnv.push({ key: k, required: false, description: "Referenced in the codebase." });
    }
    const envSync = await syncDetectedEnv(projectId, userId, detectedEnv).catch(() => null);
    if (envSync?.generated.length) {
      plog(projectId, userId, `Generated ${envSync.generated.length} app secret(s): ${envSync.generated.join(", ")}`);
    }
    if (envSync?.needsInput.length) {
      // The keys are already synced INTO the Environment tab — listing every one of them
      // here just buries the chat (a big repo greps out 150+ vars). Point at the tab and
      // keep the names in the log line's detail for debugging.
      plog(projectId, userId, `${envSync.needsInput.length} external key(s) needed — set them in the Environment tab, then Restart.`, { detail: envSync.needsInput.map((n) => n.key).join(", ") });
      await publishConfigurationNotice(
        userId,
        opts.conversationId,
        `🔑 **${envSync.needsInput.length} environment variable(s) need values** — set them in the **Environment** tab, then Restart.`,
        pub(projectId),
      ).catch(() => {});
    }

    // Reliability backstop: union already-provisioned + code-signalled DBs into the plan
    // so the "agent detects + provisions" contract holds even when the LLM plan omits one.
    manifest = await reconcileDatabases(projectId, userId, manifest);

    // 3. Provision the DBs the plan calls for, and inject each connection string
    // into the EXACT env var the app reads it from (per the plan).
    await prep("db", manifest.databases.length ? "running" : "done");
    const provisioned: Record<string, string> = {};
    const engineHandles: EngineHandle[] = [];
    if (manifest.databases.length) {
      // DB strategy (Environment tab): auto = use the user's connection var if set,
      // else provision; new = always provision; provided = never provision, use the
      // user's var (notice if it's missing).
      const [projRow] = await db.select({ dbMode: projects.dbMode }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const dbMode = projRow?.dbMode ?? "auto";
      const providedVals = new Map(
        (await db.select({ key: projectEnvironmentVariables.key, v: projectEnvironmentVariables.encryptedValue })
          .from(projectEnvironmentVariables)
          .where(and(eq(projectEnvironmentVariables.projectId, projectId), eq(projectEnvironmentVariables.hasValue, true))))
          .map((r) => { let val = ""; try { val = decryptSecret(r.v); } catch { /* unreadable */ } return [r.key, val] as const; }),
      );
      await setPreview(projectId, userId, { previewStatus: "provisioning" }, `Provisioning ${manifest.databases.map((d) => d.engine).join(", ")}…`);
      for (const dbSpec of manifest.databases) {
        const providedVal = providedVals.get(dbSpec.connectionEnvVar) || "";
        if (dbMode === "provided" && !providedVal) {
          await publishConfigurationNotice(userId, opts.conversationId, `⚠️ **DB mode is "Use my DB"** but \`${dbSpec.connectionEnvVar}\` isn't set. Add it in the Environment tab and Restart — or switch DB mode to "Always provision".`, pub(projectId)).catch(() => {});
        }
        if (await shouldUseProvidedDb(workspaceId, projectId, userId, dbSpec, providedVal, dbMode)) continue;
        plog(projectId, userId, `Provisioning ${dbSpec.engine} → ${dbSpec.connectionEnvVar}…`);
        const h = await ensurePreviewEngine(projectId, userId, dbSpec.engine, dbSpec);
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

    await prep("env", "done");

    // 5. Get the app running + VERIFIED via the CHECKPOINTED RUNBOOK. The plan is
    // an ordered command list with assertions. Setup and restart use the same executor.
    const driver = await resolveDriverModel(userId, projectId);
    let up = false;

    const configNotes = profile ? profileNotes(profile) : [];
    const result = await executeRunbook(projectId, userId, workspaceId, manifest, engineHandles, driver?.model, null, prelude, configNotes);
    up = result.up;
    await db.update(projectEnvironments).set({ setupComplete: up ? 1 : 0, runCommand: manifest.runCmd, updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
    if (!up) return failed(projectId, userId, result.error || "Preview plan failed — see the failing step.");

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
        // PIN the primary alias to its OWN port, exactly like every companion does
        // (exposeService). Registered without a port it resolves to "the job's primary
        // port" — which the FIRST companion then moves when its own enableHttpAccess
        // runs, silently re-pointing the primary subdomain at the companion's app.
        try { previewUrl = await setStableUrl(alias, workspaceId, effectivePort); }
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
    // Multi-app: bring up any ENABLED companion services on their own subdomains.
    const auditStep: RunStep = { id: "audit", phase: "verify", label: "Verify homepage, assets and database health", command: "", status: "running" };
    result.steps.push(auditStep); await persistSteps(projectId, userId, result.steps);
    const companionSummary = await runEnabledCompanions(projectId, userId, workspaceId, manifest, PROJECT_DIR, alias, previewUrl);
    // Each companion's exposeService() calls enableHttpAccess for ITS port, which leaves
    // the job's primary port pointing at whichever companion started last. Restore it to
    // the primary app so the job's bare URL (and any unpinned alias) means the main app.
    if ((manifest.services || []).some((s) => !s.primary && s.enabled)) {
      await enableHttpAccess(workspaceId, effectivePort).catch(() => {});
    }
    // Keep automatic launch diagnostics in the Preview panel, not the conversation.
    const vManifest = effectivePort === manifest.port ? manifest : { ...manifest, port: effectivePort };
    const v = await verifyPreview(projectId, userId, workspaceId, vManifest, branch || "(default)").catch(() => null);
    auditStep.status = v?.overall === "ok" ? "done" : "failed";
    if (auditStep.status === "failed") auditStep.error = v?.summary || "Verification could not complete";
    await persistSteps(projectId, userId, result.steps);
    if (v) plog(projectId, userId, "Preview launch summary", { level: v.overall === "ok" ? "info" : "error", detail: `${v.summary}\n\n🔗 ${previewUrl}${companionSummary}` });
    if (auditStep.status === "failed") return failed(projectId, userId, auditStep.error || "Preview verification failed");
    throwIfCancelled(projectId);
    await recordAppliedEnvironment(projectId, environmentBranch((await getEnv(projectId))?.previewBranch), preparedEnvironment.get(manifest));
    return { previewUrl };
  } catch (err) {
    const msg = errText(err);
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
    releaseRun(); // let a queued run (branch switch) proceed on the now-free VM
  }
}

/**
 * Drizzle wraps driver errors: `.message` is only "Failed query: … params: …",
 * while the reason ("duplicate key value violates unique constraint …") sits in
 * `.cause`. Unwrap the chain so a failed setup logs WHY, not just which query.
 */
function errText(err: unknown): string {
  const parts: string[] = [];
  const add = (v?: string) => { if (v && !parts.includes(v)) parts.push(v); };
  let e: any = err;
  for (let i = 0; e && i < 4; i++) {
    add(typeof e === "string" ? e : e.message);
    add(e.detail);                                    // pg: "Key (workspace_id)=(…) already exists."
    add(e.constraint ? `constraint: ${e.constraint}` : undefined);
    e = e.cause;
  }
  return parts.join(" — ") || String(err);
}

async function failed(projectId: string, userId: string, error: string): Promise<{ error: string }> {
  console.error(`[dev-preview] ${projectId}: ${error}`);
  await setPreview(projectId, userId, { previewStatus: "error", previewError: error.slice(0, 4000) }, "Preview failed").catch(() => {});
  return { error };
}

/** Current preview state for the Preview tab. */
const workerHealthCache=new Map<string,{at:number;error:string|null}>();
export async function getPreviewState(projectId: string) {
  const row = await getEnv(projectId);
  if (!row) return { previewStatus: "idle" as PreviewStatus, previewUrl: null, manifest: null, error: null, branch: null, log: "", steps: [], setupComplete: false, services: [] };
  const manifest = row.setupManifest ? (JSON.parse(row.setupManifest) as PreviewManifest) : null;
  // Multi-app: the service list + each service's URL for the Preview switcher. Primary →
  // the main appUrl; an enabled companion → its OWN subdomain: insert "-<name>" into the
  // primary URL's first host label (preview-<alias> → preview-<alias>-<name>). Deriving from
  // appUrl (always set when running) instead of a separate stableAlias avoids the empty-URL
  // case where a companion chip wasn't clickable and fell back to showing the primary.
  const appDomain = process.env.MAGS_APP_DOMAIN || "app.lfg.run";
  const companionUrl = (name: string): string => {
    if (!row.appUrl) return row.stableAlias ? `https://${row.stableAlias}-${name}.${appDomain}` : "";
    return row.appUrl.replace(/^(https?:\/\/[^./]+)/, `$1-${name}`).replace(/\/$/, "");
  };
  const services = (manifest?.services || []).map((s) => ({
    name: s.name,
    port: s.port,
    primary: !!s.primary,
    enabled: !!s.primary || !!s.enabled,
    manual: !!s.manual,
    dir: s.dir ?? "",
    url: s.primary ? (row.appUrl ?? "") : ((!!s.primary || !!s.enabled) ? companionUrl(s.name) : ""),
  }));
  let workerError:string|null=null;
  if(row.previewStatus==='running' && manifest?.backgroundProcesses?.length){
    let health=workerHealthCache.get(projectId);
    if(!health || Date.now()-health.at>10000){
      try{
        const workspaceId=await envWorkspaceId(projectId);const {dir}=await resolvePreviewWorkDir(projectId,workspaceId);
        const result=await sh(workspaceId,previewWorkerCommand('status',dir,manifest.backgroundProcesses,manifest.databases.map(d=>d.connectionEnvVar)),15000);
        const data=JSON.parse(result.output);
        health={at:Date.now(),error:result.exitCode===0 && data.healthy?null:'A required background worker is stopped or has outdated database settings. Restart the app to restart its workers; see App logs.'};
      }catch{health={at:Date.now(),error:'Could not verify required background workers. Check the preview runtime and App logs.'};}
      workerHealthCache.set(projectId,health);
    }
    workerError=health.error;
  }
  return {
    previewStatus: workerError ? 'error' as PreviewStatus : (row.previewStatus as PreviewStatus) ?? "idle",
    previewUrl: row.appUrl ?? null,
    manifest,
    error: workerError ?? row.previewError ?? null,
    branch: row.previewBranch ?? null,
    databaseIdentities: (await loadAppProfile(projectId,environmentBranch(row.previewBranch)))?.profile.databaseIdentities || [],
    log: logBuffers.get(projectId) ?? row.setupLog ?? "",
    steps: row.setupSteps ? (JSON.parse(row.setupSteps) as RunStep[]) : [],
    setupComplete: row.setupComplete === 1,
    services,
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

  const state = await getEnv(projectId);
  const branch = state?.previewBranch && state.previewBranch !== "(default)" ? state.previewBranch : "default";
  const { dir } = await resolvePreviewWorkDir(projectId, workspaceId);
  const prior = await loadAppProfile(projectId, branch);
  const profile = await probeAppProfile({
    workspaceId,
    userId,
    workDir: dir,
    knowledge: prior ? [...(prior.profile.directives ?? []), ...profileNotes(prior.profile)] : [],
    onLog: (l, d) => plog(projectId, userId, l, d ? { detail: d } : undefined),
  });
  if (!profile) {
    plog(projectId, userId, "Re-probe produced no profile.", { level: "error" });
    broadcastToUser(userId, { type: "preview_profile", projectId: pub(projectId), profile: null, error: "The probe produced nothing — check the logs." });
    return;
  }
  // Keep hard-won learnings across the re-probe.
  Object.assign(profile, mergeKnowledge(profile, prior?.profile));
  const fp = await sh(workspaceId, runtimeFingerprintCommand(dir), 15_000);
  profile.inputFingerprint = fp.output.trim();
  await saveAppProfile(projectId, profile, branch);
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
  opts: { postToChat?: boolean } = {},
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
      // NODE_TLS_REJECT_UNAUTHORIZED=0: the CDP endpoint is an internal Mags browser
      // session over wss:// whose cert chain isn't in Node's trust store — connectOverCDP
      // otherwise fails the TLS handshake with "unable to get local issuer certificate"
      // (which surfaced as a 400 on the screenshot button). Setting IgnoreCertificateErrors
      // inside the worker is too late — it runs after the socket connects.
      const child = spawn("node", [`${process.cwd()}/scripts/screenshot-worker.mjs`], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
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

  // 3. Post it into the chat conversation as a markdown image — UNLESS the caller is
  // routing it elsewhere (e.g. the ticket chat), in which case just return the url.
  if (opts.postToChat !== false && conversationId) {
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
export async function getPreviewBranches(projectId: string): Promise<Array<{ id: string; label: string; ticketId: string | null; branch: string; group?: string }>> {
  // `group` partitions the selector: epics are delivery units, tickets are slices of
  // one. A single flat list of 20 entries made you read every line to find either.
  const out: Array<{ id: string; label: string; ticketId: string | null; branch: string; group?: string }> = [
    { id: "default", label: "Default branch", ticketId: null, branch: "(default)", group: "" },
  ];
  const seen = new Set<string>();
  const add = (ticketId: string, name: string | null, key: string | null, branch: string) => {
    if (!ticketId || seen.has(ticketId)) return;
    seen.add(ticketId);
    const label = `${key ? key + " — " : ""}${name ?? "ticket"}`.slice(0, 60);
    out.push({ id: ticketId, label, ticketId, branch, group: "Tickets" });
  };

  // 1) Ticket worktrees are recorded as sandbox rows (workspaceType
  // "ticket-worktree") pointing at this project's preview workspace.
  // The branch MUST be resolved the same way the runner resolves it
  // (githubBranch, else the feature/ticket-<id> convention) — otherwise the
  // selector can't match the branch the preview reports as running and falls
  // back to showing "Default branch" while a ticket branch is building.
  const wtRows = await db
    .select({ ticketId: sandboxes.ticketId, name: projectTickets.name, key: projectTickets.ticketKey, branch: projectTickets.githubBranch })
    .from(sandboxes)
    .leftJoin(projectTickets, eq(sandboxes.ticketId, projectTickets.id))
    .where(and(eq(sandboxes.projectId, projectId), eq(sandboxes.workspaceType, "ticket-worktree")));
  for (const r of wtRows) if (r.ticketId) add(r.ticketId, r.name, r.key, r.branch || `feature/ticket-${r.ticketId}`);

  // 2) Tickets that were built + pushed (isolated builds destroy their VM, so
  // there's no worktree row — but the branch exists on the remote).
  const builtRows = await db
    .select({ id: projectTickets.id, name: projectTickets.name, key: projectTickets.ticketKey, branch: projectTickets.githubBranch })
    .from(projectTickets)
    .where(and(
      eq(projectTickets.projectId, projectId),
      or(isNotNull(projectTickets.githubBranch), isNotNull(projectTickets.githubCommitSha)),
    ))
    // Newest first: the ticket you just built is the one you want to run, and it was
    // landing wherever the database happened to return it.
    .orderBy(desc(projectTickets.createdAt));
  for (const r of builtRows) add(r.id, r.name, r.key, r.branch || `feature/ticket-${r.id}`);

  // 3) EPIC branches. An epic is the unit a client actually reviews — its integration
  // branch has every ticket in the epic merged into it, so previewing it shows the whole
  // feature working together rather than one ticket's slice. Listed FIRST (right under
  // "Default branch") since that's the more common thing to want to look at.
  const epicRows = await db
    .select({ id: epics.id, key: epics.epicKey, name: epics.name, branch: epics.branch, status: epics.status })
    .from(epics)
    .where(and(eq(epics.projectId, projectId), isNotNull(epics.branch)))
    .orderBy(desc(epics.createdAt));
  const epicEntries = epicRows
    // A rejected epic's branch is abandoned; a branchless one was never cut.
    .filter((e) => e.branch && e.status !== "rejected")
    .map((e) => ({
      // "epic:" prefixed so the client can tell an epic from a ticket id, and so the
      // run carries no ticketId (there's no single ticket this is).
      id: `epic:${e.id}`,
      label: `${e.key ? e.key + " — " : ""}${e.name}`.slice(0, 60),
      ticketId: null as string | null,
      branch: e.branch as string,
      group: "Epics",
    }));
  out.splice(1, 0, ...epicEntries);

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
  commits: Array<{ sha: string; when: number; subject: string }>; error?: string; merged?: boolean; compareUrl?: string;
}> {
  // Prefer the ticket's actually-pushed branch; fall back to the convention.
  const [tk] = await db.select({ gb: projectTickets.githubBranch, epicId: projectTickets.epicId }).from(projectTickets).where(eq(projectTickets.id, ticketId));
  const head = tk?.gb || `feature/ticket-${ticketId}`;
  // No base asked for: compare with the branch the ticket merges into (its epic's).
  const anchor = base ? null : await (await import("./epics.ts")).resolveTicketAnchor({ epicId: tk?.epicId });
  const b = (base || (anchor?.epic ? anchor.anchorBranch : "main")).replace(/[^\w./-]/g, "") || "main";
  // GitHub answers directly; no sandbox clone needed.
  const authed = await resolveAuthedRepoUrl(projectId);
  const gh = "error" in authed ? null : parseAuthedGithubUrl(authed.authUrl);
  if (gh) return githubTicketDiff(gh, b, head);
  let workspaceId: string;
  try { ({ workspaceId } = await ensureProjectSandbox(projectId)); }
  catch { return { branches: [], base: b, head, files: [], diff: "", commits: [], error: "No preview sandbox yet — open the Preview tab and set it up first." }; }

  // Isolated builds push the branch from a throwaway VM that's since destroyed,
  // so this long-lived preview sandbox has no local copy. Fetch it from the
  // remote first — with auth, since the repo may be private (GitLab/GitHub).
  const auth = await resolveAuthedRepoUrl(projectId); // read-only diff → owner's token
  const authUrl = "error" in auth ? "" : auth.authUrl;

  const script = `
cd ${PROJECT_DIR} 2>/dev/null || { echo "NO_REPO"; exit 1; }
[ -e .git ] || { echo "NO_REPO"; exit 1; }
${authUrl ? `git remote set-url origin "${authUrl}" 2>/dev/null || true` : ""}
# Explicit destination refspecs so refs/remotes/origin/<branch> is ALWAYS created —
# a bare 'git fetch --prune origin <branch>' only updates FETCH_HEAD and relies on the clone's
# fetch refspec for the remote-tracking ref, which fails for slashed branch names /
# narrowed clones (branch exists on GitHub but 'git rev-parse origin/<branch>' is empty).
FETCH_OK=1
FETCH_ERR=$(git fetch --no-tags --force origin "+refs/heads/${head}:refs/remotes/origin/${head}" "+refs/heads/${b}:refs/remotes/origin/${b}" 2>&1) || FETCH_OK=0
git fetch --prune origin >/dev/null 2>&1 || true
# A failed fetch used to be swallowed here and only reported if the HEAD ref was also
# missing. When the refs exist but are STALE the comparison still ran — against an old
# tip — and produced a wrong-but-plausible answer: commits already merged into the base
# listed as if this branch introduced them. Wrong quietly is worse than broken loudly.
[ "$FETCH_OK" = "1" ] || { echo "FETCH_FAILED"; echo "FETCH_ERR:$FETCH_ERR"; }
echo "===BRANCHES==="
git for-each-ref --format='%(refname:short)' refs/remotes/origin 2>/dev/null | sed 's#^origin/##' | grep -v '^HEAD$' | sort -u
echo "===REFS==="
BASE=$(git rev-parse --verify -q origin/${b} >/dev/null 2>&1 && echo origin/${b} || echo ${b})
HEAD=$(git rev-parse --verify -q origin/${head} >/dev/null 2>&1 && echo origin/${head} || echo ${head})
git rev-parse --verify -q "$HEAD" >/dev/null 2>&1 || { echo "NO_HEAD"; echo "FETCH_ERR:$FETCH_ERR"; exit 0; }
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
  // Refuse to show a comparison built on refs we couldn't refresh. Scrub the token the
  // remote URL carries before echoing git's message back.
  if (output.includes("FETCH_FAILED")) {
    const raw = output.match(/FETCH_ERR:([\s\S]*?)(?:\n===|$)/)?.[1]?.trim() ?? "";
    const safe = raw.replace(/\/\/[^@\s]+@/g, "//***@").slice(0, 300);
    return {
      branches, base: b, head, files: [], diff: "", commits: [],
      error: `Couldn't refresh \`${b}\` and \`${head}\` from the remote, so this comparison would be stale — showing nothing rather than something wrong.\n\n${safe}`,
    };
  }
  if (output.includes("NO_HEAD")) {
    const fetchErr = output.match(/FETCH_ERR:([\s\S]*?)(?:\n===|$)/)?.[1]?.trim();
    // Distinguish "the branch really isn't on the remote" from "we couldn't fetch it"
    // (auth/network) — the latter is misdiagnosed as "rebuild the ticket".
    const authish = fetchErr && /Authentication|denied|403|401|could not read|fatal: repository|not found/i.test(fetchErr);
    return {
      branches, base: b, head, files: [], diff: "", commits: [],
      error: authish
        ? `Couldn't fetch \`${head}\` from the remote (auth/network). ${fetchErr!.slice(0, 200)}`
        : `Branch ${head} not found on the remote — rebuild the ticket to create/push it.`,
    };
  }
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
/** Toggle a companion service on/off. Persists `enabled` on the profile (survives manifest
 *  re-derivation) + the derived manifest, kills its port when turning OFF, then triggers a
 *  restart so the enabled set comes up. Returns the current service list for the UI. */
/** Bring ONE companion up in the BACKGROUND (detached) on the live sandbox, leaving the
 *  primary + other companions untouched — so starting/toggling a second app never forces a
 *  full restart (which would take down the primary too, and re-derive only the enabled set).
 *  Returns true if it kicked off; false if the caller should fall back to a full restart
 *  (preview not running). Fire-and-forget for the actual bring-up. */
async function startCompanionInBackground(projectId: string, userId: string, manifest: PreviewManifest, name: string): Promise<boolean> {
  const row = await getEnv(projectId);

  const added = (manifest.services || []).find((s) => s.name === name);
  if (!(added && row?.previewStatus === "running" && row.stableAlias)) return false;
  const stableAlias = row.stableAlias, appUrl = row.appUrl ?? "";
  (async () => {
    let release:(()=>void)|undefined;
    try {
      release=await acquirePreviewAccess(projectId);
      const current = await getEnv(projectId);
      if (current?.previewBranch !== row.previewBranch) throw new Error('Preview selection changed before companion startup; retry on the selected branch.');
      await loadPublicId(projectId); // WS routing for plog/broadcast
      const sandbox = await ensureProjectSandbox(projectId); // respawn a reaped VM if needed
      if (sandbox.created || sandbox.recreated) {
        plog(projectId, userId, `The preview VM was down — restarting the whole preview (primary + "${name}")…`);
        restartPreview(projectId, { userId, branch: row.previewBranch || "(default)", expectedBranch: row.previewBranch || "(default)" }).catch((e) => console.error("[preview] companion respawn restart failed:", e));
        return;
      }
      const workspaceId = sandbox.workspaceId;
      plog(projectId, userId, `Starting app "${name}" in the background — the main app keeps running…`);
      const {dir} = await resolvePreviewWorkDir(projectId, workspaceId);
      const r = await exposeService(projectId, userId, workspaceId, added, dir, stableAlias);
      if (r.url) await persistServiceBaseUrl(projectId, workspaceId, name, r.url, dir).catch(() => {});
      // exposeService just pointed the job's primary port at THIS companion. Restore it to
      // the primary app — this toggle path deliberately leaves the primary running and
      // never re-registers its alias, so without this the main URL starts serving the
      // companion the moment you flip a second app ON.
      const primaryPort = row?.appPort ?? manifest.port;
      if (primaryPort) await enableHttpAccess(workspaceId, primaryPort).catch(() => {});
      const appDomain = process.env.MAGS_APP_DOMAIN || "app.lfg.run";
      broadcastToUser(userId, { type: "preview_services", projectId: pub(projectId), services: (manifest.services || []).map((s) => ({
        name: s.name, port: s.port, primary: !!s.primary, enabled: !!s.primary || !!s.enabled,
        url: s.primary ? appUrl : (s.name === name ? (r.url || "") : (s.enabled ? `https://${stableAlias}-${s.name}.${appDomain}` : "")),
        up: s.name === name ? r.ok : true,
      })) });
    } catch (e) { plog(projectId, userId, `Background start of "${name}" failed: ${(e as Error).message?.slice(0, 160)}`, { level: "error" }); } finally { release?.(); }
  })();
  return true;
}

export async function setServiceEnabled(projectId: string, userId: string, name: string, enabled: boolean): Promise<{ ok: boolean; error?: string; services?: unknown[] }> {
  const release = await acquirePreviewAccess(projectId);
  try {
  const selection = (await getEnv(projectId))?.previewBranch || '(default)';
  const profileBranch = environmentBranch(selection);
  const loaded = await loadAppProfile(projectId, profileBranch);
  if (!loaded?.profile.services?.length) return { ok: false, error: "This preview has no multi-app services detected." };
  const profile = loaded.profile;
  const svc = profile.services!.find((s) => s.name === name);
  if (!svc) return { ok: false, error: `Unknown service "${name}".` };
  if (svc.primary) return { ok: false, error: "The primary app is always on — it can't be toggled." };
  svc.enabled = enabled;
  await saveAppProfile(projectId, profile, profileBranch);
  const manifest = deriveManifestFromProfile(profile);
  await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));

  const appDomain = process.env.MAGS_APP_DOMAIN || "app.lfg.run";
  const row0 = await getEnv(projectId);
  const stableAlias0 = row0?.stableAlias || "";
  const svcList = () => (manifest.services || []).map((s) => ({
    name: s.name, port: s.port, primary: !!s.primary, enabled: !!s.enabled, manual: !!s.manual,
    url: s.primary ? (row0?.appUrl ?? "") : (s.enabled && stableAlias0 ? `https://${stableAlias0}-${s.name}.${appDomain}` : ""),
  }));

  if (!enabled) {
    // OFF → just stop THIS companion's process. Leave the primary + other companions running
    // (no full restart — that used to take the whole preview down for a single toggle).
    const workspaceId = await envWorkspaceId(projectId).catch(() => null);
    if (workspaceId) await sh(workspaceId, `fuser -k ${svc.port}/tcp 2>/dev/null; pkill -f ':${svc.port}' 2>/dev/null; echo OK`, 15_000).catch(() => {});
    broadcastToUser(userId, { type: "preview_services", projectId: pub(projectId), services: svcList() });
    return { ok: true, services: svcList() };
  }
  // ON → start JUST this companion in the background (primary stays up). Fall back to a full
  // restart only when the preview is not running.
  const started = await startCompanionInBackground(projectId, userId, manifest, name);
  if (!started) restartPreview(projectId, { userId, branch: selection, expectedBranch: selection }).catch((e) => console.error("[preview] service-toggle restart failed:", e));
  return { ok: true, services: svcList() };
  } finally { release(); }
}

const svcSlug = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

/**
 * Manually add a runnable app (companion) — the deterministic fallback when the probe
 * doesn't detect a monorepo's second app. The user provides name + dir + start command +
 * port; we add it to the profile's services[] (seeding a primary from the single-app
 * profile if needed so we end up with 2+), persist, and restart so it comes up on its own
 * subdomain. Enabled on add (the user asked for it).
 */
export async function addService(
  projectId: string, userId: string,
  input: { name: string; dir?: string; runCmd: string; buildCmd?: string; port: number },
): Promise<{ ok: boolean; error?: string; services?: unknown[] }> {
  const release = await acquirePreviewAccess(projectId);
  try {
  const selection = (await getEnv(projectId))?.previewBranch || '(default)';
  const profileBranch = environmentBranch(selection);
  const loaded = await loadAppProfile(projectId, profileBranch);
  if (!loaded) return { ok: false, error: "Set up the preview first, then add an app." };
  const profile = loaded.profile;

  const name = svcSlug(input.name);
  if (!name) return { ok: false, error: "A short name (letters/numbers) is required." };
  const port = Number(input.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: "A valid port (1–65535) is required." };
  const runCmd = String(input.runCmd || "").trim();
  if (!runCmd) return { ok: false, error: "A start command is required." };
  const dir = String(input.dir || "").trim().replace(/^\/+|\/+$/g, "");
  const buildCmd = String(input.buildCmd || "").trim();

  profile.services = profile.services || [];
  // Ensure a primary exists so the manifest carries services[] (dropped when < 2). Seed it
  // from the single-app profile's top-level runCmd/port.
  if (profile.services.length === 0) {
    profile.services.push({ name: svcSlug(profile.framework) || "app", runCmd: profile.runCmd, port: profile.port, primary: true, enabled: true });
  } else if (!profile.services.some((s) => s.primary)) {
    const first = profile.services[0]!; first.primary = true; first.enabled = true;
  }
  if (profile.services.some((s) => s.name === name)) return { ok: false, error: `A service named "${name}" already exists.` };
  if (profile.services.some((s) => s.port === port)) return { ok: false, error: `Port ${port} is already used by another service.` };
  profile.services.push({ name, dir: dir || undefined, runCmd, buildCmd: buildCmd || undefined, port, primary: false, enabled: true, manual: true });

  await saveAppProfile(projectId, profile, profileBranch);
  const manifest = deriveManifestFromProfile(profile);
  await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));

  // Bring the new app up in the BACKGROUND so the main app keeps serving (no full restart);
  // falls back to a full restart only when the preview is not running.
  const started = await startCompanionInBackground(projectId, userId, manifest, name);
  if (!started) restartPreview(projectId, { userId, branch: selection, expectedBranch: selection }).catch((e) => console.error("[preview] add-service restart failed:", e));
  const services = (manifest.services || []).map((s) => ({ name: s.name, port: s.port, primary: !!s.primary, enabled: !!s.enabled, manual: !!s.manual }));
  return { ok: true, services };
  } finally { release(); }
}

/** Remove a MANUALLY-added companion (auto-detected ones can only be toggled off). Stops
 *  its process and drops it from the profile; if only the primary remains the preview
 *  collapses back to single-app. */
export async function removeService(projectId: string, userId: string, name: string): Promise<{ ok: boolean; error?: string; services?: unknown[] }> {
  const release = await acquirePreviewAccess(projectId);
  try {
  const selection = (await getEnv(projectId))?.previewBranch || '(default)';
  const profileBranch = environmentBranch(selection);
  const loaded = await loadAppProfile(projectId, profileBranch);
  if (!loaded?.profile.services?.length) return { ok: false, error: "This preview has no services." };
  const profile = loaded.profile;
  const svc = profile.services!.find((s) => s.name === name);
  if (!svc) return { ok: false, error: `Unknown service "${name}".` };
  if (svc.primary) return { ok: false, error: "The primary app can't be removed." };
  if (!svc.manual) return { ok: false, error: "Only manually-added apps can be removed — auto-detected ones can be toggled off." };
  const workspaceId = await envWorkspaceId(projectId).catch(() => null);
  if (workspaceId) await sh(workspaceId, `fuser -k ${svc.port}/tcp 2>/dev/null; pkill -f ':${svc.port}' 2>/dev/null; echo OK`, 15_000).catch(() => {});
  profile.services = profile.services!.filter((s) => s.name !== name);
  await saveAppProfile(projectId, profile, profileBranch);
  const manifest = deriveManifestFromProfile(profile);
  await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
  const services = (manifest.services || []).map((s) => ({ name: s.name, port: s.port, primary: !!s.primary, enabled: !!s.enabled, manual: !!s.manual }));
  return { ok: true, services };
  } finally { release(); }
}

/**
 * HARD sandbox rebuild — for a STUCK/ORPHANED VM: the app still serves (its microVM + edge
 * route linger) but the control plane lost the job, so exec/@preview/logs all fail with
 * "No running or sleeping VM found". ensureProjectSandbox's soft liveness probe can pass on
 * such a VM, so we force-kill it (stopWorkspace, which keeps the workspace) and respawn a
 * clean, MANAGEABLE VM, then re-run the app (+ enabled companions) on it.
 */
export async function rebuildPreviewSandbox(projectId: string, userId: string): Promise<{ ok: true } | { error: string }> {
  await loadPublicId(projectId);
  resetLog(projectId);
  plog(projectId, userId, "Rebuilding the preview sandbox — killing the stuck VM and respawning a fresh one…");
  try {
    // stopWorkspace + respawn. The new VM may boot a blank /data; the restartPreview
    // below probes for the checkout and falls back to a full setup when it's gone.
    await restartProjectSandbox(projectId);
  } catch (e) {
    plog(projectId, userId, `Sandbox rebuild failed: ${(e as Error).message?.slice(0, 200)}`, { level: "error" });
    return { error: (e as Error).message?.slice(0, 200) || "rebuild failed" };
  }
  plog(projectId, userId, "Fresh VM is up — restarting the app…");
  restartPreview(projectId, { userId }).catch((e) => console.error("[preview] rebuild restart failed:", e));
  return { ok: true };
}

/** Restart the active checkout in place. Branch refresh and cold setup use restartPreview. */
export async function restartPreviewApp(projectId: string, opts: Pick<SetupOptions, "userId"> & { rebuildApp?: boolean }): Promise<{ previewUrl: string } | { error: string }> {
  const { userId } = opts;
  const releaseRun = await acquirePreviewRun(projectId);
  const steps: RunStep[] = [];
  let workspaceId: string | undefined;
  const startedPorts: number[] = [];
  let workerDir:string|undefined;
  let workersStopped=false;
  try {
    await loadPublicId(projectId);
    resetLog(projectId);
    await setPreview(projectId, userId, { previewStatus: "starting", previewError: null }, "Restarting the current app…");
    await persistSteps(projectId, userId, steps);
    // Read after acquiring the lock: a preceding branch switch may have changed this.
    const row = await getEnv(projectId);
    if (!row?.setupManifest || !row.runCommand) throw new Error("No prepared app to restart. Run the selected branch first.");
    const manifest = manifestSchema.parse(JSON.parse(row.setupManifest));
    const sandbox = await ensureProjectSandbox(projectId);
    workspaceId = sandbox.workspaceId;
    throwIfCancelled(projectId);
    if (sandbox.created || sandbox.recreated) throw new Error("The sandbox had to be recreated. Use Update & rebuild to restore its runtime and start this branch.");
    const trees = await sh(workspaceId, `git -C ${PROJECT_DIR} worktree list --porcelain`, 15_000);
    if (trees.exitCode !== 0) throw new Error("The prepared checkout is unavailable. Use Update & rebuild to prepare this branch.");
    const dir = restartWorktree(trees.output, row.previewBranch);
    workerDir=dir;
    await resolvePreviewWorkers(projectId,workspaceId,manifest,dir);

    const branch = environmentBranch(row.previewBranch);
    const profile = (await loadAppProfile(projectId, branch))?.profile;
    const savedValues = await readProjectEnvironment(projectId);
    const snapshot = environmentFingerprint(savedValues);
    const previous = profile?.appliedProjectEnvironment;
    const changedKeys = [...new Set([...environmentChanges(snapshot, previous), ...(profile?.pendingProjectEnvironment?.keys || [])])];
    const databaseKeys = new Set(manifest.databases.map(d => d.connectionEnvVar));
    // Without a prior baseline, preserve provisioned connections and recorded
    // runtime repairs. With a baseline, only actual user edits override repairs.
    const legacyProtected = new Set([...databaseKeys, ...(profile?.environmentOverrides || []).map(e => e.key)]);
    if (previous && changedKeys.some(key => databaseKeys.has(key))) {
      throw new Error("Database connection settings changed. Use Update & rebuild to apply them and check the database connection.");
    }
    const patches = Object.fromEntries(changedKeys.filter(key => previous || !legacyProtected.has(key)).map(key => [key, savedValues[key] ?? null]));
    const buildNeeded = opts.rebuildApp === true || !!profile?.pendingProjectEnvironment?.requiresBuild || requiresEnvironmentBuild(changedKeys, profile?.buildEnvironmentKeys);
    const builds = [
      ...(manifest.buildCmd ? [{ name: "app", command: manifest.buildCmd, dir: "" }] : []),
      ...(manifest.services || []).filter(s => !s.primary && s.enabled && s.buildCmd).map(s => ({ name: s.name, command: s.buildCmd!, dir: s.dir || "" })),
    ];
    if (buildNeeded && !builds.length && !/\b(dev|vite|watch)\b/.test(row.runCommand)) {
      throw new Error("These environment changes require a build, but no build command is saved. Use Update & rebuild to prepare the app.");
    }
    if (!profile) throw new Error("The saved runtime profile is missing. Use Update & rebuild to prepare this branch.");
    if (previous) {
      profile.environmentOverrides = (profile.environmentOverrides || []).filter(v => !changedKeys.includes(v.key));
    }
    if (changedKeys.length || buildNeeded) {
      profile.pendingProjectEnvironment = { keys: changedKeys, requiresBuild: buildNeeded };
      await saveAppProfile(projectId, profile, branch);
    }
    const workerStop=await sh(workspaceId,previewWorkerCommand('stop',dir,manifest.backgroundProcesses),30000);
    if(workerStop.exitCode!==0)throw new Error('Could not stop previous preview workers');
    workersStopped=true;
    if (Object.keys(patches).length) {
      plog(projectId, userId, `Applying ${Object.keys(patches).length} saved environment change(s) to this preview.`);
      const applied = await sh(workspaceId, environmentPatchCommand(dir, patches), 30_000);
      throwIfCancelled(projectId);
      if (applied.exitCode !== 0) throw new Error("Could not apply saved environment settings. Changes are still pending.");
    }
    if (buildNeeded && builds.length) {
      // Stop only these app processes before modifying their build output.
      const ports = [row.appPort || manifest.port, ...(manifest.services || []).filter(s => !s.primary && s.enabled).map(s => s.port)];
      await sh(workspaceId, ports.map(port => `fuser -k ${port}/tcp 2>/dev/null || true`).join("\n"), 15_000);
      for (const build of builds) {
        throwIfCancelled(projectId);
        const step: RunStep = { id: `env-build-${build.name}`, phase: "build", label: `Build ${build.name} with updated settings`, command: build.command, status: "running" };
        steps.push(step); await persistSteps(projectId, userId, steps);
        plog(projectId, userId, step.label);
        const result = await runDetachedPolled(projectId, userId, workspaceId,
          (build.dir ? `cd ${shellQuote(build.dir)} && ` : "") + localizeCmd(build.command, dir), 600_000,
          { workDir: dir, stallMs: 180_000, onProgress: detail => plog(projectId, userId, detail) });
        throwIfCancelled(projectId);
        if (result.exitCode !== 0) throw new Error("Build with updated environment settings failed. Changes are still pending; check the app build before retrying.");
        step.status = "done"; await persistSteps(projectId, userId, steps);
      }
    }
    plog(projectId, userId, `Restarting ${row.previewBranch || "default branch"} in place — keeping its checkout and installed dependencies.`);
    const services = [
      { name: "app", port: row.appPort || manifest.port, command: row.runCommand, log: "preview.log", subdir: "", primary: true },
      ...(manifest.services || []).filter(s => !s.primary && s.enabled).map(s => ({
        name: s.name, port: s.port, command: s.runCmd, log: `preview-${s.name}.log`, subdir: s.dir || "", primary: false,
      })),
    ];
    const alias = row.stableAlias || randomAlias();
    let previewUrl = row.appUrl || "";
    for (const service of services) {
      throwIfCancelled(projectId);
      const step: RunStep = { id: `restart-${service.name}`, phase: "run", label: `Restart ${service.name}`, command: service.command, status: "running", startedAt: new Date().toISOString() };
      steps.push(step);
      await persistSteps(projectId, userId, steps);
      const subdir = service.subdir ? `cd ${shellQuote(service.subdir)} && ` : "";
      const command = subdir + localizeCmd(service.command, dir);
      const environment = envPrefix(dir) + (service.primary ? "" : `unset $(env | grep '^Serilog__' | cut -d= -f1) 2>/dev/null; `);
      // A previous launcher can finish after its port closes. Its exit marker must
      // not make this new process appear to have exited.
      const exitFile = `${dir}/${service.log}.${crypto.randomUUID()}.exit`;
      startedPorts.push(service.port);
      const launch = await sh(workspaceId, restartServerCommand(dir, service.port, command, environment, service.log, exitFile), 15_000);
      throwIfCancelled(projectId);
      if (launch.exitCode !== 0) throw new Error(failureSummary(launch.output));
      const activeWorkspace = workspaceId;
      let lastProgress = -10;
      await waitForRestart({
        probe: async () => {
          const result = await sh(activeWorkspace, `if test -f ${shellQuote(exitFile)}; then echo EXITED; fi; printf 'HTTP='; curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${service.port}/ 2>/dev/null; echo`, 8_000);
          return { code: Number(result.output.match(/HTTP=(\d{3})/)?.[1] || 0), exited: result.output.includes("EXITED") };
        },
        cancelled: () => isCancelled(projectId), now: Date.now, sleep,
        progress: seconds => { if (seconds - lastProgress >= 10) { lastProgress = seconds; plog(projectId, userId, `Waiting for ${service.name} to start (${seconds}s)…`); } },
      });
      throwIfCancelled(projectId);
      await enableHttpAccess(workspaceId, service.port);
      const url = await setStableUrl(service.primary ? alias : `${alias}-${service.name}`, workspaceId, service.port);
      if (service.primary) previewUrl = url;
      step.status = "done";
      step.finishedAt = new Date().toISOString();
      await persistSteps(projectId, userId, steps);
    }
    throwIfCancelled(projectId);
    const workerStep:RunStep={id:'restart-workers',phase:'run',label:'Restart required background workers',command:'',status:'running'};
    steps.push(workerStep);await persistSteps(projectId,userId,steps);
    const workers=await sh(workspaceId,previewWorkerCommand('start',dir,manifest.backgroundProcesses,manifest.databases.map(d=>d.connectionEnvVar),{webPort:row.appPort||manifest.port}),45000);
    if(workers.exitCode!==0)throw new Error(failureSummary(workers.output));
    workerStep.status='done';await persistSteps(projectId,userId,steps);
    if (services.length > 1) await enableHttpAccess(workspaceId, services[0]!.port);
    await db.update(projectEnvironments).set({ stableAlias: alias, updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
    throwIfCancelled(projectId);
    await recordAppliedEnvironment(projectId, branch, snapshot);
    throwIfCancelled(projectId);
    await setPreview(projectId, userId, { previewStatus: "running", appUrl: previewUrl, previewError: null }, "App restarted");
    plog(projectId, userId, `App restarted with saved settings${buildNeeded ? " and refreshed build output" : ""}. No checkout sync, installation, migrations or AI repair were run.`);
    return { previewUrl };
  } catch (error) {
    const message = (error as Error).message || String(error);
    if(workspaceId && workerDir && workersStopped)await sh(workspaceId,previewWorkerCommand('stop',workerDir),30000).catch(()=>{});
    if (message === "__CANCELLED__" || isCancelled(projectId)) {
      if (workspaceId && startedPorts.length) await sh(workspaceId, startedPorts.map(port => `fuser -k ${port}/tcp 2>/dev/null || true`).join("\n"), 15_000).catch(() => {});
      await setPreview(projectId, userId, { previewStatus: "stopped", appUrl: null, previewError: null }, "Preview stopped");
      return { error: "cancelled" };
    }
    for (const step of steps) if (step.status === "running") { step.status = "failed"; step.error = message; step.finishedAt = new Date().toISOString(); }
    await persistSteps(projectId, userId, steps);
    return failed(projectId, userId, message);
  } finally {
    cancelledProjects.delete(projectId);
    releaseRun();
  }
}

/** Prepare/refresh a branch, including dependencies, build and schema. */
export async function restartPreview(projectId: string, opts: SetupOptions): Promise<{ previewUrl: string } | { error: string }> {
  const { userId, ticketId } = opts;
  // An explicit branch to run (an epic's integration branch). Ignored when a ticketId is
  // given — that resolves its own branch. "(default)" is the default-branch sentinel the
  // selector uses, not a real branch, so it never counts as explicit.
  const explicitBranch = !ticketId && opts.branch && opts.branch !== "(default)" ? opts.branch.trim() : "";
  const row = await getEnv(projectId);
  if (!row?.setupManifest || !row?.runCommand || row?.setupComplete !== 1) {
    // Nothing to restart yet → run the full setup, directly on the branch asked for
    // (an epic's branch, or a ticket's pushed branch) so a fresh project still previews.
    if (ticketId) {
      const [tk] = await db.select({ gb: projectTickets.githubBranch }).from(projectTickets).where(eq(projectTickets.id, ticketId));
      if (!tk?.gb) return failed(projectId, userId, "This ticket has no pushed branch yet. Build it first, then preview.");
      return setupPreview(projectId, { ...opts, ticketId: undefined, branch: tk.gb });
    }
    return setupPreview(projectId, explicitBranch ? { ...opts, branch: explicitBranch } : opts);
  }
  let manifest = JSON.parse(row.setupManifest) as PreviewManifest; // may gain DBs via reconcile below
  const savedProfile = await loadAppProfile(projectId);
  let configNotes = savedProfile ? profileNotes(savedProfile.profile) : [];
  await loadPublicId(projectId); // for WS routing

  // Prelude rows join the shared build/schema/start/verification executor for this run.
  const branchLabel0 = explicitBranch || (ticketId ? `feature/ticket-${ticketId}` : "(default)");
  const steps: RunStep[] = [
    { id: "locate", phase: "prepare", label: ticketId || explicitBranch ? `Locate the selected checkout (${branchLabel0})` : "Use the default checkout", command: "", status: "pending" },
    { id: "plan", phase: "prepare", label: "Validate the selected branch run profile", command: "", status: "pending" },
    { id: "db", phase: "prepare", label: "Start required database services", command: "", status: "pending" },
    { id: "env", phase: "prepare", label: "Apply environment and verify saved patches", command: "", status: "pending" },
  ];
  const setStep = async (id: string, s: RunStep["status"]) => {
    const st = steps.find((x) => x.id === id); if (st) { st.status = s;
      if (s === "running") { st.startedAt = new Date().toISOString(); await setPreview(projectId, userId, { previewStatus: "provisioning" }, st.label); }
      else st.finishedAt = new Date().toISOString();
    }
    await persistSteps(projectId, userId, steps);
  };

  // Serialize: cancel + wait out any run already using this project's VM before we
  // touch its git worktrees / start a build (acquired AFTER the setupPreview
  // delegation above so we don't deadlock waiting on our own lock).
  const releaseRun = await acquirePreviewRun(projectId);
  // Set when we hand off to setupPreview, which takes the run lock ITSELF — we must
  // release ours before delegating or it would wait forever on us (see the guard below).
  let lockReleased = false;

  try {
    if (opts.expectedBranch && ((await getEnv(projectId))?.previewBranch || '(default)') !== opts.expectedBranch) {
      return {error:'Preview selection changed while waiting. No branch was switched.'};
    }

    resetLog(projectId);
    // Publish before VM checks: otherwise the first poll sees the old stopped
    // state and abandons progress while this request is still starting.
    await setPreview(projectId, userId, { previewStatus: "provisioning", previewError: null }, "Preparing the selected preview…");
    await persistSteps(projectId, userId, steps);
    const { recreated } = await ensureProjectSandbox(projectId);
    const workspaceId = await envWorkspaceId(projectId);

    // The VM had stopped and was respawned. Bring Docker back so the DB containers
    // (restart=unless-stopped) come up with whatever data survived on /data — then the
    // guard below decides whether "whatever survived" includes the checkout at all.
    if (recreated) {
      plog(projectId, userId, "Sandbox VM was respawned — restarting Docker + databases…");
      await ensureDocker(projectId).catch(() => {});
    }

    // Disk-generation guard: no checkout means this VM's /data was reset, so there is
    // nothing to restart — the recorded build/run commands would run against an empty
    // directory and dead-end in the AI driver, hunting for source that isn't on the box.
    // Invalidate the stale checkpoint and run the FULL setup, which rebuilds everything
    // from what's persisted in Postgres.
    if (await checkoutMissing(workspaceId)) {
      await clearSetupCheckpoint(projectId);
      if (ticketId || explicitBranch) {
        // Any specific branch needs the base checkout to cut a worktree from (or to switch),
        // so there's nothing useful to do here — and silently running a full DEFAULT-branch
        // setup is not what was asked for. Say what happened and what fixes it.
        await setStep("locate", "failed");
        return failed(projectId, userId, "This sandbox's disk was reset (the VM was respawned), so the base checkout is gone. Run the default branch once to rebuild it, then preview this branch.");
      }
      plog(projectId, userId, "No checkout on this sandbox — its /data was reset. Running the full setup to rebuild it…");
      releaseRun();
      lockReleased = true;
      return await setupPreview(projectId, opts);
    }

    // Pick the run directory: a ticket's worktree, or the default checkout.
    let runDir = PROJECT_DIR;
    let branchLabel = "(default)";
    await setStep("locate", "running");
    const [projRow] = await db.select({ mode: projects.previewBranchMode }).from(projects).where(eq(projects.id, projectId));
    const checkoutMode = (projRow?.mode || "worktree") === "checkout";
    // A run targets EITHER a ticket (its feature branch) or an explicit branch — an
    // epic's integration branch, so a whole delivery unit can be previewed as one thing
    // instead of one ticket at a time. Everything below is driven by `remoteBranch`, so
    // the two cases differ only in where the branch name and the worktree dir come from.
    if (ticketId || explicitBranch) {
      let remoteBranch = explicitBranch;
      if (ticketId) {
        // The remote branch: the ticket's recorded branch, else the convention.
        const [tk] = await db.select({
          gb: projectTickets.githubBranch,
          sha: projectTickets.githubCommitSha,
          merge: projectTickets.githubMergeStatus,
          key: projectTickets.ticketKey,
          status: projectTickets.status,
        }).from(projectTickets).where(and(eq(projectTickets.id, ticketId),eq(projectTickets.projectId,projectId)));
        if(!tk)throw new Error("Ticket does not belong to this project.");
        remoteBranch = tk?.gb || `feature/ticket-${ticketId}`;

        // REFUSE a branch that was never pushed, rather than discovering it as a
        // fatal git error four steps later. A build whose commit/push failed leaves
        // its work in the build sandbox only — there is nothing on the remote to check
        // out, so "couldn't find remote ref" was the truth told in the least useful way
        // possible, to whoever happened to open the Preview tab (a client, in one case).
        if (tk && !tk.sha && (tk.merge === "not_pushed" || tk.status === "failed")) {
          await setStep("locate", "failed");
          const name = tk.key ? `${tk.key}` : "This ticket";
          return failed(projectId, userId,
            `${name} has nothing to preview — its build finished but the changes were never pushed` +
            `${tk.status === "failed" ? " (the build failed)" : ""}, so \`${remoteBranch}\` doesn't exist on the remote.\n\n` +
            `The work is still in the build sandbox. Open the ticket's Actions log to see the failing step, fix the cause and rebuild — ` +
            `then this preview will have something to run.`);
        }
      }
      assertPreviewBranch(remoteBranch);
      branchLabel = remoteBranch;
      const auth = await resolveAuthedRepoUrl(projectId, userId);
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
set -e
cd ${PROJECT_DIR} 2>/dev/null || { echo NO_MAIN; exit 0; }
git remote set-url origin "${auth.authUrl}" 2>/dev/null
fuser -k ${manifest.port}/tcp 2>/dev/null || true; pkill -f ':${manifest.port}' 2>/dev/null || true; sleep 1
${autostash(PROJECT_DIR, "checkout")}
git fetch --no-tags --force origin "+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}" 2>&1
git checkout -B "${remoteBranch}" "origin/${remoteBranch}" 2>&1
# Nuke stale build output so Release recompiles the Razor views (see worktree path).
echo "HEAD=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
`, 240_000);
        if (sw.exitCode !== 0) throw new Error("Selected checkout could not be prepared: " + failureSummary(sw.output));
        if (sw.output.includes("NO_MAIN")) { await setStep("locate", "failed"); return failed(projectId, userId, `The base checkout isn't set up on this sandbox yet — run the default-branch preview once, then preview this ticket.`); }
        if (!sw.output.includes(`HEAD=${remoteBranch}`)) { await setStep("locate", "failed"); return failed(projectId, userId, `Couldn't switch the checkout to \`${remoteBranch}\` — is the branch pushed?\n\n${sw.output.slice(-500)}`); }
        plog(projectId, userId, `Main checkout is now on ${remoteBranch} ✓ (local changes stashed)`);
      } else {
        // WORKTREE mode (default): a separate dir; the main checkout is untouched.
        runDir = previewCheckoutDir(remoteBranch);
        await setPreview(projectId,userId,{previewStatus:'starting',previewBranch:remoteBranch},`Refreshing ${remoteBranch}…`);
        const prep=await sh(workspaceId,refreshPreviewCheckout(PROJECT_DIR,runDir,remoteBranch,auth.authUrl),240_000);
        if(prep.exitCode!==0 || !prep.output.includes('WT_OK'))throw new Error('Selected branch could not be refreshed: '+failureSummary(prep.output));
        // Existing branch-local connection settings survive refreshes.
        await sh(workspaceId,`test -f ${shellQuote(runDir+'/.env')} || cp ${shellQuote(PROJECT_DIR+'/.env')} ${shellQuote(runDir+'/.env')}`,20_000);
      }
    } else {
      // Default branch — ALWAYS fetch + hard-sync the main checkout to the LATEST pushed
      // default branch before building, so switching back to default (or a restart) picks
      // up new commits instead of rebuilding a stale checkout (the ticket/worktree path
      // already hard-syncs; default lagged behind). Local uncommitted changes are stashed
      // first (recoverable), then we reset to origin; saved config patches + env are
      // re-applied below, exactly like the worktree path.
      const authRes = await resolveAuthedRepoUrl(projectId, userId).catch(() => null);
      const authUrl = authRes && "authUrl" in authRes ? authRes.authUrl : null;
      await setPreview(projectId, userId, { previewStatus: "starting", previewBranch: "(default)" }, "Pulling the latest default branch…");
      plog(projectId, userId, "Syncing the default branch to the latest pushed commit…");
      const sync = await sh(workspaceId, `
set -e
cd ${PROJECT_DIR} 2>/dev/null || { echo NO_MAIN; exit 0; }
${authUrl ? `git remote set-url origin "${authUrl}" 2>/dev/null` : ""}
fuser -k ${manifest.port}/tcp 2>/dev/null || true; pkill -f ':${manifest.port}' 2>/dev/null || true; sleep 1
${autostash(PROJECT_DIR, "default")}
git fetch --no-tags --force origin 2>&1
git remote set-head origin -a >/dev/null 2>&1
DEF=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's@^origin/@@'); [ -z "$DEF" ] && DEF=main
git checkout -B "$DEF" "origin/$DEF" 2>&1
git reset --hard "origin/$DEF" 2>&1
git clean -fd 2>&1
echo "HEAD=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) $(git log -1 --oneline 2>/dev/null)"
`, 240_000);
      if (sync.exitCode !== 0) throw new Error("Default checkout could not be refreshed: " + failureSummary(sync.output));
      if (sync.output.includes("NO_MAIN")) {
        // Belt-and-braces: the disk-generation guard above already routes a wiped /data
        // to the full setup, so reaching here means the checkout went away mid-run (or
        // PROJECT_DIR exists without a .git). Either way there is NOTHING to build —
        // delegate instead of carrying on into build/run against an empty directory,
        // which is what previously burned a whole agent run and reported "the app did
        // not come back up". This path is default-branch only (ticketId is falsy here),
        // so handing off to setupPreview is always the right move.
        await clearSetupCheckpoint(projectId);
        plog(projectId, userId, "No base checkout on this sandbox — running the full setup to clone it…");
        releaseRun();
        lockReleased = true;
        return await setupPreview(projectId, opts);
      } else {
        const head = sync.output.match(/HEAD=(.+)/)?.[1]?.trim();
        plog(projectId, userId, `Default branch synced to latest ✓${head ? ` (${head})` : ""}`);
      }
    }
    if(opts.cleanBuild) {
      const clean=await sh(workspaceId,cleanPreviewBuildCommand(runDir),60_000);
      if(clean.exitCode!==0)throw new Error('Explicit clean build could not clear generated outputs.');
    }
    await setStep("locate", "done");

    await setStep("plan", "running");
    const profileBranch = branchLabel === "(default)" ? "default" : branchLabel;
    activeProfileBranches.set(projectId, profileBranch);
    const fingerprint = await sh(workspaceId, runtimeFingerprintCommand(runDir), 15_000);
    const inputs = fingerprint.output.trim();
    let scoped = await loadAppProfile(projectId, profileBranch);
    if (fingerprint.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(inputs)) throw new Error("Could not identify the selected checkout's source revision.");
    // Saved corrections can be newer than the committed recipe. Replacing them on
    // every refresh repeats the same bootstrap failure and repair. Changed source
    // still invalidates the profile below.
    if (scoped?.profile.inputFingerprint === inputs) {
      plog(projectId, userId, "Reusing the saved runtime recipe and corrections for this unchanged branch.");
    } else {
      const committedRecipe = await sh(workspaceId, `git -C ${shellQuote(runDir)} show HEAD:.lfg-validation.json`, 15_000);
      if (committedRecipe.exitCode === 0 && committedRecipe.output.trim()) {
        const recipe = appProfileSchema.parse(JSON.parse(committedRecipe.output));
        recipe.previewAccounts = scoped?.profile.previewAccounts;
        if(scoped?.profile.services) {
          const preferences=new Map(scoped.profile.services.map(service=>[service.name,service]));
          recipe.services=(recipe.services||[]).map(service=>({...service,enabled:preferences.get(service.name)?.enabled ?? service.enabled}));
          for(const service of scoped.profile.services)if(service.manual && !recipe.services.some(s=>s.name===service.name))recipe.services.push(service);
        }
        recipe.inputFingerprint = inputs;
        await saveAppProfile(projectId, recipe, profileBranch);
        scoped = await loadAppProfile(projectId, profileBranch);
        plog(projectId, userId, "Using the runtime recipe committed with this branch.");
      }
    }

    if (!scoped || scoped.profile.inputFingerprint !== inputs) {
      plog(projectId, userId, "Branch inputs changed — checking its run profile before replay.");
      const ac = new AbortController();
      const timer = setInterval(() => { if (isCancelled(projectId)) ac.abort(); }, 1000);
      let probed: AppProfile | null;
      try { probed = await probeAppProfile({ workspaceId, userId, workDir: runDir, knowledge: [...(scoped?.profile.directives ?? savedProfile?.profile.directives ?? []), ...configNotes], abortSignal: ac.signal,
        onLog: (l, d) => plog(projectId, userId, l, d ? { detail: d } : undefined) }); }
      finally { clearInterval(timer); }
      throwIfCancelled(projectId);
      if (!probed) throw new Error("Could not validate the selected branch's run profile. No unverified plan was replayed; retry probing.");
      // Branch-specific corrections stay on their branch. Inherit general instructions
      // for a new branch, but never silently transplant literal patches from another branch.
      const baseline = scoped?.profile ?? (savedProfile ? { ...savedProfile.profile, previewAccounts: [], databaseIdentities: [], configPatches: [], replayActions: [], environmentOverrides: [] } : undefined);
      const next = mergeKnowledge(probed, baseline);
      next.inputFingerprint = inputs;
      delete next.blockedFailure; delete next.verifiedRevision;
      await saveAppProfile(projectId, next, profileBranch);
      scoped = await loadAppProfile(projectId, profileBranch);
    }
    if (scoped) {
      manifest = deriveManifestFromProfile(scoped.profile);
      configNotes = profileNotes(scoped.profile);
      await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
    }
    await setStep("plan", "done");
    await setStep("db", "running");
    // Reconcile DBs on RESTART too (not just Re-setup): union already-provisioned engines
    // + engines the code signals, so a plain Restart also provisions a database the app
    // needs. reapplyEnv() below then brings each up via ensureEngine AND writes the
    // connection var into .env — so a NEWLY-provisioned DB is both started and reachable.
    manifest = await reconcileDatabases(projectId, userId, manifest, runDir);

    const engines: EngineHandle[] = [];
    const provisionedEngines = await db.select({ engine: projectDatabases.engine }).from(projectDatabases).where(eq(projectDatabases.projectId, projectId));
    for (const { engine } of provisionedEngines) {
      throwIfCancelled(projectId);
      plog(projectId, userId, `Starting ${engine}…`);
      engines.push(await ensurePreviewEngine(projectId, userId, engine as DbEngine));
    }
    await setStep("db", "done");
    await setStep("env", "running");
    await reapplyEnv(projectId, userId, workspaceId, manifest);
    if (runDir !== PROJECT_DIR) {
      const copied = await sh(workspaceId, `cp ${PROJECT_DIR}/.env ${shellQuote(runDir + "/.env")}`, 15_000);
      if (copied.exitCode !== 0) throw new Error("Could not copy environment into selected checkout");
    }
    for (const spec of manifest.databases) {
      if (!engines.some(e => e.engine === spec.engine)) {
        const managed = await db.select().from(projectDatabases).where(and(eq(projectDatabases.projectId, projectId), eq(projectDatabases.engine, spec.engine)));
        if (managed.length) engines.push(await ensurePreviewEngine(projectId, userId, spec.engine));
      }
    }
    await setStep("env", "done");
    const driver = await resolveDriverModel(userId, projectId);
    const result = await executeRunbook(projectId, userId, workspaceId, manifest, engines, driver?.model, null, steps, configNotes, runDir);
    if (!result.up) return failed(projectId, userId, result.error || "Preview plan failed — see the failing step.");
    const effectivePort = manifest.port;
    await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), runCommand: manifest.runCmd, updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
    plog(projectId, userId, `App and saved plan verified ✓ (${branchLabel})`);
    // Re-expose (idempotent) and mark running — on the port the app actually bound.
    await enableHttpAccess(workspaceId, effectivePort).catch(() => {});
    const alias = row.stableAlias || randomAlias();
    // PERSIST a freshly-minted alias (setupPreview does; restart previously didn't) so
    // the preview URL stays STABLE across restarts — otherwise each restart could mint a
    // new subdomain, leaving old URLs pointing at a stale binding.
    if (!row.stableAlias) await db.update(projectEnvironments).set({ stableAlias: alias, updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId)).catch(() => {});
    let previewUrl = row.appUrl || "";
    // PIN the primary alias to its OWN port (see the same call in setupPreview): an
    // unpinned alias tracks the job's primary port, which a companion's exposeService
    // moves — leaving the primary subdomain serving the companion's app.
    try { previewUrl = await setStableUrl(alias, workspaceId, effectivePort); } catch { /* keep existing */ }
    await setPreview(projectId, userId, { previewStatus: "running", appUrl: previewUrl, appPort: effectivePort, previewError: null, previewBranch: branchLabel }, "Preview is live");
    // Multi-app: bring up any ENABLED companion services on their own subdomains (in the
    // SAME run dir — a ticket worktree or the main checkout).
    const companionStep: RunStep = { id: "companions", phase: "run", label: "Start enabled companion apps", command: "", status: "running" };
    const auditStep: RunStep = { id: "audit", phase: "verify", label: "Verify homepage, assets and database health", command: "", status: "pending" };
    result.steps.push(companionStep, auditStep);
    await persistSteps(projectId, userId, result.steps);
    const companionSummary = await runEnabledCompanions(projectId, userId, workspaceId, manifest, runDir, alias, previewUrl);
    companionStep.status = /❌|failed|did not/i.test(companionSummary) ? "failed" : "done";
    auditStep.status = "running";
    await persistSteps(projectId, userId, result.steps);
    // Companions leave the job's primary port pointing at the last one started — restore
    // it to the primary app (see the same call in setupPreview).
    if ((manifest.services || []).some((s) => !s.primary && s.enabled)) {
      await enableHttpAccess(workspaceId, effectivePort).catch(() => {});
    }
    // Keep automatic launch diagnostics in the Preview panel, not the conversation.
    const vManifest = effectivePort === manifest.port ? manifest : { ...manifest, port: effectivePort };
    const v = await verifyPreview(projectId, userId, workspaceId, vManifest, branchLabel).catch(() => null);
    auditStep.status = v?.overall === "ok" ? "done" : "failed";
    if (auditStep.status === "failed") auditStep.error = v?.summary || "Verification could not complete";
    await persistSteps(projectId, userId, result.steps);
    if (v) plog(projectId, userId, "Preview launch summary", { level: v.overall === "ok" ? "info" : "error", detail: `${v.summary}\n\n🔗 ${previewUrl}${companionSummary}` });
    if (auditStep.status === "failed") return failed(projectId, userId, auditStep.error || "Preview verification failed");
    throwIfCancelled(projectId);
    await recordAppliedEnvironment(projectId, environmentBranch((await getEnv(projectId))?.previewBranch), preparedEnvironment.get(manifest));
    return { previewUrl };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg === "__CANCELLED__" || isCancelled(projectId)) {
      await setPreview(projectId, userId, { previewStatus: "stopped", appUrl: null, previewError: null }, "Preview stopped").catch(() => {});
      return { error: "cancelled" };
    }
    for (const st of steps) if (st.status === "running") { st.status = "failed"; st.error = failureSummary(msg); st.finishedAt = new Date().toISOString(); }
    await persistSteps(projectId, userId, steps);
    return failed(projectId, userId, msg);
  } finally {
    // When we handed off to setupPreview we already released the lock, and IT owns the
    // run's lifecycle from that point — clearing the cancel flag here would fire late
    // (after its whole pipeline) and could clear a flag belonging to a newer run.
    if (!lockReleased) {
      cancelledProjects.delete(projectId);
      activeProfileBranches.delete(projectId);
      driverFailures.delete(projectId);
      releaseRun(); // let a queued run (branch switch) proceed on the now-free VM
    }
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
  const workerManifest=row?.setupManifest?JSON.parse(row.setupManifest) as PreviewManifest:null;
  const workerDir=(await resolvePreviewWorkDir(projectId,workspaceId)).dir;
  await sh(workspaceId,previewWorkerCommand('stop',workerDir,workerManifest?.backgroundProcesses),30000);
  // Kill the app port + any lingering build/install processes started for this run.
  // Include git (clone/fetch + the git-remote-https helper): a cancelled run's clone
  // keeps churning otherwise and, overlapped with the next run's clone, OOMs the VM
  // ('git-remote-https died of signal 11'). npm/dotnet/node builds too.
  await sh(workspaceId, `fuser -k ${port}/tcp 2>/dev/null; pkill -f ':${port}' 2>/dev/null; pkill -f 'dotnet' 2>/dev/null; pkill -f 'npm ' 2>/dev/null; pkill -f 'git-remote-http' 2>/dev/null; pkill -f 'git clone' 2>/dev/null; pkill -f 'git fetch' 2>/dev/null; echo stopped`, 30_000).catch(() => {});
  await setPreview(projectId, userId, { previewStatus: "stopped", appUrl: null }, "Preview stopped");
}
