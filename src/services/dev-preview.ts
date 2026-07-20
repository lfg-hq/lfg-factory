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
import { generateObject } from "ai";
import { and, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projects, projectEnvironmentVariables } from "../db/schema/projects.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { githubTokens, llmApiKeys } from "../db/schema/users.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { getValidGitlabToken } from "./gitlab-token.ts";
import { getModel, getProviderName, getProviderModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { decryptSecret } from "../utils/crypto.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { enableHttpAccess, execOnWorkspace, setStableUrl } from "./mags.ts";
import { ensureProjectSandbox, ensureEngine, ensureDocker, type EngineHandle } from "./project-sandbox.ts";
import { startPiCli, streamPiToCompletion, isPiSupportedProvider } from "./pi-cli.ts";

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

// ── Agent runner (full loop): an in-sandbox coding agent gets the app running
// and verifies it against the port, self-correcting from logs. Matches the
// project chat model via Pi. ────────────────────────────────────────────────
async function resolveAgentModel(userId: string): Promise<{ provider: string; modelId: string; apiKey: string } | null> {
  const [sel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId));
  const modelKey = sel?.selectedModel ?? DEFAULT_MODEL_KEY;
  const provider = getProviderName(modelKey);
  if (!provider || !isPiSupportedProvider(provider)) return null; // e.g. anthropic → deterministic fallback
  const [keys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, userId));
  const apiKey = (keys as Record<string, string | null> | undefined)?.[`${provider}ApiKey`] || "";
  if (!apiKey) return null;
  return { provider, modelId: getProviderModel(modelKey) ?? modelKey, apiKey };
}

