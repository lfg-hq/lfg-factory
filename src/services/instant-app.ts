import { and, desc, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { instantApps } from "../db/schema/instant.ts";
import { messages } from "../db/schema/chat.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { githubTokens } from "../db/schema/users.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { enableHttpAccess, execOnWorkspace, newWorkspace, stopWorkspace } from "./mags.ts";
import { createGitHubRepo, initAndPushRepo, commitAndPush } from "./git.ts";
import {
  extractExitCode,
  extractSessionId,
  hasAuthError,
  isStreamComplete,
  parseJsonlEvents,
  pollOutput,
  startClaudeCli,
  type ClaudeJsonEvent,
  saveCredentialsFromVm,
} from "./claude-cli.ts";

const PROJECT_DIR = "project";
const CLAUDE_PROJECT_DIR = "/home/claudeuser/project";
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const activeBuilds = new Set<string>();

export interface CreateInstantAppInput {
  userId: string;
  projectId?: string;
  conversationId: string;
  name: string;
  requirements: string;
  envVars?: Record<string, string>;
}

export interface InstantStatusResult {
  appId: string;
  appName: string;
  status: string;
  previewUrl: string;
  message: string;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function sanitizeAppName(name: string): string {
  return (name || "instant-app")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "instant-app";
}

async function appendSystemNotice(conversationId: string, content: Record<string, unknown>) {
  await db.insert(messages).values({
    conversationId,
    role: "system",
    content: JSON.stringify(content),
  });
}

async function broadcastInstantStatus(params: {
  userId: string;
  conversationId?: string | null;
  appId: string;
  status: string;
  message: string;
  previewUrl?: string;
  appName?: string;
}) {
  const { userId, conversationId, appId, status, message, previewUrl, appName } = params;

  const isRunning = status === "running";
  broadcastToUser(userId, {
    type: "ai_chunk",
    chunk: "",
    is_final: false,
    is_notification: true,
    notification_type: isRunning ? "instant_app_ready" : "instant_app_status",
    instant_app_id: appId,
    instant_app_status: status,
    conversation_id: conversationId ?? "",
    message,
    preview_url: previewUrl ?? "",
    app_name: appName ?? "",
  });

  if (conversationId) {
    await appendSystemNotice(conversationId, {
      type: "instant_build_notice",
      instant_app_id: appId,
      status,
      message,
      preview_url: previewUrl ?? "",
      app_name: appName ?? "",
    });
  }
}

async function broadcastEnvVarRequest(params: {
  userId: string;
  conversationId: string;
  key: string;
  description: string;
  required: boolean;
  appId: string;
}) {
  const payload = {
    key: params.key,
    description: params.description,
    required: params.required,
    app_id: params.appId,
  };

  broadcastToUser(params.userId, {
    type: "ai_chunk",
    chunk: "",
    is_final: false,
    is_notification: true,
    notification_type: "env_var_request",
    data: payload,
  });

  await appendSystemNotice(params.conversationId, {
    type: "env_var_request",
    ...payload,
  });
}

function extractProgress(events: ClaudeJsonEvent[]): string | null {
  for (const event of events) {
    if (event.type !== "assistant") continue;
    const blocks = event.message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "tool_use" && block.name) {
        const toolInput = block.input ?? {};
        if (typeof toolInput.file_path === "string") {
          return `${block.name}: ${toolInput.file_path}`;
        }
        if (typeof toolInput.command === "string") {
          return `${block.name}: ${toolInput.command.slice(0, 90)}`;
        }
        return `Running: ${block.name}`;
      }
      if (block.type === "text" && block.text?.trim()) {
        return `Agent: ${block.text.trim().slice(0, 160)}`;
      }
    }
  }
  return null;
}

