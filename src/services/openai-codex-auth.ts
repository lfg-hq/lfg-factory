/**
 * Per-user ChatGPT/OpenAI Codex authentication for Pi sandbox builds.
 *
 * The refresh credential is encrypted in the profile table and is materialized
 * only inside a dedicated auth workspace. Ticket workspaces receive a short-lived
 * bearer token, never the reusable refresh credential.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { profiles } from "../db/schema/users.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { decryptSecret, encryptSecret } from "../utils/crypto.ts";
import { execOnWorkspace, newWorkspace, stopWorkspace, syncWorkspaceClock } from "./mags.ts";

const WORKSPACE_TYPE = "openai_codex_auth";
const AUTH_DIR = "/root/.pi/agent";
const AUTH_FILE = `${AUTH_DIR}/auth.json`;
const AUTH_LOG = "/data/openai_codex_auth.log";
const PI_PACKAGE = process.env.PI_CODING_AGENT_PACKAGE || "@earendil-works/pi-coding-agent";

export interface OpenAICodexCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface OpenAICodexStartResult {
  status: "pending" | "already_authenticated" | "error";
  verificationUri?: string;
  userCode?: string;
  error?: string;
}

function isCredential(value: unknown): value is OpenAICodexCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Record<string, unknown>;
  return credential.type === "oauth" &&
    typeof credential.access === "string" && credential.access.length > 0 &&
    typeof credential.refresh === "string" && credential.refresh.length > 0 &&
    typeof credential.expires === "number";
}

async function getAuthSandbox(userId: string) {
  const [row] = await db.select().from(sandboxes)
    .where(and(eq(sandboxes.userId, userId), eq(sandboxes.workspaceType, WORKSPACE_TYPE)))
    .orderBy(sandboxes.updatedAt)
    .limit(1);
  return row ?? null;
}

async function getStoredCredential(userId: string): Promise<OpenAICodexCredential | null> {
  const [profile] = await db.select({ credentials: profiles.openaiCodexCredentials })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  if (!profile?.credentials) return null;
  try {
    const parsed: unknown = JSON.parse(decryptSecret(profile.credentials));
    return isCredential(parsed) ? parsed : null;
  } catch (error) {
    console.error("[openai-codex-auth] could not decrypt stored credential", error);
    return null;
  }
}

async function persistCredential(userId: string, credential: OpenAICodexCredential): Promise<void> {
  const now = new Date();
  const encrypted = encryptSecret(JSON.stringify(credential));
  await db.insert(profiles)
    .values({
      userId,
      openaiCodexAuthenticated: true,
      openaiCodexCredentials: encrypted,
      openaiCodexCredentialsUpdatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: {
        openaiCodexAuthenticated: true,
        openaiCodexCredentials: encrypted,
        openaiCodexCredentialsUpdatedAt: now,
        updatedAt: now,
      },
    });
}

async function readWorkspaceCredential(workspaceId: string): Promise<OpenAICodexCredential | null> {
  const script = `node -e 'const fs=require("fs");try{const a=JSON.parse(fs.readFileSync("${AUTH_FILE}","utf8"));const c=a["openai-codex"];if(c)process.stdout.write(Buffer.from(JSON.stringify(c)).toString("base64"))}catch{}'`;
  const result = await execOnWorkspace(workspaceId, script, { timeout: 15_000 });
  const encoded = result.output.trim().split(/\s+/).pop();
  if (!encoded) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return isCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function installCurrentPi(workspaceId: string): Promise<void> {
  // A VM whose clock is behind sees the npm registry's TLS cert as "not yet valid" and
  // the install dies with CERT_NOT_YET_VALID — nothing to do with the user's account.
  await syncWorkspaceClock(workspaceId);
  const packageName = JSON.stringify(PI_PACKAGE);
  const script = `export HOME=/root
for rc in /etc/profile ~/.profile ~/.bashrc; do [ -f "$rc" ] && . "$rc" >/dev/null 2>&1 || true; done
export npm_config_prefix=/data/.npm-global
export npm_config_cache=/data/.npm-cache
export PATH=/data/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
mkdir -p /data/.npm-global /data/.npm-cache ${AUTH_DIR}
if ! command -v npm >/dev/null 2>&1; then echo NO_NPM; exit 1; fi
npm i -g ${packageName} >/data/openai_codex_pi_install.log 2>&1
pi --version
PI_AI_CLI=$(find /data/.npm-global/lib/node_modules -path '*/pi-ai/dist/cli.js' -type f 2>/dev/null | head -1)
[ -n "$PI_AI_CLI" ] || { echo NO_PI_AI; tail -30 /data/openai_codex_pi_install.log; exit 1; }
echo "PI_AI_CLI=$PI_AI_CLI"`;
  const result = await execOnWorkspace(workspaceId, script, { timeout: 180_000 });
  if (result.exitCode !== 0 || !result.output.includes("PI_AI_CLI=")) {
    const raw = (result.output || result.stderr);
    const hint = /CERT_NOT_YET_VALID|certificate is not yet valid|CERT_HAS_EXPIRED/i.test(raw)
      ? "The sandbox VM's clock is wrong, so it rejects valid TLS certificates. We tried to correct it and it didn't take — retry in a moment; if it persists the VM needs recycling. "
      : "";
    throw new Error(`Could not install the current Pi authentication runtime: ${hint}${raw.slice(-600)}`);
  }
}

async function createAuthWorkspace(userId: string): Promise<string> {
  const existing = await getAuthSandbox(userId);
  if (existing?.magsWorkspaceId) {
    await stopWorkspace(existing.magsWorkspaceId).catch(() => {});
    await db.delete(sandboxes).where(eq(sandboxes.id, existing.id));
  }

  const workspaceName = `openai-auth-${crypto.randomUUID().slice(0, 12)}`;
  const { jobId, workspaceId } = await newWorkspace(workspaceName, {
    rootfsType: "pi",
    noSync: true,
    idleMinutes: 60,
    diskGb: 3,
    memGb: 2,
  });
  await db.insert(sandboxes).values({
    userId,
    workspaceType: WORKSPACE_TYPE,
    magsWorkspaceId: workspaceId,
    magsJobId: jobId,
    status: "ready",
  });
  return workspaceId;
}

export async function hasOpenAICodexCredentials(userId: string): Promise<boolean> {
  const [profile] = await db.select({
    authenticated: profiles.openaiCodexAuthenticated,
    credentials: profiles.openaiCodexCredentials,
  }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
  return !!profile?.authenticated && !!profile.credentials;
}

export async function startOpenAICodexAuth(userId: string): Promise<OpenAICodexStartResult> {
  try {
    if (await hasOpenAICodexCredentials(userId)) {
      return { status: "already_authenticated" };
    }

    const workspaceId = await createAuthWorkspace(userId);
    await installCurrentPi(workspaceId);

    const loginScript = `#!/bin/bash
