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
import { decryptSecret } from "../utils/crypto.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { enableHttpAccess, execOnWorkspace, setStableUrl } from "./mags.ts";
import { ensureProjectSandbox, ensureEngine, ensureDocker, type EngineHandle } from "./project-sandbox.ts";

const PROJECT_DIR = "/data/project";
const DEFAULT_PORT = 8080; // fallback ONLY — the real port is decided by the detected manifest per stack

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
    projectId,
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

/** Append a human-readable line to the project's setup log (UI + server + DB). */
function plog(projectId: string, userId: string, line: string, opts?: { level?: "info" | "error"; detail?: string }) {
  const ts = new Date().toISOString().slice(11, 19);
  const level = opts?.level ?? "info";
  let entry = `[${ts}] ${line}`;
  if (opts?.detail) entry += "\n" + opts.detail.split("\n").map((l) => "    " + l).join("\n");
  const buf = ((logBuffers.get(projectId) ?? "") + entry + "\n").slice(-80_000); // keep last ~80KB (full prompt + commands)
  logBuffers.set(projectId, buf);
  console.log(`[dev-preview] ${projectId.slice(0, 8)} ${level === "error" ? "ERROR " : ""}${line}${opts?.detail ? " :: " + opts.detail.replace(/\n/g, " ").slice(0, 300) : ""}`);
  broadcastToUser(userId, { type: "preview_log", projectId, line: entry, level });
}

