/**
 * App Profile + Probe agent.
 *
 * The PROBE is a deep, tool-using read of the connected repo that runs BEFORE
 * any build/run and produces a persisted, self-healing "how to run THIS app"
 * profile — the single source of truth the preview runbook is derived from.
 * It exists to kill the non-determinism of "an agent re-figures-it-out every
 * run": instead we investigate once, thoroughly, record everything (stack,
 * versions, the DB schema recipe in dependency order, env vars classified as
 * auto-provided vs USER-REQUIRED secrets, and config/build quirks), persist it,
 * and let every subsequent run derive deterministic steps from it. Failures +
 * corrections get written back so re-runs get faster, not slower.
 *
 * This module deliberately does NOT import from dev-preview.ts at runtime (only
 * the PreviewManifest *type*) so there is no import cycle — dev-preview.ts is
 * the consumer.
 */
import { z } from "zod";
import { generateText, tool, zodSchema, stepCountIs } from "ai";
import { eq, and } from "drizzle-orm";
import { db } from "../config/db.ts";
import { appProfiles } from "../db/schema/app-profile.ts";
import { projectEnvironmentVariables } from "../db/schema/projects.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { getModel, getProviderName, DEFAULT_MODEL_KEY, type ProviderName } from "../ai/provider.ts";
import { execOnWorkspace } from "./mags.ts";
import { encryptSecret } from "../utils/crypto.ts";
import { randomBytes } from "node:crypto";
import type { LanguageModel } from "ai";
import type { PreviewManifest } from "./dev-preview.ts";

/** Providers whose native structured-output (generateObject) + agentic tool-calling are
 *  reliable. Kimi/DeepSeek/GLM negotiate generateObject poorly (→ "response did not match
 *  schema") and don't converge on multi-step tool loops, so setup uses a JSON-text +
 *  manual-parse path and skips the tool-probe for them. */
export function providerSupportsStructured(provider: ProviderName | null): boolean {
  return !!provider && ["anthropic", "openai", "google"].includes(provider);
}

/**
 * Resolve the LLM the user picked in chat (with their own keys) for setup/probe work.
 * Preview setup must use the SAME model the user selected — not a hardcoded default on
 * the server's env key (which broke setup when the server's OpenAI key was invalid,
 * even though the user had a valid Kimi/other key). Falls back to the default model +
 * env only when the user has no selection/keys. Also reports whether the model can do
 * native structured output / agentic tool-calling, so callers pick the right strategy.
 */
export async function resolveUserModel(
  userId: string,
): Promise<{ model: LanguageModel; modelKey: string; provider: ProviderName | null; supportsStructured: boolean }> {
  const [sel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, userId));
  const [keys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, userId));
  const modelKey = sel?.selectedModel ?? DEFAULT_MODEL_KEY;
  const userApiKeys = keys
    ? {
        anthropic: keys.anthropicApiKey ?? undefined,
        openai: keys.openaiApiKey ?? undefined,
        google: keys.googleApiKey ?? undefined,
        kimi: keys.kimiApiKey ?? undefined,
        deepseek: keys.deepseekApiKey ?? undefined,
        glm: keys.glmApiKey ?? undefined,
      }
    : undefined;
  const provider = getProviderName(modelKey);
  return {
    model: getModel(modelKey, userApiKeys, { allowEnvFallback: true }),
    modelKey,
    provider,
    supportsStructured: providerSupportsStructured(provider),
  };
}

const PROJECT_DIR = "/data/project";

// ── The App Profile schema ───────────────────────────────────────────────────
const CONN_FORMATS = ["url", "dotnet-npgsql", "dotnet-mysql", "dotnet-sqlserver", "keyvalue"] as const;

