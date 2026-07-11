/**
 * Instant App Tester — plug-and-play post-build QA.
 *
 * After an instant app goes live, boot a Mags cloud Chromium, visit every static
 * screen, screenshot each, and report pass/fail (HTTP status, uncaught page
 * errors, console errors) over WebSocket + persist the report on the app.
 *
 * ─ Runtime note ─────────────────────────────────────────────────────────────
 * The server runs on Bun, but Playwright's `connectOverCDP` hangs under Bun
 * (works under Node — verified). So the actual browser driving happens in a
 * short-lived NODE subprocess (scripts/qa-browser-worker.mjs); Bun orchestrates
 * (Mags SDK, route discovery, broadcasts, persistence) and streams the worker's
 * NDJSON results.
 *
 * ─ Plug-and-play contract ───────────────────────────────────────────────────
 *  • The ONLY integration point is `testInstantApp(opts)` — a single
 *    fire-and-forget call. It never throws.
 *  • Owns its on/off gate (`isTestingEnabled`), boots + tears down its own
 *    browser VM, and writes its own results.
 *
 * ─ Disabling ────────────────────────────────────────────────────────────────
 *  • Globally:  set env `INSTANT_APP_TESTING=off`.
 *  • By plan / paid users (future): extend `isTestingEnabled(opts)`.
 */

import { spawn } from "node:child_process";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { instantApps } from "../db/schema/instant.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { getModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { execOnWorkspace, startBrowserSession, stopWorkspace } from "./mags.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";

// ── Tunables ─────────────────────────────────────────────────────────────────
const CONFIG = {
  enabled: (process.env.INSTANT_APP_TESTING ?? "on").toLowerCase() !== "off",
  maxScreens: parseInt(process.env.INSTANT_TEST_MAX_SCREENS || "12", 10),
  navTimeoutMs: parseInt(process.env.INSTANT_TEST_NAV_TIMEOUT_MS || "15000", 10),
  navRetries: 3,
  settleMs: 1200,
  viewport: { width: 1280, height: 800 },
  screenshotQuality: 72,
};

export interface InstantTestOptions {
  appId: string;       // public app id — WS routing + uploads path
  appDbId: string;     // instantApps.id — persistence
  userId: string;
  conversationId?: string | null;
  appName: string;
  previewUrl: string;  // public URL of the running app
  buildWorkspaceId: string; // build VM — used to enumerate routes
  /** Called when one or more screens FAIL. Lets the caller surface the findings
   *  back into the chat / trigger an auto-fix. Best-effort; errors are swallowed. */
  onIssues?: (report: {
    passed: number;
    failed: number;
    overall?: string;
    screens: ScreenResult[];
  }) => Promise<void> | void;
}

export interface ScreenResult {
  route: string;
  url: string;
  ok: boolean;
  httpStatus: number | null;
  pageError?: string;
  consoleErrors: string[];
  screenshotUrl?: string;
  title?: string;
  observation?: string;  // technical note of what the browser saw
  textSnippet?: string;  // visible text (for the AI explainer; not displayed)
  explainer?: string;    // AI plain-English one-liner about the screen
}

/** The single on/off gate. Currently env-driven; the one place to add per-plan
 *  gating later (free vs paid) — it already receives userId. */
export async function isTestingEnabled(_opts: { userId: string }): Promise<boolean> {
  if (!CONFIG.enabled) return false;
  // FUTURE (paid-only): const plan = await getUserPlan(_opts.userId); return plan !== "free";
  return true;
}