async function ensureSandboxForApp(appId: string) {
  const [row] = await db
    .select({ app: instantApps, sandbox: sandboxes })
    .from(instantApps)
    .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
    .where(eq(instantApps.id, appId))
    .limit(1);

  if (!row) return null;
  if (row.sandbox?.magsWorkspaceId) {
    return { app: row.app, sandbox: row.sandbox };
  }

  // Look up user's claude_auth workspace to use as base (has Node, Bun, Claude CLI configured)
  const [authSandbox] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.userId, row.app.userId), eq(sandboxes.workspaceType, "claude_auth")))
    .limit(1);

  const baseWorkspaceId = authSandbox?.magsWorkspaceId ?? undefined;

  const workspaceName = `instant-${row.app.appId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const { jobId, workspaceId } = await newWorkspace(workspaceName, { baseWorkspaceId });

  const [sandbox] = await db
    .insert(sandboxes)
    .values({
      projectId: row.app.projectId ?? null,
      userId: row.app.userId,
      magsWorkspaceId: workspaceId,
      magsJobId: jobId,
      workspaceType: "instant",
      status: "ready",
      previewPort: 8080,
      updatedAt: new Date(),
    })
    .returning();

  await db
    .update(instantApps)
    .set({ sandboxId: sandbox!.id, updatedAt: new Date() })
    .where(eq(instantApps.id, row.app.id));

  return { app: row.app, sandbox: sandbox! };
}

async function checkLocalServer(workspaceId: string, retries = 5): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(3_000); // wait between retries
    try {
      const res = await execOnWorkspace(
        workspaceId,
        "curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/ 2>/dev/null || echo 000",
        { timeout: 15_000 }
      );
      const code = (res.output || "").trim().split(/\s+/).pop() || "000";
      const codeNum = parseInt(code, 10);
      // Any HTTP response (even 404/500) means the server IS running
      if (codeNum > 0 && codeNum < 600) return true;
    } catch {
      // transient error — retry
    }
  }
  return false;
}

async function validatePublicUrl(
  publicUrl: string,
  retries = 3
): Promise<{ ok: boolean; statusCode: number; error?: string; body?: string }> {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(5_000);
    try {
      const res = await fetch(publicUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.text();

      const hasErrorIndicators =
        body.includes("Internal Server Error") ||
        body.includes("Application error") ||
        body.includes("Cannot GET") ||
        body.includes("ECONNREFUSED") ||
        body.includes("502 Bad Gateway") ||
        body.includes("503 Service");

      if (res.ok && !hasErrorIndicators) {
        return { ok: true, statusCode: res.status };
      }

      const snippet = body.slice(0, 2000);
      return {
        ok: false,
        statusCode: res.status,
        error:
          `HTTP ${res.status}` +
          (hasErrorIndicators ? " — response contains error indicators" : ""),
        body: snippet,
      };
    } catch (err) {
      if (attempt === retries - 1) {
        return { ok: false, statusCode: 0, error: String(err) };
      }
    }
  }
  return { ok: false, statusCode: 0, error: "All retries exhausted" };
}

async function runInstantBuild(appId: string, feedback?: string) {
  if (activeBuilds.has(appId)) return;
  activeBuilds.add(appId);

  let buildWorkspaceId: string | null = null;
  let buildUserId: string | null = null;

  try {
    const initial = await ensureSandboxForApp(appId);
    if (!initial) return;

    let app = initial.app;
    let sandbox = initial.sandbox;
    const workspaceId = sandbox.magsWorkspaceId!;
    const appName = app.name;
    buildWorkspaceId = workspaceId;
    buildUserId = app.userId;

    await db
      .update(instantApps)
      .set({ status: "building", updatedAt: new Date() })
      .where(eq(instantApps.id, appId));

    await broadcastInstantStatus({
      userId: app.userId,
      conversationId: app.conversationId,
      appId: app.appId,
      appName,
      status: "building",
      message: `Provisioning sandbox for ${appName}...`,
    });

    const shouldContinue = !!feedback && !!sandbox.cliSessionId;
    const prompt = shouldContinue
      ? `The user wants changes to the running app.

## Feedback / New Requirements
${feedback}

## CRITICAL: Working Directory
- Your working directory is /root/project — ALL project files are here. NEVER cd elsewhere.

## Instructions
1. export PATH=/root/node/current/bin:/root/.npm-global/bin:$PATH
2. Apply the requested changes to the project in /root/project
3. Ensure the app is running on port 8080, bound to 0.0.0.0
4. If you need to restart:
   cd /root/project && npm run build && nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 &`
      : `You are building a full-stack web application inside a cloud sandbox.

## App: ${appName}

## Requirements
${app.requirements ?? ""}

