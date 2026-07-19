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
import { ensureProjectSandbox, ensureEngine, type DbEngine, type EngineHandle } from "./project-sandbox.ts";
import { startPiCli, streamPiToCompletion, isPiSupportedProvider } from "./pi-cli.ts";

const PROJECT_DIR = "/data/project";
const DEFAULT_PORT = 8080; // fallback ONLY — the real port is decided by the detected manifest per stack

export type PreviewStatus =
  | "idle" | "detecting" | "provisioning" | "installing" | "seeding" | "starting" | "running" | "error" | "stopped";

// ── Setup manifest (detected once, saved, editable, re-runnable) ─────────
export const manifestSchema = z.object({
  runtime: z.string().describe("e.g. node, python, ruby, dotnet, php, go"),
  framework: z.string().describe("e.g. next, vite, django, rails, express, dotnet, laravel; '' if unknown"),
  installCmd: z.string().describe("Command to install deps, e.g. 'npm install', 'pip install -r requirements.txt', 'bundle install'"),
  buildCmd: z.string().describe("Build command if the app needs one before running (e.g. 'npm run build'); '' if none"),
  runCmd: z.string().describe("Command to START the app in the FOREGROUND on `port` below, bound to 0.0.0.0 (ALL interfaces, NOT localhost) using whatever mechanism this framework provides (a --host/--port flag, a bind arg, or an env var it reads)."),
  port: z.number().describe("The app's real port — DETECT it from the codebase, do not force a standard value. Determine it from however THIS stack declares its port: run scripts / framework config, docker-compose 'ports', Dockerfile EXPOSE, .env(.example), or the framework's documented default. Use the port this app actually listens on; THIS exact port is what gets exposed publicly."),
  engines: z.array(z.enum(["postgres", "mysql", "redis"])).describe("Databases the app needs, inferred from deps/config. Empty if none."),
  migrateCmd: z.string().describe("DB migration command if any (e.g. 'npx prisma migrate deploy', 'python manage.py migrate', 'bundle exec rails db:migrate'); '' if none"),
  seedCmd: z.string().describe("Seed command if the repo has one (e.g. 'npx prisma db seed', 'python manage.py loaddata seed.json'); '' if none"),
  envVars: z.array(z.object({
    key: z.string(),
    required: z.boolean(),
    description: z.string().describe("what this var is / where to get it"),
  })).describe("Env vars the app needs (from .env.example / config). EXCLUDE DB connection vars — those are auto-provisioned."),
});
export type PreviewManifest = z.infer<typeof manifestSchema>;

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
  const buf = ((logBuffers.get(projectId) ?? "") + entry + "\n").slice(-12_000); // keep last ~12KB
  logBuffers.set(projectId, buf);
  console.log(`[dev-preview] ${projectId.slice(0, 8)} ${level === "error" ? "ERROR " : ""}${line}${opts?.detail ? " :: " + opts.detail.replace(/\n/g, " ").slice(0, 300) : ""}`);
  broadcastToUser(userId, { type: "preview_log", projectId, line: entry, level });
}

function resetLog(projectId: string) { logBuffers.set(projectId, ""); }

