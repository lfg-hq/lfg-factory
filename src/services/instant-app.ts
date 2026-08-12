import { and, desc, eq } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db } from "../config/db.ts";
import { instantApps } from "../db/schema/instant.ts";
import { messages, modelSelections } from "../db/schema/chat.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { githubTokens, profiles } from "../db/schema/users.ts";
import { broadcastToUser, broadcastToConversation } from "../ws/connection-manager.ts";

/**
 * Deliver an instant notification ONLY to the tab(s) bound to this conversation, so
 * with several instant apps open at once one app's build messages don't leak into
 * another's chat. Falls back to a user-wide broadcast when no conversation is known.
 */
function broadcastInstant(userId: string, conversationId: string | null | undefined, data: object): void {
  if (conversationId) broadcastToConversation(userId, conversationId, data);
  else broadcastToUser(userId, data);
}
import { getModel, getProviderName, getProviderModel } from "../ai/provider.ts";
import { enableHttpAccess, execOnWorkspace, findJob, newWorkspace, newWorkspaceV2, stopWorkspace, deleteWorkspace, normalizeMagsAppUrl, setStableUrl, type MagsExecResult } from "./mags.ts";
import { testInstantApp, type ScreenResult } from "./instant-tester.ts";
import { createGitHubRepo, initAndPushRepo, commitAndPush, cloneRepo } from "./git.ts";
import {
  extractExitCode,
  extractSessionId,
  hasAuthError,
  isStreamComplete,
  parseJsonlEvents,
  pollOutput,
  startClaudeCli,
  injectCredentials,
  type ClaudeJsonEvent,
  saveCredentialsFromVm,
  markClaudeDisconnected,
  resolveClaudeAuth,
} from "./claude-cli.ts";
import {
  composeDesignTokens,
  generateTokensCss,
  resolvePaletteId,
  resolveFontPairingId,
  resolveStyleProfileId,
  inferBrightness,
  type DesignTokens,
} from "../config/design-tokens/index.ts";
import {
  resolveAgentBuilder,
  resolveAgentBuilderForModel,
  runAgenticBuild,
  getInstantBuilderSystemPrompt,
  type AgentBuilderSelection,
} from "./instant-builder-agent.ts";
import { startPiCli, streamPiToCompletion, isPiSupportedProvider, probeBuildActivity } from "./pi-cli.ts";
import { detectProjectType, getBuildProfile, type ProjectType } from "./instant-profiles.ts";

// Non-Anthropic builds default to the in-sandbox Pi coding agent. Set
// INSTANT_NONANTHROPIC_BUILDER=agent to use the server-side SSH agent instead.
const USE_PI_IN_SANDBOX = (process.env.INSTANT_NONANTHROPIC_BUILDER ?? "pi") !== "agent";

// Build on the big /data volume (7.8GB via diskGb), not /root (1.9GB) — avoids ENOSPC.
const PROJECT_DIR = "project"; // relative name; CLI runners resolve under /data
const CLAUDE_PROJECT_DIR = "/data/project";
// Build-phase markers live OUTSIDE the project dir so they SURVIVE a scaffold's
// `rm -rf /data/project/*`. They make scaffolding idempotent/resumable across ANY
// stack: a retry skips already-completed steps instead of nuking work and re-running
// slow installs. (scaffold.inprogress = started; scaffold.done = finished; step_<i>.ok
// = that step completed.)
const LFG_MARKER_DIR = "/data/.lfg";

// Mags sandbox type that ships the Next.js webapp scaffold (+ node_modules + Pi)
// pre-baked — `mags new <name> --type lfg-instant-boiler`. Booting from it lets a
// brand-new project skip the slow create-next-app + npm install + shadcn scaffold.
const INSTANT_BOILERPLATE_ROOTFS = process.env.INSTANT_BOILERPLATE_ROOTFS || "lfg-instant-boiler";
// Project types whose scaffold the boilerplate template actually contains. The
// boilerplate is the webapp (Next.js + shadcn) stack; landing needs framer-motion
// and game is a different Vite/three.js stack, so those still scaffold normally.
const BOILERPLATE_PROJECT_TYPES = new Set(["webapp"]);
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const activeBuilds = new Set<string>();
// Internal app ids (instantApps.id) whose build the user asked to stop. The build
// loop polls this and tears down promptly (kills the in-VM agent, skips GitHub sync,
// marks the app "stopped"). Cleared in runInstantBuild's finally.
const cancelledBuilds = new Set<string>();
// Thrown internally when the user stops a build; the catch maps it to a "stopped" status.
const BUILD_CANCELLED_MARKER = "__BUILD_STOPPED_BY_USER__";

/**
 * Request cancellation of an in-progress build. Best-effort: the running build loop
 * notices within one poll (~5s), kills the in-VM coding agent, and marks the app
 * "stopped". No-op (cancelled:false) when no build is active for the app.
 */
export async function cancelInstantBuild(input: { userId: string; appId: string }): Promise<{ cancelled: boolean; reason?: string }> {
  const [app] = await db
    .select()
    .from(instantApps)
    .where(and(eq(instantApps.userId, input.userId), eq(instantApps.appId, input.appId)))
    .limit(1);
  if (!app) return { cancelled: false, reason: "App not found" };
  if (!activeBuilds.has(app.id)) return { cancelled: false, reason: "No build is currently running" };

  cancelledBuilds.add(app.id);
  console.log(`[instant] [${app.id}] cancel requested by user`);
  // Immediate feedback — the loop will follow with the terminal "stopped" status.
  await broadcastInstantStatus({
    userId: app.userId,
    conversationId: app.conversationId,
    appId: app.appId,
    appName: app.name,
    status: "building",
    message: "Stopping the build…",
  });
  return { cancelled: true };
}

export interface DesignChoices {
  paletteId?: string;
  fontPairingId?: string;
  styleProfileId?: string;
}

/**
 * Decide which design to actually use. Design is GLOBAL (one palette/font/style for the
 * whole app). Whether a request WANTS a design change is decided by the orchestrator
 * (it understands the user's intent) and passed in as `designChange` — we do NOT
 * keyword-guess it here. Default (designChange=false) REUSES the app's current design,
 * so an addition like "add a landing page" can never silently restyle the whole app.
 * Only when the model signals an explicit design change do freshly-picked choices win.
 *
 * All values are normalized to canonical IDs — the orchestrator and older metadata
 * sometimes carry display names ("Slate Minimal") in id fields, which would silently
 * fail to match and fall back to a default palette.
 */
function resolveEffectiveDesignChoices(
  existingMeta: Record<string, unknown> | null | undefined,
  inputChoices: DesignChoices | undefined,
  designChange: boolean,
): DesignChoices | undefined {
  const meta = existingMeta ?? {};
  // Read the ACTUALLY-APPLIED (built) design. Priority: spec.design FIRST — it is
  // written ONLY by build + swap_theme, never by an (unapproved) propose, so it can't
  // be clobbered by a proposal the user didn't approve. Then designTokens.meta, then
  // the stored *Id fields. resolve* normalizes ids OR display names.
  const sd = (meta.spec as { design?: { palette?: string; fonts?: string; style?: string } } | undefined)?.design;
  const dt = (meta.designTokens as { meta?: { paletteName?: string; fontPairingName?: string; styleProfileName?: string } } | undefined)?.meta;
  const existing: DesignChoices = {
    paletteId: resolvePaletteId((sd?.palette ?? dt?.paletteName ?? meta.paletteId) as string | undefined),
    fontPairingId: resolveFontPairingId((sd?.fonts ?? dt?.fontPairingName ?? meta.fontPairingId) as string | undefined),
    styleProfileId: resolveStyleProfileId((sd?.style ?? dt?.styleProfileName ?? meta.styleProfileId) as string | undefined),
  };
  const hasExisting = !!(existing.paletteId || existing.fontPairingId || existing.styleProfileId);

  const input: DesignChoices | undefined = inputChoices
    ? {
        paletteId: resolvePaletteId(inputChoices.paletteId),
        fontPairingId: resolveFontPairingId(inputChoices.fontPairingId),
        styleProfileId: resolveStyleProfileId(inputChoices.styleProfileId),
      }
    : undefined;

  // ADDITION (existing design + model did NOT flag a design change) → keep current design.
  if (hasExisting && !designChange) return existing;
  // First build, or explicit design change → honor the picked choices, else the existing.
  return input ?? (hasExisting ? existing : undefined);
}

/**
 * Durable, build-agnostic spec for an instant app. Persisted in
 * instantApps.metadata.spec and re-materialized into /data/project/PROJECT_SPEC.md
 * on every build so the coding agent (Claude or the SSH agent) re-grounds from disk
 * instead of relying on volatile session memory.
 */
interface ProposalSection {
  title: string;
  description: string;
}

interface InstantProposal {
  summary?: string;
  sections?: ProposalSection[];
  designChoices?: DesignChoices;
  projectType?: string;
  at?: string;
}

interface InstantSpec {
  appName: string;
  requirements: string;
  /** One-line product description shown on the approval card. */
  summary?: string;
  /** High-level architecture / feature sections from the approved plan. */
  sections?: ProposalSection[];
  design: {
    palette: string;
    fonts: string;
    style: string;
    primary: string;
    background: string;
    text: string;
  };
  /** Accumulated change requests / business decisions across iterations. */
  decisions: string[];
  updatedAt: string;
}

function buildSpecMarkdown(spec: InstantSpec): string {
  const decisionsBlock = spec.decisions.length
    ? spec.decisions.map((d, i) => `${i + 1}. ${d}`).join("\n")
    : "_(none yet — initial build)_";

  const overviewBlock = spec.summary ? `\n## Overview\n${spec.summary}\n` : "";
  const sectionsBlock = spec.sections?.length
    ? `\n## Approved Sections / Architecture\n${spec.sections
        .map((s) => `- **${s.title}** — ${s.description}`)
        .join("\n")}\n`
    : "";

  return `# Project Spec — ${spec.appName}

> This file is the SOURCE OF TRUTH for this app. It is regenerated on every build.
> Read it before doing anything and do NOT deviate from the architecture, business
> rules, or design decisions below. If a new request conflicts with this spec,
> update this file to reflect the new decision, then implement it.
${overviewBlock}${sectionsBlock}
## Architecture & Requirements
${spec.requirements || "(no requirements captured)"}

## Design System (authoritative: tokens.json + design-tokens.css)
- Palette: ${spec.design.palette}
- Fonts: ${spec.design.fonts}
- Style: ${spec.design.style}
- Primary: ${spec.design.primary} | Background: ${spec.design.background} | Text: ${spec.design.text}
- The values in tokens.json / design-tokens.css are authoritative. Never invent colors or fonts.

## Decisions Log (accumulated across iterations)
${decisionsBlock}
`;
}