export HOME=/root
export PATH=/data/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
cd ${AUTH_DIR}
rm -f auth.json
PI_AI_CLI=$(find /data/.npm-global/lib/node_modules -path '*/pi-ai/dist/cli.js' -type f 2>/dev/null | head -1)
[ -n "$PI_AI_CLI" ] || exit 1
printf '2\\n' | node "$PI_AI_CLI" login openai-codex > ${AUTH_LOG} 2>&1
`;
    const loginB64 = Buffer.from(loginScript).toString("base64");
    await execOnWorkspace(
      workspaceId,
      `echo '${loginB64}' | base64 -d > /data/openai_codex_login.sh; chmod 700 /data/openai_codex_login.sh; setsid /data/openai_codex_login.sh >/dev/null 2>&1 < /dev/null & echo STARTED`,
      { timeout: 15_000 },
    );

    // The device URL/code appears quickly, but give a cold VM a little room.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const log = await execOnWorkspace(workspaceId, `cat ${AUTH_LOG} 2>/dev/null || true`, { timeout: 8_000 })
        .then((result) => result.output)
        .catch(() => "");
      const verificationUri = log.match(/https:\/\/auth\.openai\.com\/codex\/device\S*/i)?.[0];
      const userCode = log.match(/Enter code:\s*([A-Z0-9-]+)/i)?.[1];
      if (verificationUri && userCode) return { status: "pending", verificationUri, userCode };
      if (/error|failed|invalid selection/i.test(log)) {
        return { status: "error", error: log.trim().slice(-500) || "OpenAI sign-in failed" };
      }
    }
    return { status: "error", error: "Timed out waiting for the OpenAI device sign-in code" };
  } catch (error) {
    console.error("[openai-codex-auth/start]", error);
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function pollOpenAICodexAuth(userId: string): Promise<{ authenticated: boolean; pending: boolean; error?: string }> {
  if (await hasOpenAICodexCredentials(userId)) return { authenticated: true, pending: false };
  const sandbox = await getAuthSandbox(userId);
  if (!sandbox?.magsWorkspaceId) return { authenticated: false, pending: false };

  const credential = await readWorkspaceCredential(sandbox.magsWorkspaceId).catch(() => null);
  if (credential) {
    await persistCredential(userId, credential);
    await execOnWorkspace(sandbox.magsWorkspaceId, `rm -f ${AUTH_LOG} /data/openai_codex_login.sh`, { timeout: 8_000 }).catch(() => {});
    return { authenticated: true, pending: false };
  }

  const state = await execOnWorkspace(
    sandbox.magsWorkspaceId,
    `if pgrep -f '[p]i-ai.*login openai-codex' >/dev/null; then echo PENDING; else tail -20 ${AUTH_LOG} 2>/dev/null || echo STOPPED; fi`,
    { timeout: 10_000 },
  ).then((result) => result.output).catch(() => "");
  if (state.includes("PENDING")) return { authenticated: false, pending: true };
  return { authenticated: false, pending: false, error: state.trim().slice(-500) || "OpenAI sign-in stopped before completion" };
}

const tokenLocks = new Map<string, Promise<void>>();

async function withUserTokenLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tokenLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  tokenLocks.set(userId, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tokenLocks.get(userId) === queued) tokenLocks.delete(userId);
  }
}

export async function getOpenAICodexAccessToken(userId: string): Promise<string> {
  return withUserTokenLock(userId, async () => {
    const stored = await getStoredCredential(userId);
    if (!stored) throw new Error("OpenAI Codex is not connected for this user");
    // Most builds need no auth workspace at all: return the still-valid encrypted-at-rest
    // access token directly. The workspace is only a refresh broker near expiration.
    if (stored.expires > Date.now() + 5 * 60_000) return stored.access;

    let sandbox = await getAuthSandbox(userId);
    let workspaceId = sandbox?.magsWorkspaceId ?? null;
    if (workspaceId) {
      const alive = await execOnWorkspace(workspaceId, "echo READY", { timeout: 8_000 })
        .then((result) => result.output.includes("READY"))
        .catch(() => false);
      if (!alive) workspaceId = null;
    }
    // Same reason as the install: a skewed clock breaks the HTTPS token refresh too.
    if (workspaceId) await syncWorkspaceClock(workspaceId);
    if (!workspaceId) {
      workspaceId = await createAuthWorkspace(userId);
      await installCurrentPi(workspaceId);
      sandbox = await getAuthSandbox(userId);
    }

    const auth = Buffer.from(JSON.stringify({ "openai-codex": stored })).toString("base64");
    // Cross-process lock: multiple app instances may refresh the same user's rotated
    // token concurrently. Once inside the lock, keep an already-present credential
    // because another process may have refreshed it while this request was waiting.
    const result = await execOnWorkspace(
      workspaceId,
      `export HOME=/root