function resetLog(projectId: string) { logBuffers.set(projectId, ""); }

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
  const workspaceId = `env-${projectId}`;
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
  for (let i = 0; i < tries; i++) {
    const { output } = await sh(workspaceId, `curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:${port}/ 2>/dev/null || echo 000`, 15_000);
    const code = parseInt((output.match(/\d{3}/) || ["000"])[0], 10);
    // Reachable and NOT a server error: 2xx/3xx = serving, 4xx = up (e.g. API-only
    // app with no route at /). 5xx = app crashed on the request → not "live". 000 = down.
    if (code >= 200 && code < 500) return true;
    await sleep(3000);
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

/** Prefix that puts the toolchain on PATH, caches on /data, and loads .env. */
function envPrefix(): string {
  return `export PATH="/data/.dotnet:/data/.dotnet/tools:/root/.dotnet/tools:/usr/local/bin:/usr/bin:/bin:/sbin:$PATH"; ` +
    `export DOTNET_ROOT=/data/.dotnet DOTNET_CLI_HOME=/data/.dotnet NUGET_PACKAGES=/data/.nuget ` +
    `DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 TMPDIR=/data/tmp; mkdir -p /data/tmp; ` +
    `cd ${PROJECT_DIR} 2>/dev/null; set -a; [ -f ./.env ] && . ./.env; set +a; `;
}

function buildDriverSystemPrompt(manifest: PreviewManifest, engines: EngineHandle[]): string {
  const port = manifest.port;
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

SANDBOX: Alpine Linux (musl, apk, OpenRC/rc-service, busybox) — NOT Debian. Use \`apk add --no-cache <pkg>\` (never apt/yum), \`rc-service <svc> start\` (never systemctl). Docker is installed and running. Every \`run\` command ALREADY has: the .NET toolchain on PATH (if installed to /data/.dotnet), caches pointed at /data (NUGET_PACKAGES, DOTNET_CLI_HOME, TMPDIR — keep everything on /data, the 20GB volume; the root fs is tiny), and the project's .env sourced. You are in ${PROJECT_DIR}.

The repo is already cloned. The databases below are already installed + running (do NOT install/start any DB); their connection strings are already in .env:
${dbLines}

SETUP PLAN (from analyzing the codebase — follow it, but verify against reality and adapt when a command fails):
${plan}

GOAL: the app must serve HTTP on 0.0.0.0:${port} and actually respond.

HOW TO WORK:
- Install the toolchain, then dependencies. On Alpine, if \`apk add dotnet8-sdk\` is unavailable/broken, install via \`curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir /data/.dotnet\` (it's already on PATH after that).
- For compiled stacks: restore → BUILD → run. For a multi-project solution, run the startup project named above.
- Apply migrations, then the SQL scripts in order (SQL Server runs in Docker — use \`docker exec\` with sqlcmd inside the mssql container, or a client you install; the connection string is in .env).
- Start the app in the BACKGROUND, DETACHED so it survives the command: \`setsid sh -c '<run command>' </dev/null > ${PROJECT_DIR}/preview.log 2>&1 &\` — it must bind 0.0.0.0:${port}.
- VERIFY for real: \`curl -sS -i http://127.0.0.1:${port}/\`. Up = a real 2xx/3xx/4xx response. 000/connection-refused/5xx = NOT up → read ${PROJECT_DIR}/preview.log, diagnose, fix, retry.

RULES:
- Do NOT modify the application's SOURCE CODE. You may install tools/deps, set env, choose commands, fix host/port. If it genuinely needs a code change to run, call \`finish\` with status "failed" and the exact reason.
- restore/build for a package-heavy solution can take 10-20 MINUTES on a cold cache — ALWAYS pass a large timeoutSec (e.g. 1500) on the \`dotnet restore\` / \`dotnet build\` / \`npm install\` calls and WAIT. Slow ≠ failed. The NuGet cache is on /data and persists, so a repeat restore is fast. If a restore times out, just re-run it with a bigger timeoutSec — it resumes from the cache.
- When a command fails, read the real error and fix the ENVIRONMENT, then continue. Keep going until the app responds or it truly cannot run.
- One command per \`run\` call. Never print secrets.`;
}

async function driveSandbox(
  projectId: string,
  userId: string,
  workspaceId: string,
  manifest: PreviewManifest,
  engines: EngineHandle[],
  model: any,
): Promise<boolean> {
  const port = manifest.port;
  let finished: { status: "ready" | "failed"; detail: string } | undefined;

  const tools = {
    run: tool({
      description: "Run one shell command in the Alpine sandbox (bash). The toolchain PATH, /data caches, and the project's .env are already set up. Returns exit code + combined stdout/stderr (last 6KB).",
      inputSchema: zodSchema(z.object({
        command: z.string().describe("The shell command to run (one command; use && or a heredoc for multi-step)."),
        timeoutSec: z.number().optional().describe("Timeout in seconds (default 300, max 900). Use ~600 for restore/build."),
      })),
      execute: async ({ command, timeoutSec }: { command: string; timeoutSec?: number }) => {
        // Default 600s; allow up to 1800s (30min) for a cold restore/build of a
        // package-heavy solution (ML.NET/Syncfusion/etc. can take 10-20min).
        const t = Math.min(Math.max(timeoutSec ?? 600, 10), 1800) * 1000;
        plog(projectId, userId, `$ ${command}`);
        setPreview(projectId, userId, { previewStatus: "starting" }, `$ ${command.slice(0, 110)}`).catch(() => {});
        const full = `${envPrefix()}\n${command}`;
        const b64 = Buffer.from(full).toString("base64");
        const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | bash`, { timeout: t })
          .catch((e: any) => ({ output: "", stderr: String(e?.message ?? e), exitCode: -1 }));
        const output = ((r.output || "") + (r.stderr ? "\n" + r.stderr : "")).trim();
        plog(projectId, userId, `  → exit ${r.exitCode ?? -1}`, output ? { detail: output.slice(-1800), level: (r.exitCode ?? -1) === 0 ? "info" : "error" } : undefined);
        return { exitCode: r.exitCode ?? -1, output: output.slice(-6000) || "(no output)" };
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

  try {
    await generateText({
      model,
      tools,
      stopWhen: stepCountIs(80), // generous step budget — we control the loop, not a blind timer
      system: buildDriverSystemPrompt(manifest, engines),
      prompt: `Bring the app up and verify it serves on 0.0.0.0:${port}. Begin.`,
    });
  } catch (e) {
    plog(projectId, userId, `Driver loop error: ${(e as Error).message}`, { level: "error" });
  }

  // Trust reality, not the model's word: confirm the port actually serves.
  if (await checkServer(workspaceId, port, 8)) return true;
  if (finished?.status === "failed") {
    plog(projectId, userId, "App could not be brought up", { level: "error", detail: finished.detail });
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────────────────
export interface SetupOptions { userId: string; branch?: string; rebuildManifest?: boolean }

/**
 * Full setup: bring the client app up live in its sandbox and return a preview
 * URL. Long-running — call in the background and stream status over WS.
 */
export async function setupPreview(projectId: string, opts: SetupOptions): Promise<{ previewUrl: string } | { error: string }> {
  const { userId } = opts;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return { error: "project not found" };
  const branch = opts.branch || ""; // "" → use the repo's default branch

  resetLog(projectId);
  try {
    plog(projectId, userId, "Starting the project's sandbox…");
    await ensureProjectSandbox(projectId);
    const workspaceId = `env-${projectId}`;
    plog(projectId, userId, `Sandbox ready (${workspaceId}) — Alpine Linux, 8GB, Docker-capable`);
    await setPreview(projectId, userId, { previewStatus: "detecting", previewError: null, previewBranch: branch || "(default)" }, "Preparing sandbox…");

    // 0. Install + start Docker UP FRONT (before pulling the code) so it's ready
    // for any Docker-based DB (SQL Server) and for the run agent. Alpine → OpenRC.
    plog(projectId, userId, "Installing + starting Docker…");
    const dockerReady = await ensureDocker(projectId);
    plog(projectId, userId, dockerReady ? "Docker ready ✓" : "Docker did not start (only fatal if a Docker-based DB is needed)", dockerReady ? undefined : { level: "error" });

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
      return failed(projectId, userId, `Could not fetch the repo:\n${safe}`);
    }
    plog(projectId, userId, "Repo fetched ✓");

    // 2. Detect (or reuse) the setup manifest.
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

    // 3. Provision the DBs the plan calls for, and inject each connection string
    // into the EXACT env var the app reads it from (per the plan).
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
    }

    // 4. Write env: the plan's DB connection vars + PORT/HOST(/ASPNETCORE_URLS) +
    // stored project vars.
    await writeEnvFile(workspaceId, projectId, manifest, provisioned);
    plog(projectId, userId, `Wrote .env (${Object.keys(provisioned).length} DB connection var(s) + run config)`);

    // 5. Get the app running + VERIFIED. Master-slave: an AI on OUR side drives
    // the sandbox command-by-command (install → build → migrate → run → verify),
    // reading each command's real output. Falls back to a straight deterministic
    // run of the plan when no usable model/key is available.
    await setPreview(projectId, userId, { previewStatus: "installing" }, "Setting up & running the app…");
    const driver = await resolveDriverModel(userId);
    let up = false;
    if (driver) {
      plog(projectId, userId, `Driving the sandbox with ${driver.modelKey} to install, run, and verify the app on port ${manifest.port}…`);
      up = await driveSandbox(projectId, userId, workspaceId, manifest, engineHandles, driver.model);
    } else {
      plog(projectId, userId, "No usable model/key — running the plan deterministically.");
      // toolchain
      for (const t of manifest.toolchain || []) { plog(projectId, userId, `Toolchain: ${t}…`); await sh(workspaceId, `${t} >/dev/null 2>&1; echo done`, 300_000); }
      await setPreview(projectId, userId, { previewStatus: "installing" }, "Installing dependencies…");
      plog(projectId, userId, `Installing dependencies (${manifest.installCmd})…`);
      const inst = await sh(workspaceId, `
export PATH=/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export npm_config_cache=/data/.npm-cache NODE_OPTIONS="--max-old-space-size=1536"
cd ${PROJECT_DIR} && set -a; . ./.env 2>/dev/null; set +a; ${manifest.installCmd || "true"} > install.log 2>&1; echo "INSTALL_EXIT=$?"; tail -4 install.log`, 600_000);
      const instExit = (inst.output.match(/INSTALL_EXIT=(\d+)/) || [])[1];
      plog(projectId, userId, instExit === "0" ? "Dependencies installed ✓" : `Install exited ${instExit}`, instExit && instExit !== "0" ? { level: "error", detail: inst.output.slice(-500) } : undefined);
      if (manifest.buildCmd) { plog(projectId, userId, `Building (${manifest.buildCmd})…`); await sh(workspaceId, `cd ${PROJECT_DIR} && set -a; . ./.env 2>/dev/null; set +a; ${manifest.buildCmd} > build.log 2>&1; echo done`, 600_000); }
      // Apply raw .sql scripts against the first provisioned SQL engine.
      const sqlEngine = engineHandles.find((h) => h.engine === "postgres" || h.engine === "mysql");
      const applySql = (f: string) => !sqlEngine ? `echo "no SQL engine for ${f}"`
        : sqlEngine.engine === "postgres"
          ? `PGPASSWORD='${sqlEngine.password}' psql -h 127.0.0.1 -p ${sqlEngine.port} -U ${sqlEngine.username} -d ${sqlEngine.dbName} -f '${f}'`
          : `mysql -h 127.0.0.1 -P ${sqlEngine.port} -u ${sqlEngine.username} -p'${sqlEngine.password}' ${sqlEngine.dbName} < '${f}'`;
      const schemaSteps = [...(manifest.migrations || []), ...(manifest.sqlScripts || []).map(applySql), ...(manifest.seedCmd ? [manifest.seedCmd] : [])];
      if (schemaSteps.length) {
        await setPreview(projectId, userId, { previewStatus: "seeding" }, "Applying schema + seed…");
        for (const step of schemaSteps) { plog(projectId, userId, `Schema: ${step}…`); await sh(workspaceId, `cd ${PROJECT_DIR} && set -a; . ./.env 2>/dev/null; set +a; ${step} >> migrate.log 2>&1; echo done`, 300_000); }
      }
      await setPreview(projectId, userId, { previewStatus: "starting" }, "Starting the app…");
      plog(projectId, userId, `Starting the app (${manifest.runCmd})…`);
      up = await startApp(workspaceId, manifest);
    }

    // 6. Confirm the app is actually serving on its port (reality check).
    plog(projectId, userId, `Verifying the app responds on 127.0.0.1:${manifest.port}…`);
    if (!up) {
      const log = await sh(workspaceId, `tail -40 ${PROJECT_DIR}/preview.log 2>/dev/null; echo '--- install.log ---'; tail -15 ${PROJECT_DIR}/install.log 2>/dev/null`, 20_000);
      const detail = (log.output || "").trim() || "(no log output captured)";
      plog(projectId, userId, `The app did not respond on port ${manifest.port}`, { level: "error", detail });
      return failed(projectId, userId, `The app did not come up on port ${manifest.port}.\n\n${detail.slice(-1000)}`);
    }
    plog(projectId, userId, "App is responding ✓");

    // 7. Expose the app's OWN port publicly. The app is CONFIRMED up, so a
    // transient Mags "job not found" here must NOT throw away a working preview —
    // retry the exposure (the VM name just needs a moment to re-resolve).
    plog(projectId, userId, `Exposing port ${manifest.port} as a public URL…`);
    const alias = existing?.stableAlias || `preview-${projectId.slice(0, 8)}`;
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
    plog(projectId, userId, "Setup failed", { level: "error", detail: msg });
    return failed(projectId, userId, msg);
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
  if (!row) return { previewStatus: "idle" as PreviewStatus, previewUrl: null, manifest: null, error: null, branch: null, log: "" };
  return {
    previewStatus: (row.previewStatus as PreviewStatus) ?? "idle",
    previewUrl: row.appUrl ?? null,
    manifest: row.setupManifest ? JSON.parse(row.setupManifest) : null,
    error: row.previewError ?? null,
    branch: row.previewBranch ?? null,
    log: logBuffers.get(projectId) ?? row.setupLog ?? "",
  };
}

/** Stop the running app (leaves the sandbox + DBs up). */
export async function stopPreview(projectId: string, userId: string): Promise<void> {
  const workspaceId = `env-${projectId}`;
  const row = await getEnv(projectId);
  const port = row?.appPort
    ?? (row?.setupManifest ? (JSON.parse(row.setupManifest) as PreviewManifest).port : undefined)
    ?? DEFAULT_PORT;
  await sh(workspaceId, `fuser -k ${port}/tcp 2>/dev/null; pkill -f ':${port}' 2>/dev/null; echo stopped`, 30_000).catch(() => {});
  await setPreview(projectId, userId, { previewStatus: "stopped", appUrl: null }, "Preview stopped");
}
