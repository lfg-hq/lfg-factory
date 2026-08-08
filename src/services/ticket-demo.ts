/**
 * Ticket demo recorder — after a ticket build completes, exercise the feature and
 * capture proof it works, surfaced in the ticket's Preview tab.
 *
 *  • FRONTEND ticket → drive the running app in a Mags cloud browser and record a
 *    VIDEO walkthrough (scripts/demo-recorder-worker.mjs, Node subprocess — same
 *    Bun/CDP constraint as the instant QA worker).
 *  • API/backend ticket → run the endpoint(s) with curl inside the sandbox VM and
 *    capture a styled terminal TRANSCRIPT (command + response data).
 *
 * Auth: apps built to honor a preview session accept the `LFG_PREVIEW_MODE` cookie
 * as a logged-in "Preview User" (seeded by the recorder, sandbox-only). If the app
 * doesn't honor it we detect the Google login screen and mark the demo `auth_gated`
 * instead of failing.
 *
 * The ONLY integration point is `generateTicketDemo(...)` — fire-and-forget, never
 * throws. Disable globally with env `TICKET_DEMO=off`.
 */

import { spawn } from "node:child_process";
import { eq, and } from "drizzle-orm";
import { generateText } from "ai";
import { db } from "../config/db.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { sandboxes } from "../db/schema/sandbox.ts";
import { modelSelections } from "../db/schema/chat.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { getLiteModel, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { execOnWorkspace, startBrowserSession, stopWorkspace } from "./mags.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";

const CONFIG = {
  enabled: (process.env.TICKET_DEMO ?? "on").toLowerCase() !== "off",
  navTimeoutMs: parseInt(process.env.TICKET_DEMO_NAV_TIMEOUT_MS || "15000", 10),
  settleMs: 1200,
  viewport: { width: 1280, height: 800 },
  maxSteps: 12,
  maxApiCalls: 6,
  // The cookie the recorder seeds; apps built to honor a preview session treat it as
  // an authenticated "Preview User" (see the ticket build prompt). Value is a shared
  // secret so a real deployment can't be spoofed by just knowing the cookie name.
  cookieName: process.env.LFG_PREVIEW_COOKIE_NAME || "lfg_preview_session",
  cookieSecret: process.env.LFG_PREVIEW_SECRET || "lfg-preview-mode",
};

type DemoKind = "frontend" | "api";

interface FrontendStep {
  action: "goto" | "click" | "type" | "scroll" | "wait";
  selector?: string;
  text?: string;
  url?: string;
  path?: string;
  amount?: number;
  ms?: number;
}
interface ApiCall {
  method: string;
  path: string;
  body?: string;
  note?: string;
}
interface DemoPlan {
  kind: DemoKind;
  summary?: string;
  steps?: FrontendStep[];
  calls?: ApiCall[];
}

export interface TicketDemoResult {
  kind: DemoKind;
  status: "ready" | "auth_gated" | "error" | "skipped";
  videoUrl?: string;
  transcript?: { command: string; note?: string; status?: string; output: string }[];
  summary?: string;
  generatedAt: string;
}

interface GenerateOpts {
  workspaceId?: string;
  ownerId: string;
  projectId: string;
}

/** Fire-and-forget entry point. Never throws — a demo failure must not affect the
 *  ticket's own success/failure. */
export async function generateTicketDemo(ticketId: string, opts: GenerateOpts): Promise<void> {
  if (!CONFIG.enabled) return;
  try {
    await run(ticketId, opts);
  } catch (e) {
    console.warn(`[ticket-demo] [${ticketId}] failed:`, (e as Error).message);
    await persist(ticketId, {
      kind: "frontend",
      status: "error",
      summary: `Demo could not be generated: ${(e as Error).message}`,
      generatedAt: new Date().toISOString(),
    }).catch(() => {});
    broadcast(opts.ownerId, ticketId, "error");
  }
}