/** Entry point. Fire-and-forget safe: gates itself, never throws, cleans up. */
export async function testInstantApp(opts: InstantTestOptions): Promise<void> {
  try {
    if (!(await isTestingEnabled({ userId: opts.userId }))) {
      console.log(`[instant-tester] [${opts.appId}] disabled — skipping`);
      return;
    }
    if (!opts.previewUrl) {
      console.log(`[instant-tester] [${opts.appId}] no preview URL — skipping`);
      return;
    }
    await runTest(opts);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[instant-tester] [${opts.appId}] run failed:`, msg);
    broadcast(opts, "tested_issues", `QA failed: ${msg.slice(0, 200)}`, { results: [], passed: 0, failed: 0 });
  }
}

async function runTest(opts: InstantTestOptions): Promise<void> {
  const base = opts.previewUrl.replace(/\/+$/, "");
  const routes = (await enumerateRoutes(opts.buildWorkspaceId)).slice(0, CONFIG.maxScreens);
  console.log(`[instant-tester] [${opts.appId}] testing ${routes.length} screen(s): ${routes.join(", ")}`);
  broadcast(opts, "testing", `Testing ${opts.appName} — ${routes.length} screen${routes.length === 1 ? "" : "s"}…`);

  let requestId: string | undefined;
  const results: ScreenResult[] = [];
  try {
    const session = await startBrowserSession({ timeout: 120_000 });
    requestId = session.requestId;
    const workerCfg = {
      wsEndpoint: session.wsEndpoint,
      base,
      routes,
      appId: opts.appId,
      outDir: `${process.cwd()}/uploads/instant-tests/${opts.appId}`,
      navTimeoutMs: CONFIG.navTimeoutMs,
      navRetries: CONFIG.navRetries,
      settleMs: CONFIG.settleMs,
      viewport: CONFIG.viewport,
      quality: CONFIG.screenshotQuality,
    };
    await runWorker(workerCfg, (screen) => {
      results.push(screen);
      broadcast(opts, "testing", `${screen.ok ? "✓" : "✗"} ${screen.route}`, { screen });
    });
  } finally {
    if (requestId) await stopWorkspace(requestId).catch(() => {});
  }

  // AI explainer: one LLM call describes each screen + an overall summary.
  // Mutates results (adds .explainer); returns the overall summary (or undefined).
  const overall = await generateExplainers(opts, results);

  const failed = results.filter((r) => !r.ok).length;
  const passed = results.length - failed;
  await persistReport(opts.appDbId, results, overall);
  broadcast(
    opts,
    failed === 0 ? "tested_ok" : "tested_issues",
    failed === 0
      ? `Tested ${passed} screen${passed === 1 ? "" : "s"} — all good.`
      : `Tested ${results.length} screens — ${passed} passed, ${failed} with issues.`,
    { results, passed, failed, overall }
  );
  console.log(`[instant-tester] [${opts.appId}] done — ${passed} passed, ${failed} failed`);

  // Hand the findings back to the caller (chat surfacing / auto-fix) when broken.
  if (failed > 0 && opts.onIssues) {
    try {
      await opts.onIssues({ passed, failed, overall, screens: results });
    } catch (e) {
      console.warn(`[instant-tester] onIssues handler failed: ${(e as Error).message}`);
    }
  }
}

/**
 * One LLM call: write a plain-English one-liner per screen + an overall summary.
 * Uses the user's selected model/key (env fallback allowed). Best-effort — on any
 * failure (no key, parse error) it returns undefined and the run still completes.
 */
async function generateExplainers(opts: InstantTestOptions, results: ScreenResult[]): Promise<string | undefined> {
  if (!results.length) return undefined;
  try {
    const [modelSel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, opts.userId));
    const [keys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, opts.userId));
    const modelKey = modelSel?.selectedModel ?? DEFAULT_MODEL_KEY;
    const userApiKeys = keys
      ? {
          anthropic: keys.anthropicApiKey ?? undefined,
          openai: keys.openaiApiKey ?? undefined,
          google: keys.googleApiKey ?? undefined,
          kimi: keys.kimiApiKey ?? undefined,
          deepseek: keys.deepseekApiKey ?? undefined,
        }
      : undefined;

    let model;
    try {
      model = getModel(modelKey, userApiKeys, { allowEnvFallback: true });
    } catch {
      return undefined; // no usable key — skip explainers, keep technical observations
    }

    const lines = results
      .map((r) => `[${r.route}] ${r.ok ? "PASS" : "FAIL"} · ${r.observation ?? ""} · visible text: ${JSON.stringify((r.textSnippet ?? "").slice(0, 400))}`)
      .join("\n");

    const prompt =
      `An automated browser test visited these screens of the app "${opts.appName}". ` +
      `For EACH screen, decide whether it is HEALTHY or BROKEN, then write ONE short plain-English sentence ` +
      `describing what the screen shows and any problem. Mark a screen BROKEN if it shows an error message ` +
      `(e.g. "unable to load data", "something went wrong"), a failed/empty data load, a crash, a blank page, ` +
      `or has console errors — even if the page otherwise loaded. Then write an OVERALL 1-2 sentence summary.\n\n` +
      `${lines}\n\n` +
      `Respond EXACTLY in this format, nothing else (one [route] line per screen, same route keys):\n` +
      `OVERALL: <summary>\n` +
      results.map((r) => `[${r.route}]: HEALTHY|BROKEN — <one sentence>`).join("\n");

    const { text } = await generateText({ model, prompt, maxOutputTokens: 600 });

    let overall: string | undefined;
    const perScreen: Record<string, { explainer: string; broken: boolean }> = {};
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const mo = line.match(/^OVERALL:\s*(.+)$/i);
      if (mo?.[1]) { overall = mo[1].trim(); continue; }
      const ms = line.match(/^\[(.+?)\]:\s*(.+)$/);
      if (ms?.[1] && ms[2]) {
        const rest = ms[2].trim();
        const verdict = rest.match(/^(HEALTHY|BROKEN|UNHEALTHY)\b/i);
        const broken = /^(BROKEN|UNHEALTHY)/i.test(verdict?.[1] ?? "");
        perScreen[ms[1].trim()] = { explainer: rest.replace(/^(HEALTHY|BROKEN|UNHEALTHY)\b[\s—:-]*/i, "").trim() || rest, broken };
      }
    }
    for (const r of results) {
      const hit = perScreen[r.route];
      if (!hit) continue;
      r.explainer = hit.explainer;
      // Second verdict gate: the model can catch a visually-broken screen the
      // mechanical checks missed (e.g. an empty error card with no console error).
      if (hit.broken && r.ok) r.ok = false;
    }
    return overall;
  } catch (e) {
    console.warn(`[instant-tester] explainer generation failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** Spawn the Node browser worker, stream its NDJSON results. Resolves when the
 *  worker exits cleanly; rejects on spawn error or a worker-reported error. */
function runWorker(cfg: object, onScreen: (s: ScreenResult) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerPath = `${process.cwd()}/scripts/qa-browser-worker.mjs`;
    const child = spawn("node", [workerPath], { stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    let workerError: Error | null = null;

    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "screen") onScreen(msg.screen as ScreenResult);
        else if (msg.type === "error") workerError = new Error(msg.message);
      }
    });
    child.on("error", (e) => reject(e)); // e.g. node not found
    child.on("exit", () => (workerError ? reject(workerError) : resolve()));

    child.stdin.write(JSON.stringify(cfg));
    child.stdin.end();
  });
}