function buildRunPrompt(manifest: PreviewManifest, engines: EngineHandle[], round: number, prevTail?: string): string {
  const port = manifest.port;
  const dbLines = engines.length
    ? manifest.databases.map((d, i) => `  - ${d.engine} on 127.0.0.1:${engines[i]?.port ?? "?"} (db "${engines[i]?.dbName ?? "app"}") — connection string ALREADY in .env as ${d.connectionEnvVar}`).join("\n")
    : "  - none";
  const list = (label: string, items: string[]) => items.length ? `- ${label}:\n${items.map((s) => `    • ${s}`).join("\n")}` : "";
  const one = (label: string, v: string) => (v ? `- ${label}: \`${v}\`` : "");

  // The PLAN, produced by reading the codebase — the exact steps to run this app.
  const plan = [
    `- stack: ${manifest.stack || `${manifest.runtime}/${manifest.framework}`}`,
    list("toolchain (install these first if missing)", manifest.toolchain || []),
    one("install libraries", manifest.installCmd),
    one("build (do this BEFORE running — compiled stacks)", manifest.buildCmd),
    manifest.startupProject ? `- startup project (multi-project solution — run THIS one): ${manifest.startupProject}` : "",
    list("apply DB migrations (schema)", manifest.migrations || []),
    list("apply these SQL script files to the DB in order", manifest.sqlScripts || []),
    one("seed", manifest.seedCmd),
    one("run (foreground, bind 0.0.0.0)", manifest.runCmd),
    `- port: ${port}`,
  ].filter(Boolean).join("\n");

  const continuation = round > 1
    ? `\n⚠️ THIS IS RETRY #${round}. A previous attempt did NOT get the app serving on port ${port} — but its work is still here (installed SDKs/toolchains, restored packages all persist in this sandbox). DO NOT start over; pick up where it left off. First check what's already there and whether anything is listening (\`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/ ; ls ${PROJECT_DIR}\`), read ${PROJECT_DIR}/preview.log, then continue.${prevTail ? `\nTail of the previous attempt:\n${prevTail.slice(-1200)}` : ""}\n`
    : "";

  return `You are getting an EXISTING application RUNNING inside an Alpine Linux sandbox so it can be previewed live in a browser. Work in ${PROJECT_DIR}.
${continuation}
ENVIRONMENT: this is an ALPINE LINUX sandbox (musl libc, apk, OpenRC, busybox) — NOT Debian/Ubuntu. Use \`apk add --no-cache <pkg>\` for packages (never apt/yum), \`rc-service <svc> start\` to start services (never systemctl), and \`apk add gcompat\` if a glibc-only binary fails to run. Docker is ALREADY installed and running.

Context:
- The repo is already cloned at ${PROJECT_DIR}.
- A .env file already exists with PORT/HOST and every DB connection string — ALWAYS load it before running commands (\`set -a; . ./.env; set +a\`).
- These databases are ALREADY installed + running locally (do NOT install or start any database) — their connection strings are already in .env under the env var named:
${dbLines}

SETUP PLAN (prepared by analyzing this codebase — follow it; it may need small corrections, verify against the real files):
${plan}

GOAL: the app must be serving HTTP on 0.0.0.0:${port} and actually respond.

Steps:
1. Run the toolchain installs, then install libraries.
2. For COMPILED stacks, BUILD before running. For a multi-project solution, run the startup project named above.
3. Apply the DB migrations / SQL scripts / seed from the plan (the DB connection is already in .env — for a raw .sql file use the matching client, e.g. \`psql "$ConnectionEnvVar" -f file.sql\` or pipe into \`mysql\`).
4. Start the app in the BACKGROUND, bound to 0.0.0.0 on port ${port}, DETACHED so it survives your shell — e.g. \`setsid sh -c 'set -a; . ./.env; set +a; <run command>' </dev/null > ${PROJECT_DIR}/preview.log 2>&1 &\`.
5. VERIFY BY ACTUALLY REQUESTING THE APP and INSPECTING THE RESPONSE — do not assume: \`curl -sS -i http://127.0.0.1:${port}/\`. Working ONLY on a real 2xx/3xx response WITH actual content. connection-refused (000), 5xx, or an error/stack-trace page = NOT working → keep fixing.
6. If not up: read ${PROJECT_DIR}/preview.log + the build output, DIAGNOSE (missing dep, wrong build step, missing env var, DB not migrated, wrong startup project), FIX THE ENVIRONMENT, and RETRY until it responds.

CRITICAL RULES:
- DO NOT MODIFY THE APPLICATION'S SOURCE CODE. This is a preview of the user's EXISTING repository. You MAY install tools/dependencies, set environment variables, pick the correct build/run command, and fix host/port binding — but you must NOT edit, create, or delete any application source file. If the app genuinely cannot run without a code change, do NOT change it: stop and report PREVIEW_FAILED with the exact code-level reason so the user can fix it.
- DO NOT GIVE UP EARLY. restore/build/install for large apps can take SEVERAL MINUTES — give slow commands a generous timeout (e.g. run bash with timeout 600). A slow command is NOT a failure; wait for it. If a command errors, READ the error, fix the ENVIRONMENT (not the code), and try again. Keep working until the app actually serves on port ${port}, unless you have truly exhausted every option.
- RELAY ERRORS ACCURATELY. Whenever something fails, surface the ACTUAL error text you saw (the real compiler/runtime/log message) — do not paraphrase it away. If you must give up, PREVIEW_FAILED's reason must contain the concrete error.

Only after curl confirms the app responds with real content on port ${port}, print on its own line exactly:
PREVIEW_READY ${port}
If (and only if) you have genuinely exhausted all environment fixes — or it needs a source-code change — print exactly:
PREVIEW_FAILED <concrete reason incl. the real error>

Hard rules: the server MUST bind 0.0.0.0 (not localhost-only) and MUST be detached (survive your shell). Never print secrets.`;
}

const MAX_AGENT_ROUNDS = 2; // initial attempt + one resume