async function run(ticketId: string, opts: GenerateOpts): Promise<void> {
  const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  if (!ticket) return;

  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.ticketId, ticketId), eq(sandboxes.workspaceType, "ticket")))
    .limit(1);
  const workspaceId = opts.workspaceId || sandbox?.magsWorkspaceId || undefined;
  if (!workspaceId || !sandbox) {
    console.warn(`[ticket-demo] [${ticketId}] no sandbox/workspace — skipping`);
    return;
  }

  broadcast(opts.ownerId, ticketId, "running");
  console.log(`[ticket-demo] [${ticketId}] starting demo (ws=${workspaceId})`);

  // Ensure the app is running + get its public URL and local port.
  const { startDevServer } = await import("./preview.ts");
  const server = await startDevServer(sandbox.id);
  const base = server.previewUrl;
  const port = server.port;

  // Context for the planner: what changed + which routes exist.
  const changedFiles = await listChangedFiles(workspaceId);
  const routes = await listRoutes(workspaceId);

  const plan = await planDemo(ticket.name, ticket.description, changedFiles, routes, opts.ownerId);
  console.log(`[ticket-demo] [${ticketId}] plan kind=${plan.kind} steps=${plan.steps?.length ?? 0} calls=${plan.calls?.length ?? 0}`);

  let result: TicketDemoResult;
  if (plan.kind === "api") {
    result = await recordApi(ticketId, workspaceId, port, plan);
  } else {
    result = await recordFrontend(ticketId, base, plan);
  }

  await persist(ticketId, result);
  broadcast(opts.ownerId, ticketId, result.status);
  console.log(`[ticket-demo] [${ticketId}] done — ${plan.kind} → ${result.status}`);
}

// ── Planner ────────────────────────────────────────────────────────────────────

async function planDemo(
  name: string,
  description: string,
  changedFiles: string[],
  routes: string[],
  ownerId: string,
): Promise<DemoPlan> {
  // Heuristic seed — the LLM makes the final call, but we bias classification.
  const text = `${name} ${description}`.toLowerCase();
  const apiish = /\b(endpoint|api|rest|graphql|webhook|route handler|backend|cron|worker|migration|schema|query|mutation)\b/.test(text);
  const uiish = /\b(button|form|ui|component|page|screen|layout|header|footer|modal|dialog|design|styling|frontend|redesign|css|html)\b/.test(text);
  const seed: DemoKind = apiish && !uiish ? "api" : "frontend";

  const fallback: DemoPlan =
    seed === "api"
      ? { kind: "api", calls: [{ method: "GET", path: "/", note: "smoke test" }] }
      : { kind: "frontend", steps: [{ action: "goto", path: routes[0] || "/" }, { action: "scroll", amount: 600 }, { action: "wait", ms: 1200 }] };

  try {
    const model = await resolveModel(ownerId);
    if (!model) return fallback;

    const prompt =
      `You are planning an automated DEMO of a just-completed software ticket, to prove the feature works.\n\n` +
      `Ticket: "${name}"\nDescription: ${description}\n\n` +
      `Files changed in this ticket:\n${changedFiles.slice(0, 40).join("\n") || "(unknown)"}\n\n` +
      `Known app routes: ${routes.slice(0, 30).join(", ") || "/"}\n\n` +
      `Decide if this is a FRONTEND change (has a UI/page to show) or an API/backend change (an endpoint to call).\n` +
      `Then output a short demo plan as STRICT JSON, no prose, in ONE of these shapes:\n` +
      `FRONTEND: {"kind":"frontend","summary":"<1 sentence>","steps":[{"action":"goto","path":"/some-route"},{"action":"click","selector":"CSS or text"},{"action":"type","selector":"CSS","text":"..."},{"action":"scroll","amount":600},{"action":"wait","ms":1000}]}\n` +
      `API: {"kind":"api","summary":"<1 sentence>","calls":[{"method":"GET","path":"/api/thing","note":"what it shows"},{"method":"POST","path":"/api/thing","body":"{\\"k\\":\\"v\\"}","note":"..."}]}\n\n` +
      `Rules: prefer the route(s) most relevant to the changed files; keep it to at most ${CONFIG.maxSteps} steps / ${CONFIG.maxApiCalls} calls; for a click, prefer a stable selector or visible button text; output JSON only.`;

    const { text: out } = await generateText({ model, prompt, maxOutputTokens: 700 });
    const parsed = parsePlan(out);
    return parsed ?? fallback;
  } catch (e) {
    console.warn(`[ticket-demo] planner failed, using fallback: ${(e as Error).message}`);
    return fallback;
  }
}