/** List static Next.js app-router routes from the build VM's /data/project. */
async function enumerateRoutes(workspaceId: string): Promise<string[]> {
  try {
    const cmd =
      `find /data/project/src/app /data/project/app -type f ` +
      `\\( -name 'page.tsx' -o -name 'page.jsx' -o -name 'page.ts' -o -name 'page.js' \\) 2>/dev/null | head -200`;
    const res = await execOnWorkspace(workspaceId, cmd, { timeout: 20_000 });
    const paths = (res.output || "").split("\n").map((s) => s.trim()).filter(Boolean);
    return filesToRoutes(paths);
  } catch (e) {
    console.warn(`[instant-tester] route enumeration failed, testing "/" only: ${(e as Error).message}`);
    return ["/"];
  }
}

/** Map page-file paths → URL routes, dropping route groups and dynamic segments. */
export function filesToRoutes(paths: string[]): string[] {
  const routes = new Set<string>(["/"]);
  for (const p of paths) {
    const rel = p.replace(/^.*\/(?:src\/)?app/, "").replace(/\/page\.(tsx|jsx|ts|js)$/, "");
    const segs = rel.split("/").filter(Boolean);
    if (segs.some((s) => /\[.*\]/.test(s) || s.startsWith("@") || s.startsWith("(."))) continue;
    const cleaned = segs.filter((s) => !/^\(.*\)$/.test(s));
    routes.add("/" + cleaned.join("/"));
  }
  return [...routes].map((r) => (r === "" ? "/" : r));
}

async function persistReport(appDbId: string, results: ScreenResult[], overall?: string): Promise<void> {
  try {
    const [row] = await db.select({ metadata: instantApps.metadata }).from(instantApps).where(eq(instantApps.id, appDbId)).limit(1);
    const meta = (row?.metadata as Record<string, unknown> | null) ?? {};
    await db
      .update(instantApps)
      .set({
        metadata: {
          ...meta,
          testReport: {
            ranAt: new Date().toISOString(),
            passed: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
            overall: overall ?? null,
            // Drop the raw text snippet (LLM input only) to keep the report lean.
            screens: results.map(({ textSnippet, ...rest }) => rest),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(instantApps.id, appDbId));
  } catch (e) {
    console.warn(`[instant-tester] failed to persist report: ${(e as Error).message}`);
  }
}

function broadcast(
  opts: InstantTestOptions,
  status: "testing" | "tested_ok" | "tested_issues",
  message: string,
  extra?: Record<string, unknown>
): void {
  broadcastToUser(opts.userId, {
    type: "ai_chunk",
    chunk: "",
    is_final: false,
    is_notification: true,
    notification_type: "instant_app_test",
    instant_app_id: opts.appId,
    instant_app_test_status: status,
    conversation_id: opts.conversationId ?? "",
    app_name: opts.appName,
    message,
    ...(extra ?? {}),
  });
}