async function runViaAgent(
  projectId: string,
  userId: string,
  workspaceId: string,
  manifest: PreviewManifest,
  engines: EngineHandle[],
  agent: { provider: string; modelId: string; apiKey: string },
): Promise<boolean> {
  let prevTail = "";
  for (let round = 1; round <= MAX_AGENT_ROUNDS; round++) {
    if (round > 1) plog(projectId, userId, `Agent stopped before the app was up — resuming (attempt ${round}/${MAX_AGENT_ROUNDS})…`);
    const prompt = buildRunPrompt(manifest, engines, round, prevTail);
    // Log the FULL prompt handed to the agent (so you can see/test exactly what
    // it was told), not a snippet.
    plog(projectId, userId, `── Agent prompt (attempt ${round}) ──`, { detail: prompt });
    const pi = await startPiCli({
      workspaceId,
      prompt,
      projectDir: PROJECT_DIR, // pi-cli strips /data/ → "project"
      provider: agent.provider,
      modelId: agent.modelId,
      apiKey: agent.apiKey,
    });
    let lastLine = "";
    const result = await streamPiToCompletion({
      workspaceId,
      outputFile: pi.outputFile,
      backgroundPid: pi.backgroundPid,
      timeoutMs: 15 * 60_000,
      progressMaxLen: 100_000, // log the FULL command the agent runs, not a cutoff
      onProgress: (m) => {
        if (m && m !== lastLine) { lastLine = m; plog(projectId, userId, `agent: ${m}`); } // full line → log
        const head = m.length > 120 ? m.slice(0, 120) + "…" : m; // short line → header only
        setPreview(projectId, userId, { previewStatus: "starting" }, head).catch(() => {});
      },
    });
    if (result.fatalError) plog(projectId, userId, `agent exited: ${result.fatalError}`, { level: "error" });

    // Trust the reality of the port, not the agent's word: confirm it listens.
    if (await checkServer(workspaceId, manifest.port, 8)) return true;
    if (result.tail && /PREVIEW_READY/.test(result.tail) && await checkServer(workspaceId, manifest.port, 4)) return true;

    // Not up yet — capture what happened, feed it into the next round's prompt.
    const tail = await sh(workspaceId, `tail -25 ${PROJECT_DIR}/preview.log 2>/dev/null`, 20_000).catch(() => ({ output: "" }));
    const agentTail = (result.tail || "").split("\n").filter((l) => l.trim()).slice(-6).join("\n");
    prevTail = [agentTail && `agent:\n${agentTail}`, tail.output && `preview.log:\n${tail.output}`].filter(Boolean).join("\n\n");
    // If the agent explicitly declared it cannot run, stop retrying.
    if (result.tail && /PREVIEW_FAILED/.test(result.tail)) {
      plog(projectId, userId, "Agent reported it cannot run this app", { level: "error", detail: prevTail });
      return false;
    }
    plog(projectId, userId, `App still not responding on port ${manifest.port} after attempt ${round}`, round === MAX_AGENT_ROUNDS ? { level: "error", detail: prevTail } : undefined);
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

    // 5. Get the app running + VERIFIED. Preferred: an in-sandbox coding agent
    // (matches the project chat model) that installs, migrates/seeds, starts the
    // server, curls the port, and self-corrects from logs. Falls back to the
    // deterministic runner when no Pi-capable model/key is available.
    const agent = await resolveAgentModel(userId);
    let up = false;
    if (agent) {
      plog(projectId, userId, `Handing off to the ${agent.provider} agent to install, run, and verify the app on port ${manifest.port}…`);
      await setPreview(projectId, userId, { previewStatus: "starting" }, `Agent (${agent.provider}) is getting the app running…`);
      up = await runViaAgent(projectId, userId, workspaceId, manifest, engineHandles, agent);
    } else {
      plog(projectId, userId, "No agent model available — using the deterministic runner.");
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

    // 7. Expose the app's OWN port publicly (whatever the manifest decided).
    plog(projectId, userId, `Exposing port ${manifest.port} as a public URL…`);
    await enableHttpAccess(workspaceId, manifest.port);
    const alias = existing?.stableAlias || `preview-${projectId.slice(0, 8)}`;
    let previewUrl = "";
    try { previewUrl = await setStableUrl(alias, workspaceId); }
    catch { previewUrl = await enableHttpAccess(workspaceId, manifest.port); }

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