function parsePlan(raw: string): DemoPlan | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as DemoPlan;
    if (obj.kind !== "frontend" && obj.kind !== "api") return null;
    if (obj.kind === "frontend") {
      obj.steps = (obj.steps ?? []).filter((s) => s && s.action).slice(0, CONFIG.maxSteps);
      if (!obj.steps.length) obj.steps = [{ action: "goto", path: "/" }];
    } else {
      obj.calls = (obj.calls ?? []).filter((c) => c && c.path).slice(0, CONFIG.maxApiCalls);
      if (!obj.calls.length) obj.calls = [{ method: "GET", path: "/" }];
    }
    return obj;
  } catch {
    return null;
  }
}

// ── Frontend recorder (video) ────────────────────────────────────────────────────

async function recordFrontend(ticketId: string, base: string, plan: DemoPlan): Promise<TicketDemoResult> {
  const outDir = `${process.cwd()}/uploads/ticket-tests/${ticketId}`;
  let requestId: string | undefined;
  try {
    const session = await startBrowserSession({ timeout: 120_000 });
    requestId = session.requestId;
    const workerCfg = {
      wsEndpoint: session.wsEndpoint,
      base,
      outDir,
      viewport: CONFIG.viewport,
      navTimeoutMs: CONFIG.navTimeoutMs,
      settleMs: CONFIG.settleMs,
      steps: plan.steps ?? [],
      authCookie: { name: CONFIG.cookieName, value: CONFIG.cookieSecret },
    };
    const { videoPath, authGated } = await runRecorder(workerCfg);
    const videoUrl = videoPath ? `/uploads/ticket-tests/${ticketId}/demo.webm` : undefined;
    return {
      kind: "frontend",
      status: authGated ? "auth_gated" : videoUrl ? "ready" : "error",
      videoUrl,
      summary: authGated
        ? "The app requires Google sign-in and preview-mode auth wasn't honored — rebuild to enable full-demo recording."
        : plan.summary || "Recorded a walkthrough of the feature.",
      generatedAt: new Date().toISOString(),
    };
  } finally {
    if (requestId) await stopWorkspace(requestId).catch(() => {});
  }
}

/** Spawn the Node recorder worker; resolve with the video path + auth flag. */
function runRecorder(cfg: object): Promise<{ videoPath: string | null; authGated: boolean }> {
  return new Promise((resolve, reject) => {
    const workerPath = `${process.cwd()}/scripts/demo-recorder-worker.mjs`;
    const child = spawn("node", [workerPath], { stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    let workerError: Error | null = null;
    let done: { videoPath: string | null; authGated: boolean } = { videoPath: null, authGated: false };

    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "done") done = { videoPath: msg.videoPath ?? null, authGated: !!msg.authGated };
        else if (msg.type === "error") workerError = new Error(msg.message);
      }
    });
    child.on("error", (e) => reject(e));
    child.on("exit", () => (workerError ? reject(workerError) : resolve(done)));

    child.stdin.write(JSON.stringify(cfg));
    child.stdin.end();
  });
}

// ── API recorder (terminal transcript) ───────────────────────────────────────────