## CRITICAL: Working Directory
- Your CWD is /root/project — ALL work happens here. NEVER cd elsewhere.
- PATH, npm, and node are already configured. Do NOT debug or fix npm/node/PATH issues.
- npm cache is at /tmp/npm-cache (writable). Do NOT change npm config.

## Build Steps — Follow EXACTLY in order
1. Clean the project directory and scaffold:
   rm -rf /root/project/* /root/project/.* 2>/dev/null; true
   npx create-next-app@latest /root/project --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes

2. Install additional deps:
   cd /root/project && npm install drizzle-orm better-sqlite3 && npm install -D drizzle-kit @types/better-sqlite3

3. Init shadcn/ui:
   cd /root/project && npx shadcn@latest init -y -d

4. Implement ALL requirements — pages, API routes, database schema, UI components.
   Stay in /root/project. Write files directly, do not create subdirectories for the project itself.

5. Build and start (MUST use nohup):
   cd /root/project && npm run build && nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 &
   sleep 3 && curl -s http://localhost:8080/ || true

## Rules
- The app MUST listen on 0.0.0.0:8080. MUST use nohup. Redirect output to dev.log.
- Do NOT create nested project directories.
- Do NOT run whoami, env, cat .npmrc, or debug the environment. It is already configured correctly.
- Do NOT use yarn or pnpm. Use npm only. Do NOT use sudo.
- Use apk (not apt/yum) for system packages.
- If create-next-app fails, retry once. If it fails again, create the project manually (package.json + files).`;

    await broadcastInstantStatus({
      userId: app.userId,
      conversationId: app.conversationId,
      appId: app.appId,
      appName,
      status: "building",
      message: shouldContinue
        ? `Applying your changes to ${appName}...`
        : `Claude Code is building ${appName}...`,
    });

    const cli = await startClaudeCli({
      workspaceId,
      prompt,
      projectDir: PROJECT_DIR,
      sessionId: shouldContinue ? sandbox.cliSessionId ?? undefined : undefined,
      maxTurns: 120,
      userId: app.userId,
      envVars: (app.envVars as Record<string, string> | null) ?? {},
    });

    let offset = 0;
    let allOutput = "";
    let sessionId = sandbox.cliSessionId ?? undefined;
    let completed = false;
    let lastProgressAt = 0;
    const deadline = Date.now() + BUILD_TIMEOUT_MS;

    while (Date.now() < deadline && !completed) {
      await sleep(POLL_INTERVAL_MS);
      const poll = await pollOutput(workspaceId, cli.outputFile, offset, cli.backgroundPid);
      offset = poll.newOffset;
      if (!poll.data) {
        if (!poll.alive && allOutput.includes("___CLAUDE_EXIT_CODE")) {
          break;
        }
        continue;
      }

      allOutput += poll.data;
      const events = parseJsonlEvents(poll.data);

      if (!sessionId) {
        const extracted = extractSessionId(events);
        if (extracted) {
          sessionId = extracted;
          await db
            .update(sandboxes)
            .set({ cliSessionId: extracted, updatedAt: new Date() })
            .where(eq(sandboxes.id, sandbox.id));
        }
      }

      if (Date.now() - lastProgressAt > 5_000) {
        const progress = extractProgress(events);
        if (progress) {
          lastProgressAt = Date.now();
          await broadcastInstantStatus({
            userId: app.userId,
            conversationId: app.conversationId,
            appId: app.appId,
            appName,
            status: "building",
            message: progress,
          });
        }
      }

      if (isStreamComplete(events)) {
        completed = true;
      }
    }

    const exitCode = extractExitCode(allOutput);
    if (hasAuthError(allOutput)) {
      throw new Error("Claude Code authentication failed. Reconnect in Settings.");
    }
    if (exitCode !== null && exitCode !== 0) {
      throw new Error(`Claude CLI failed with exit code ${exitCode}`);
    }

    let previewUrl = app.previewUrl ?? sandbox.previewUrl ?? "";
    if (!previewUrl) {
      previewUrl = await enableHttpAccess(workspaceId, 8080);
    }

    const isLive = await checkLocalServer(workspaceId);

    // ── Validate Public URL & Auto-Fix ─────────────────────────────
    let publicUrlValid = false;
    if (previewUrl) {
      console.log(`[instant] Validating public URL: ${previewUrl}`);
      const validation = await validatePublicUrl(previewUrl);
      publicUrlValid = validation.ok;

      if (!validation.ok && sessionId) {
        console.log(
          `[instant] Public URL validation failed (HTTP ${validation.statusCode}): ${validation.error}`
        );

        await broadcastInstantStatus({
          userId: app.userId,
          conversationId: app.conversationId,
          appId: app.appId,
          appName,
          status: "building",
          message: `Public URL returned an error — Claude is diagnosing and fixing...`,
        });

        const fixPrompt = `The app was built and the server started, but the public URL returned an error:
URL: ${previewUrl}
HTTP Status: ${validation.statusCode}
Response body (truncated):
${validation.body ?? "(no body)"}

Please diagnose and fix this issue. Check dev.log for server errors:
  cat /home/claudeuser/project/dev.log | tail -50

After fixing, rebuild and restart the server:
  cd /home/claudeuser/project && npm run build && (pkill -f 'next start' 2>/dev/null || true) && nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 &

Then wait 3 seconds and verify with: curl -s http://localhost:8080/ || true`;

        // Resume Claude CLI with the fix prompt (max 1 auto-fix attempt)
        const fixCli = await startClaudeCli({
          workspaceId,
          prompt: fixPrompt,
          projectDir: PROJECT_DIR,
          sessionId,
          maxTurns: 40,
          userId: app.userId,
          envVars: (app.envVars as Record<string, string> | null) ?? {},
        });

        let fixOffset = 0;
        let fixOutput = "";
        let fixCompleted = false;
        const fixDeadline = Date.now() + 10 * 60 * 1000; // 10 min for fix

        while (Date.now() < fixDeadline && !fixCompleted) {
          await sleep(POLL_INTERVAL_MS);
          const poll = await pollOutput(workspaceId, fixCli.outputFile, fixOffset, fixCli.backgroundPid);
          fixOffset = poll.newOffset;
          if (!poll.data) {
            if (!poll.alive && fixOutput.includes("___CLAUDE_EXIT_CODE")) break;
            continue;
          }
          fixOutput += poll.data;

          const fixEvents = parseJsonlEvents(poll.data);
          const progress = extractProgress(fixEvents);
          if (progress) {
            await broadcastInstantStatus({
              userId: app.userId,
              conversationId: app.conversationId,
              appId: app.appId,
              appName,
              status: "building",
              message: `Fixing: ${progress}`,
            });
          }
          if (isStreamComplete(fixEvents)) fixCompleted = true;
        }

        // Re-validate after fix attempt
        await sleep(5_000);
        console.log(`[instant] Re-validating public URL after fix attempt: ${previewUrl}`);
        const revalidation = await validatePublicUrl(previewUrl);
        publicUrlValid = revalidation.ok;

        if (!revalidation.ok) {
          console.log(
            `[instant] Re-validation still failed (HTTP ${revalidation.statusCode}): ${revalidation.error}`
          );
        } else {
          console.log(`[instant] Fix successful — public URL is now healthy`);
        }
      } else if (validation.ok) {
        console.log(`[instant] Public URL validated successfully`);
      }
    }

    const finalStatus = "running";
    await db
      .update(instantApps)
      .set({
        status: finalStatus,
        previewUrl,
        updatedAt: new Date(),
      })
      .where(eq(instantApps.id, appId));

    await db
      .update(sandboxes)
      .set({
        status: "ready",
        previewUrl,
        previewPort: 8080,
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.id, sandbox.id));

    // Save refreshed credentials from VM back to DB (CLI may have refreshed the OAuth token)
    await saveCredentialsFromVm(workspaceId, app.userId).catch((err) =>
      console.warn(`[instant] Failed to save credentials from VM:`, err)
    );

    const statusMessage =
      isLive && publicUrlValid
        ? `${appName} is live!`
        : isLive && !publicUrlValid
          ? `${appName} is running but the public URL may have issues — try refreshing the preview.`
          : `${appName} built successfully. Server may still be starting — try refreshing the preview.`;

    await broadcastInstantStatus({
      userId: app.userId,
      conversationId: app.conversationId,
      appId: app.appId,
      appName,
      status: "running",
      message: statusMessage,
      previewUrl,
    });

    // ── Auto-sync to GitHub if user has a connected GitHub account ──
    try {
      const [ghToken] = await db
        .select({ accessToken: githubTokens.accessToken })
        .from(githubTokens)
        .where(eq(githubTokens.userId, app.userId))
        .limit(1);

      if (ghToken?.accessToken) {
        console.log(`[instant] Auto-syncing ${appName} to GitHub...`);

        await broadcastInstantStatus({
          userId: app.userId,
          conversationId: app.conversationId,
          appId: app.appId,
          appName,
          status: "running",
          message: `Syncing ${appName} to GitHub...`,
          previewUrl,
        });

        const repoName = `lfg-${app.name}`;
        const repo = await createGitHubRepo({
          repoName,
          description: `Built with LFG Instant Mode: ${(app.description ?? app.name).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100).trim()}`,
          isPrivate: true,
          githubToken: ghToken.accessToken,
        });

        if (repo.created) {
          // Fresh repo — init and push to main
          await initAndPushRepo({
            workspaceId,
            projectDir: CLAUDE_PROJECT_DIR,
            repoUrl: repo.cloneUrl,
            branch: "main",
            githubToken: ghToken.accessToken,
          });
        } else {
          // Existing repo — commit and push to main
          await commitAndPush({
            workspaceId,
            projectDir: CLAUDE_PROJECT_DIR,
            commitMessage: `Update ${app.name} via LFG Instant Mode`,
            featureBranch: "main",
            repoUrl: repo.cloneUrl,
            githubToken: ghToken.accessToken,
          });
        }

        // Store repo info in app metadata
        await db
          .update(instantApps)
          .set({
            metadata: {
              ...((app.metadata as Record<string, unknown> | null) ?? {}),
              githubRepoUrl: repo.repoUrl,
              githubRepoName: repo.repoName,
              githubOwner: repo.owner,
              lastExportedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(instantApps.id, app.id));

        console.log(`[instant] Auto-synced ${appName} to ${repo.repoUrl}`);

        await broadcastInstantStatus({
          userId: app.userId,
          conversationId: app.conversationId,
          appId: app.appId,
          appName,
          status: "running",
          message: `${appName} synced to GitHub: ${repo.repoUrl}`,
          previewUrl,
        });
      }
    } catch (syncErr) {
      // Don't fail the build if GitHub sync fails
      console.warn(`[instant] Auto-sync to GitHub failed for ${appName}:`, syncErr);
    }
  } catch (error) {
    const [app] = await db.select().from(instantApps).where(eq(instantApps.id, appId)).limit(1);
    if (app) {
      await db
        .update(instantApps)
        .set({
          status: "error",
          metadata: {
            ...((app.metadata as Record<string, unknown> | null) ?? {}),
            error: String(error),
          },
          updatedAt: new Date(),
        })
        .where(eq(instantApps.id, app.id));

      await broadcastInstantStatus({
        userId: app.userId,
        conversationId: app.conversationId,
        appId: app.appId,
        appName: app.name,
        status: "error",
        message: `Error building ${app.name}: ${String(error)}`,
      });
    }
  } finally {
    // Always save refreshed credentials from VM back to DB
    if (buildWorkspaceId && buildUserId) {
      await saveCredentialsFromVm(buildWorkspaceId, buildUserId).catch(() => {});
    }
    activeBuilds.delete(appId);
  }
}

export async function createOrContinueInstantApp(input: CreateInstantAppInput) {
  const normalizedName = sanitizeAppName(input.name);
  const [existing] = await db
    .select()
    .from(instantApps)
    .where(
      and(
        eq(instantApps.userId, input.userId),
        eq(instantApps.conversationId, input.conversationId)
      )
    )
    .orderBy(desc(instantApps.createdAt))
    .limit(1);

  if (existing) {
    await db
      .update(instantApps)
      .set({
        name: normalizedName,
        description: input.requirements.slice(0, 500),
        requirements: input.requirements,
        envVars: input.envVars ?? ((existing.envVars as Record<string, string>) ?? {}),
        status: "building",
        updatedAt: new Date(),
      })
      .where(eq(instantApps.id, existing.id));

    void runInstantBuild(existing.id, input.requirements);

    return {
      appId: existing.appId,
      appName: normalizedName,
      status: "building",
      continued: true,
    };
  }

  const [app] = await db
    .insert(instantApps)
    .values({
      name: normalizedName,
      description: input.requirements.slice(0, 500),
      requirements: input.requirements,
      envVars: input.envVars ?? {},
      status: "building",
      projectId: input.projectId ?? null,
      userId: input.userId,
      conversationId: input.conversationId,
    })
    .returning();

  if (app) {
    void runInstantBuild(app.id);
  }

  return {
    appId: app!.appId,
    appName: app!.name,
    status: "building",
    continued: false,
  };
}

export async function getInstantAppStatus(params: {
  userId: string;
  conversationId: string;
  restartServer?: boolean;
}): Promise<InstantStatusResult | null> {
  const [row] = await db
    .select({ app: instantApps, sandbox: sandboxes })
    .from(instantApps)
    .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
    .where(
      and(
        eq(instantApps.userId, params.userId),
        eq(instantApps.conversationId, params.conversationId)
      )
    )
    .orderBy(desc(instantApps.createdAt))
    .limit(1);

  if (!row) return null;

  const app = row.app;
  const sandbox = row.sandbox;
  let status = app.status;
  let previewUrl = app.previewUrl ?? "";

  if (!sandbox?.magsWorkspaceId) {
    return {
      appId: app.appId,
      appName: app.name,
      status,
      previewUrl: "",
      message: `${app.name} status: ${status}`,
    };
  }

  if (params.restartServer) {
    const rebuildCmd =
      "cd /home/claudeuser/project && (pkill -f 'next start' 2>/dev/null || true) && npm run build && nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 &";
    await execOnWorkspace(sandbox.magsWorkspaceId, rebuildCmd, { timeout: 180_000 });
    await sleep(3_000);
  }

  if (!previewUrl || params.restartServer) {
    previewUrl = await enableHttpAccess(sandbox.magsWorkspaceId, 8080);
  }

  const live = await checkLocalServer(sandbox.magsWorkspaceId);
  if (live) status = "running";

  await db
    .update(instantApps)
    .set({
      status,
      previewUrl: live ? previewUrl : app.previewUrl,
      updatedAt: new Date(),
    })
    .where(eq(instantApps.id, app.id));

  if (live) {
    await db
      .update(sandboxes)
      .set({
        previewUrl,
        previewPort: 8080,
        status: "ready",
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.id, sandbox.id));
  }

  await broadcastInstantStatus({
    userId: params.userId,
    conversationId: app.conversationId,
    appId: app.appId,
    appName: app.name,
    status,
    message: live ? `${app.name} is live!` : `${app.name} status: ${status}`,
    previewUrl: live ? previewUrl : "",
  });

  return {
    appId: app.appId,
    appName: app.name,
    status,
    previewUrl: live ? previewUrl : "",
    message: live ? `${app.name} is live!` : `${app.name} status: ${status}`,
  };
}

export async function requestInstantEnvVariable(params: {
  userId: string;
  conversationId: string;
  key: string;
  description: string;
  required?: boolean;
}) {
  const [app] = await db
    .select()
    .from(instantApps)
    .where(
      and(
        eq(instantApps.userId, params.userId),
        eq(instantApps.conversationId, params.conversationId)
      )
    )
    .orderBy(desc(instantApps.createdAt))
    .limit(1);

  if (!app) return { sent: false, reason: "No instant app for this conversation." };

  await broadcastEnvVarRequest({
    userId: params.userId,
    conversationId: params.conversationId,
    key: params.key,
    description: params.description,
    required: params.required !== false,
    appId: app.appId,
  });
  return { sent: true, appId: app.appId };
}

export async function getInstantAppForConversation(userId: string, conversationId: string) {
  const [app] = await db
    .select()
    .from(instantApps)
    .where(and(eq(instantApps.userId, userId), eq(instantApps.conversationId, conversationId)))
    .orderBy(desc(instantApps.createdAt))
    .limit(1);
  return app ?? null;
}

export async function askInstantSandboxQuestion(params: {
  userId: string;
  conversationId: string;
  question: string;
}) {
  const [row] = await db
    .select({ app: instantApps, sandbox: sandboxes })
    .from(instantApps)
    .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
    .where(
      and(
        eq(instantApps.userId, params.userId),
        eq(instantApps.conversationId, params.conversationId)
      )
    )
    .orderBy(desc(instantApps.createdAt))
    .limit(1);

  if (!row?.sandbox?.magsWorkspaceId) {
    return { answer: "No sandbox is available yet for this app." };
  }

  // Lightweight sandbox introspection fallback.
  const cmd = `cd /home/claudeuser/project && (ls -la && echo "\\nQuestion: ${params.question.replace(/"/g, '\\"')}" )`;
  const result = await execOnWorkspace(row.sandbox.magsWorkspaceId, cmd, { timeout: 30_000 });
  return { answer: result.output.slice(0, 4000) };
}

// ── Delete Instant App ───────────────────────────────────────────────

export async function deleteInstantApp(params: {
  userId: string;
  appId: string;
}): Promise<{ deleted: boolean; message: string }> {
  const [row] = await db
    .select({ app: instantApps, sandbox: sandboxes })
    .from(instantApps)
    .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
    .where(and(eq(instantApps.userId, params.userId), eq(instantApps.appId, params.appId)))
    .limit(1);

  if (!row) return { deleted: false, message: "App not found." };

  // Stop the VM if it has an active workspace
  if (row.sandbox?.magsWorkspaceId) {
    try {
      await stopWorkspace(row.sandbox.magsWorkspaceId);
    } catch (err) {
      console.warn(`[InstantApp] Failed to stop workspace ${row.sandbox.magsWorkspaceId}:`, err);
    }
  }

  // Delete sandbox record first (instant_app references it)
  if (row.sandbox) {
    await db.delete(sandboxes).where(eq(sandboxes.id, row.sandbox.id));
  }

  // Delete the instant app record (cascade will clean up conversation link)
  await db.delete(instantApps).where(eq(instantApps.id, row.app.id));

  return { deleted: true, message: `Deleted ${row.app.name} and stopped its sandbox.` };
}

// ── Export to GitHub ─────────────────────────────────────────────────

export interface GitHubExportResult {
  success: boolean;
  repoUrl?: string;
  commitSha?: string;
  message: string;
}

export async function exportInstantAppToGitHub(params: {
  userId: string;
  appId: string;
  repoName?: string;
  isPrivate?: boolean;
}): Promise<GitHubExportResult> {
  // Look up app + sandbox
  const [row] = await db
    .select({ app: instantApps, sandbox: sandboxes })
    .from(instantApps)
    .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
    .where(and(eq(instantApps.userId, params.userId), eq(instantApps.appId, params.appId)))
    .limit(1);

  if (!row) return { success: false, message: "App not found." };
  if (!row.sandbox?.magsWorkspaceId) return { success: false, message: "No sandbox available — app must be built first." };

  // Get GitHub token
  const [ghToken] = await db
    .select({ accessToken: githubTokens.accessToken })
    .from(githubTokens)
    .where(eq(githubTokens.userId, params.userId))
    .limit(1);

  if (!ghToken?.accessToken) {
    return { success: false, message: "No GitHub account connected. Connect GitHub in Settings first." };
  }

  const workspaceId = row.sandbox.magsWorkspaceId;
  const repoName = params.repoName || `lfg-${row.app.name}`;
  const projectDir = CLAUDE_PROJECT_DIR;

  try {
    // Create or get the GitHub repo
    const repo = await createGitHubRepo({
      repoName,
      description: `Built with LFG Instant Mode: ${(row.app.description ?? row.app.name).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100).trim()}`,
      isPrivate: params.isPrivate ?? true,
      githubToken: ghToken.accessToken,
    });

    // Check if repo already has content (not freshly created)
    if (repo.created) {
      // Fresh repo — init and push
      await initAndPushRepo({
        workspaceId,
        projectDir,
        repoUrl: repo.cloneUrl,
        branch: "main",
        githubToken: ghToken.accessToken,
      });
    } else {
      // Existing repo — commit and push to main
      await commitAndPush({
        workspaceId,
        projectDir,
        commitMessage: `Update from LFG Instant Mode: ${row.app.name}`,
        featureBranch: "main",
        repoUrl: repo.cloneUrl,
        githubToken: ghToken.accessToken,
      });
    }

    // Store the repo URL on the app metadata
    await db
      .update(instantApps)
      .set({
        metadata: {
          ...((row.app.metadata as Record<string, unknown> | null) ?? {}),
          githubRepoUrl: repo.repoUrl,
          githubRepoName: repo.repoName,
          githubOwner: repo.owner,
          lastExportedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(instantApps.id, row.app.id));

    return {
      success: true,
      repoUrl: repo.repoUrl,
      commitSha: "",
      message: `Code exported to ${repo.repoUrl}`,
    };
  } catch (err) {
    return { success: false, message: `GitHub export failed: ${(err as Error).message}` };
  }
}

// ── Download App Archive ─────────────────────────────────────────────

export async function getInstantAppArchive(params: {
  userId: string;
  appId: string;
}): Promise<{ success: boolean; data?: Buffer; filename?: string; message: string }> {
  const [row] = await db
    .select({ app: instantApps, sandbox: sandboxes })
    .from(instantApps)
    .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
    .where(and(eq(instantApps.userId, params.userId), eq(instantApps.appId, params.appId)))
    .limit(1);

  if (!row) return { success: false, message: "App not found." };
  if (!row.sandbox?.magsWorkspaceId) return { success: false, message: "No sandbox available." };

  try {
    // Create tarball excluding node_modules and .next
    const tarCmd =
      `cd /home/claudeuser && tar czf /tmp/app-export.tar.gz --exclude='node_modules' --exclude='.next' --exclude='.git' project/`;
    await execOnWorkspace(row.sandbox.magsWorkspaceId, tarCmd, { timeout: 60_000 });

    // Read the tarball as base64
    const b64Result = await execOnWorkspace(
      row.sandbox.magsWorkspaceId,
      "base64 /tmp/app-export.tar.gz",
      { timeout: 60_000 }
    );

    const data = Buffer.from(b64Result.output.trim(), "base64");
    const filename = `${row.app.name || "instant-app"}.tar.gz`;

    return { success: true, data, filename, message: "Archive ready." };
  } catch (err) {
    return { success: false, message: `Archive failed: ${(err as Error).message}` };
  }
}

// ── Provision Postgres DB for Instant App ────────────────────────────

export async function provisionInstantAppDatabase(params: {
  userId: string;
  appId: string;
}): Promise<{ success: boolean; dbName?: string; connectionString?: string; message: string }> {
  const host = process.env.POSTGRES_PROVISIONING_HOST || "135.181.37.208";
  const port = parseInt(process.env.POSTGRES_PROVISIONING_PORT || "5433", 10);
  const user = process.env.POSTGRES_PROVISIONING_USER || "lfg_admin";
  const password = process.env.POSTGRES_PROVISIONING_PASSWORD;

  if (!password) {
    return { success: false, message: "Postgres provisioning not configured on the server." };
  }

  const [row] = await db
    .select()
    .from(instantApps)
    .where(and(eq(instantApps.userId, params.userId), eq(instantApps.appId, params.appId)))
    .limit(1);

  if (!row) return { success: false, message: "App not found." };

  // Generate DB name from app name
  const slug = (row.name || "app")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
  const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  const dbName = `lfg_instant_${slug}_${shortId}`;

  // Dynamic import to avoid top-level dep if not used
  const pg = await import("pg");
  const client = new pg.default.Client({ host, port, user, password, database: "postgres" });

  try {
    await client.connect();
    const { rows } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (rows.length === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
  } catch (err) {
    return { success: false, message: `DB provisioning failed: ${(err as Error).message}` };
  } finally {
    await client.end().catch(() => {});
  }

  const connectionString = `postgresql://${user}:${password}@${host}:${port}/${dbName}`;

  // Store DATABASE_URL in the app's env vars
  const currentEnv = (row.envVars as Record<string, string> | null) ?? {};
  currentEnv["DATABASE_URL"] = connectionString;

  await db
    .update(instantApps)
    .set({
      envVars: currentEnv,
      metadata: {
        ...((row.metadata as Record<string, unknown> | null) ?? {}),
        provisionedDb: dbName,
        provisionedDbAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(instantApps.id, row.id));

  const maskedUrl = `postgresql://${user}:****@${host}:${port}/${dbName}`;

  return {
    success: true,
    dbName,
    connectionString: maskedUrl,
    message: `Database '${dbName}' provisioned. DATABASE_URL added to env vars.`,
  };
}