export const appProfileSchema = z.object({
  // ── Stack / versions ──
  stack: z.string().describe("Human summary incl. versions, e.g. '.NET 8 / ASP.NET Core, multi-project solution'."),
  runtime: z.string().describe("dotnet | node | python | ruby | php | go"),
  framework: z.string().describe("aspnet-core | next | vite | django | rails | express | laravel; '' if unknown"),
  runtimeVersion: z.string().describe("EXACT runtime/SDK version the app targets, read from .csproj <TargetFramework>, global.json, package.json engines, .python-version, etc. e.g. 'net8.0', 'node 20', 'python 3.12'. '' if truly unknowable."),
  // ── Toolchain / build ──
  toolchain: z.array(z.string()).describe("Alpine commands to install the language+runtime IN ORDER, e.g. ['apk add --no-cache dotnet8-sdk']. Prefer the official installer when the apk package is unreliable (e.g. dotnet-install.sh). [] if the base image already has it."),
  installCmd: z.string().describe("Restore the app's libraries: 'dotnet restore <Solution.sln>' / 'npm ci' / 'pip install -r requirements.txt' / 'bundle install' / 'composer install'. '' if none."),
  buildCmd: z.string().describe("Compile step BEFORE running (compiled stacks): 'dotnet build <sln> -c Release', 'npm run build'. '' if none."),
  startupProject: z.string().describe("For a multi-project solution, the WEB/entry project to run (references Microsoft.NET.Sdk.Web / ASP.NET Core). '' for single-project apps."),
  runCmd: z.string().describe("Command to START the app in the FOREGROUND on `port`, bound to 0.0.0.0."),
  port: z.number().describe("The app's REAL port from the codebase (launchSettings/appsettings/run scripts/framework default)."),
  services: z.array(z.object({
    name: z.string().describe("Short slug for this app, e.g. 'web', 'admin', 'api'."),
    runCmd: z.string().describe("Command to START this app in the FOREGROUND on ITS port, bound to 0.0.0.0."),
    buildCmd: z.string().optional().describe("Build step for THIS app if not covered by the shared buildCmd. '' when shared."),
    port: z.number().describe("This app's real port."),
    primary: z.boolean().optional().describe("true for the MAIN app (default preview URL, always runs). Exactly ONE primary."),
    enabled: z.boolean().optional().describe("Whether a companion runs. Leave unset — the user toggles companions on/off; the primary always runs."),
    dir: z.string().optional().describe("Subfolder (relative to the repo root) this app runs from, e.g. 'apps/admin'. Omit for repo-root apps."),
    manual: z.boolean().optional().describe("true when a user added this app by hand (not auto-detected)."),
  })).optional().describe("MULTIPLE separately-runnable web apps in ONE repo (monorepo — e.g. a public site + an admin portal on different ports, each with its own .csproj referencing Microsoft.NET.Sdk.Web / its own dev script). Populate ONLY when there are 2+ such apps; OMIT for a normal single-app repo. Skip class libraries. Mark the most public one primary; the top-level runCmd/port should equal the primary."),
  buildQuirks: z.array(z.string()).describe("Known build gotchas / required flags discovered from the code, e.g. 'needs DOTNET_SYSTEM_NET_DISABLEIPV6=1 or NuGet restore hangs', 'run `dotnet ef` with -v since it hides build errors'. [] if none."),
  // ── Databases ──
  databases: z.array(z.object({
    engine: z.enum(["postgres", "mysql", "redis", "mssql"]).describe("The app's REAL engine. mssql = Microsoft SQL Server (Docker). Do NOT downgrade SQL Server to postgres."),
    connectionEnvVar: z.string().describe("EXACT env var / .NET config key the app reads the connection from, e.g. 'ConnectionStrings__DefaultConnection', 'DATABASE_URL', 'REDIS_URL'. If the app reads the SAME connection under several keys, list the primary here and note the others in configQuirks."),
    connectionFormat: z.enum(CONN_FORMATS).describe("How to format the string: 'url' (Node/Python/Rails/Prisma), 'dotnet-npgsql', 'dotnet-mysql', 'dotnet-sqlserver', 'keyvalue'."),
  })).describe("Every database the app connects to AND how. Read appsettings*.json ConnectionStrings, docker-compose, ORM config, DATABASE_URL. [] if none."),
  // ── Schema build recipe (ORDERED — this is the part that keeps breaking) ──
  schemaSteps: z.array(z.object({
    kind: z.enum(["migration", "sqlScript", "seed"]).describe("migration = ORM migration command (EF/Prisma/Django); sqlScript = a raw .sql file the repo ships; seed = a seed/data-load command."),
    command: z.string().describe("For 'migration'/'seed': the exact command with NO connection string and NO database name embedded — e.g. 'dotnet ef database update --project Cohire.Core --startup-project Cohire.Web'. CRITICAL: do NOT prepend ConnectionStrings__*=... or put a Database=... anywhere. The sandbox writes the ONE correct connection (to the auto-provisioned DB) into .env and sources it before every command, so the migration MUST inherit that — if you hardcode a DB name (e.g. one you saw in appsettings), the migration builds a DIFFERENT database than the app and the SQL scripts use, and the app then 500s on missing tables/columns. For a multi-DbContext app, add one migration step per context with --context. For 'sqlScript': ONLY the file path RELATIVE to the repo (e.g. 'Sql Scripts/Create_Workspace_Tables.sql') — the system pipes it into the provisioned DB itself."),
    note: z.string().describe("Why this step / what it depends on, e.g. 'must run AFTER the EF migration creates the base tables'. Critical: order the whole array so dependencies come first (migrations before the scripts that ALTER their tables)."),
  })).describe("The COMPLETE ordered recipe to build the schema so the app doesn't 500 on missing columns. Migrations first, then dependent SQL scripts, then seeds. NONE of the commands may embed a connection string or database name — they all run against the single .env-provided connection. [] only if the app has no schema setup."),
  // ── Env / secrets ──
  autoEnvVars: z.array(z.object({
    key: z.string(),
    value: z.string().describe("A concrete value the SYSTEM can set (a default/derivable value), or '' to just note it's needed."),
    description: z.string(),
  })).describe("Non-secret config the system can provide itself (feature flags, URLs, ports, safe defaults). EXCLUDE DB connection vars (handled from `databases`)."),
  secretsRequired: z.array(z.object({
    key: z.string().describe("The exact env var / config key, e.g. 'SUPABASE_URL', 'Stripe__SecretKey', 'SMTP__Password'."),
    description: z.string().describe("What it's for."),
    whereToGet: z.string().describe("How the USER obtains it, e.g. 'Supabase dashboard → Project Settings → API'. The system CANNOT generate this."),
  })).describe("ONLY secrets WITHOUT which the app cannot START AT ALL — a real external credential the app reads FROM THE ENVIRONMENT with NO checked-in fallback, so startup crashes without it. CRITICAL: if appsettings/config already ships a value for the key (a checked-in value — even a placeholder/prod one), it is NOT required — the app runs with it, so DO NOT list it. Do NOT list DB connections (auto-provisioned), things with dev defaults, or keys only needed for a secondary feature (payments, captcha, email) that the app boots fine without. When unsure, DO NOT list it — this list is for genuine startup blockers only, and the vast majority of apps have NONE. Be extremely conservative."),
  // ── Config quirks (so the run agent doesn't corrupt files or fight the config) ──
  configQuirks: z.array(z.string()).describe("Concrete gotchas the run/preview agent must respect, e.g. 'appsettings.json is JSONC (has // comments) — do NOT parse/edit it as JSON; inject the connection via the ConnectionStrings__ env var which ASP.NET overrides with', 'appsettings has a hardcoded prod SQL Server host — override via env, do not point at it', 'the app also reads ConnectionStrings:Cohyreconnectionstring — set that key too'. [] if none."),
  // ── MANDATORY DIRECTIVES (must-do playbook for THIS project) ──
  // User-authored AND agent-appended rules that the run/preview agents MUST verify
  // and satisfy on every run (stronger than a learning, which is only advisory).
  // The probe leaves this empty; the user edits it in the Profile panel and the
  // agent appends to it (addDirective) when it solves a significant blocker.
  directives: z.array(z.string()).optional().describe("Leave EMPTY — user-authored + agent-appended must-do rules; not filled by the probe."),
  // ── Accumulated run learnings (self-healing memory) ──
  // Auto-appended from real runs when an agent discovers a correction the plan
  // fields can't capture (schema ordering, a missing client, a working install
  // method). The PROBE leaves this empty; it's populated by recordProfileLearning.
  learnings: z.array(z.string()).optional().describe("Leave EMPTY — this is auto-filled from real runs, not by the probe."),
  // ── Replayable config-file patches (survive branch switches + rebuilds) ──
  // Deployment edits to CONFIG files (not app source) that must be re-applied on
  // every checkout — e.g. repointing an appsettings.json connection from a dead
  // dev/prod host to the provisioned localhost DB. Auto-filled via persistConfigPatch.
  configPatches: z.array(z.object({
    file: z.string().describe("Path relative to the checkout, e.g. 'Cohire.Web/appsettings.json'."),
    find: z.string().describe("Exact literal text to replace."),
    replace: z.string().describe("Replacement text."),
    note: z.string().optional(),
  })).optional().describe("Leave EMPTY — auto-filled from runtime config fixes that must survive branch switches / rebuilds."),
});
export type AppProfile = z.infer<typeof appProfileSchema>;
export type RequiredSecret = AppProfile["secretsRequired"][number];