async function recordApi(ticketId: string, workspaceId: string, port: number, plan: DemoPlan): Promise<TicketDemoResult> {
  const transcript: NonNullable<TicketDemoResult["transcript"]> = [];
  for (const call of plan.calls ?? []) {
    const method = (call.method || "GET").toUpperCase();
    const url = `http://localhost:${port}${call.path.startsWith("/") ? call.path : "/" + call.path}`;
    // -s silent, -S show errors, -w append status; body for non-GET; cap output size.
    const parts = [`curl -sS -X ${method}`, `-H 'Content-Type: application/json'`];
    if (call.body && method !== "GET") parts.push(`-d ${shellQuote(call.body)}`);
    parts.push(`-w '\\n__HTTP__%{http_code}'`, shellQuote(url));
    const cmd = `cd /data/project 2>/dev/null; ${parts.join(" ")} 2>&1 | head -c 4000`;
    let output = "";
    let statusCode = "";
    try {
      const res = await execOnWorkspace(workspaceId, cmd, { timeout: 30_000 });
      output = (res.output || "").trim();
      const m = output.match(/__HTTP__(\d{3})\s*$/);
      if (m) {
        statusCode = m[1]!;
        output = output.replace(/__HTTP__\d{3}\s*$/, "").trim();
      }
    } catch (e) {
      output = `error: ${(e as Error).message}`;
    }
    transcript.push({
      command: `${method} ${call.path}`,
      note: call.note,
      status: statusCode || undefined,
      output: output || "(no output)",
    });
  }
  return {
    kind: "api",
    status: transcript.length ? "ready" : "error",
    transcript,
    summary: plan.summary || "Executed the endpoint(s) and captured the response data.",
    generatedAt: new Date().toISOString(),
  };
}

// ── Sandbox helpers ──────────────────────────────────────────────────────────────

async function listChangedFiles(workspaceId: string): Promise<string[]> {
  try {
    const cmd =
      `cd /data/project 2>/dev/null && ` +
      `(git diff --name-only HEAD~1 2>/dev/null || git diff --name-only 2>/dev/null) | head -60`;
    const res = await execOnWorkspace(workspaceId, cmd, { timeout: 20_000 });
    return (res.output || "").split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function listRoutes(workspaceId: string): Promise<string[]> {
  try {
    const cmd =
      `find /data/project/src/app /data/project/app -type f ` +
      `\\( -name 'page.tsx' -o -name 'page.jsx' -o -name 'page.ts' -o -name 'page.js' \\) 2>/dev/null | head -100`;
    const res = await execOnWorkspace(workspaceId, cmd, { timeout: 20_000 });
    const paths = (res.output || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const routes = new Set<string>(["/"]);
    for (const p of paths) {
      const rel = p.replace(/^.*\/(?:src\/)?app/, "").replace(/\/page\.(tsx|jsx|ts|js)$/, "");
      const segs = rel.split("/").filter(Boolean);
      if (segs.some((s) => /\[.*\]/.test(s) || s.startsWith("@") || s.startsWith("(."))) continue;
      routes.add("/" + segs.filter((s) => !/^\(.*\)$/.test(s)).join("/"));
    }
    return [...routes].map((r) => (r === "" ? "/" : r));
  } catch {
    return ["/"];
  }
}

async function resolveModel(ownerId: string) {
  const [modelSel] = await db.select().from(modelSelections).where(eq(modelSelections.userId, ownerId));
  const [keys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, ownerId));
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
  try {
    return getLiteModel(modelKey, userApiKeys, { allowEnvFallback: true }).model;
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── Persistence + broadcast ──────────────────────────────────────────────────────

async function persist(ticketId: string, result: TicketDemoResult): Promise<void> {
  // Stored under the existing `details` JSON column (present on both sqlite + pg
  // ticket schemas) — no migration. Spread preserves any other detail keys.
  const [row] = await db
    .select({ details: projectTickets.details })
    .from(projectTickets)
    .where(eq(projectTickets.id, ticketId))
    .limit(1);
  const details = (row?.details as Record<string, unknown> | null) ?? {};
  await db
    .update(projectTickets)
    .set({ details: { ...details, previewDemo: result }, updatedAt: new Date() })
    .where(eq(projectTickets.id, ticketId));
}

function broadcast(ownerId: string, ticketId: string, status: string): void {
  broadcastToUser(ownerId, { type: "ticket_demo", ticketId, status });
}