// ── Stack detection → manifest ─────────────────────────────────────────────
async function gatherFingerprint(workspaceId: string): Promise<string> {
  const script = `
cd ${PROJECT_DIR} 2>/dev/null || exit 0
echo "=== FILES ==="; ls -a1 | head -60
echo "=== package.json ==="; head -c 4000 package.json 2>/dev/null
echo "=== requirements.txt ==="; head -c 1500 requirements.txt 2>/dev/null
echo "=== pyproject.toml ==="; head -c 1500 pyproject.toml 2>/dev/null
echo "=== manage.py ==="; test -f manage.py && echo present
echo "=== Gemfile ==="; head -c 1500 Gemfile 2>/dev/null
echo "=== composer.json ==="; head -c 1500 composer.json 2>/dev/null
echo "=== go.mod ==="; head -c 800 go.mod 2>/dev/null
echo "=== csproj ==="; ls *.csproj **/*.csproj 2>/dev/null | head
echo "=== docker-compose ==="; head -c 2500 docker-compose.yml 2>/dev/null; head -c 2500 docker-compose.yaml 2>/dev/null
echo "=== .env.example ==="; head -c 2500 .env.example 2>/dev/null; head -c 2500 .env.sample 2>/dev/null
echo "=== prisma ==="; head -c 1500 prisma/schema.prisma 2>/dev/null
echo "=== migrations dirs ==="; ls -d */migrations migrations db/migrate 2>/dev/null | head
`.trim();
  const { output } = await sh(workspaceId, script, 60_000);
  return output.slice(0, 12_000);
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
    prompt: `You are the build engineer configuring how to RUN this repository inside a Linux sandbox so a developer can preview it live. YOU decide the whole run config from the codebase — the stack, the commands, the databases, and the PORT. Do not assume anything; read the fingerprint.

Decide:
- port: the app's real port — detect it from however THIS stack declares its port (run scripts, framework config, docker-compose 'ports', Dockerfile EXPOSE, .env(.example), or the framework's documented default). Do NOT force a standard number. Whatever port you return is exactly the port we expose publicly.
- runCmd: start the app in the foreground on that port, bound to 0.0.0.0 (all interfaces — a localhost-only bind is NOT reachable by the proxy), using the stack's own flag/env mechanism.
- installCmd / buildCmd / migrateCmd / seedCmd: the correct commands for the detected stack. '' when a step doesn't apply.
- engines: only DBs the app truly needs (deps like pg/psycopg/mysql/mysql2/redis/ioredis, prisma provider, docker-compose services, DATABASE_URL scheme in .env.example). Postgres/MySQL/Redis only.
- envVars: real external config (API keys, feature flags) from .env(.example). EXCLUDE DATABASE_URL, REDIS_URL, DB_*, PG* — those are auto-provisioned and injected.

Repo fingerprint:
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
function engineEnv(engine: DbEngine, h: { connectionString: string; host: string; port: number; dbName: string; username: string; password: string }): Record<string, string> {
  if (engine === "redis") return { REDIS_URL: h.connectionString };
  // primary SQL engine
  return {
    DATABASE_URL: h.connectionString,
    DB_HOST: h.host, DB_PORT: String(h.port), DB_NAME: h.dbName, DB_USER: h.username, DB_PASSWORD: h.password,
    ...(engine === "postgres" ? { PGHOST: h.host, PGPORT: String(h.port), PGDATABASE: h.dbName, PGUSER: h.username, PGPASSWORD: h.password } : {}),
  };
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
  const vars: Record<string, string> = { PORT: String(port), HOST: "0.0.0.0" };
  if (runtime.includes("dotnet") || framework.includes("dotnet") || framework.includes("asp")) {
    vars.ASPNETCORE_URLS = `http://0.0.0.0:${port}`;
  }
  Object.assign(vars, provisioned);
  for (const v of stored) {
    if (!v.hasValue) continue;
    try { vars[v.key] = decryptSecret(v.encryptedValue); } catch { /* skip unreadable */ }
  }
  const body = Object.entries(vars)
    .map(([k, val]) => `${k}=${/[\s"'#]/.test(val) ? JSON.stringify(val) : val}`)
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
    ? engines.map((e) => `  - ${e.engine} on 127.0.0.1:${e.port} (db "${e.dbName}", user "${e.username}") — connection string in .env`).join("\n")
    : "  - none";
  const hint = (label: string, v: string) => (v ? `  - ${label}: \`${v}\`` : "");

  const continuation = round > 1
    ? `\n⚠️ THIS IS RETRY #${round}. A previous attempt did NOT get the app serving on port ${port} — but its work is still here (installed SDKs/toolchains, restored packages, node_modules all persist in this sandbox). DO NOT start over from scratch; pick up where it left off. First check what's already there and whether anything is listening (\`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/ ; ls ${PROJECT_DIR}\`), read ${PROJECT_DIR}/preview.log, then continue.${prevTail ? `\nTail of the previous attempt:\n${prevTail.slice(-1200)}` : ""}\n`
    : "";

  return `You are getting an EXISTING application RUNNING inside a Linux sandbox so it can be previewed live in a browser. Work in ${PROJECT_DIR}.
${continuation}
Context:
- The repo is already cloned at ${PROJECT_DIR}.
- A .env file already exists there with database credentials and PORT/HOST — load and use it (\`set -a; . ./.env; set +a\`).
- Databases are already installed and RUNNING locally (do not install or start any database):
${dbLines}
- Detected stack is only a HINT — verify against the actual code: runtime=${manifest.runtime || "?"}, framework=${manifest.framework || "?"}.
${[hint("install", manifest.installCmd), hint("build", manifest.buildCmd), hint("migrate", manifest.migrateCmd), hint("seed", manifest.seedCmd), hint("run", manifest.runCmd)].filter(Boolean).join("\n")}

GOAL: the app must be serving HTTP on 0.0.0.0:${port} and actually respond.

Steps:
1. Install the toolchain + dependencies if not already done.
2. For COMPILED stacks (.NET, Java, Go, Rust): restore → BUILD → then run. Do the build BEFORE trying to run. For a multi-project solution, find the WEB/startup project (the one referencing ASP.NET Core / a web SDK) and run THAT specific project, not the whole solution.
3. Run DB migrations and seed data if the app has them (creds are already in .env).
4. Start the app in the BACKGROUND, bound to host 0.0.0.0 on port ${port}, DETACHED so it keeps running after your command returns — e.g. \`setsid sh -c 'set -a; . ./.env; set +a; export PORT=${port} HOST=0.0.0.0; <run command>' </dev/null > ${PROJECT_DIR}/preview.log 2>&1 &\`.
5. VERIFY BY ACTUALLY REQUESTING THE APP over localhost and INSPECTING THE RESPONSE — do not assume: \`curl -sS -i http://127.0.0.1:${port}/\`. It is working ONLY if you get a real HTTP response with a 2xx/3xx status AND actual page content. It is NOT working if you get connection refused (000), a 5xx server error, or an error/stack-trace page — in that case keep diagnosing and fixing.
6. If it is not up: read ${PROJECT_DIR}/preview.log and the build output, DIAGNOSE (missing dep, wrong build step, missing env var, DB not migrated, needs a production build first, wrong host/port, wrong startup project), FIX THE ENVIRONMENT, and RETRY. Iterate until it responds.

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
      onProgress: (m) => {
        if (m && m !== lastLine) { lastLine = m; plog(projectId, userId, `agent: ${m}`); }
        setPreview(projectId, userId, { previewStatus: "starting" }, m).catch(() => {});
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
    plog(projectId, userId, `Sandbox ready (${workspaceId})`);
    await setPreview(projectId, userId, { previewStatus: "detecting", previewError: null, previewBranch: branch || "(default)" }, "Preparing sandbox…");

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
    let manifest: PreviewManifest;
    if (!opts.rebuildManifest && existing?.setupManifest) {
      manifest = JSON.parse(existing.setupManifest);
      plog(projectId, userId, `Using saved config (${manifest.framework || manifest.runtime}, port ${manifest.port})`);
    } else {
      plog(projectId, userId, "Analyzing the codebase to work out how to run it…");
      manifest = await detectManifest(projectId);
      await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
      plog(projectId, userId, `Detected: ${manifest.runtime}${manifest.framework ? "/" + manifest.framework : ""}, port ${manifest.port}, databases: ${manifest.engines.length ? manifest.engines.join(", ") : "none"}`);
    }

    // 3. Provision the DBs the app needs (keep the handles for the agent prompt).
    const provisioned: Record<string, string> = {};
    const engineHandles: EngineHandle[] = [];
    if (manifest.engines.length) {
      await setPreview(projectId, userId, { previewStatus: "provisioning" }, `Provisioning ${manifest.engines.join(", ")}…`);
      for (const engine of manifest.engines) {
        plog(projectId, userId, `Provisioning ${engine}…`);
        const h = await ensureEngine(projectId, engine);
        engineHandles.push(h);
        Object.assign(provisioned, engineEnv(engine, h));
        plog(projectId, userId, `${engine} ready at 127.0.0.1:${h.port} (db "${h.dbName}") ✓`);
      }
    }

    // 4. Write env (provisioned creds + stored project vars).
    await writeEnvFile(workspaceId, projectId, manifest, provisioned);
    plog(projectId, userId, "Wrote .env (DB credentials + project env vars)");

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
      await setPreview(projectId, userId, { previewStatus: "installing" }, "Installing dependencies…");
      plog(projectId, userId, `Installing dependencies (${manifest.installCmd})…`);
      const inst = await sh(workspaceId, `