export interface CreateInstantAppInput {
  userId: string;
  projectId?: string;
  conversationId: string;
  name: string;
  requirements: string;
  envVars?: Record<string, string>;
  designChoices?: DesignChoices;
  /** Orchestrator-decided: true ONLY when the user explicitly asked to change the look/
   *  theme. Default false → reuse the app's existing design (so additions don't restyle). */
  designChange?: boolean;
  /** Model selected in the composer — decides the build backend (Anthropic → Claude Code CLI; otherwise SSH agent). */
  buildModelKey?: string;
  /** Project type (webapp / landing / game) — picks the build profile. */
  projectType?: string;
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

export async function broadcastInstantStatus(params: {
  userId: string;
  conversationId?: string | null;
  appId: string;
  status: string;
  message: string;
  previewUrl?: string;
  appName?: string;
  errorType?: string;
}) {
  const { userId, conversationId, appId, status, message, previewUrl, appName, errorType } = params;

  const isRunning = status === "running";
  broadcastInstant(userId, conversationId, {
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
    ...(errorType ? { error_type: errorType } : {}),
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

/**
 * Post-build QA found broken screens. Surface the findings back into the chat so
 * the agent/user can see it, and auto-trigger ONE fix build (guarded by a metadata
 * flag so we never loop). Best-effort — never throws into the QA fire-and-forget.
 */
async function handleQaIssues(params: {
  appDbId: string;
  appId: string;
  userId: string;
  conversationId: string | null;
  appName: string;
  previewUrl: string;
  report: { passed: number; failed: number; overall?: string; screens: ScreenResult[] };
}): Promise<void> {
  const { appDbId, appId, userId, conversationId, appName, previewUrl, report } = params;
  const broken = report.screens.filter((s) => !s.ok);
  if (!broken.length) return;

  // Human-readable findings (route → what went wrong) used for both the chat
  // notice and the fix prompt.
  const findingLines = broken.map((s) => {
    const why = [s.explainer, s.observation].filter(Boolean).join(" — ");
    const errs = (s.consoleErrors ?? []).slice(0, 3).map((e) => `console: ${e}`).join("; ");
    return `• ${s.route} — ${why}${errs ? ` (${errs})` : ""}`;
  });
  const summary =
    `QA found ${broken.length} broken screen${broken.length === 1 ? "" : "s"} on ${appName}` +
    (report.overall ? `: ${report.overall}` : ".");

  // 1) Surface into the conversation so the agent/UI sees the real verdict on
  //    reload. (The QA panel itself was already updated by the tester's own
  //    tested_issues broadcast — this persists the findings into chat history.)
  if (conversationId) {
    await appendSystemNotice(conversationId, {
      type: "instant_qa_issues",
      instant_app_id: appId,
      app_name: appName,
      preview_url: previewUrl,
      passed: report.passed,
      failed: report.failed,
      overall: report.overall ?? null,
      findings: findingLines,
    });
  }

  // 2) Auto-fix ONCE. Guard on a metadata flag so a still-broken rebuild can't loop.
  let alreadyTried = false;
  try {
    const [row] = await db
      .select({ metadata: instantApps.metadata })
      .from(instantApps)
      .where(eq(instantApps.id, appDbId))
      .limit(1);
    const meta = (row?.metadata as Record<string, unknown> | null) ?? {};
    alreadyTried = meta.qaAutoFixAttempted === true;
    if (!alreadyTried) {
      await db
        .update(instantApps)
        .set({ metadata: { ...meta, qaAutoFixAttempted: true }, updatedAt: new Date() })
        .where(eq(instantApps.id, appDbId));
    }
  } catch (e) {
    console.warn(`[instant] [${appDbId}] QA auto-fix flag check failed: ${(e as Error).message}`);
  }

  if (alreadyTried) {
    console.log(`[instant] [${appDbId}] QA found issues but auto-fix already attempted — leaving for user`);
    if (conversationId) {
      await appendSystemNotice(conversationId, {
        type: "instant_build_notice",
        instant_app_id: appId,
        status: "running",
        message: `${appName} still has issues after an auto-fix attempt. Tell me what to change and I'll fix it.`,
        preview_url: previewUrl,
        app_name: appName,
      });
    }
    return;
  }

  console.log(`[instant] [${appDbId}] QA found ${broken.length} broken screen(s) — auto-fixing once`);
  await broadcastInstantStatus({
    userId,
    conversationId,
    appId,
    appName,
    status: "building",
    message: `QA found issues — fixing automatically…`,
    previewUrl,
  });

  const fixPrompt =
    `The app was built and is live, but automated QA found broken screen(s). ` +
    `These pages load (HTTP 200) but show errors — DO NOT assume the work is done just because the page renders.\n\n` +
    `${summary}\n\n` +
    `Broken screens:\n${findingLines.join("\n")}\n\n` +
    `Diagnose and FIX the root cause (most likely a failing data fetch, a wrong/empty API call, ` +
    `an unhandled error, or an error boundary tripping). Check the server log for clues:\n` +
    `  cat /data/project/dev.log | tail -80\n\n` +
    `Make the data actually load (use mock/seed data if no external API/key is available — never leave it ` +
    `showing an error state). Do NOT rewrite or re-scaffold the whole app; make the smallest change that fixes the error. ` +
    `Then rebuild and restart:\n` +
    `  cd /data/project && npm run build && (pkill -f 'next start' 2>/dev/null || true) && nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 &\n` +
    `Then wait 3 seconds and verify with: curl -s http://localhost:8080/ || true`;

  void runInstantBuild(appDbId, fixPrompt);
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

  broadcastInstant(params.userId, params.conversationId, {
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

// ── API Key Research ──

interface ApiKeyInfo {
  key: string;
  service: string;
  description: string;
  required: boolean;
}

interface ApiKeyAnalysis {
  apiKeys: ApiKeyInfo[];
  summary: string;
}

const apiKeySchema = z.object({
  apiKeys: z.array(
    z.object({
      key: z.string().describe("Environment variable name, e.g. STRIPE_SECRET_KEY"),
      service: z.string().describe("Service name, e.g. Stripe"),
      description: z.string().describe("What this key is used for"),
      required: z.boolean().describe("Whether the app fundamentally needs this key to work"),
    })
  ),
  summary: z.string().describe("Brief summary of external services needed"),
});

async function analyzeRequirementsForApiKeys(
  app: typeof instantApps.$inferSelect,
  model: ReturnType<typeof getModel>
): Promise<ApiKeyAnalysis | null> {
  const requirements = app.requirements ?? "";
  if (!requirements.trim()) return null;

  const appId = app.appId;
  console.log(`[instant] [${appId}] Analyzing requirements for API keys...`);

  await broadcastInstantStatus({
    userId: app.userId,
    conversationId: app.conversationId,
    appId,
    appName: app.name,
    status: "building",
    message: "Analyzing requirements for API keys...",
  });

  const { object: analysis } = await generateObject({
    model,
    schema: apiKeySchema,
    prompt: `Analyze the following app requirements and identify any external services that would need API keys or secret tokens to function. Only include real third-party services that require authentication (e.g. Stripe, OpenAI, Google Maps, Twilio, SendGrid, Firebase, AWS). Do NOT include database connections, internal services, or things that can work without keys.

Requirements:
${requirements}

If no external API keys are needed, return an empty apiKeys array.`,
  });

  if (!analysis.apiKeys.length) {
    console.log(`[instant] [${appId}] No API keys needed`);
    return analysis;
  }

  console.log(`[instant] [${appId}] Found ${analysis.apiKeys.length} API key(s): ${analysis.apiKeys.map((k) => k.key).join(", ")}`);

  // Filter out keys already provided
  const existingEnvVars = (app.envVars as Record<string, string> | null) ?? {};
  const missingKeys = analysis.apiKeys.filter((k) => !existingEnvVars[k.key]);

  if (!missingKeys.length) {
    console.log(`[instant] [${appId}] All API keys already provided`);
    return analysis;
  }

  // Broadcast env var requests for missing keys
  for (const key of missingKeys) {
    await broadcastEnvVarRequest({
      userId: app.userId,
      conversationId: app.conversationId || appId,
      key: key.key,
      description: `${key.service}: ${key.description}`,
      required: key.required,
      appId,
    });
  }

  // No polling — build continues immediately. The user can enter keys via the
  // frontend cards; the next build/feedback cycle will pick them up from DB.
  console.log(`[instant] [${appId}] Env var requests broadcast, continuing build`);

  return analysis;
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

async function ensureSandboxForApp(appId: string, buildProjectType?: string, buildModelKey?: string) {
  console.log(`[instant] [${appId}] ensureSandbox: looking up app + sandbox...`);
  const [row] = await db
    .select({ app: instantApps, sandbox: sandboxes })
    .from(instantApps)
    .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
    .where(eq(instantApps.id, appId))
    .limit(1);

  if (!row) {
    console.log(`[instant] [${appId}] ensureSandbox: no app row found`);
    return null;
  }

  // If a sandbox+VM already exists, verify it's still alive before reusing it
  if (row.sandbox?.magsWorkspaceId) {
    const wsId = row.sandbox.magsWorkspaceId;
    console.log(`[instant] [${appId}] ensureSandbox: checking existing VM '${wsId}'...`);
    const job = await findJob(wsId).catch((e) => {
      console.warn(`[instant] [${appId}] ensureSandbox: findJob failed: ${(e as Error).message?.slice(0, 120)}`);
      return null;
    });
    if (job && job.status === "running") {
      // A "running" VM can still be DEGRADED — reused across many builds until its exec
      // channel is broken (commands return empty, processes die → "Pi produced no files"),
      // OR its outbound network dies (the coding agent then can't reach the model API →
      // "Connection error", and pip downloads fail). Don't blindly trust the status: probe
      // that (a) exec works, (b) the filesystem works, AND (c) the VM can reach the
      // internet (DNS + a TLS connect). If any fail, the VM is toast — replace it.
      const probe = await execOnWorkspace(
        wsId,
        "echo __VM_OK__; touch /data/.lfg_health 2>/dev/null && echo __FS_OK__; " +
          "(curl -sm 8 -o /dev/null https://api.deepseek.com 2>/dev/null || curl -sm 8 -o /dev/null https://1.1.1.1 2>/dev/null) && echo __NET_OK__ || echo __NET_BAD__",
        { timeout: 30_000 },
      ).then((r) => r.output ?? "").catch((e) => {
        console.warn(`[instant] [${appId}] ensureSandbox: health probe failed: ${(e as Error).message?.slice(0, 120)}`);
        return "";
      });
      const execFsOk = probe.includes("__VM_OK__") && probe.includes("__FS_OK__");
      const netOk = probe.includes("__NET_OK__"); // false on __NET_BAD__ or a dead exec
      if (execFsOk && netOk) {
        console.log(`[instant] [${appId}] ensureSandbox: reusing running VM (health OK)`);
        return { app: row.app, sandbox: row.sandbox, freshVm: false, prescaffolded: false };
      }
      console.log(`[instant] [${appId}] VM '${wsId}' unhealthy (exec/fs=${execFsOk}, net=${netOk}) — replacing with a fresh VM`);
      // fall through to delete + provision fresh
    } else if (job && job.status === "sleeping") {
      // A sleeping (frozen) VM must be woken to exec into it. Wake can fail
      // ("job failed to wake (status: error)"). Probe it FIRST with a trivial exec —
      // if it doesn't wake, treat it as dead and provision fresh instead of letting
      // the whole build fail. (Reused only when wake succeeds → project on local disk
      // is intact; otherwise fresh VM → re-scaffold.)
      const woke = await execOnWorkspace(wsId, "echo __WOKE__", { timeout: 25_000 })
        .then((r) => r.output.includes("__WOKE__"))
        .catch((e) => {
          console.warn(`[instant] [${appId}] ensureSandbox: wake probe failed: ${(e as Error).message?.slice(0, 120)}`);
          return false;
        });
      if (woke) {
        console.log(`[instant] [${appId}] ensureSandbox: reusing woken VM`);
        return { app: row.app, sandbox: row.sandbox, freshVm: false, prescaffolded: false };
      }
      console.log(`[instant] [${appId}] VM '${wsId}' would not wake — provisioning fresh`);
    } else {
      console.log(`[instant] [${appId}] VM '${wsId}' no longer alive (status: ${job?.status ?? "not found"}), creating fresh VM`);
    }
    // Stale/un-wakeable — delete the workspace storage (cost) + the record, then
    // create a fresh VM.
    await deleteWorkspace(wsId).catch(() => {});
    await db.delete(sandboxes).where(eq(sandboxes.id, row.sandbox.id)).catch(() => {});
  }

  const workspaceName = `instant-${row.app.appId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  // startup command (auto-restart dev server on wake) is profile-specific:
  // Next.js apps use `npm start`, Vite games use `npm run dev`.
  const persistedType = (row.app.metadata as Record<string, unknown> | null)?.projectType as string | undefined;
  const projectType = detectProjectType(row.app.requirements ?? "", buildProjectType ?? persistedType);
  const startupCommand = getBuildProfile(projectType).startupCommand;
  // Rootfs choice by build model: non-Anthropic builds run the `pi` binary, which
  // only ships on the `pi` rootfs (a superset that also has node + claude). Anthropic
  // builds use the `claude` rootfs. Without this, Pi builds fail with exit 127 (pi not found).
  const provider = buildModelKey ? getProviderName(buildModelKey) : null;
  const baseRootfs = provider && provider !== "anthropic" ? "pi" : "claude";
  // Fresh-project fast path: a brand-new app with no GitHub repo to clone would
  // otherwise run the full scaffold (create-next-app + npm install + shadcn). Boot
  // from the pre-baked boilerplate template instead and skip scaffolding. Scoped to
  // the Pi path (where the boilerplate ships) + the webapp stack it contains.
  const hasRepo = !!(row.app.metadata as Record<string, unknown> | null)?.githubRepoUrl;
  const useBoilerplate = !hasRepo && baseRootfs === "pi" && BOILERPLATE_PROJECT_TYPES.has(projectType);
  // Python projects boot the Mags `python` type (--type python): a glibc base with
  // Python preinstalled, so heavy/native deps (Docling, torch, pandas…) install from
  // manylinux wheels instead of failing to compile on the Alpine/musl pi/claude rootfs.
  // The in-VM coding agent (Pi) bootstraps its own node here. Overridable for testing.
  const rootfsType = projectType === "python"
    ? (process.env.INSTANT_PYTHON_ROOTFS || "python")
    : useBoilerplate ? INSTANT_BOILERPLATE_ROOTFS : baseRootfs;
  console.log(`[instant] [${appId}] ensureSandbox: creating new VM '${workspaceName}' (type=${projectType}, rootfs=${rootfsType}${useBoilerplate ? ", pre-scaffolded boilerplate" : ""})...`);
  const vmStart = Date.now();
  // NO-SYNC (no workspace_id) → ZERO JuiceFS/S3 storage cost. The big /data volume is
  // driven by `diskGb` (per-VM ext4 on /dev/vdb), NOT by workspace_id — verified live:
  // a no-sync VM with diskGb:8 mounts /data at 7.8GB. (workspace_id only adds the
  // separate /workspace JuiceFS sync, which we don't need — code lives on GitHub, so a
  // reaped VM just re-clones/re-scaffolds.)
  const diskGb = parseInt(process.env.INSTANT_DISK_GB || "8", 10);
  // Python needs a BIG box: verbose models (DeepSeek/Kimi) accumulate a large context,
  // and Pi's node heap sizes to VM RAM — a 4GB box OOMs Pi's heap (exit 134). The SDK's
  // __MAGS_MEM_GB only honors 2/4, so real 8GB comes from the v2 API (top-level
  // memory_mb/vcpus). It COLD-BOOTS (~15s vs the ~5s snapshot tier), so it needs the
  // longer VM-start timeout. Non-python stacks keep the fast 4GB snapshot path.
  const pythonBigVm = projectType === "python" && (process.env.INSTANT_PYTHON_BIG_VM ?? "1") !== "0";
  const { jobId, workspaceId } = pythonBigVm
    ? await newWorkspaceV2(workspaceName, {
        rootfsType,
        noSync: true,
        startupCommand,
        diskGb,
        vcpus: parseInt(process.env.INSTANT_PYTHON_VCPUS || "4", 10),
        memoryMb: parseInt(process.env.INSTANT_PYTHON_MEM_MB || "8192", 10),
        // CRITICAL: no_sleep. A build has no HTTP traffic on the app port for
        // many minutes, so Mags idle-reaps the VM mid-build → 'sleeping'. These
        // v2 cold-boot VMs then FAIL TO WAKE (status: error), killing the build.
        // Keep it alive for its whole life; it's freed explicitly on app delete.
        // Override with INSTANT_PYTHON_KEEP_ALIVE=0 to fall back to sleep-on-idle.
        keepAlive: (process.env.INSTANT_PYTHON_KEEP_ALIVE ?? "1") !== "0",
      })
    : await newWorkspace(workspaceName, {
        startupCommand,
        rootfsType,
        noSync: true,
        idleMinutes: 120,
        // Mags defaults to 2GB root — too small. The 8GB volume mounts at /data.
        diskGb,
        // RAM via __MAGS_MEM_GB (SDK path honors only 2/4). Override with INSTANT_MEM_GB.
        memGb: parseInt(process.env.INSTANT_MEM_GB || "4", 10),
      });
  console.log(`[instant] [${appId}] ensureSandbox: VM ready in ${Date.now() - vmStart}ms (workspaceId=${workspaceId})`);

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

  return { app: row.app, sandbox: sandbox!, freshVm: true, prescaffolded: useBoilerplate };
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

/**
 * Wait for the app to answer on :8080, giving a STILL-COMPILING server time. A cold
 * Next.js build (esp. heavy deps like @base-ui) routinely takes a minute+, and the
 * short fixed-retry window declared "did NOT come up" while the server was literally
 * still starting. So poll up to maxMs — but bail EARLY if no dev-server/build process
 * is alive for a few cycles (a genuinely dead server must not cost the whole window).
 */
async function waitForLocalServer(workspaceId: string, maxMs = 150_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  let deadStreak = 0;
  while (Date.now() < deadline) {
    if (await checkLocalServer(workspaceId, 1)) return true;
    // Not up yet — is a server/build process still working? If so, keep waiting.
    let busy = false;
    try {
      const proc = await execOnWorkspace(
        workspaceId,
        "ps -eo args 2>/dev/null | grep -iE 'next|vite|node .*(dev|start|build)|npm (run )?(dev|start|build)|python .*app\\.py|flask|gunicorn|webpack|esbuild|\\btsc\\b' | grep -v grep | head -1",
        { timeout: 10_000 }
      );
      busy = !!(proc.output || "").trim();
    } catch {
      busy = true; // poll flaky — assume still working, keep waiting
    }
    if (busy) deadStreak = 0;
    else if (++deadStreak >= 3) return false; // ~12s with no process alive → truly dead
    await sleep(3_000);
  }
  return checkLocalServer(workspaceId, 1);
}

/**
 * Reliably (re)start the dev server so it SURVIVES the exec teardown. The build
 * agent's own `nohup npm start &` often dies because Mags kills the exec's process
 * group when the RPC ends — so we restart it server-side with `setsid` (a NEW
 * session, detached from the exec's group) and verify it's listening. This is what
 * fixes the "built successfully but preview shows 500" failures.
 */
async function ensureDevServerRunning(workspaceId: string, projectType: string): Promise<boolean> {
  const isVite = projectType === "game";
  const isPython = projectType === "python";
  // ALWAYS kill every matching server first and start exactly ONE — the coding agent
  // often starts the app several times during a build, leaving duplicate processes
  // fighting over :8080 ("Address already in use"). Converging to a single fresh
  // instance guarantees one app is running (and fixes "built ok but 500").
  const killCmd = isPython
    ? "pkill -9 -f 'python.*app.py' 2>/dev/null; pkill -9 -f 'flask run' 2>/dev/null; pkill -9 -f gunicorn 2>/dev/null"
    : isVite
      ? "pkill -9 -f vite 2>/dev/null; pkill -9 -f 'node .*vite' 2>/dev/null"
      : "pkill -9 -f 'next start' 2>/dev/null; pkill -9 -f 'next-server' 2>/dev/null";
  const startInner = isPython
    ? ".venv/bin/python app.py"
    : isVite
      ? "npm run dev -- --host 0.0.0.0 --port 8080"
      : "npm start --hostname 0.0.0.0 -p 8080";
  const buildStep = isPython || isVite ? "" : "[ -d .next ] || npm run build > build.log 2>&1";
  const script = `
export PATH=/data/project/.venv/bin:/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
export NODE_OPTIONS="--max-old-space-size=1536"
cd /data/project || exit 1
# Free :8080 no matter what holds it, then remove any strays by name.
fuser -k 8080/tcp 2>/dev/null; ${killCmd}; sleep 1
${buildStep}
CMD="cd /data/project && exec ${startInner}"
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c "$CMD" </dev/null > dev.log 2>&1 &
else
  nohup sh -c "$CMD" </dev/null > dev.log 2>&1 &
fi
echo SERVER_LAUNCHED
`;
  const b64 = Buffer.from(script).toString("base64");
  await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | bash`, { timeout: 180_000 }).catch((e) =>
    console.warn(`[instant] ensureDevServerRunning launch failed: ${(e as Error).message?.slice(0, 120)}`)
  );
  // Wait for it to come up — a cold Next.js build+start can take a minute+, so give it
  // real time (bails early if nothing is actually starting) instead of a fixed ~24s.
  return waitForLocalServer(workspaceId, 120_000);
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

// Notable Python libraries a user might explicitly request → their import module name.
// Used to VERIFY the built app actually has what was asked for (e.g. "use Docling"),
// so a silent fallback (Docling → pypdf) when a heavy/native dep can't install on the
// musl sandbox is surfaced honestly instead of hidden. Curated to well-known libs so we
// never false-warn on an incidental word in the requirements.
const NOTABLE_PY_LIBS: Record<string, string> = {
  docling: "docling",
  torch: "torch", pytorch: "torch",
  tensorflow: "tensorflow", keras: "keras",
  transformers: "transformers",
  spacy: "spacy", nltk: "nltk",
  pandas: "pandas", numpy: "numpy", scipy: "scipy",
  "scikit-learn": "sklearn", sklearn: "sklearn",
  opencv: "cv2",
  matplotlib: "matplotlib", seaborn: "seaborn", plotly: "plotly",
  pypdf: "pypdf", pdfplumber: "pdfplumber", pymupdf: "fitz",
  beautifulsoup: "bs4", scrapy: "scrapy", sqlalchemy: "sqlalchemy",
};

/**
 * After a Python build, verify the libraries the user explicitly named actually installed
 * & import in the venv. Returns the requested-but-missing library names — so a silent
 * fallback can be reported honestly rather than passed off as "done".
 */
async function verifyRequestedPythonLibs(workspaceId: string, requirements: string): Promise<string[]> {
  const req = (requirements || "").toLowerCase();
  const wanted: Array<[string, string]> = [];
  const seenMods = new Set<string>();
  for (const [key, mod] of Object.entries(NOTABLE_PY_LIBS)) {
    if (req.includes(key) && !seenMods.has(mod)) { wanted.push([key, mod]); seenMods.add(mod); }
  }
  if (!wanted.length) return [];
  const mods = wanted.map(([, m]) => m).join(",");
  // find_spec checks importability WITHOUT importing (no heavy init / side effects).
  const pyCode = `import importlib.util as u; mods="${mods}".split(","); print("MISSING:"+",".join([m for m in mods if u.find_spec(m) is None]))`;
  const shell = `cd ${CLAUDE_PROJECT_DIR} 2>/dev/null; .venv/bin/python -c '${pyCode}'`;
  const b64 = Buffer.from(shell).toString("base64");
  const out = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | bash`, { timeout: 30_000 })
    .then((r) => r.output || "")
    .catch(() => "");
  const m = out.match(/MISSING:([^\n]*)/);
  const missingMods = m?.[1] ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  // Map the missing import-names back to the user-facing library names they asked for.
  return wanted.filter(([, mod]) => missingMods.includes(mod)).map(([key]) => key);
}

// Transient Mags/gateway failures (Cloudflare 5xx, exec timeouts, socket resets) are
// common on a slow git push through the VM — retry a couple of times before giving up so
// the GitHub backup actually lands (a missing backup = "refresh lost my changes" when the
// VM is later reaped and restored from a stale repo).
const TRANSIENT_ERR_RE = /error code: 52\d|\b52[0-4]\b|timed out|timeout|etimedout|econnreset|econnrefused|socket hang up|network/i;
async function retryTransient<T>(fn: () => Promise<T>, label: string, appId: string, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = String((e as Error).message ?? e);
      if (i >= attempts || !TRANSIENT_ERR_RE.test(msg)) throw e;
      console.warn(`[instant] [${appId}] ${label} transient failure (attempt ${i}/${attempts}): ${msg.slice(0, 120)} — retrying`);
      await sleep(3000 * i);
    }
  }
  throw lastErr;
}

/**
 * Run a slow scaffold step DETACHED inside the VM and poll for completion.
 *
 * Why: a single blocking `execOnWorkspace` holds ONE HTTP request open for the
 * whole command. Cloudflare sits in front of the Mags API and kills any request
 * that stays silent for ~100s with `error code: 524` — so a >100s install (e.g.
 * the ~200MB CPU-torch wheel) dies at the socket long before our local timeout.
 * Instead we launch the script with nohup (writes its own log + exit-code marker)
 * and poll with SHORT (~15s) exec calls that just read the marker/log tail. Each
 * poll is a fresh, fast request → never trips the 524 window, no matter how long
 * the install actually takes. Same pattern as streamPiToCompletion.
 */
async function runDetachedStep(
  workspaceId: string,
  script: string,
  stepIndex: number,
  opts: { appId: string; deadlineMs?: number } = { appId: "" },
): Promise<{ exitCode: number; output: string; stderr?: string }> {
  const deadlineMs = opts.deadlineMs ?? 20 * 60 * 1000; // 20 min hard cap
  const dir = `${LFG_MARKER_DIR}/steps`;
  const sh = `${dir}/step_${stepIndex}.sh`;
  const log = `${dir}/step_${stepIndex}.log`;
  const exit = `${dir}/step_${stepIndex}.exit`;
  const scriptB64 = Buffer.from(script).toString("base64");

  // Write the script + launch it detached. `setsid`/`nohup` + `&` so it outlives
  // this short exec; the exit code lands in a marker file on completion.
  const launch =
    `mkdir -p ${dir}; ` +
    `echo '${scriptB64}' | base64 -d > ${sh}; ` +
    `rm -f ${log} ${exit}; ` +
    `nohup sh -c 'sh ${sh} > ${log} 2>&1; echo $? > ${exit}' >/dev/null 2>&1 & ` +
    `echo __LAUNCHED__`;
  await retryTransient(
    () => execOnWorkspace(workspaceId, launch, { timeout: 20_000 }),
    `detached step ${stepIndex} launch`,
    opts.appId,
  );

  const start = Date.now();
  const pollEvery = 8_000;
  while (Date.now() - start < deadlineMs) {
    await sleep(pollEvery);
    // One short request: report exit code if finished, else stream a tail so the
    // build log shows progress. `error code: 52x` on a poll is itself transient.
    const probe = await retryTransient(
      () =>
        execOnWorkspace(
          workspaceId,
          `if test -f ${exit}; then echo "__EXIT__=$(cat ${exit})"; fi; tail -c 800 ${log} 2>/dev/null`,
          { timeout: 20_000 },
        ),
      `detached step ${stepIndex} poll`,
      opts.appId,
    ).catch((e) => ({ output: `__POLL_ERR__ ${String((e as Error).message).slice(0, 80)}`, exitCode: 0 } as MagsExecResult));

    const out = probe.output ?? "";
    const m = out.match(/__EXIT__=(\d+)/);
    if (m) {
      const code = parseInt(m[1]!, 10);
      const logTail = out.replace(/__EXIT__=\d+\s*/, "");
      return { exitCode: code, output: logTail };
    }
  }
  // Deadline blown — treat as failure but leave the marker absent so a resume re-runs it.
  return { exitCode: 124, output: `detached step ${stepIndex} exceeded ${Math.round(deadlineMs / 1000)}s deadline` };
}

/**
 * Prompt for a RESUMED Pi run after a resource-limit death (OOM / tool-call runaway).
 * The prior run left real work on /data/project, so we tell Pi to CONTINUE — inspect
 * what exists, finish only what's missing, and (critically) STOP the behaviour that
 * usually caused the death: re-running the heavy, memory-hungry pipeline over and over
 * to "verify" it. One light check is enough.
 */
function buildPiResumePrompt(originalPrompt: string, projectType: string): string {
  const heavyLibNote =
    projectType === "python"
      ? `\n- This is a Python app. Loading ML libs (torch / docling / transformers) into a subprocess uses 2-3GB RAM. Do NOT repeatedly import them or re-run the full parse pipeline to "test" — that is what ran the box out of memory. Trust the code; verify at most ONCE with a single small request, then stop.`
      : "";
  return `You are RESUMING an interrupted build — you are NOT starting over.

The previous run made real progress but was killed by a resource limit (it ran out of memory or looped on too many steps). All of its work is already saved in the project directory (/data/project). Your job is to FINISH it, efficiently.

Do this, in order:
1. First look at what already exists: list the project files and read the main entry point (app.py / package.json and the primary source files). Do NOT recreate files that are already there.
2. Identify what is actually incomplete or broken and fix ONLY that.
3. Make sure the app starts and serves on port 8080. Start it ONCE and confirm it responds. If it already runs, leave it.
4. Then STOP. Do not keep re-testing, re-installing, or refactoring working code.

Rules to avoid another death:
- Be decisive and minimal. Every extra step spends the limited budget that killed the last run.
- Do NOT reinstall dependencies that are already installed. Check first (a quick import or \`pip show\`), install only if missing.${heavyLibNote}
- Do NOT loop: if a check passes once, move on.

Original requirements (for reference only — most of this is likely already built):
${originalPrompt}`;
}

async function runInstantBuild(appId: string, feedback?: string, designChoices?: DesignChoices, buildModelKey?: string, buildProjectType?: string, designChange?: boolean) {
  if (activeBuilds.has(appId)) return;
  activeBuilds.add(appId);

  let buildWorkspaceId: string | null = null;
  let buildUserId: string | null = null;
  let buildAuthMode: "oauth" | "apiKey" | "agent" | null = null;
  const buildStart = Date.now();

  try {
    console.log(`[instant] [${appId}] runInstantBuild START`);
    const t0 = Date.now();
    const initial = await ensureSandboxForApp(appId, buildProjectType, buildModelKey);
    console.log(`[instant] [${appId}] ensureSandboxForApp done in ${Date.now() - t0}ms`);
    if (!initial) return;

    let app = initial.app;
    let sandbox = initial.sandbox;
    const workspaceId = sandbox.magsWorkspaceId!;
    const appName = app.name;
    buildWorkspaceId = workspaceId;
    buildUserId = app.userId;

    // Resolve the build profile (webapp / landing / game) — picks the scaffold,
    // prompt, and serve command. Explicit type wins, else persisted, else heuristic.
    const persistedType = (app.metadata as Record<string, unknown> | null)?.projectType as string | undefined;
    const projectType: ProjectType = detectProjectType(app.requirements ?? "", buildProjectType ?? persistedType);
    const profile = getBuildProfile(projectType);
    console.log(`[instant] [${appId}] workspaceId=${workspaceId} appName=${appName} projectType=${projectType}`);

    // Pre-flight: resolve the build backend from the user-selected model.
    //  - Anthropic model → Claude Code CLI (OAuth, or Anthropic API key / server env).
    //  - Non-Anthropic model (DeepSeek/Kimi/…) → SSH builder agent with that exact model.
    //  - No model selected → preserve legacy behavior (Claude Code, else auto SSH agent).
    let anthropicApiKey: string | undefined;
    let agentBuild: AgentBuilderSelection | null = null;

    const selectedProvider = buildModelKey ? getProviderName(buildModelKey) : null;
    const wantsAgentForModel = !!selectedProvider && selectedProvider !== "anthropic";

    if (wantsAgentForModel) {
      // User explicitly selected a non-Anthropic model — use the SSH agent with it.
      agentBuild = await resolveAgentBuilderForModel(app.userId, buildModelKey!);
      if (!agentBuild) {
        throw new Error(`No ${selectedProvider} API key found for the selected model. Add it in Settings → LLM Keys, or pick a model you have a key for.`);
      }
      buildAuthMode = "agent";
      console.log(`[instant] [${appId}] using SSH builder agent for selected model=${agentBuild.modelKey} (provider=${selectedProvider})`);
    } else {
      // Anthropic model, or no model info → Claude Code CLI (OAuth / Anthropic key).
      const auth = await resolveClaudeAuth(app.userId);
      if (auth?.mode === "oauth") {
        buildAuthMode = "oauth";
        // Always inject fresh credentials from DB into the VM before starting
        const injected = await injectCredentials(workspaceId, app.userId);
        if (!injected) {
          await markClaudeDisconnected(app.userId);
          throw new Error("Failed to inject credentials into sandbox. Please reconnect Claude Code in Settings.");
        }
        console.log(`[instant] [${appId}] credentials injected from DB into VM`);
      } else if (auth?.mode === "apiKey") {
        buildAuthMode = "apiKey";
        anthropicApiKey = auth.apiKey;
        console.log(`[instant] [${appId}] using Anthropic API key auth (Claude Code OAuth not connected)`);
      } else {
        // No Anthropic credentials — fall back to the SSH builder agent (DeepSeek/Kimi).
        agentBuild = await resolveAgentBuilder(app.userId);
        if (!agentBuild) {
          await markClaudeDisconnected(app.userId);
          throw new Error("No Claude Code connection or LLM key. Connect Claude Code or add an Anthropic, DeepSeek, or Kimi key in Settings → LLM Keys.");
        }
        buildAuthMode = "agent";
        console.log(`[instant] [${appId}] using SSH builder agent (model=${agentBuild.modelKey}, no Anthropic creds)`);
      }
    }
    const isOAuth = buildAuthMode === "oauth";
    const useAgentBuilder = buildAuthMode === "agent";

    // Compose design tokens from requirements. If the build was approved via the
    // design proposal card, prefer the design choices the user approved.
    const existingMeta = (app.metadata as Record<string, unknown>) ?? {};
    const proposal = existingMeta.proposal as InstantProposal | undefined;
    // Reuse the app's current design for additions; only redesign on explicit request.
    const effectiveDesignChoices = resolveEffectiveDesignChoices(
      existingMeta,
      designChoices ?? proposal?.designChoices,
      designChange ?? false,
    );
    // Keep the build's light/dark consistent with the approved design: infer brightness
    // from the requirements + approved plan so recomposing can't flip an approved light
    // palette back to dark (or vice-versa) off an incidental keyword in the requirements.
    const buildBrightness = inferBrightness(
      [
        app.requirements,
        proposal?.summary,
        ...((proposal?.sections ?? []).map((s) => `${s.title} ${s.description}`)),
      ]
        .filter(Boolean)
        .join(" \n "),
    );
    const tokens = composeDesignTokens(app.requirements ?? "", appName, {
      ...(effectiveDesignChoices ?? {}),
      ...(buildBrightness ? { brightness: buildBrightness } : {}),
    });

    // Build/refresh the durable spec (source of truth across builds + iterations).
    const existingSpec = existingMeta.spec as InstantSpec | undefined;
    const decisions = [...(existingSpec?.decisions ?? [])];
    if (feedback && feedback.trim()) {
      const entry = feedback.trim().slice(0, 500);
      if (!decisions.includes(entry)) decisions.push(entry);
    }
    const spec: InstantSpec = {
      appName,
      requirements: app.requirements ?? "",
      summary: proposal?.summary ?? existingSpec?.summary,
      sections: proposal?.sections ?? existingSpec?.sections,
      design: {
        palette: tokens.meta.paletteName,
        fonts: tokens.meta.fontPairingName,
        style: tokens.meta.styleProfileName,
        primary: tokens.colors.primary,
        background: tokens.colors.background,
        text: tokens.colors.text,
      },
      decisions,
      updatedAt: new Date().toISOString(),
    };

    // Store tokens + spec in app metadata (for theme swapping + durable re-injection).
    // Persist the build model so a later Restore uses the SAME backend (Pi/Claude),
    // not whatever default — otherwise restore picks the wrong rootfs.
    const buildMeta: Record<string, unknown> = {
      ...existingMeta,
      designTokens: tokens,
      // Store canonical IDs (not display names) so future additions can REUSE this
      // design — the reuse path matches on ids. Resolve from the applied token names.
      paletteId: resolvePaletteId(tokens.meta.paletteName) ?? tokens.meta.paletteName,
      fontPairingId: resolveFontPairingId(tokens.meta.fontPairingName) ?? tokens.meta.fontPairingName,
      styleProfileId: resolveStyleProfileId(tokens.meta.styleProfileName) ?? tokens.meta.styleProfileName,
      spec,
      projectType,
      ...(buildModelKey ? { buildModelKey } : {}),
    };
    await db
      .update(instantApps)
      .set({ metadata: buildMeta })
      .where(eq(instantApps.id, appId));

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
      message: `Provisioning workspace for ${appName}...`,
    });

    // NOTE: design tokens + PROJECT_SPEC.md are injected AFTER scaffolding (below) —
    // create-next-app/vite run `rm -rf /data/project/*`, which would wipe them if
    // injected here.

    // ── Decide how to set up /data/project ──────────────────────────────
    // Requested behavior:
    //   • Sandbox EXISTS + project files present  → REUSE (skip setup, apply request).
    //   • Otherwise, if a GitHub repo exists       → CLONE from GitHub (restore exact code).
    //   • Otherwise (first build, no repo)         → SCAFFOLD from spec.
    const ghToken = (await db
      .select({ accessToken: githubTokens.accessToken })
      .from(githubTokens)
      .where(eq(githubTokens.userId, app.userId))
      .limit(1))[0]?.accessToken;
    const repoUrl = (existingMeta.githubRepoUrl as string | undefined) ?? undefined;

    // Stack-agnostic resume detection (replaces the Next-only package.json check):
    //  - projectHasContent: the project dir is non-empty (any stack — Next/Python/game).
    //  - scaffoldPartial:   a PRIOR scaffold started but never finished (markers say so),
    //    so we should RESUME it (skipping completed steps) rather than reuse-as-is.
    let projectHasContent = false;
    let scaffoldPartial = false;
    if (!initial.freshVm) {
      const probe = await execOnWorkspace(
        workspaceId,
        `test -n "$(ls -A ${CLAUDE_PROJECT_DIR} 2>/dev/null)" && echo HAS || echo EMPTY; ` +
          `if test -f ${LFG_MARKER_DIR}/scaffold.inprogress && ! test -f ${LFG_MARKER_DIR}/scaffold.done; then echo PARTIAL; fi`,
        { timeout: 20_000 },
      ).then((r) => r.output).catch(() => "");
      projectHasContent = /\bHAS\b/.test(probe);
      scaffoldPartial = /\bPARTIAL\b/.test(probe);
    }

    let setupMode: "reuse" | "clone" | "scaffold";
    if (scaffoldPartial) setupMode = "scaffold";        // resume an interrupted scaffold (skips done steps, no rm)
    else if (projectHasContent) setupMode = "reuse";    // fully built (or legacy) → iterate in place
    else if (repoUrl && ghToken) setupMode = "clone";   // reaped VM → restore from GitHub
    else setupMode = "scaffold";                         // brand-new build
    console.log(`[instant] [${appId}] setup mode = ${setupMode} (freshVm=${initial.freshVm}, hasContent=${projectHasContent}, scaffoldPartial=${scaffoldPartial}, hasRepo=${!!repoUrl})`);

    // Restore from GitHub when resuming a reaped/empty sandbox.
    if (setupMode === "clone") {
      await broadcastInstantStatus({
        userId: app.userId, conversationId: app.conversationId, appId: app.appId, appName,
        status: "building", message: `Restoring ${appName} from GitHub...`,
      });
      const cloned = await cloneRepo({ workspaceId, projectDir: CLAUDE_PROJECT_DIR, repoUrl: repoUrl!, githubToken: ghToken! });
      if (!cloned) {
        console.warn(`[instant] [${appId}] clone failed — falling back to scaffold`);
        setupMode = "scaffold";
      }
    }

    // INCOMPLETE-project guard: a reuse/clone assumes the app is fully built and tells the
    // agent "just run it, don't write code". But a restored repo can be incomplete (e.g. an
    // earlier push failed before app.py was committed → only helper files exist). If the
    // stack's ENTRY POINT is missing, the project is NOT complete — fall back to a full
    // build so the agent regenerates the missing app instead of crashing on "no such file".
    if (setupMode === "reuse" || setupMode === "clone") {
      const entryPoint = projectType === "python" ? "app.py" : "package.json";
      const hasEntry = await execOnWorkspace(
        workspaceId,
        `test -f ${CLAUDE_PROJECT_DIR}/${entryPoint} && echo YES || echo NO`,
        { timeout: 20_000 },
      ).then((r) => r.output.includes("YES")).catch(() => false);
      if (!hasEntry) {
        console.warn(`[instant] [${appId}] ${setupMode} project missing entry point (${entryPoint}) — incomplete, doing a full build`);
        setupMode = "scaffold";
      }
    }

    // Only a fresh scaffold counts as a "new build" (API-key analysis + scaffold steps).
    const isNewBuild = setupMode === "scaffold";

    // API key research (only on new builds). Uses generateObject (structured output),
    // which DeepSeek/Kimi's API don't support (they 400 on response_format) — so only
    // run it for providers that do (Anthropic/OpenAI/Google), with the build's own
    // model + key. Skipped (not failed) otherwise; it's a best-effort convenience step.
    let apiAnalysis: ApiKeyAnalysis | null = null;
    const analysisProvider = agentBuild?.provider ?? getProviderName(buildModelKey ?? "") ?? "anthropic";
    const analysisSupportsStructured = ["anthropic", "openai", "google"].includes(analysisProvider);
    if (isNewBuild && analysisSupportsStructured) {
      try {
        const analysisModel = agentBuild
          ? getModel(agentBuild.modelKey, agentBuild.userApiKeys)
          : getModel(buildModelKey ?? "claude_4.5_haiku", undefined, { allowEnvFallback: true });
        apiAnalysis = await analyzeRequirementsForApiKeys(app, analysisModel);
        // Re-read app from DB to pick up any newly-saved envVars
        const [refreshed] = await db
          .select()
          .from(instantApps)
          .where(eq(instantApps.id, appId))
          .limit(1);
        if (refreshed) app = refreshed;
      } catch (err) {
        console.error(`[instant] [${appId}] API key analysis failed, continuing:`, err);
      }
    } else if (isNewBuild) {
      console.log(`[instant] [${appId}] skipping API key analysis — provider '${analysisProvider}' has no structured-output support`);
    }

    if (isNewBuild) {
      // Boilerplate VMs ship the scaffold pre-baked — but only trust that if the
      // project is actually present. A misconfigured/empty template must fall back to
      // a normal scaffold instead of hard-failing every new build.
      let needScaffold = !initial.prescaffolded;
      if (initial.prescaffolded) {
        const ready = await execOnWorkspace(
          workspaceId,
          `test -f ${CLAUDE_PROJECT_DIR}/package.json && test -d ${CLAUDE_PROJECT_DIR}/node_modules && echo YES || echo NO`,
          { timeout: 20_000 }
        ).then((r) => r.output.includes("YES")).catch(() => false);
        if (ready) {
          console.log(`[instant] [${appId}] pre-scaffolded boilerplate VM verified — skipping ${profile.scaffoldSteps.length} scaffold steps`);
        } else {
          console.warn(`[instant] [${appId}] boilerplate VM missing /data/project scaffold — falling back to normal scaffold`);
          needScaffold = true;
        }
      }
      if (needScaffold) {
        // Profile-driven scaffold (webapp → Next.js+shadcn, landing → +framer-motion,
        // game → Vite+three.js, python → venv+Flask). Idempotent + resumable: mark the
        // phase in-progress and read which steps a prior run already finished, so a build
        // resumed after a mid-scaffold interruption SKIPS completed steps instead of
        // re-nuking the project and re-running a slow install. Universal across stacks.
        const doneSteps = await execOnWorkspace(
          workspaceId,
          `mkdir -p ${LFG_MARKER_DIR}; rm -f ${LFG_MARKER_DIR}/scaffold.done; touch ${LFG_MARKER_DIR}/scaffold.inprogress; ls ${LFG_MARKER_DIR}/ 2>/dev/null`,
          { timeout: 20_000 },
        ).then((r) => new Set(r.output.match(/step_\d+\.ok/g) ?? [])).catch(() => new Set<string>());

        for (let i = 0; i < profile.scaffoldSteps.length; i++) {
          const step = profile.scaffoldSteps[i]!;
          const marker = `step_${i}.ok`;
          if (doneSteps.has(marker)) {
            console.log(`[instant] [${appId}] scaffold step ${i} already complete — skipping (${step.message})`);
            continue;
          }
          await broadcastInstantStatus({
            userId: app.userId,
            conversationId: app.conversationId,
            appId: app.appId,
            appName,
            status: "building",
            message: step.message,
          });
          console.log(`[instant] [${appId}] scaffold step ${i}: ${step.message}${step.slow ? " (detached)" : ""}`);
          // Slow steps (big pip/apt installs) run detached + polled so a >100s
          // command never trips Cloudflare's ~100s 524 on a single held request.
          const stepResult = step.slow
            ? await runDetachedStep(workspaceId, step.script, i, { appId })
            : await execOnWorkspace(
                workspaceId,
                `echo '${Buffer.from(step.script).toString("base64")}' | base64 -d | sh`,
                { timeout: 180_000 },
              );
          console.log(`[instant] [${appId}] scaffold step ${i} done, exit=${stepResult.exitCode}`);
          if (stepResult.exitCode !== 0) {
            // Surface the failure output (tail) so a failing npm install / shadcn is diagnosable.
            const out = `${stepResult.output ?? ""}${stepResult.stderr ? `\n[stderr] ${stepResult.stderr}` : ""}`;
            console.warn(`[instant] [${appId}] scaffold step ${i} FAILED (exit=${stepResult.exitCode}) — last output:\n${out.slice(-1500)}`);
          } else {
            // Only a fully-successful step earns its marker → a failed step re-runs on resume.
            await execOnWorkspace(workspaceId, `touch ${LFG_MARKER_DIR}/${marker}`, { timeout: 15_000 }).catch(() => {});
          }
        }
        // Scaffolding phase finished (the coding agent takes over from here). If the VM
        // dies mid-scaffold before this runs, scaffold.done is absent → the next build
        // resumes the scaffold instead of restarting it.
        await execOnWorkspace(workspaceId, `touch ${LFG_MARKER_DIR}/scaffold.done; rm -f ${LFG_MARKER_DIR}/scaffold.inprogress`, { timeout: 15_000 }).catch(() => {});
        console.log(`[instant] [${appId}] server-side pre-scaffolding complete (${projectType})`);
      }

      // Mark scaffolded so future change requests skip scaffolding (don't wipe work).
      await db
        .update(instantApps)
        .set({ metadata: { ...buildMeta, scaffolded: true } })
        .where(eq(instantApps.id, appId));
    }

    // ── Inject design tokens + spec AFTER scaffolding (so create-next-app's rm -rf
    //    doesn't wipe them). Done every build so reused VMs stay in sync. ──
    const tokensB64 = Buffer.from(JSON.stringify(tokens, null, 2)).toString("base64");
    await execOnWorkspace(workspaceId, `mkdir -p /data/project && echo '${tokensB64}' | base64 -d > /data/project/tokens.json`);
    const cssByte = Buffer.from(generateTokensCss(tokens)).toString("base64");
    await execOnWorkspace(workspaceId, `echo '${cssByte}' | base64 -d > /data/project/design-tokens.css`);
    const specB64 = Buffer.from(buildSpecMarkdown(spec)).toString("base64");
    await execOnWorkspace(workspaceId, `echo '${specB64}' | base64 -d > /data/project/PROJECT_SPEC.md`);

    // On a fresh scaffold, append the design tokens to the global stylesheet (once).
    if (isNewBuild && profile.globalCssPath) {
      const cssPath = `/data/project/${profile.globalCssPath}`;
      await execOnWorkspace(
        workspaceId,
        `if [ -f ${JSON.stringify(cssPath)} ]; then cat /data/project/design-tokens.css >> ${JSON.stringify(cssPath)}; fi`
      ).catch((e) => console.warn(`[instant] [${appId}] globals.css append failed: ${(e as Error).message?.slice(0, 120)}`));
    }
    console.log(`[instant] [${appId}] tokens.json + design-tokens.css + PROJECT_SPEC.md injected post-scaffold (palette=${tokens.meta.paletteName}, decisions=${spec.decisions.length})`);

    const specSection = `
## Project Spec — Source of Truth (READ FIRST)
The file \`/data/project/PROJECT_SPEC.md\` holds the authoritative architecture,
requirements, business rules, and the accumulated decisions log for this app
(alongside \`tokens.json\` / \`design-tokens.css\` for design). READ PROJECT_SPEC.md
BEFORE doing anything and treat it as the contract — do not contradict its
architecture, business rules, or design decisions. If this request changes a prior
decision, update PROJECT_SPEC.md to match, then implement the change.
`;

    // Build API key context section for the prompt
    let apiKeySection = "";
    if (apiAnalysis?.apiKeys.length) {
      const currentEnvVars = (app.envVars as Record<string, string> | null) ?? {};
      const lines = apiAnalysis.apiKeys.map((k) => {
        const provided = !!currentEnvVars[k.key];
        return `- ${k.key} — ${k.service}: ${k.description} (${provided ? "PROVIDED" : "NOT PROVIDED"})`;
      });
      apiKeySection = `
## External API Keys
The following external services were identified for this app:
${lines.join("\n")}

Access provided keys via process.env.VARIABLE_NAME. Do NOT hardcode API keys.
For keys marked "(NOT PROVIDED)", the feature WILL NOT work until the user provides the key. Build the integration code that reads from the env var, but do NOT use mock data or placeholder values. If the key is missing at runtime, show a clear message telling the user to provide the API key.
`;
    }

    // The build profile (webapp / landing / game) owns the design, memory, stack
    // rules and serve command. Continue mode only applies to Claude (session resume).
    const shouldContinue = !!feedback && !!sandbox.cliSessionId;

    // Pure RESUME: code was restored (clone/reuse) and there's no new request → don't
    // regenerate the app; just build it and start the server. Avoids Pi rewriting a
    // complete, working project (wasteful + risks drift).
    const isResumeOnly = (setupMode === "clone" || setupMode === "reuse") && !feedback;
    const prompt = isResumeOnly
      ? `The project in /data/project is ALREADY COMPLETE and was just restored from source control. Do NOT rewrite, re-scaffold, or re-implement anything.

Your ONLY job: get it running on 0.0.0.0:8080.
1. export PATH=/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
2. cd /data/project
3. If there is no node_modules, run: npm install
4. Build + start using the project's scripts, bound to 0.0.0.0:8080, detached with nohup → dev.log
   (Next.js: npm run build && nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 & ;
    Vite: nohup npm run dev -- --host 0.0.0.0 --port 8080 > dev.log 2>&1 &)
5. Verify: sleep 3 && curl -s http://localhost:8080/ || true
Do NOT use TodoWrite. Do NOT edit source files. Just install (if needed), build, and start.`
      : profile.buildPrompt({
          appName,
          requirements: app.requirements ?? "",
          feedback,
          shouldContinue,
          tokens,
          specSection,
          apiKeySection,
        });

    await broadcastInstantStatus({
      userId: app.userId,
      conversationId: app.conversationId,
      appId: app.appId,
      appName,
      status: "building",
      message: shouldContinue
        ? `Applying your changes to ${appName}...`
        : `Building ${appName}...`,
    });

    // Free the VM before launching the coding agent. A REUSED sandbox accumulates stray
    // processes across builds (old Flask/Vite/Next dev servers, zombie pi/node from failed
    // runs), eating RAM until a fresh Pi run gets silently OOM-killed by the cgroup limit
    // → "Pi produced no files (no tool calls)" with an empty output file. Kill known strays
    // (NOT our own exec/node) and drop caches so the agent has headroom. Best-effort.
    if (!initial.freshVm) {
      // FREE /tmp FIRST — on these VMs /tmp is a RAM tmpfs, and after many builds it fills
      // with leftover pi_* files, which then silently swallows Pi's output writes (the root
      // cause of endless "Pi produced no files"). Lead with the rm (short, runs even when
      // /tmp is full), then kill stray app/build processes to reclaim RAM. Report df+free.
      const cleanup =
        "rm -rf /tmp/pi_* /tmp/node22.tar.gz /tmp/*.jsonl /tmp/*.log 2>/dev/null; " +
        "pkill -9 -f 'python.*app.py' 2>/dev/null; pkill -9 -f 'flask run' 2>/dev/null; " +
        "pkill -9 -f gunicorn 2>/dev/null; pkill -9 -f 'next start' 2>/dev/null; " +
        "pkill -9 -f 'next-server' 2>/dev/null; pkill -9 -f vite 2>/dev/null; " +
        "pkill -9 -f pi-coding-agent 2>/dev/null; sync 2>/dev/null; " +
        "df -h /tmp 2>/dev/null | tail -1; free -m 2>/dev/null | head -2; true";
      const out = await execOnWorkspace(workspaceId, cleanup, { timeout: 30_000 }).then((r) => r.output?.trim() ?? "").catch(() => "");
      console.log(`[instant] [${appId}] pre-build cleanup done — /tmp + mem after:\n${out}`);
    }

    // Claude Code resumes via session id; the SSH agent has no session concept.
    let sessionId = sandbox.cliSessionId ?? undefined;

    const piProvider = agentBuild?.provider ?? "";
    const usePi = useAgentBuilder && !!agentBuild && USE_PI_IN_SANDBOX && isPiSupportedProvider(piProvider);

    if (usePi && agentBuild) {
      // ── In-sandbox Pi coding agent (user-selected model + their key) ──
      const piModelId = getProviderModel(agentBuild.modelKey) ?? agentBuild.modelKey;
      const apiKey = agentBuild.userApiKeys[piProvider as keyof typeof agentBuild.userApiKeys];
      if (!apiKey) {
        throw new Error(`No ${piProvider} API key found for the selected model. Add it in Settings → LLM Keys.`);
      }
      const t1 = Date.now();
      console.log(`[instant] [${appId}] running Pi in sandbox (${piProvider}/${piModelId})...`);
      // Live build-activity forwarder: the in-VM forwarder parses Pi's JSONL and POSTs
      // compact tool-call ops to LFG in real time. Needs the user's CLI key + a server
      // URL the VM can reach (graceful no-op if missing/unreachable — the poll fallback
      // below still gives coarse progress).
      const [cliProfile] = await db
        .select({ cliApiKey: profiles.cliApiKey })
        .from(profiles)
        .where(eq(profiles.userId, app.userId))
        .limit(1);
      // APP_URL is the var the (working) ticket-executor callback uses — include it so a
      // dev ngrok set as APP_URL works without extra config; LFG_API_URL/PUBLIC_URL win if set.
      const forwardApiUrl =
        process.env.LFG_API_URL ||
        process.env.PUBLIC_URL ||
        process.env.APP_URL ||
        `http://localhost:${process.env.PORT || 8000}`;
      // Auto-provision the CLI callback key if the user doesn't have one yet — same
      // format the Settings "generate key" action uses — so the live forwarder works
      // without making the user generate one first.
      let cliApiKey = cliProfile?.cliApiKey ?? null;
      if (!cliApiKey) {
        cliApiKey = `lfg_cli_${crypto.randomUUID().replace(/-/g, "")}`;
        await db
          .insert(profiles)
          .values({ userId: app.userId, cliApiKey })
          .onConflictDoUpdate({ target: profiles.userId, set: { cliApiKey, updatedAt: new Date() } });
      }
      const forward = { apiUrl: forwardApiUrl, apiKey: cliApiKey, appId: app.appId };
      // Resume loop: a weak model (Flash) on a heavy task can run out of memory or hit
      // the tool-call budget WITH real work already on disk. Rather than throwing that
      // work away, restart Pi to CONTINUE from the current project state. Each attempt
      // gets a fresh tool-call budget; we clean up leftover procs + free RAM between
      // attempts so an OOM doesn't immediately recur. Only RESUMABLE failures loop
      // (see pi-cli `resumable`); auth/quota/stall failures fall straight through.
      const maxAttempts = parseInt(process.env.INSTANT_PI_MAX_ATTEMPTS || "3", 10);
      let piResult!: Awaited<ReturnType<typeof streamPiToCompletion>>;
      let lastPiBroadcast = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const isResume = attempt > 1;
        if (isResume) {
          // Free the VM before restarting: kill the OOM leftovers (a half-loaded torch/
          // docling subprocess can hold GBs) and drop caches so the next run starts clean.
          await execOnWorkspace(
            workspaceId,
            `pkill -9 -f 'python|pip|torch|docling|node .*forward' 2>/dev/null; sync; echo 1 > /proc/sys/vm/drop_caches 2>/dev/null; free -m | head -2; true`,
            { timeout: 25_000 },
          ).catch(() => {});
          await broadcastInstantStatus({
            userId: app.userId,
            conversationId: app.conversationId,
            appId: app.appId,
            appName,
            status: "building",
            message: `Build hit a resource limit — resuming where it left off (attempt ${attempt}/${maxAttempts})…`,
          });
          console.log(`[instant] [${appId}] Pi RESUME attempt ${attempt}/${maxAttempts} (prev: ${piResult.oomKilled ? "OOM" : "runaway"}, toolCalls=${piResult.toolCalls})`);
        }
        const pi = await startPiCli({
          workspaceId,
          prompt: isResume ? buildPiResumePrompt(prompt, projectType) : prompt,
          projectDir: PROJECT_DIR,
          provider: piProvider,
          modelId: piModelId,
          apiKey,
          envVars: (app.envVars as Record<string, string> | null) ?? {},
          forward,
        });
        piResult = await streamPiToCompletion({
          workspaceId,
          outputFile: pi.outputFile,
          backgroundPid: pi.backgroundPid,
          timeoutMs: BUILD_TIMEOUT_MS,
          shouldCancel: () => cancelledBuilds.has(appId),
          onProgress: (msg) => {
            const now = Date.now();
            if (now - lastPiBroadcast < 5_000) return;
            lastPiBroadcast = now;
            void broadcastInstantStatus({
              userId: app.userId,
              conversationId: app.conversationId,
              appId: app.appId,
              appName,
              status: "building",
              message: msg,
            });
          },
        });
        console.log(`[instant] [${appId}] Pi build done in ${Date.now() - t1}ms (attempt ${attempt}/${maxAttempts}), exitCode=${piResult.exitCode}, fatal=${piResult.fatalError ? "yes" : "no"}, didWork=${piResult.didWork}, toolCalls=${piResult.toolCalls}, resumable=${piResult.resumable}`);
        // Clean finish, or a failure we can't fix by restarting → stop looping.
        if (!piResult.resumable || attempt >= maxAttempts) break;
        // Resumable (OOM / runaway) with work on disk → loop and continue the build.
        console.warn(`[instant] [${appId}] Pi ${piResult.oomKilled ? "OOM-killed" : "ran away"} with work present — will resume (attempt ${attempt} of ${maxAttempts}).`);
      }
      if (piResult.exitCode !== null && piResult.exitCode !== 0) {
        console.error(`[instant] [${appId}] Pi output tail:\n${piResult.tail.slice(-2500)}`);
        throw new Error(`Pi build failed with exit code ${piResult.exitCode}`);
      }
      // Pi exits 0 even on an API auth/quota failure — streamPiToCompletion detects
      // that VM-side (only when the agent produced ZERO successful output). A resumable
      // failure that survived all attempts still carries a fatalError; but if the project
      // is actually up we'd rather validate the URL than hard-fail — so treat a resumable
      // fatal as non-fatal here and let the URL check below be the source of truth.
      if (piResult.fatalError && !piResult.resumable) {
        console.error(`[instant] [${appId}] Pi output tail:\n${piResult.tail.slice(-2500)}`);
        throw new Error(`Pi build failed: ${piResult.fatalError}`);
      }
      if (piResult.fatalError && piResult.resumable) {
        console.warn(`[instant] [${appId}] Pi exhausted ${maxAttempts} resume attempts (${piResult.fatalError}) — proceeding to URL validation with whatever was built.`);
      }
      // Pi made ZERO tool calls → it wrote no files. Do NOT claim success (which would
      // sync an empty project to GitHub). Surface the output so we can see why.
      if (!piResult.didWork) {
        console.error(`[instant] [${appId}] Pi made no tool calls — output tail:\n${piResult.tail.slice(-3000)}`);
        throw new Error("Pi produced no files (no tool calls). It may have only replied with text, or hit an early error — check the build logs.");
      }
    } else if (useAgentBuilder && agentBuild) {
      // ── Fallback: server-side SSH builder agent (DeepSeek/Kimi) ──
      const t1 = Date.now();
      console.log(`[instant] [${appId}] running SSH builder agent (${agentBuild.modelKey})...`);
      let lastAgentBroadcast = 0;
      const agentResult = await runAgenticBuild({
        workspaceId,
        systemPrompt: getInstantBuilderSystemPrompt(),
        userPrompt: prompt,
        userId: app.userId,
        modelKey: agentBuild.modelKey,
        userApiKeys: agentBuild.userApiKeys,
        envVars: (app.envVars as Record<string, string> | null) ?? {},
        maxSteps: shouldContinue ? 80 : 120,
        projectDir: CLAUDE_PROJECT_DIR,
        onProgress: (msg) => {
          const now = Date.now();
          if (now - lastAgentBroadcast < 5_000) return;
          lastAgentBroadcast = now;
          void broadcastInstantStatus({
            userId: app.userId,
            conversationId: app.conversationId,
            appId: app.appId,
            appName,
            status: "building",
            message: msg,
          });
        },
      });
      console.log(`[instant] [${appId}] SSH builder agent done in ${Date.now() - t1}ms, steps=${agentResult.steps}, finishReason=${agentResult.finishReason}`);
    } else {
      // ── Claude Code CLI (OAuth or Anthropic API key) ──
      const t1 = Date.now();
      console.log(`[instant] [${appId}] calling startClaudeCli...`);
      const cli = await startClaudeCli({
        workspaceId,
        prompt,
        projectDir: PROJECT_DIR,
        sessionId: shouldContinue ? sandbox.cliSessionId ?? undefined : undefined,
        maxTurns: shouldContinue ? 60 : 80,
        userId: app.userId,
        envVars: (app.envVars as Record<string, string> | null) ?? {},
        anthropicApiKey,
      });
      console.log(`[instant] [${appId}] startClaudeCli done in ${Date.now() - t1}ms, outputFile=${cli.outputFile}, pid=${cli.backgroundPid}`);

      let offset = 0;
      let allOutput = "";
      let completed = false;
      let lastProgressAt = 0;
      let consecutivePollErrors = 0;
      // Blind-window resilience: a flaky control-plane (exec timeouts) must not kill a
      // build that's still alive in the VM — verify liveness before giving up.
      let cliBlindSince = 0;
      const CLI_BLIND_LIMIT_MS = 5 * 60_000;
      const deadline = Date.now() + BUILD_TIMEOUT_MS;

      while (Date.now() < deadline && !completed) {
        await sleep(POLL_INTERVAL_MS);
        if (cancelledBuilds.has(appId)) throw new Error(BUILD_CANCELLED_MARKER);
        let poll: Awaited<ReturnType<typeof pollOutput>>;
        try {
          poll = await pollOutput(workspaceId, cli.outputFile, offset, cli.backgroundPid);
          consecutivePollErrors = 0;
          cliBlindSince = 0;
        } catch (pollErr) {
          consecutivePollErrors++;
          const emsg = (pollErr as Error).message?.slice(0, 120);
          console.warn(`[instant] Poll error (${consecutivePollErrors}):`, emsg);
          if (consecutivePollErrors >= 2) {
            const job = await findJob(workspaceId).catch(() => null);
            const vmAlive = !!job && (job.status === "running" || job.status === "sleeping");
            if (!vmAlive) throw new Error(`build VM is no longer running (status: ${job?.status ?? "unknown"}) — ${emsg}`);
            if (cliBlindSince === 0) cliBlindSince = Date.now();
            if (Date.now() - cliBlindSince > CLI_BLIND_LIMIT_MS) {
              throw new Error(`lost contact with a LIVE build VM for ${Math.round((Date.now() - cliBlindSince) / 60000)}min — giving up. Last error: ${emsg}`);
            }
            await sleep(POLL_INTERVAL_MS); // back off; the VM is alive, just slow to answer
          }
          continue; // transient error — retry next interval
        }
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
      // Verify auth by running `claude auth status` on the VM (not by scanning output,
      // which would false-positive on app code containing strings like "not logged in")
      // `claude auth status` only reflects OAuth login — skip it in API-key mode.
      if (exitCode !== null && exitCode !== 0 && isOAuth && await hasAuthError(workspaceId)) {
        throw new Error("Claude Code authentication failed. Reconnect in Settings.");
      }
      if (exitCode !== null && exitCode !== 0) {
        throw new Error(`Claude CLI failed with exit code ${exitCode}`);
      }
    }

    // User asked to stop mid-build → tear down here, BEFORE starting the server, minting
    // a URL, or pushing to GitHub. The catch below turns this into a clean "stopped".
    if (cancelledBuilds.has(appId)) throw new Error(BUILD_CANCELLED_MARKER);

    // Make sure the dev server is actually running and SURVIVES (the agent's own
    // background start often gets reaped → "built ok but 500"). Restart it robustly.
    await ensureDevServerRunning(workspaceId, projectType);

    // Honesty check (Python): if the user explicitly asked for libraries that couldn't be
    // installed here (heavy/native ML deps have no musl wheels on this sandbox), say so
    // plainly instead of letting the agent's silent fallback pass as "done".
    if (projectType === "python") {
      const missingLibs = await verifyRequestedPythonLibs(workspaceId, app.requirements ?? "").catch(() => [] as string[]);
      if (missingLibs.length) {
        console.warn(`[instant] [${appId}] requested Python libs NOT installed: ${missingLibs.join(", ")}`);
        const libs = missingLibs.join(", ");
        const plural = missingLibs.length > 1;
        await broadcastInstantStatus({
          userId: app.userId,
          conversationId: app.conversationId,
          appId: app.appId,
          appName,
          status: "building",
          message: `⚠️ Requested ${plural ? "libraries" : "library"} ${libs} could NOT be installed in the sandbox (heavy/native deps have no musl wheels here), so the app was built WITHOUT ${plural ? "them" : "it"} — it uses lighter fallbacks. Running ${libs} needs a glibc/Debian environment.`,
        });
      }
    }

    // STABLE URL: point a per-app subdomain alias at the CURRENT VM. Each VM gets its
    // own random subdomain, so without an alias the URL would change on every
    // reap/restore (and a stored URL would point at the dead old VM → 500). The alias
    // (e.g. coinsight-app-9c47eb.apps.mags.run) is minted once, persisted, and re-pointed
    // to the live VM on every build — so the public URL never changes.
    const stableAlias = (existingMeta.urlAlias as string | undefined)
      ?? `${appName}-${app.appId.replace(/-/g, "").slice(0, 6)}`.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 50);
    let previewUrl = "";
    try {
      await enableHttpAccess(workspaceId, 8080); // open the HTTP port on the current VM
      previewUrl = await setStableUrl(stableAlias, workspaceId); // stable alias → current VM
      console.log(`[instant] [${appId}] stable URL: ${previewUrl} → ${workspaceId}`);
    } catch (e) {
      console.warn(`[instant] [${appId}] stable-URL setup failed, falling back: ${(e as Error).message?.slice(0, 120)}`);
      previewUrl = await enableHttpAccess(workspaceId, 8080).catch(() => normalizeMagsAppUrl(app.previewUrl ?? sandbox.previewUrl ?? ""));
    }

    // Process-aware wait: don't declare "did NOT come up" while it's still compiling.
    const isLive = await waitForLocalServer(workspaceId, 90_000);

    // ── Validate Public URL & Auto-Fix ─────────────────────────────
    let publicUrlValid = false;
    if (previewUrl) {
      console.log(`[instant] Validating public URL: ${previewUrl}`);
      const validation = await validatePublicUrl(previewUrl);
      publicUrlValid = validation.ok;

      if (!validation.ok && (sessionId || useAgentBuilder)) {
        console.log(
          `[instant] Public URL validation failed (HTTP ${validation.statusCode}): ${validation.error}`
        );

        await broadcastInstantStatus({
          userId: app.userId,
          conversationId: app.conversationId,
          appId: app.appId,
          appName,
          status: "building",
          message: `Public URL returned an error — diagnosing and fixing...`,
        });

        const fixPrompt = `The app was built and the server started, but the public URL returned an error:
URL: ${previewUrl}
HTTP Status: ${validation.statusCode}
Response body (truncated):
${validation.body ?? "(no body)"}

Please diagnose and fix this issue. Check dev.log for server errors:
  cat /data/project/dev.log | tail -50

After fixing, rebuild and restart the server:
  cd /data/project && npm run build && (pkill -f 'next start' 2>/dev/null || true) && nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 &

Then wait 3 seconds and verify with: curl -s http://localhost:8080/ || true`;

        if (usePi && agentBuild) {
          // Re-run Pi in the sandbox with the fix prompt (max 1 auto-fix attempt)
          const fixModelId = getProviderModel(agentBuild.modelKey) ?? agentBuild.modelKey;
          const fixApiKey = agentBuild.userApiKeys[piProvider as keyof typeof agentBuild.userApiKeys];
          if (fixApiKey) {
            const fixPi = await startPiCli({
              workspaceId,
              prompt: fixPrompt,
              projectDir: PROJECT_DIR,
              provider: piProvider,
              modelId: fixModelId,
              apiKey: fixApiKey,
              envVars: (app.envVars as Record<string, string> | null) ?? {},
            });
            let lastFixBroadcast = 0;
            await streamPiToCompletion({
              workspaceId,
              outputFile: fixPi.outputFile,
              backgroundPid: fixPi.backgroundPid,
              timeoutMs: 10 * 60 * 1000,
              onProgress: (msg) => {
                const now = Date.now();
                if (now - lastFixBroadcast < 5_000) return;
                lastFixBroadcast = now;
                void broadcastInstantStatus({
                  userId: app.userId,
                  conversationId: app.conversationId,
                  appId: app.appId,
                  appName,
                  status: "building",
                  message: `Fixing: ${msg}`,
                });
              },
            });
          }
        } else if (useAgentBuilder && agentBuild) {
          // Re-run the SSH builder agent with the fix prompt (max 1 auto-fix attempt)
          let lastFixBroadcast = 0;
          await runAgenticBuild({
            workspaceId,
            systemPrompt: getInstantBuilderSystemPrompt(),
            userPrompt: fixPrompt,
            userId: app.userId,
            modelKey: agentBuild.modelKey,
            userApiKeys: agentBuild.userApiKeys,
            envVars: (app.envVars as Record<string, string> | null) ?? {},
            maxSteps: 50,
            projectDir: CLAUDE_PROJECT_DIR,
            onProgress: (msg) => {
              const now = Date.now();
              if (now - lastFixBroadcast < 5_000) return;
              lastFixBroadcast = now;
              void broadcastInstantStatus({
                userId: app.userId,
                conversationId: app.conversationId,
                appId: app.appId,
                appName,
                status: "building",
                message: `Fixing: ${msg}`,
              });
            },
          });
        } else {
          // Resume Claude CLI with the fix prompt (max 1 auto-fix attempt)
          const fixCli = await startClaudeCli({
            workspaceId,
            prompt: fixPrompt,
            projectDir: PROJECT_DIR,
            sessionId,
            maxTurns: 40,
            userId: app.userId,
            envVars: (app.envVars as Record<string, string> | null) ?? {},
            anthropicApiKey,
          });

          let fixOffset = 0;
          let fixOutput = "";
          let fixCompleted = false;
          const fixDeadline = Date.now() + 10 * 60 * 1000; // 10 min for fix

          let fixPollErrors = 0;
          while (Date.now() < fixDeadline && !fixCompleted) {
            await sleep(POLL_INTERVAL_MS);
            let poll: Awaited<ReturnType<typeof pollOutput>>;
            try {
              poll = await pollOutput(workspaceId, fixCli.outputFile, fixOffset, fixCli.backgroundPid);
              fixPollErrors = 0;
            } catch (pollErr) {
              fixPollErrors++;
              if (fixPollErrors >= 5) break;
              continue;
            }
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

    // Confirm the URL before declaring the app done. If the server never came up on
    // :8080 (isLive=false, after checkLocalServer's retries ≈ 15–24s), the app is NOT
    // working — do NOT mark it "running" (that's how a crashed/incomplete build showed
    // as live). Mark "error" so the user sees the truth and can retry.
    const finalStatus = isLive ? "running" : "error";
    await db
      .update(instantApps)
      .set({
        status: finalStatus,
        previewUrl,
        // Persist the stable alias so it's reused on every future build/restore.
        metadata: { ...buildMeta, scaffolded: true, urlAlias: stableAlias },
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

    // Save refreshed credentials from VM back to DB (CLI may have refreshed the OAuth token).
    // Only relevant in OAuth mode — API-key builds write no credentials file.
    if (isOAuth) {
      await saveCredentialsFromVm(workspaceId, app.userId).catch((err) =>
        console.warn(`[instant] Failed to save credentials from VM:`, err)
      );
    }

    const statusMessage =
      isLive && publicUrlValid
        ? `${appName} is live!`
        : isLive && !publicUrlValid
          ? `${appName} is running but the public URL is still warming up — refresh the preview in a few seconds.`
          : `${appName} did NOT come up — the server isn't responding on port 8080, so the build looks incomplete or crashed on startup. Check the Logs tab; say "retry" to rebuild.`;

    await broadcastInstantStatus({
      userId: app.userId,
      conversationId: app.conversationId,
      appId: app.appId,
      appName,
      // Only "running" once the server is actually confirmed up; otherwise surface "error".
      status: finalStatus,
      message: statusMessage,
      previewUrl,
    });

    // ── Post-build QA: cloud-browser screen tests (plug-and-play module) ──
    // Fire-and-forget: the module self-gates (INSTANT_APP_TESTING / future plan
    // gate), never throws, and tears down its own browser VM. Only when live.
    if (isLive && previewUrl) {
      void testInstantApp({
        appId: app.appId,
        appDbId: appId,
        userId: app.userId,
        conversationId: app.conversationId,
        appName,
        previewUrl,
        buildWorkspaceId: workspaceId,
        onIssues: (report) =>
          handleQaIssues({
            appDbId: appId,
            appId: app.appId,
            userId: app.userId,
            conversationId: app.conversationId,
            appName,
            previewUrl,
            report,
          }),
      });
    }

    // ── Auto-sync to GitHub if user has a connected GitHub account ──
    // Only back up a CONFIRMED-WORKING build. Pushing a broken/incomplete build would
    // overwrite a good backup and make the next restore boot a broken app.
    if (!isLive) {
      console.log(`[instant] [${appId}] server not up — skipping GitHub auto-sync (won't overwrite a good backup with a broken build)`);
    }
    try {
      if (!isLive) throw new Error("__SKIP_SYNC_SERVER_DOWN__");
      console.log(`[instant] [${appId}] Checking for GitHub token to auto-sync...`);
      const [ghToken] = await db
        .select({ accessToken: githubTokens.accessToken })
        .from(githubTokens)
        .where(eq(githubTokens.userId, app.userId))
        .limit(1);

      if (!ghToken?.accessToken) {
        console.log(`[instant] [${appId}] No GitHub token found — skipping auto-sync`);
      } else {
        console.log(`[instant] [${appId}] GitHub token found, starting auto-sync for ${appName}...`);

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
        console.log(`[instant] [${appId}] Creating/finding GitHub repo: ${repoName}`);
        const repo = await createGitHubRepo({
          repoName,
          description: `Built with LFG Instant Mode: ${(app.description ?? app.name).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100).trim()}`,
          isPrivate: true,
          githubToken: ghToken.accessToken,
        });
        console.log(`[instant] [${appId}] GitHub repo result: created=${repo.created} repoUrl=${repo.repoUrl} cloneUrl=${repo.cloneUrl}`);

        if (repo.created) {
          // Fresh repo — init and push to main
          console.log(`[instant] [${appId}] Fresh repo — running initAndPushRepo to ${repo.cloneUrl}...`);
          await retryTransient(() => initAndPushRepo({
            workspaceId,
            projectDir: CLAUDE_PROJECT_DIR,
            repoUrl: repo.cloneUrl,
            branch: "main",
            githubToken: ghToken.accessToken,
          }), "initAndPushRepo", appId);
          console.log(`[instant] [${appId}] initAndPushRepo completed successfully`);
        } else {
          // Existing repo — commit and push to main
          console.log(`[instant] [${appId}] Existing repo — running commitAndPush to ${repo.cloneUrl}...`);
          const commitResult = await retryTransient(() => commitAndPush({
            workspaceId,
            projectDir: CLAUDE_PROJECT_DIR,
            commitMessage: `Update ${app.name} via LFG Instant Mode`,
            featureBranch: "main",
            repoUrl: repo.cloneUrl,
            githubToken: ghToken.accessToken,
          }), "commitAndPush", appId);
          console.log(`[instant] [${appId}] commitAndPush completed: sha=${commitResult.sha} branch=${commitResult.branch}`);
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

        console.log(`[instant] [${appId}] Auto-sync complete: ${appName} → ${repo.repoUrl}`);

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
      // Deliberate skip (server not up) → no warning; we intentionally don't back up a
      // broken build over a good one.
      if (String(syncErr).includes("__SKIP_SYNC_SERVER_DOWN__")) {
        // no-op
      } else {
      // Don't fail the build if GitHub sync fails — the app is built and running. But do
      // NOT leave it silent: a failed push means the app ISN'T backed up, so if the VM is
      // reaped a restore would clone an empty repo. Tell the user so they can re-export.
      console.error(`[instant] [${appId}] Auto-sync to GitHub FAILED for ${appName}:`, String(syncErr));
      console.error(`[instant] [${appId}] Sync error details:`, (syncErr as Error).stack?.slice(0, 500));
      await broadcastInstantStatus({
        userId: app.userId,
        conversationId: app.conversationId,
        appId: app.appId,
        appName,
        status: "running",
        message: `⚠️ ${appName} is live, but the GitHub backup didn't complete (${String(syncErr).replace(/^Error:\s*/i, "").slice(0, 120)}). Your app still works — say "export to GitHub" to retry the backup (needed to restore the app if the sandbox is reaped).`,
        previewUrl,
      }).catch(() => {});
      }
    }
  } catch (error) {
    // User-initiated stop → clean terminal "stopped", not a red build error.
    if (cancelledBuilds.has(appId) || String(error).includes(BUILD_CANCELLED_MARKER)) {
      console.log(`[instant] [${appId}] build stopped by user after ${Date.now() - buildStart}ms`);
      const [app] = await db.select().from(instantApps).where(eq(instantApps.id, appId)).limit(1);
      if (app) {
        await db
          .update(instantApps)
          .set({ status: "stopped", updatedAt: new Date() })
          .where(eq(instantApps.id, app.id));
        await broadcastInstantStatus({
          userId: app.userId,
          conversationId: app.conversationId,
          appId: app.appId,
          appName: app.name,
          status: "stopped",
          message: "Build stopped. You can edit the plan and build again whenever you're ready.",
        });
      }
      return;
    }
    console.error(`[instant] [${appId}] BUILD FAILED after ${Date.now() - buildStart}ms — ${String(error)}`);
    const [app] = await db.select().from(instantApps).where(eq(instantApps.id, appId)).limit(1);
    if (app) {
      const raw = String(error);
      // PRECISE auth classification. Generic substrings like "authentication"/"expired"
      // match countless non-auth failures (a provider hiccup, TLS "certificate expired",
      // npm token text, a stall, app code) — mislabeling those as "your key was rejected"
      // sends the user to fix a key that demonstrably works in chat. Only flag a real
      // provider rejection (HTTP 401/403, invalid/expired API key, no quota).
      const apiKeyRejected =
        /\b(401|403)\b|unauthorized|invalid[\s_-]*api[\s_-]*key|invalid_api_key|invalid[\s_-]*authentication|authentication[\s_-]*(error|failed)|invalid[\s_-]*token|expired[\s_-]*(api[\s_-]*key|token|credential)|insufficient[\s_-]*(balance|credit|quota)|permission[\s_-]*denied/i.test(
          raw,
        );
      // OAuth (Claude Code) session problems — distinct from an API-key rejection.
      const oauthProblem = /no credentials|credentials\.json|not logged in|reconnect|oauth token|session (expired|invalid)/i.test(raw);
      const isCredError = apiKeyRejected || oauthProblem;

      // Only flip the OAuth "connected" flag for an actual OAuth-mode session failure.
      if (oauthProblem && buildAuthMode !== "apiKey" && buildAuthMode !== "agent") {
        await markClaudeDisconnected(app.userId).catch(() => {});
      }

      await db
        .update(instantApps)
        .set({
          status: "error",
          metadata: {
            ...((app.metadata as Record<string, unknown> | null) ?? {}),
            error: raw,
          },
          updatedAt: new Date(),
        })
        .where(eq(instantApps.id, app.id));

      // Trimmed real error so a non-auth failure is diagnosable instead of hidden behind
      // a wrong "key rejected" message.
      const detail = raw.replace(/^Error:\s*/i, "").slice(0, 300);
      // A NETWORK failure reaching the model API (0 tokens, "Connection error") is the
      // sandbox's egress dying — not auth, not the model. The VM's next reuse is health-
      // checked for egress and replaced if dead, so a plain retry usually lands a good VM.
      const networkError = /connection error|econnreset|econnrefused|etimedout|socket hang up|network|getaddrinfo|dns/i.test(raw)
        && !apiKeyRejected;
      let message: string;
      if (apiKeyRejected && buildAuthMode === "apiKey") {
        message = `Your Anthropic API key was rejected by the provider. Check it in Settings → LLM Keys, or connect Claude Code. (${detail})`;
      } else if (apiKeyRejected && buildAuthMode === "agent") {
        message = `The build's LLM call was rejected by the provider (DeepSeek/Kimi). This is the in-sandbox build path, not chat — check the key/credits in Settings → LLM Keys, or connect Claude Code. (${detail})`;
      } else if (oauthProblem) {
        message = "Claude Code isn't connected (or the session expired). Reconnect it in Settings to build apps.";
      } else if (networkError) {
        message = `The sandbox couldn't reach the model API — a network error inside the VM (not your key or the model). This VM's egress is flaky. Say "retry" to rebuild on a health-checked (and if needed, fresh) VM. (${detail})`;
      } else {
        message = `Error building ${app.name}: ${detail}`;
      }

      await broadcastInstantStatus({
        userId: app.userId,
        conversationId: app.conversationId,
        appId: app.appId,
        appName: app.name,
        status: "error",
        message,
        errorType: isCredError ? "no_credentials" : undefined,
      });
    }
  } finally {
    // Save refreshed credentials from VM back to DB (OAuth mode only —
    // API-key builds never write a credentials file).
    if (buildWorkspaceId && buildUserId && buildAuthMode === "oauth") {
      await saveCredentialsFromVm(buildWorkspaceId, buildUserId).catch(() => {});
    }
    activeBuilds.delete(appId);
    cancelledBuilds.delete(appId);
  }
}

const STACK_LABEL: Record<string, string> = {
  webapp: "Next.js + shadcn/ui + SQLite",
  landing: "Next.js + framer-motion",
  game: "Vite + three.js",
  python: "Python (Flask) + HTML + SQLite",
};

export interface ProposePlanInput {
  userId: string;
  projectId?: string;
  conversationId: string;
  name: string;
  requirements: string;
  projectType?: string;
  summary?: string;
  sections?: ProposalSection[];
  /** A one-line note of what changed this round — appended to the visible change log. */
  changeNote?: string;
}

/**
 * STEP 1 of the two-stage approval: present the PLAN (summary + sections + stack) for
 * approval, with NO design. Persists the plan on the app and broadcasts a `plan_proposal`
 * card. Design comes NEXT (proposeInstantDesign) after the user approves the plan.
 */
export async function proposePlan(input: ProposePlanInput) {
  const normalizedName = sanitizeAppName(input.name);
  const projectType = detectProjectType(input.requirements, input.projectType);

  const [existing] = await db
    .select()
    .from(instantApps)
    .where(and(eq(instantApps.userId, input.userId), eq(instantApps.conversationId, input.conversationId)))
    .orderBy(desc(instantApps.createdAt))
    .limit(1);
  const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {};
  const priorProposal = existingMeta.proposal as InstantProposal | undefined;

  // Plan only — carry forward any design choices already made so they aren't dropped.
  const proposal: InstantProposal = {
    summary: input.summary ?? priorProposal?.summary,
    sections: input.sections ?? priorProposal?.sections,
    designChoices: priorProposal?.designChoices,
    projectType,
  };

  // Visible change log — append a note when this revises an existing plan.
  const priorLog = Array.isArray(existingMeta.changeLog) ? (existingMeta.changeLog as string[]) : [];
  const changeLog = input.changeNote && input.changeNote.trim()
    ? [...priorLog, input.changeNote.trim()].slice(-20)
    : priorLog;

  let appId: string;
  if (existing) {
    const priorHistory = Array.isArray(existingMeta.proposalHistory) ? (existingMeta.proposalHistory as InstantProposal[]) : [];
    await db
      .update(instantApps)
      .set({
        name: normalizedName,
        description: input.requirements.slice(0, 500),
        requirements: input.requirements,
        metadata: {
          ...existingMeta,
          proposal,
          proposalHistory: [...priorHistory, { ...proposal, at: new Date().toISOString() }].slice(-20),
          projectType,
          changeLog,
        },
        updatedAt: new Date(),
      })
      .where(eq(instantApps.id, existing.id));
    appId = existing.appId;
  } else {
    const [app] = await db
      .insert(instantApps)
      .values({
        name: normalizedName,
        description: input.requirements.slice(0, 500),
        requirements: input.requirements,
        status: "draft",
        projectId: input.projectId ?? null,
        userId: input.userId,
        conversationId: input.conversationId,
        metadata: { proposal, proposalHistory: [{ ...proposal, at: new Date().toISOString() }], projectType, changeLog },
      })
      .returning();
    appId = app!.appId;
  }

  const data = {
    app_id: appId,
    app_name: normalizedName,
    project_type: projectType,
    summary: input.summary ?? priorProposal?.summary ?? "",
    sections: input.sections ?? priorProposal?.sections ?? [],
    stack: STACK_LABEL[projectType] ?? "",
    change_log: changeLog,
  };
  broadcastInstant(input.userId, input.conversationId, {
    type: "ai_chunk",
    chunk: "",
    is_final: false,
    is_notification: true,
    notification_type: "plan_proposal",
    data,
  });
  await appendSystemNotice(input.conversationId, { type: "plan_proposal", ...data });

  return { appId, appName: normalizedName, projectType };
}

export interface ProposeDesignInput {
  userId: string;
  projectId?: string;
  conversationId: string;
  name: string;
  requirements: string;
  projectType?: string;
  designChoices?: DesignChoices;
  /** Orchestrator-decided: true ONLY when the user explicitly asked to change the look/
   *  theme. Default false → reuse the app's existing design. */
  designChange?: boolean;
  /** The user's stated light/dark preference — a HARD constraint on palette selection. */
  brightness?: "light" | "dark";
  summary?: string;
  sections?: ProposalSection[];
}

/**
 * Present a design + plan proposal to the user for approval BEFORE building.
 * Composes the design tokens (for real swatches), persists the proposal on the
 * app (so the approved choices flow into the build + PROJECT_SPEC.md), and
 * broadcasts a `design_proposal` card. Does NOT start a build.
 */
export async function proposeInstantDesign(input: ProposeDesignInput) {
  const normalizedName = sanitizeAppName(input.name);
  const projectType = detectProjectType(input.requirements, input.projectType);

  // Look up the existing app first so we can reuse its approved design for ADDITIONS.
  const [existing] = await db
    .select()
    .from(instantApps)
    .where(and(eq(instantApps.userId, input.userId), eq(instantApps.conversationId, input.conversationId)))
    .orderBy(desc(instantApps.createdAt))
    .limit(1);

  // Design is GLOBAL. For an addition (existing design + no explicit redesign ask),
  // REUSE the current design — otherwise "add a landing page" recomposes a different
  // palette and restyles the whole app. resolveEffectiveDesignChoices enforces this
  // regardless of what palette the orchestrator picked, and normalizes ids.
  const existingMeta = (existing?.metadata as Record<string, unknown> | null) ?? {};
  const effectiveChoices = resolveEffectiveDesignChoices(existingMeta, input.designChoices, input.designChange ?? false);
  // brightness (a hard light/dark preference) is honored by selectPalette inside compose.
  // The model SHOULD pass `brightness`, but non-Anthropic models often omit it — so when
  // it's absent, infer light/dark from the requirements + the approved plan (summary +
  // sections, e.g. a "Clean Light Dashboard" section). Without this, an omitted flag lets
  // a dark `palette_id` hint win even though the user explicitly asked for a light UI.
  const priorPlan = existingMeta.proposal as InstantProposal | undefined;
  const brightnessSignal = [
    input.requirements,
    input.summary ?? priorPlan?.summary,
    ...(input.sections ?? priorPlan?.sections ?? []).map((s) => `${s.title} ${s.description}`),
  ]
    .filter(Boolean)
    .join(" \n ");
  const effectiveBrightness = input.brightness ?? inferBrightness(brightnessSignal);
  const tokens = composeDesignTokens(input.requirements, normalizedName, {
    ...(effectiveChoices ?? {}),
    brightness: effectiveBrightness,
  });
  // Persist the ACTUALLY-SELECTED design (resolved from the composed tokens) — not the
  // model's raw pick, which selectPalette may have overridden to honor brightness. This
  // is what flows into the build, so the approved light/dark palette is what gets built.
  const resolvedChoices: DesignChoices = {
    paletteId: resolvePaletteId(tokens.meta.paletteName),
    fontPairingId: resolveFontPairingId(tokens.meta.fontPairingName),
    styleProfileId: resolveStyleProfileId(tokens.meta.styleProfileName),
  };

  // Preserve the plan (summary/sections) set by the earlier propose_plan step — the
  // design step doesn't re-send them, so falling back avoids wiping the approved plan.
  const priorProposal = existingMeta.proposal as InstantProposal | undefined;
  const proposal: InstantProposal = {
    summary: input.summary ?? priorProposal?.summary,
    sections: input.sections ?? priorProposal?.sections,
    designChoices: resolvedChoices,
    projectType,
  };

  let appId: string;
  if (existing) {
    // Keep a HISTORY of every proposal (don't overwrite) — plus `proposal` = latest.
    const priorHistory = Array.isArray(existingMeta.proposalHistory)
      ? (existingMeta.proposalHistory as InstantProposal[])
      : [];
    await db
      .update(instantApps)
      .set({
        name: normalizedName,
        description: input.requirements.slice(0, 500),
        requirements: input.requirements,
        metadata: {
          ...existingMeta,
          proposal,
          proposalHistory: [...priorHistory, { ...proposal, at: new Date().toISOString() }].slice(-20),
          projectType,
          // PROPOSAL-only preview tokens — kept SEPARATE from `designTokens` (the
          // applied/built design). Writing `designTokens` here would silently change
          // the running app's design before the user approves anything.
          proposalTokens: tokens,
        },
        updatedAt: new Date(),
      })
      .where(eq(instantApps.id, existing.id));
    appId = existing.appId;
  } else {
    const [app] = await db
      .insert(instantApps)
      .values({
        name: normalizedName,
        description: input.requirements.slice(0, 500),
        requirements: input.requirements,
        status: "draft",
        projectId: input.projectId ?? null,
        userId: input.userId,
        conversationId: input.conversationId,
        metadata: { proposal, proposalHistory: [{ ...proposal, at: new Date().toISOString() }], projectType, proposalTokens: tokens },
      })
      .returning();
    appId = app!.appId;
  }

  const data = {
    app_id: appId,
    app_name: normalizedName,
    project_type: projectType,
    summary: input.summary ?? "",
    sections: input.sections ?? [],
    palette: {
      name: tokens.meta.paletteName,
      colors: {
        primary: tokens.colors.primary,
        secondary: tokens.colors.secondary,
        accent: tokens.colors.accent,
        background: tokens.colors.background,
        text: tokens.colors.text,
        border: tokens.colors.border,
      },
    },
    fonts: {
      heading: tokens.typography.headingFont,
      body: tokens.typography.bodyFont,
      pairing: tokens.meta.fontPairingName,
    },
    style: tokens.meta.styleProfileName,
  };

  broadcastInstant(input.userId, input.conversationId, {
    type: "ai_chunk",
    chunk: "",
    is_final: false,
    is_notification: true,
    notification_type: "design_proposal",
    data,
  });
  await appendSystemNotice(input.conversationId, { type: "design_proposal", ...data });

  return { appId, appName: normalizedName, projectType, palette: tokens.meta.paletteName };
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
    // Never blow away saved requirements with a degraded retry. If the caller passes
    // empty/blank requirements (e.g. the orchestrator lost context and retried), keep
    // the persisted ones — the plan is the source of truth, not the chat thread.
    const requirements = input.requirements?.trim() ? input.requirements : (existing.requirements ?? "");
    await db
      .update(instantApps)
      .set({
        name: normalizedName,
        description: requirements.slice(0, 500),
        requirements,
        envVars: input.envVars ?? ((existing.envVars as Record<string, string>) ?? {}),
        status: "building",
        updatedAt: new Date(),
      })
      .where(eq(instantApps.id, existing.id));

    void runInstantBuild(existing.id, requirements, input.designChoices, input.buildModelKey, input.projectType, input.designChange);

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
    void runInstantBuild(app.id, undefined, input.designChoices, input.buildModelKey, input.projectType, input.designChange);
  }

  return {
    appId: app!.appId,
    appName: app!.name,
    status: "building",
    continued: false,
  };
}

/**
 * Retry/rebuild the existing app for a conversation using its ALREADY-SAVED
 * requirements + design — NO user input needed. The plan is persisted on the app
 * record (requirements + metadata.spec), so a crashed/failed build recovers
 * deterministically without the orchestrator re-asking what to build.
 */
export async function retryInstantBuild(params: {
  userId: string;
  conversationId: string;
  modelKey?: string;
}): Promise<{ started: boolean; appId?: string; appName?: string; reason?: string }> {
  const [app] = await db
    .select()
    .from(instantApps)
    .where(and(eq(instantApps.userId, params.userId), eq(instantApps.conversationId, params.conversationId)))
    .orderBy(desc(instantApps.createdAt))
    .limit(1);

  if (!app) return { started: false, reason: "No app exists for this conversation to retry." };
  if (!app.requirements?.trim()) {
    return { started: false, reason: "No saved requirements for this app — ask the user what to build." };
  }
  if (activeBuilds.has(app.id)) {
    return { started: true, appId: app.appId, appName: app.name, reason: "A build is already running." };
  }

  const meta = (app.metadata as Record<string, unknown> | null) ?? {};
  const projectType = meta.projectType as string | undefined;
  // Use the SAME model the app was built with so restore picks the right backend
  // (Pi vs Claude) and rootfs. Caller override → persisted build model → user's
  // current default selection. Without this, restore defaults to Claude (wrong).
  let modelKey = params.modelKey ?? (meta.buildModelKey as string | undefined);
  if (!modelKey) {
    const [sel] = await db
      .select({ selectedModel: modelSelections.selectedModel })
      .from(modelSelections)
      .where(eq(modelSelections.userId, params.userId))
      .limit(1);
    modelKey = sel?.selectedModel ?? undefined;
  }

  await db
    .update(instantApps)
    .set({ status: "building", updatedAt: new Date() })
    .where(eq(instantApps.id, app.id));

  // feedback=undefined → rebuilds from the persisted requirements (source of truth).
  void runInstantBuild(app.id, undefined, undefined, modelKey, projectType);
  return { started: true, appId: app.appId, appName: app.name };
}

/**
 * Trigger the cloud-browser QA pass for this conversation's app (used by the
 * `test_app` tool and the QA button). Fire-and-forget — results stream over WS.
 */
export async function runInstantAppQA(params: {
  userId: string;
  conversationId: string;
}): Promise<{ started: boolean; appName?: string; reason?: string }> {
  const [row] = await db
    .select({ app: instantApps, sandbox: sandboxes })
    .from(instantApps)
    .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
    .where(and(eq(instantApps.userId, params.userId), eq(instantApps.conversationId, params.conversationId)))
    .orderBy(desc(instantApps.createdAt))
    .limit(1);

  if (!row?.app) return { started: false, reason: "no app exists for this conversation yet" };
  if (!row.sandbox?.magsWorkspaceId) return { started: false, appName: row.app.name, reason: "the app isn't running yet — build it first" };
  if (!row.app.previewUrl) return { started: false, appName: row.app.name, reason: "the app has no preview URL yet — build it first" };

  void testInstantApp({
    appId: row.app.appId,
    appDbId: row.app.id,
    userId: params.userId,
    conversationId: row.app.conversationId,
    appName: row.app.name,
    previewUrl: row.app.previewUrl,
    buildWorkspaceId: row.sandbox.magsWorkspaceId,
  });
  return { started: true, appName: row.app.name };
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
  let previewUrl = normalizeMagsAppUrl(app.previewUrl ?? "");

  if (!sandbox?.magsWorkspaceId) {
    return {
      appId: app.appId,
      appName: app.name,
      status,
      previewUrl: "",
      message: `${app.name} status: ${status}`,
    };
  }

  // Check VM liveness before attempting any exec — a dead VM would cause
  // execOnWorkspace to retry for minutes and block the whole WS stream.
  const vmJob = await findJob(sandbox.magsWorkspaceId).catch(() => null);
  const vmAlive = vmJob && (vmJob.status === "running" || vmJob.status === "sleeping");
  if (!vmAlive) {
    return {
      appId: app.appId,
      appName: app.name,
      status,
      previewUrl: "",
      message: `${app.name} status: ${status}. VM is not running — build needs to be retried.`,
    };
  }

  // A build that is still running ("building") must NOT be reported as live, even
  // though a server already answers on :8080 — the scaffolded Next.js app serves a
  // default page from the very first second, so a port probe is true long before the
  // real app exists. Promoting building → running here is exactly what made the
  // orchestrator announce "It's live!" over an unfinished/empty scaffold. While a
  // build is in flight we report progress and leave the status untouched; the build
  // flow itself flips status to "running" + broadcasts "is live!" only on genuine
  // completion. (restart_server is an explicit post-build troubleshooting action, so
  // it's allowed to re-probe.)
  const buildInFlight = status === "building" && !params.restartServer;
  if (buildInFlight) {
    // Truthful liveness so the orchestrator stops guessing: a heavy install/compile is
    // SLOW, not stalled — blindly rebuilding just re-runs the slow step and can loop.
    const act = await probeBuildActivity(sandbox.magsWorkspaceId).catch(() => ({ busy: false, proc: "", recentWrite: false }));
    const detail = act.busy
      ? `It is ACTIVELY building${act.proc ? ` (running \`${act.proc.split(/\s+/)[0]?.split("/").pop() ?? "build"}\`)` : (act.recentWrite ? " (files changing on disk)" : "")} — heavy dependencies can take several minutes. Do NOT rebuild; it is progressing. Just tell the user it's still working.`
      : `No build activity is visible on the sandbox right now — it may be between steps, or genuinely stalled. Do NOT rebuild on a single check; if it's still idle after another check ~1 min later, it's likely stalled and worth retrying.`;
    return {
      appId: app.appId,
      appName: app.name,
      status,
      previewUrl: "",
      message: `${app.name} is still building — not live yet. Do not tell the user it's ready. ${detail}`,
    };
  }

  if (params.restartServer) {
    const rebuildCmd =
      "cd /data/project && (pkill -f 'next start' 2>/dev/null || true) && npm run build && nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 &";
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
  /** A read-only shell command to run in the project dir (e.g. `cat parser_engine.py`). */
  command: string;
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

  // Guard: don't exec on a dead VM — would hang for minutes
  const vmJob = await findJob(row.sandbox.magsWorkspaceId).catch(() => null);
  if (!vmJob || (vmJob.status !== "running" && vmJob.status !== "sleeping")) {
    return { answer: "Sandbox VM is not currently running. The app needs to be rebuilt before sandbox inspection is available." };
  }

  // Actually RUN the requested inspection command in the project dir (previously this
  // ignored the input and only ran `ls -la`, so the agent could never read a file). The
  // command is base64-wrapped to avoid any quoting/escaping issues.
  const command = (params.command || "").trim() || "ls -la";
  const script = `cd ${CLAUDE_PROJECT_DIR} 2>/dev/null || cd /data/project; ${command}`;
  const b64 = Buffer.from(script).toString("base64");
  const result = await execOnWorkspace(
    row.sandbox.magsWorkspaceId,
    `echo ${b64} | base64 -d | bash`,
    { timeout: 30_000 },
  ).catch((e) => ({ output: "", stderr: `exec failed: ${(e as Error).message?.slice(0, 200)}`, exitCode: -1 }));

  const stdout = (result.output ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  // Prefer stdout (the file contents / listing). Surface stderr only when there's no
  // stdout (e.g. `cat` on a missing path) so the agent sees the real error, not silence.
  const body = stdout || stderr || "(command produced no output)";
  const answer = `$ ${command}\n${body}`.slice(0, 12000);
  return { answer };
}

// ── Swap Theme ──────────────────────────────────────────────────────

export async function swapInstantAppTheme(params: {
  userId: string;
  conversationId: string;
  paletteId?: string;
  fontPairingId?: string;
  styleProfileId?: string;
}): Promise<{ success: boolean; message: string; tokens?: DesignTokens }> {
  const { recomposeTokens, generateTokensCss } = await import("../config/design-tokens/index.ts");

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

  if (!row?.app) return { success: false, message: "No instant app found for this conversation." };
  if (!row.sandbox?.magsWorkspaceId) return { success: false, message: "No workspace available. Build the app first." };

  const existingMeta = (row.app.metadata as Record<string, unknown>) ?? {};
  const existingTokens = existingMeta.designTokens as DesignTokens | undefined;

  const newTokens = recomposeTokens(
    params.paletteId,
    params.fontPairingId,
    params.styleProfileId,
    existingTokens
  );

  if (!newTokens) {
    return { success: false, message: "Invalid theme combination or validation failed. Try different options." };
  }

  // Update metadata
  await db
    .update(instantApps)
    .set({
      metadata: {
        ...existingMeta,
        designTokens: newTokens,
        // Canonical ids (not display names) so a later addition reuses this theme.
        paletteId: resolvePaletteId(newTokens.meta.paletteName) ?? newTokens.meta.paletteName,
        fontPairingId: resolveFontPairingId(newTokens.meta.fontPairingName) ?? newTokens.meta.fontPairingName,
        styleProfileId: resolveStyleProfileId(newTokens.meta.styleProfileName) ?? newTokens.meta.styleProfileName,
        // Keep spec.design in sync — it's the primary source the reuse logic reads,
        // so a deliberate theme swap must update it too (otherwise reuse would revert).
        spec: {
          ...((existingMeta.spec as Record<string, unknown> | undefined) ?? {}),
          design: {
            ...(((existingMeta.spec as { design?: Record<string, unknown> } | undefined)?.design) ?? {}),
            palette: newTokens.meta.paletteName,
            fonts: newTokens.meta.fontPairingName,
            style: newTokens.meta.styleProfileName,
            primary: newTokens.colors.primary,
            background: newTokens.colors.background,
            text: newTokens.colors.text,
          },
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(instantApps.id, row.app.id));

  // Re-inject tokens into sandbox
  const workspaceId = row.sandbox.magsWorkspaceId;
  const tokensB64 = Buffer.from(JSON.stringify(newTokens, null, 2)).toString("base64");
  await execOnWorkspace(workspaceId, `echo '${tokensB64}' | base64 -d > /data/project/tokens.json`);

  const cssByte = Buffer.from(generateTokensCss(newTokens)).toString("base64");
  await execOnWorkspace(workspaceId, `echo '${cssByte}' | base64 -d > /data/project/design-tokens.css`);

  return {
    success: true,
    message: `Theme updated: palette=${newTokens.meta.paletteName}, fonts=${newTokens.meta.fontPairingName}, style=${newTokens.meta.styleProfileName}. Trigger a rebuild to apply.`,
    tokens: newTokens,
  };
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

  // Stop the VM AND delete its persistent workspace storage (frees S3 cost —
  // stop alone leaves the workspace data lingering and billing).
  if (row.sandbox?.magsWorkspaceId) {
    try {
      await stopWorkspace(row.sandbox.magsWorkspaceId);
    } catch (err) {
      console.warn(`[InstantApp] Failed to stop workspace ${row.sandbox.magsWorkspaceId}:`, err);
    }
    try {
      await deleteWorkspace(row.sandbox.magsWorkspaceId);
    } catch (err) {
      console.warn(`[InstantApp] Failed to delete workspace ${row.sandbox.magsWorkspaceId}:`, err);
    }
  }

  // Delete sandbox record first (instant_app references it)
  if (row.sandbox) {
    await db.delete(sandboxes).where(eq(sandboxes.id, row.sandbox.id));
  }

  // Delete the instant app record (cascade will clean up conversation link)
  await db.delete(instantApps).where(eq(instantApps.id, row.app.id));

  return { deleted: true, message: `Deleted ${row.app.name} and stopped its workspace.` };
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
  if (!row.sandbox?.magsWorkspaceId) return { success: false, message: "No workspace available — app must be built first." };

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
  if (!row.sandbox?.magsWorkspaceId) return { success: false, message: "No workspace available." };

  try {
    // The project lives at /data/project (NOT /root/project — that path doesn't exist,
    // which is why downloads produced an empty/failed archive). Exclude heavy/generated
    // dirs across stacks (node_modules/.next for Next, .venv/__pycache__/*.pyc for Python,
    // .git) so the archive is SOURCE-ONLY and small enough to return inline.
    const tarCmd =
      `cd /data && tar czf /tmp/app-export.tar.gz ` +
      `--exclude='node_modules' --exclude='.next' --exclude='.git' ` +
      `--exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='dev.log' ` +
      `project/ && wc -c < /tmp/app-export.tar.gz`;
    const tarRes = await execOnWorkspace(row.sandbox.magsWorkspaceId, tarCmd, { timeout: 60_000 });
    const size = parseInt((tarRes.output || "").trim().split(/\s+/).pop() || "0", 10);
    if (!size) {
      return { success: false, message: "Nothing to archive — the project directory is empty or missing on the sandbox." };
    }
    // The exec API caps output (~4MB) and base64 inflates ~33%, so bail above ~3MB and
    // point the user at the GitHub export (which streams the full repo) instead of
    // returning a silently-truncated, corrupt tarball.
    if (size > 3_000_000) {
      return { success: false, message: `The code archive is ${(size / 1e6).toFixed(1)}MB — too large to download inline. Use "Open GitHub repo" (or export to GitHub) to get the full code.` };
    }

    // Read the tarball as base64
    const b64Result = await execOnWorkspace(
      row.sandbox.magsWorkspaceId,
      "base64 /tmp/app-export.tar.gz",
      { timeout: 60_000 }
    );

    const data = Buffer.from(b64Result.output.trim(), "base64");
    const filename = `${(row.app.name || "instant-app").replace(/[^a-zA-Z0-9._-]/g, "-")}.tar.gz`;

    return { success: true, data, filename, message: "Archive ready." };
  } catch (err) {
    return { success: false, message: `Archive failed: ${(err as Error).message}` };
  }
}

// Instant apps use SQLite (better-sqlite3 + drizzle) on the app's own disk —
// no external database is provisioned. The previous Postgres provisioner was
// removed so instant apps only ever use SQLite.
