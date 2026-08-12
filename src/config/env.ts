import { z } from "zod";

const envSchema = z.object({
  // Database driver: "sqlite" for local dev/testing, "postgresql" for production
  DATABASE_DRIVER: z
    .enum(["sqlite", "postgresql"])
    .optional()
    .default("sqlite"),

  // SQLite path (used when DATABASE_DRIVER=sqlite)
  DATABASE_URL: z.string().optional().default("./data/lfg.db"),

  // PostgreSQL connection (used when DATABASE_DRIVER=postgresql)
  // DATABASE_URL takes precedence if set; otherwise built from individual vars.
  POSTGRES_HOST: z.string().optional().default("localhost"),
  POSTGRES_PORT: z.string().optional().default("5432"),
  POSTGRES_DB: z.string().optional().default("lfg_node"),
  POSTGRES_USER: z.string().optional().default("postgres"),
  POSTGRES_PASSWORD: z.string().optional().default(""),

  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().url(),

  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GITHUB_CLIENT_ID: z.string().optional().default(""),
  GITHUB_CLIENT_SECRET: z.string().optional().default(""),
  GITLAB_CLIENT_ID: z.string().optional().default(""),
  GITLAB_CLIENT_SECRET: z.string().optional().default(""),
  // GitLab base URL — gitlab.com by default, override for self-hosted GitLab.
  GITLAB_BASE_URL: z.string().optional().default("https://gitlab.com"),

  ANTHROPIC_API_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),
  GOOGLE_AI_API_KEY: z.string().optional().default(""),
  DEEPSEEK_API_KEY: z.string().optional().default(""),
  EXA_API_KEY: z.string().optional().default(""),

  // Public base URL used to build links in emails (falls back to BETTER_AUTH_URL)
  APP_URL: z.string().optional().default(""),

  SENDGRID_API_KEY: z.string().optional().default(""),
  EMAIL_FROM: z.string().optional().default("noreply@lfg.run"),

  ENCRYPTION_KEY: z.string().optional().default(""),

  // S3 / file storage
  FILE_STORAGE_TYPE: z.enum(["local", "s3"]).optional().default("local"),
  AWS_S3_BUCKET_NAME: z.string().optional().default(""),
  AWS_ACCESS_KEY_ID: z.string().optional().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(""),
  AWS_S3_REGION: z.string().optional().default("us-east-1"),

  // PostgreSQL provisioning (optional: a separate server used to spin up
  // per-user Postgres DBs). Leave HOST empty to disable this feature.
  POSTGRES_PROVISIONING_HOST: z.string().optional().default(""),
  POSTGRES_PROVISIONING_PORT: z.string().optional().default("5432").transform((v) => parseInt(v, 10)),
  POSTGRES_PROVISIONING_USER: z.string().optional().default("postgres"),
  POSTGRES_PROVISIONING_PASSWORD: z.string().optional().default(""),

  // ── Sandbox / code-execution backend ────────────────────────────────
  // Where Instant-app builds and ticket execution run their coding agents.
  //   "mags"   → Magpie Cloud Firecracker micro-VMs (hosted; needs MAGS_API_TOKEN)
  //   "docker" → local Docker containers (self-hosted; needs Docker installed)
  SANDBOX_BACKEND: z.enum(["mags", "docker"]).optional().default("mags"),
  // Prebuilt sandbox image (node + python + claude-code + pi). Build & push it
  // once from Dockerfile.sandbox (see scripts/build-sandbox-image.sh), then set
  // this to your tag, e.g. "youruser/lfg-sandbox:latest". Required for docker backend.
  SANDBOX_IMAGE: z.string().optional().default("lfg-sandbox:latest"),
  // Docker network mode for sandboxes.
  //   "bridge" (default) → each container is isolated; its internal app port is
  //     published to a UNIQUE auto-assigned host port (no cross-app collisions,
  //     works on macOS + Linux). Recommended.
  //   "host" → container shares the host network and binds the app port directly
  //     (Linux only; apps must use distinct ports, and 8080 must be free).
  SANDBOX_DOCKER_NETWORK: z.string().optional().default("bridge"),
  // The port an app listens on INSIDE its container (the Instant scaffold uses
  // 8080). In bridge mode this is published to a random free host port.
  SANDBOX_APP_PORT: z.string().optional().default("8080").transform((v) => parseInt(v, 10)),
  // Base URL the LFG host uses to reach a running app's (mapped) port.
  SANDBOX_PREVIEW_HOST: z.string().optional().default("http://localhost"),
  // Headless-Chromium image used for QA/browser sessions on the docker backend.
  SANDBOX_BROWSER_IMAGE: z.string().optional().default("zenika/alpine-chrome:latest"),

  // Local filesystem storage dir (used when FILE_STORAGE_TYPE=local for binary
  // uploads). Must be writable by the process. Text content still lives in the DB.
  LOCAL_STORAGE_DIR: z.string().optional().default("./data/uploads"),

  // Composio (integration platform — composio.dev)
  COMPOSIO_API_KEY: z.string().optional().default(""),

  // Cloudflare Turnstile
  TURNSTILE_SITE_KEY: z.string().optional().default(""),
  TURNSTILE_SECRET_KEY: z.string().optional().default(""),

  // Public Telegram bot (channel-agnostic instant app builder)
  TELEGRAM_PUBLIC_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_PUBLIC_BOT_OWNER_ID: z.string().optional().default(""),

  PORT: z
    .string()
    .optional()
    .default("3000")
    .transform((v) => parseInt(v, 10)),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .optional()
    .default("development"),
});

type RawEnv = z.infer<typeof envSchema>;

// Derived type with the resolved postgres connection URL added
export type Env = RawEnv & { POSTGRES_URL: string };

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:", result.error.format());
    process.exit(1);
  }

  const raw = result.data;

  // Build a postgres connection URL from individual vars if DATABASE_URL hasn't
  // been overridden to a postgres:// string already.
  const isExplicitPgUrl =
    raw.DATABASE_DRIVER === "postgresql" &&
    raw.DATABASE_URL.startsWith("postgres");

  const POSTGRES_URL = isExplicitPgUrl
    ? raw.DATABASE_URL
    : `postgresql://${raw.POSTGRES_USER}:${encodeURIComponent(raw.POSTGRES_PASSWORD)}@${raw.POSTGRES_HOST}:${raw.POSTGRES_PORT}/${raw.POSTGRES_DB}`;

  return { ...raw, POSTGRES_URL };
}

export const env = loadEnv();