// ── Probe: deep, tool-using read of the repo ─────────────────────────────────
/** Bounded shell read against the workspace (used by the probe's tools). */
async function probeSh(workspaceId: string, script: string, timeout = 45_000): Promise<string> {
  const b64 = Buffer.from(script).toString("base64");
  const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | bash`, { timeout }).catch(
    (e: any) => ({ output: "", stderr: e?.message ?? String(e), exitCode: -1 }),
  );
  return ((r.output || "") + (r.stderr ? "\n" + r.stderr : "")).slice(0, 12_000);
}

const PROBE_SYSTEM = `You are a senior build engineer PROBING an existing repository so it can be run in a fresh sandbox for a live preview. Investigate the ACTUAL code with your tools, then record a COMPLETE, concrete run profile. Do not guess — read the files.

ENVIRONMENT: the sandbox is ALPINE LINUX (musl, apk, OpenRC, busybox). Every toolchain command must be Alpine-compatible (apk add --no-cache …, never apt/yum; rc-service, never systemctl). Docker is already installed and running (SQL Server / DBs run as Docker containers on 127.0.0.1).

YOUR JOB — investigate and determine:
- Exact stack, framework, and RUNTIME VERSION (read .csproj <TargetFramework>, global.json, package.json engines, lockfiles).
- The toolchain, install, build, startup project, run command, and REAL port.
- Every DATABASE and the EXACT config key the app reads its connection from (appsettings ConnectionStrings live in JSON, not .env). Note EVERY key the same connection is read under.
- The COMPLETE, ORDERED schema recipe: ORM migrations AND the raw .sql scripts the repo ships AND seeds — in DEPENDENCY ORDER (migrations before the scripts that ALTER their tables). This is the #1 cause of the app 500ing on "Invalid column" — find the real order (README, a run.sh, the numeric/prefix order of a "Sql Scripts" folder, EF migration history). CRITICAL: the schema commands must NOT contain any connection string or database name — the sandbox injects the ONE correct connection (to the auto-provisioned DB) via .env, sourced before every command. If a migration hardcodes a DB name it saw in appsettings, it builds a SEPARATE database from the one the app and the SQL scripts use → guaranteed "Invalid column/object" 500s. For an app with multiple DbContexts, emit one migration step per context (--context).
- USER-REQUIRED SECRETS: real external credentials the system CANNOT generate (Supabase, Stripe, OAuth secrets, SMTP, API keys) without which the app won't start or a core path fails. Be precise and conservative — only genuine blockers.
- CONFIG QUIRKS the run agent must respect so it doesn't corrupt config: is appsettings.json actually JSONC with // comments (so it must be edited via env override, never JSON-parsed)? Are there hardcoded prod DB hosts to override? Multiple connection keys?

INVESTIGATION TIPS: list the tree first; cat the solution/csproj/appsettings/docker-compose/package.json/README; grep for how the app reads config (GetEnvironmentVariable, IConfiguration[...], GetConnectionString, process.env); list the Sql Scripts folder to get the real ordering. Use ~10-25 tool calls, then call saveProfile ONCE with everything filled in.`;

/**
 * Run the probe agent against the cloned repo and return the structured profile.
 * Does NOT persist — the caller persists via saveAppProfile so it controls the
 * branch/version. Returns null if the agent never produced a profile.
 */
export async function probeAppProfile(opts: {
  workspaceId: string;
  userId: string;
  workDir?: string;
  onLog?: (line: string, detail?: string) => void;
  abortSignal?: AbortSignal;
}): Promise<AppProfile | null> {
  const { workspaceId, userId, workDir = PROJECT_DIR, onLog, abortSignal } = opts;
  const log = (l: string, d?: string) => { try { onLog?.(l, d); } catch { /* noop */ } };
  let profile: AppProfile | null = null;

  const tools = {
    listDir: tool({
      description: "List a directory (relative to the repo root). Use to discover the tree, the Sql Scripts folder ordering, migration dirs.",
      inputSchema: zodSchema(z.object({ path: z.string().describe("Path relative to the repo root, e.g. '.', 'Sql Scripts', 'Cohire.Core/Migrations'.") })),
      execute: async ({ path }: { path: string }) => {
        const safe = path.replace(/'/g, "");
        return probeSh(workspaceId, `cd ${workDir} 2>/dev/null && ls -la './${safe}' 2>&1 | head -80`);
      },
    }),
    readFile: tool({
      description: "Read a file from the repo (first ~10KB). Use for .sln/.csproj/appsettings*.json/package.json/docker-compose/README/.env.example/launchSettings/run scripts.",
      inputSchema: zodSchema(z.object({ path: z.string().describe("Path relative to the repo root.") })),
      execute: async ({ path }: { path: string }) => {
        const safe = path.replace(/'/g, "");
        return probeSh(workspaceId, `cd ${workDir} 2>/dev/null && (head -c 10000 './${safe}' 2>&1 || echo '[not found]')`);
      },
    }),
    grep: tool({
      description: "Search the repo for a pattern (how the app reads config/connections/env). Returns matching lines with file:line.",
      inputSchema: zodSchema(z.object({
        pattern: z.string().describe("Extended-regex pattern, e.g. 'GetConnectionString|GetEnvironmentVariable|IConfiguration\\['."),
        glob: z.string().optional().describe("Optional filename filter, e.g. '*.cs', '*.json'."),
      })),
      execute: async ({ pattern, glob }: { pattern: string; glob?: string }) => {
        const p = pattern.replace(/'/g, "'\\''");
        const inc = glob ? `--include='${glob.replace(/'/g, "")}'` : "";
        return probeSh(workspaceId, `cd ${workDir} 2>/dev/null && grep -rInE ${inc} --exclude-dir=node_modules --exclude-dir=.git '${p}' . 2>/dev/null | head -60`);
      },
    }),
    saveProfile: tool({
      description: "Record the COMPLETE run profile. Call this exactly ONCE at the end, with every field filled in from what you actually read.",
      inputSchema: zodSchema(appProfileSchema),
      execute: async (p: AppProfile) => {
        profile = p;
        log(`Probe complete: ${p.stack}`, `DBs: ${p.databases.map((d) => d.engine).join(", ") || "none"} · schema steps: ${p.schemaSteps.length} · secrets needed: ${p.secretsRequired.length}`);
        return "profile saved";
      },
    }),
  };

  log("Probing the codebase (deep read → run profile)…");
  const { model } = await resolveUserModel(userId);
  try {
    await generateText({
      model,
      tools,
      stopWhen: stepCountIs(40),
      system: PROBE_SYSTEM,
      prompt: `Probe the repository at ${workDir} and record its run profile. Investigate with the tools, then call saveProfile once. Begin.`,
      abortSignal,
    });
  } catch (e) {
    log(`Probe agent error: ${(e as Error).message}`);
  }
  return profile;
}

