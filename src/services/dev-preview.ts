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
import { githubTokens } from "../db/schema/users.ts";
import { getModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { decryptSecret } from "../utils/crypto.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { enableHttpAccess, execOnWorkspace, setStableUrl } from "./mags.ts";
import { ensureProjectSandbox, ensureEngine, type DbEngine } from "./project-sandbox.ts";

const PROJECT_DIR = "/data/project";
const APP_PORT = 8080; // Mags HTTP proxy port (same as Instant)

export type PreviewStatus =
  | "idle" | "detecting" | "provisioning" | "installing" | "seeding" | "starting" | "running" | "error" | "stopped";

// ── Setup manifest (detected once, saved, editable, re-runnable) ─────────
export const manifestSchema = z.object({
  runtime: z.string().describe("e.g. node, python, ruby, dotnet, php, go"),
  framework: z.string().describe("e.g. next, vite, django, rails, express, dotnet, laravel; '' if unknown"),
  installCmd: z.string().describe("Command to install deps, e.g. 'npm install', 'pip install -r requirements.txt', 'bundle install'"),
  buildCmd: z.string().describe("Build command if the app needs one before running (e.g. 'npm run build'); '' if none"),
  runCmd: z.string().describe("Command to START the app in the foreground, bound to host 0.0.0.0 and port 8080 (use env PORT/HOST). e.g. 'npm start', 'python manage.py runserver 0.0.0.0:8080'"),
  port: z.number().describe("Port the app listens on. Prefer 8080."),
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
    .set({ ...patch, updatedAt: new Date() })
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
    prompt: `You are configuring a dev preview that RUNS this repository inside a Linux sandbox and exposes it on host 0.0.0.0 port 8080. Analyze the repo fingerprint and produce the exact commands to install, migrate, seed, and run it.

Rules:
- runCmd MUST make the app listen on 0.0.0.0:8080. Use the env vars PORT=8080 and HOST=0.0.0.0 which will be set, or pass flags explicitly (e.g. 'python manage.py runserver 0.0.0.0:8080', 'npm run dev -- --host 0.0.0.0 --port 8080').
- engines: only DBs the app truly needs (look at deps like pg/psycopg/mysql/mysql2/redis/ioredis/prisma provider, docker-compose services, DATABASE_URL in .env.example). Postgres/MySQL/Redis only.
- envVars: real external config the app needs (API keys, feature flags) from .env.example. DO NOT include DATABASE_URL, REDIS_URL, DB_* — those are auto-provisioned.
- If something is unknown, choose the most standard command for the detected stack.

Repo fingerprint:
${fingerprint}`,
  });

  // Project-level manual overrides win (customInstallCmd/customDevCmd/customDefaultPort).
  const manifest: PreviewManifest = {
    ...object,
    installCmd: project.customInstallCmd || object.installCmd,
    runCmd: project.customDevCmd || object.runCmd,
    port: project.customDefaultPort || object.port || APP_PORT,
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

async function writeEnvFile(workspaceId: string, projectId: string, provisioned: Record<string, string>) {
  // Stored project env vars (decrypted) + provisioned DB creds + run hints.
  const stored = await db.select().from(projectEnvironmentVariables).where(eq(projectEnvironmentVariables.projectId, projectId));
  const vars: Record<string, string> = { PORT: String(APP_PORT), HOST: "0.0.0.0", ...provisioned };
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
async function checkServer(workspaceId: string, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const { output } = await sh(workspaceId, `curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:${APP_PORT}/ 2>/dev/null || echo 000`, 15_000);
    const code = (output.match(/\d{3}/) || ["000"])[0];
    if (code !== "000") return true; // anything listening (even 404/500) means the server is up
    await sleep(3000);
  }
  return false;
}

async function startApp(workspaceId: string, manifest: PreviewManifest): Promise<boolean> {
  const buildStep = manifest.buildCmd ? `${manifest.buildCmd} >> preview.log 2>&1 || echo BUILD_FAILED >> preview.log` : "true";
  const script = `
export PATH=/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export NODE_OPTIONS="--max-old-space-size=1536"
cd ${PROJECT_DIR} || exit 1
# free the port
fuser -k ${APP_PORT}/tcp 2>/dev/null; pkill -f ':${APP_PORT}' 2>/dev/null; sleep 1
${buildStep}
CMD='set -a; [ -f ./.env ] && . ./.env; set +a; export PORT=${APP_PORT} HOST=0.0.0.0; cd ${PROJECT_DIR}; exec ${manifest.runCmd.replace(/'/g, "'\\''")}'
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c "$CMD" </dev/null >> preview.log 2>&1 &
else
  nohup sh -c "$CMD" </dev/null >> preview.log 2>&1 &
fi
echo LAUNCHED
`;
  await sh(workspaceId, script, 300_000);
  return checkServer(workspaceId, 20); // ~60s
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
  const branch = opts.branch || "lfg-agent";

  try {
    await ensureProjectSandbox(projectId);
    const workspaceId = `env-${projectId}`;
    await setPreview(projectId, userId, { previewStatus: "detecting", previewError: null, previewBranch: branch }, "Preparing sandbox…");

    // 1. Clone / update the repo into the sandbox.
    const [ghToken] = await db.select().from(githubTokens).where(eq(githubTokens.userId, project.ownerId)).limit(1);
    const repoUrl = project.repoUrl || (project.repoOwner && project.repoName ? `https://github.com/${project.repoOwner}/${project.repoName}.git` : "");
    if (!repoUrl) return failed(projectId, userId, "This project has no connected repository to preview.");
    if (!ghToken?.accessToken) return failed(projectId, userId, "No GitHub token — connect GitHub to preview this project.");

    await setPreview(projectId, userId, { previewStatus: "detecting" }, "Fetching the code…");
    const authUrl = repoUrl.replace("https://", `https://x-access-token:${ghToken.accessToken}@`);
    const clone = await sh(workspaceId, `
export PATH=/root/node/current/bin:/usr/local/bin:/usr/bin:/bin:$PATH
apk add --no-cache git ca-certificates >/dev/null 2>&1 || true
mkdir -p /data
if [ -d ${PROJECT_DIR}/.git ]; then
  cd ${PROJECT_DIR} && git remote set-url origin "${authUrl}" && git fetch origin >/dev/null 2>&1 && git checkout ${branch} 2>/dev/null && git reset --hard origin/${branch} 2>/dev/null && echo CLONE_OK
else
  rm -rf ${PROJECT_DIR}; git clone "${authUrl}" ${PROJECT_DIR} 2>&1 | tail -2 && cd ${PROJECT_DIR} && (git checkout ${branch} 2>/dev/null || true) && echo CLONE_OK
fi`, 240_000);
    if (!clone.output.includes("CLONE_OK")) return failed(projectId, userId, `Could not fetch the repo:\n${clone.output.slice(-400)}`);

    // 2. Detect (or reuse) the setup manifest.
    const existing = await getEnv(projectId);
    let manifest: PreviewManifest;
    if (!opts.rebuildManifest && existing?.setupManifest) {
      manifest = JSON.parse(existing.setupManifest);
    } else {
      manifest = await detectManifest(projectId);
      await db.update(projectEnvironments).set({ setupManifest: JSON.stringify(manifest), updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
    }

    // 3. Provision the DBs the app needs.
    const provisioned: Record<string, string> = {};
    if (manifest.engines.length) {
      await setPreview(projectId, userId, { previewStatus: "provisioning" }, `Provisioning ${manifest.engines.join(", ")}…`);
      for (const engine of manifest.engines) {
        const h = await ensureEngine(projectId, engine);
        Object.assign(provisioned, engineEnv(engine, h));
      }
    }

    // 4. Write env (provisioned creds + stored project vars).
    await writeEnvFile(workspaceId, projectId, provisioned);

    // 5. Install deps.
    await setPreview(projectId, userId, { previewStatus: "installing" }, "Installing dependencies…");
    const install = await sh(workspaceId, `
export PATH=/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export npm_config_cache=/data/.npm-cache NODE_OPTIONS="--max-old-space-size=1536"
cd ${PROJECT_DIR} && ${manifest.installCmd} > install.log 2>&1; echo "INSTALL_EXIT=$?"; tail -3 install.log`, 480_000);
    const installExit = (install.output.match(/INSTALL_EXIT=(\d+)/) || [])[1];
    if (installExit && installExit !== "0") {
      // Non-fatal for some stacks, but log it.
      console.warn(`[dev-preview] install exit ${installExit}: ${install.output.slice(-300)}`);
    }

    // 6. Migrate + seed.
    if (manifest.migrateCmd || manifest.seedCmd) {
      await setPreview(projectId, userId, { previewStatus: "seeding" }, "Running migrations + seed…");
      if (manifest.migrateCmd) await sh(workspaceId, `cd ${PROJECT_DIR} && set -a; . ./.env 2>/dev/null; set +a; ${manifest.migrateCmd} >> migrate.log 2>&1; echo done`, 300_000);
      if (manifest.seedCmd) await sh(workspaceId, `cd ${PROJECT_DIR} && set -a; . ./.env 2>/dev/null; set +a; ${manifest.seedCmd} >> migrate.log 2>&1; echo done`, 300_000);
    }

    // 7. Start the app (detached) and wait for it to listen.
    await setPreview(projectId, userId, { previewStatus: "starting" }, "Starting the app…");
    const up = await startApp(workspaceId, manifest);
    if (!up) {
      const log = await sh(workspaceId, `tail -30 ${PROJECT_DIR}/preview.log 2>/dev/null`, 20_000);
      return failed(projectId, userId, `The app did not start on port ${APP_PORT}. Last log:\n${log.output.slice(-600)}`);
    }

    // 8. Expose a stable public URL.
    await enableHttpAccess(workspaceId, APP_PORT);
    const alias = existing?.stableAlias || `preview-${projectId.slice(0, 8)}`;
    let previewUrl = "";
    try { previewUrl = await setStableUrl(alias, workspaceId); }
    catch { previewUrl = await enableHttpAccess(workspaceId, APP_PORT); }

    await db.update(projectEnvironments).set({ stableAlias: alias, updatedAt: new Date() }).where(eq(projectEnvironments.projectId, projectId));
    await setPreview(projectId, userId, { previewStatus: "running", appUrl: previewUrl, appPort: APP_PORT, previewError: null }, "Preview is live");
    return { previewUrl };
  } catch (err) {
    return failed(projectId, userId, (err as Error).message ?? String(err));
  }
}

async function failed(projectId: string, userId: string, error: string): Promise<{ error: string }> {
  console.error(`[dev-preview] ${projectId}: ${error}`);
  await setPreview(projectId, userId, { previewStatus: "error", previewError: error.slice(0, 2000) }, "Preview failed").catch(() => {});
  return { error };
}

/** Current preview state for the Preview tab. */
export async function getPreviewState(projectId: string) {
  const row = await getEnv(projectId);
  if (!row) return { previewStatus: "idle" as PreviewStatus, previewUrl: null, manifest: null, error: null, branch: null };
  return {
    previewStatus: (row.previewStatus as PreviewStatus) ?? "idle",
    previewUrl: row.appUrl ?? null,
    manifest: row.setupManifest ? JSON.parse(row.setupManifest) : null,
    error: row.previewError ?? null,
    branch: row.previewBranch ?? null,
  };
}

/** Stop the running app (leaves the sandbox + DBs up). */
export async function stopPreview(projectId: string, userId: string): Promise<void> {
  const workspaceId = `env-${projectId}`;
  await sh(workspaceId, `fuser -k ${APP_PORT}/tcp 2>/dev/null; pkill -f ':${APP_PORT}' 2>/dev/null; echo stopped`, 30_000).catch(() => {});
  await setPreview(projectId, userId, { previewStatus: "stopped", appUrl: null }, "Preview stopped");
}