export PATH=/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export npm_config_cache=/data/.npm-cache NODE_OPTIONS="--max-old-space-size=1536"
cd ${PROJECT_DIR} && ${manifest.installCmd} > install.log 2>&1; echo "INSTALL_EXIT=$?"; tail -4 install.log`, 480_000);
      const instExit = (inst.output.match(/INSTALL_EXIT=(\d+)/) || [])[1];
      plog(projectId, userId, instExit === "0" ? "Dependencies installed ✓" : `Install exited ${instExit}`, instExit && instExit !== "0" ? { level: "error", detail: inst.output.slice(-500) } : undefined);
      if (manifest.migrateCmd || manifest.seedCmd) {
        await setPreview(projectId, userId, { previewStatus: "seeding" }, "Running migrations + seed…");
        if (manifest.migrateCmd) { plog(projectId, userId, `Migrating (${manifest.migrateCmd})…`); await sh(workspaceId, `cd ${PROJECT_DIR} && set -a; . ./.env 2>/dev/null; set +a; ${manifest.migrateCmd} >> migrate.log 2>&1; echo done`, 300_000); }
        if (manifest.seedCmd) { plog(projectId, userId, `Seeding (${manifest.seedCmd})…`); await sh(workspaceId, `cd ${PROJECT_DIR} && set -a; . ./.env 2>/dev/null; set +a; ${manifest.seedCmd} >> migrate.log 2>&1; echo done`, 300_000); }
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