// ── Persistence ──────────────────────────────────────────────────────────────
export async function loadAppProfile(projectId: string, branch = "default"): Promise<{ profile: AppProfile; version: number } | null> {
  const [row] = await db.select().from(appProfiles)
    .where(and(eq(appProfiles.projectId, projectId), eq(appProfiles.branch, branch)));
  if (!row) return null;
  try {
    const parsed = appProfileSchema.safeParse(JSON.parse(row.profile));
    if (!parsed.success) return null;
    return { profile: parsed.data, version: row.version };
  } catch { return null; }
}

export async function saveAppProfile(projectId: string, profile: AppProfile, branch = "default"): Promise<void> {
  const existing = await db.select({ version: appProfiles.version }).from(appProfiles)
    .where(and(eq(appProfiles.projectId, projectId), eq(appProfiles.branch, branch)));
  const nextVersion = (existing[0]?.version ?? 0) + 1;
  await db.insert(appProfiles)
    .values({ projectId, branch, version: nextVersion, profile: JSON.stringify(profile), probedAt: new Date() })
    .onConflictDoUpdate({
      target: [appProfiles.projectId, appProfiles.branch],
      set: { profile: JSON.stringify(profile), version: nextVersion, probedAt: new Date(), updatedAt: new Date() },
    });
}