export PATH=/data/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
find /data/.openai_codex_refresh_lock -maxdepth 0 -mmin +2 -exec rmdir {} \\; 2>/dev/null || true
LOCK_OWNED=0
for i in $(seq 1 120); do
  if mkdir /data/.openai_codex_refresh_lock 2>/dev/null; then LOCK_OWNED=1; break; fi
  sleep .5
done
[ "$LOCK_OWNED" = "1" ] || { echo LOCK_TIMEOUT; exit 1; }
trap 'rmdir /data/.openai_codex_refresh_lock 2>/dev/null' EXIT
mkdir -p ${AUTH_DIR}
if ! node -e 'const fs=require("fs");try{const a=JSON.parse(fs.readFileSync("${AUTH_FILE}","utf8"));process.exit(a["openai-codex"]?.refresh?0:1)}catch{process.exit(1)}'; then
  echo '${auth}' | base64 -d > ${AUTH_FILE}
  chmod 700 ${AUTH_DIR}; chmod 600 ${AUTH_FILE}
fi
pi auth print-bearer-token --provider openai-codex --min-expiry 5m`,
      { timeout: 90_000 },
    );
    const token = result.output.split(/\s+/).find((line) => line.length > 80 && line.split(".").length >= 3);
    if (result.exitCode !== 0 || !token) {
      // Do not attach command output: a partially successful credential-print command
      // may have emitted a bearer token even if its exit status/output shape is odd.
      throw new Error("OpenAI Codex session could not be refreshed. Reconnect it in Settings.");
    }

    // Pi may rotate the refresh token. Persist the updated entry before returning.
    const refreshed = await readWorkspaceCredential(workspaceId);
    if (refreshed) await persistCredential(userId, refreshed);
    return token;
  });
}

export async function disconnectOpenAICodex(userId: string): Promise<void> {
  const sandbox = await getAuthSandbox(userId);
  if (sandbox?.magsWorkspaceId) await stopWorkspace(sandbox.magsWorkspaceId).catch(() => {});
  await db.delete(sandboxes)
    .where(and(eq(sandboxes.userId, userId), eq(sandboxes.workspaceType, WORKSPACE_TYPE)));
  await db.update(profiles).set({
    openaiCodexAuthenticated: false,
    openaiCodexCredentials: null,
    openaiCodexCredentialsUpdatedAt: null,
    updatedAt: new Date(),
  }).where(eq(profiles.userId, userId));
}