// ── Derive the runbook manifest from the profile ─────────────────────────────
/**
 * Strip a hardcoded connection/DB from the FRONT of a schema command (e.g. a
 * probe that prepended `ConnectionStrings__X='...Database=foo...' dotnet ef …`).
 * Such a command builds a DIFFERENT database than the app + SQL scripts use (they
 * take the .env connection), which guarantees "Invalid column/object" 500s. We
 * remove only connection-ish leading assignments so the migration inherits .env.
 */
function stripInlineConnEnv(cmd: string): string {
  let c = (cmd || "").trim();
  const re = /^([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|\S+)\s+/;
  while (true) {
    const m = c.match(re);
    if (!m) break;
    const key = m[1]!, val = m[2]!;
    const isConn = /connection|database_url/i.test(key) || /Database=|Server=|Data Source=|Host=[^;]*Password=/i.test(val);
    if (!isConn) break;
    c = c.slice(m[0].length);
  }
  return c.trim();
}

/** Map the rich profile onto the PreviewManifest the existing runbook consumes. */
export function deriveManifestFromProfile(profile: AppProfile): PreviewManifest {
  const migrations = profile.schemaSteps.filter((s) => s.kind === "migration").map((s) => stripInlineConnEnv(s.command));
  const sqlScripts = profile.schemaSteps.filter((s) => s.kind === "sqlScript").map((s) => s.command);
  const seedCmd = stripInlineConnEnv(profile.schemaSteps.find((s) => s.kind === "seed")?.command || "");
  // Surface required secrets AND auto vars as manifest envVars (the .env writer
  // + the driver prompt read these). Secrets are marked required.
  const envVars = [
    ...profile.secretsRequired.map((s) => ({ key: s.key, required: true, description: `${s.description} (${s.whereToGet})` })),
    ...profile.autoEnvVars.map((v) => ({ key: v.key, required: false, description: v.description })),
  ];
  return {
    stack: profile.stack,
    runtime: profile.runtime,
    framework: profile.framework,
    toolchain: profile.toolchain,
    installCmd: profile.installCmd,
    buildCmd: profile.buildCmd,
    startupProject: profile.startupProject,
    runCmd: profile.runCmd,
    port: profile.port,
    // Multi-app: carry services[] only when it names 2+ apps; companions default off.
    services: (profile.services && profile.services.length >= 2)
      ? profile.services.map((s, i) => ({ ...s, primary: !!s.primary || (i === 0 && !profile.services!.some((x) => x.primary)), enabled: s.enabled ?? !!s.primary }))
      : undefined,
    databases: profile.databases,
    migrations,
    sqlScripts,
    seedCmd,
    envVars,
  };
}

// ── Secret gate ──────────────────────────────────────────────────────────────
/**
 * Which required secrets are NOT yet provided for this project. A secret counts
 * as provided if a project env var with the same key exists and has a value.
 */
// Self-contained secrets we can safely AUTO-GENERATE (the app just needs a random
// value — a session/JWT/CSRF signing key). Never matches an external-service key.
const SAFE_SECRET_RE = /(SESSION|JWT|SECRET_KEY|APP_KEY|APP_SECRET|ENCRYPTION|COOKIE|CSRF|NEXTAUTH_SECRET|AUTH_SECRET|TOKEN_SECRET|SIGNING)/i;
// Credentials issued by an external service — we can NEVER invent these; the user
// must paste them. Takes precedence over SAFE_SECRET_RE.
const EXTERNAL_KEY_RE = /(SENDGRID|STRIPE|OPENAI|ANTHROPIC|TWILIO|MAILGUN|POSTMARK|RESEND|SMTP|AWS|S3|GITHUB|GOOGLE|OAUTH|CLIENT_SECRET|CLIENT_ID|ACCESS_KEY|SECRET_ACCESS|API_KEY|APIKEY|WEBHOOK|DSN|CLOUDINARY|SUPABASE|FIREBASE)/i;

/**
 * Persist the env the detected app needs into the project's Environment tab, so the
 * user can see + fill what's required and it gets applied on setup/restart. For each
 * detected key WITHOUT a user-set value:
 *  - self-contained secrets (session/JWT/…) → auto-generate a random value;
 *  - external-service keys (SendGrid/Stripe/…) → create an empty "needed" placeholder.
 * Never clobbers a value the user already set. Returns what was generated vs. still
 * needs input, so the caller can post a notice.
 */
export async function syncDetectedEnv(
  projectId: string,
  createdById: string | null,
  needed: { key: string; required?: boolean; description?: string }[],
): Promise<{ generated: string[]; needsInput: { key: string; description: string }[] }> {
  const generated: string[] = [];
  const needsInput: { key: string; description: string }[] = [];
  if (!needed.length) return { generated, needsInput };

  const existing = await db
    .select({ key: projectEnvironmentVariables.key, hasValue: projectEnvironmentVariables.hasValue })
    .from(projectEnvironmentVariables)
    .where(eq(projectEnvironmentVariables.projectId, projectId));
  const existingMap = new Map(existing.map((e) => [e.key, e.hasValue]));

  const seen = new Set<string>();
  for (const v of needed) {
    const key = (v.key || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (existingMap.get(key) === true) continue; // user already provided a value — leave it

    const desc = v.description ?? "";
    const isExternal = EXTERNAL_KEY_RE.test(key);
    if (!isExternal && SAFE_SECRET_RE.test(key)) {
      // Auto-generate a strong random value and store it.
      const value = randomBytes(48).toString("base64url");
      await db
        .insert(projectEnvironmentVariables)
        .values({ projectId, key, encryptedValue: encryptSecret(value), isSecret: true, isRequired: !!v.required, hasValue: true, description: desc || "auto-generated secret", createdById })
        .onConflictDoUpdate({
          target: [projectEnvironmentVariables.projectId, projectEnvironmentVariables.key],
          set: { encryptedValue: encryptSecret(value), hasValue: true, isSecret: true, updatedAt: new Date() },
        });
      generated.push(key);
    } else {
      // External / unknown → empty placeholder the user fills in (don't overwrite an
      // existing empty row, just ensure it exists so the Environment tab lists it).
      await db
        .insert(projectEnvironmentVariables)
        .values({ projectId, key, encryptedValue: "", isSecret: true, isRequired: !!v.required, hasValue: false, description: desc, createdById })
        .onConflictDoNothing({ target: [projectEnvironmentVariables.projectId, projectEnvironmentVariables.key] });
      needsInput.push({ key, description: desc });
    }
  }
  return { generated, needsInput };
}

export async function missingSecrets(projectId: string, profile: AppProfile): Promise<RequiredSecret[]> {
  if (!profile.secretsRequired.length) return [];
  const rows = await db.select({ key: projectEnvironmentVariables.key, hasValue: projectEnvironmentVariables.hasValue })
    .from(projectEnvironmentVariables).where(eq(projectEnvironmentVariables.projectId, projectId));
  const provided = new Set(rows.filter((r) => r.hasValue).map((r) => r.key.toLowerCase()));
  return profile.secretsRequired.filter((s) => !provided.has(s.key.toLowerCase()));
}

// ── Self-healing: write corrections back into the profile ────────────────────
/** All the notes an agent should respect this run: probe-found quirks + build
 *  quirks + everything learned from prior runs. Injected into every driver prompt. */
export function profileNotes(profile: AppProfile): string[] {
  return [...profile.configQuirks, ...profile.buildQuirks, ...(profile.learnings ?? [])];
}

const PLAN_FIELDS = new Set(["toolchain", "installCmd", "buildCmd", "runCmd", "port", "startupProject"]);

/**
 * Persist a plan-FIELD correction the run agent discovered (toolchain/install/
 * build/run/port/startupProject) back into the PROFILE — not just the derived
 * manifest — so the next run's derive keeps it instead of clobbering it. Also
 * records a learning line. Returns false if there's no profile to correct.
 */
export async function applyProfileCorrection(projectId: string, field: string, value: string, note?: string, branch = "default"): Promise<boolean> {
  if (!PLAN_FIELDS.has(field)) return false;
  const loaded = await loadAppProfile(projectId, branch);
  if (!loaded) return false;
  const p = loaded.profile;
  if (field === "toolchain") p.toolchain = value.split("\n").map((s) => s.trim()).filter(Boolean);
  else if (field === "port") { const n = parseInt(value, 10); if (n > 0) p.port = n; }
  else (p as any)[field] = value;
  const shown = field === "toolchain" ? p.toolchain.join("; ") : value;
  p.learnings = [...(p.learnings ?? []), `learned: ${field} → ${shown}${note ? ` (${note})` : ""}`].slice(-40);
  await saveAppProfile(projectId, p, branch);
  return true;
}

/** Append a MANDATORY directive (a must-do rule the agent solved for or the user
 *  authored) to the profile, so every future run/preview agent must verify it. */
export async function recordDirective(projectId: string, note: string, branch = "default"): Promise<boolean> {
  const trimmed = (note || "").trim();
  if (!trimmed) return false;
  const loaded = await loadAppProfile(projectId, branch);
  if (!loaded) return false;
  const p = loaded.profile;
  if ((p.directives ?? []).some((d) => d.trim() === trimmed)) return true; // de-dupe
  p.directives = [...(p.directives ?? []), trimmed].slice(-40);
  await saveAppProfile(projectId, p, branch);
  return true;
}

/** Append a free-form learning (schema ordering, a missing client, etc.) to the
 *  profile so future runs + branches see it in CONFIG QUIRKS. */
export async function recordProfileLearning(projectId: string, note: string, branch = "default"): Promise<boolean> {
  const trimmed = (note || "").trim();
  if (!trimmed) return false;
  const loaded = await loadAppProfile(projectId, branch);
  if (!loaded) return false;
  const p = loaded.profile;
  // de-dupe: don't append a note we already have
  if ((p.learnings ?? []).some((l) => l === `learned: ${trimmed}` || l === trimmed)) return true;
  p.learnings = [...(p.learnings ?? []), `learned: ${trimmed}`].slice(-40);
  await saveAppProfile(projectId, p, branch);
  return true;
}

// ── Replayable config patches (survive branch switches / rebuilds) ───────────
export type ConfigPatch = { file: string; find: string; replace: string; note?: string };

/** Persist a config-file patch onto the profile (de-duped by file+find), so it's
 *  re-applied after every checkout. */
export async function recordConfigPatch(projectId: string, patch: ConfigPatch, branch = "default"): Promise<boolean> {
  const loaded = await loadAppProfile(projectId, branch);
  if (!loaded) return false;
  const p = loaded.profile;
  const patches = (p.configPatches ?? []).slice();
  const i = patches.findIndex((x) => x.file === patch.file && x.find === patch.find);
  if (i >= 0) patches[i] = patch; else patches.push(patch);
  p.configPatches = patches.slice(-30);
  await saveAppProfile(projectId, p, branch);
  return true;
}

/**
 * Build a shell script that re-applies the given config patches to `dir` — a
 * literal (non-regex) find/replace on each file, in one python3 pass (BOM/encoding
 * safe). "" if no patches. Idempotent (skips if the replacement is already there).
 * Degrades to a no-op if python3 is absent (the driver then re-patches, as before).
 */
export function buildConfigPatchScript(patches: ConfigPatch[] | undefined, dir: string): string {
  if (!patches || !patches.length) return "";
  const blob = Buffer.from(JSON.stringify(patches.map((p) => ({ file: p.file, find: p.find, replace: p.replace })))).toString("base64");
  return `echo ${blob} | base64 -d > /tmp/_cfgpatch.json 2>/dev/null && python3 - "${dir}" <<'PYEOF' 2>/dev/null || true
import json, os, sys
base = sys.argv[1]
try:
    patches = json.load(open("/tmp/_cfgpatch.json"))
except Exception:
    patches = []
for p in patches:
    fp = os.path.join(base, p["file"])
    if not os.path.isfile(fp):
        continue
    try:
        s = open(fp, encoding="utf-8", errors="ignore").read()
    except Exception:
        continue
    if p["find"] in s and p["replace"] not in s:
        open(fp, "w", encoding="utf-8").write(s.replace(p["find"], p["replace"]))
        print("re-applied config patch:", p["file"])
PYEOF`;
}

/** A NON-blocking, informational note: the app runs with its checked-in config;
 *  these are external credentials the user MAY add for full functionality. */
export function secretsNoticeMessage(missing: RequiredSecret[]): string {
  const lines = missing.map((s) => `• **${s.key}** — ${s.description}\n   ↳ _where to get it: ${s.whereToGet}_`);
  return `ℹ️ **Optional: external credentials for full functionality.**\n\nThe preview will keep starting with the app's checked-in/default config — you don't need to do anything to see it run. To enable these features for real, add the keys below in **Environment Variables** and press **Restart**:\n\n${lines.join("\n")}\n\n_(Databases are provisioned automatically; only real third-party credentials like these have to come from you — and only if you want those specific features working.)_`;
}
