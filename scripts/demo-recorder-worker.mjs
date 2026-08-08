/**
 * Demo recorder worker — runs under NODE (Playwright's connectOverCDP hangs under
 * Bun, but works under Node — same constraint as qa-browser-worker.mjs). The Bun
 * server spawns this, writes a JSON config to stdin, and reads newline-delimited
 * JSON from stdout:
 *   {"type":"step","step":{...}}     (one per executed step, best-effort)
 *   {"type":"done","videoPath":"…","authGated":bool,"steps":[…]}
 *   {"type":"error","message":"…"}
 *
 * It records a VIDEO of a scripted walkthrough of the built app (frontend tickets):
 * connect over CDP → new context with recordVideo → seed the preview-auth cookie →
 * run the planned steps (goto/click/type/scroll/wait) → close the context (flushes
 * the .webm) → report the video path.
 *
 * Config (stdin JSON): {
 *   wsEndpoint, base, outDir, viewport, navTimeoutMs, settleMs,
 *   steps: [{ action, selector?, text?, url?, path?, amount?, ms? }],
 *   authCookie?: { name, value }   // preview-mode session, seeded before nav
 * }
 */
import { chromium } from "playwright-core";
import { mkdir, readdir, rename } from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const readStdin = () =>
  new Promise((res) => {
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => res(d));
  });

async function connectWithRetry(ws) {
  let last;
  for (let i = 1; i <= 5; i++) {
    try {
      return await chromium.connectOverCDP(ws, { timeout: 20_000 });
    } catch (e) {
      last = e;
      if (i < 5) await sleep(3000);
    }
  }
  throw last;
}

// A reaped/sleeping VM serves a 503 "waking up" placeholder for the first several
// seconds — wait it out so the demo records the REAL app, not the cold-start page.
const WAKING_RE = /Starting your application|Your VM is waking up|waking up/i;
// Landed on a Google login screen → the app is auth-gated and our preview bypass
// didn't take. Detected so the orchestrator can mark the demo auth_gated.
const GOOGLE_AUTH_RE = /accounts\.google\.com|oauth2|\/auth\/google|sign in with google/i;

async function gotoReady(page, url, cfg) {
  let resp = null;
  for (let a = 0; a < 6; a++) {
    try {
      resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs });
    } catch (e) {
      if (a === 5) throw e;
      await page.waitForTimeout(2500);
      continue;
    }
    let waking = (resp?.status() ?? 0) === 503;
    if (!waking) {
      try {
        waking = WAKING_RE.test((await page.evaluate(() => (document.body && document.body.innerText) || "")) || "");
      } catch {
        /* ignore */
      }
    }
    if (waking && a < 5) {
      await page.waitForTimeout(4000);
      continue;
    }
    break;
  }
  return resp;
}

const cfg = JSON.parse(await readStdin());
await mkdir(cfg.outDir, { recursive: true }).catch(() => {});

let browser;
try {
  browser = await connectWithRetry(cfg.wsEndpoint);
} catch (e) {
  emit({ type: "error", message: "CDP WS connect failed: " + String(e.message).split("\n")[0] });
  process.exit(0);
}

const executed = [];
let authGated = false;
let context;
let videoPath;
try {
  // A dedicated context with video recording. Video is written on context.close().
  context = await browser.newContext({
    viewport: cfg.viewport || { width: 1280, height: 800 },
    recordVideo: { dir: cfg.outDir, size: cfg.viewport || { width: 1280, height: 800 } },
    ignoreHTTPSErrors: true,
  });
  // Seed the preview-mode session cookie BEFORE any navigation, so the very first
  // page load is already authenticated (skips Google OAuth on apps that honor it).
  if (cfg.authCookie?.name && cfg.base) {
    try {
      await context.addCookies([
        {
          name: cfg.authCookie.name,
          value: cfg.authCookie.value,
          url: cfg.base,
        },
      ]);
    } catch {
      /* best-effort */
    }
  }

  const page = await context.newPage();
  // Default first step is a goto to base if the plan didn't start with one.
  const steps = Array.isArray(cfg.steps) && cfg.steps.length ? cfg.steps : [{ action: "goto", path: "/" }];

  for (const step of steps) {
    const started = Date.now();
    let ok = true;
    let note = "";
    try {
      switch (step.action) {
        case "goto": {
          const target = step.url || cfg.base + (step.path && step.path !== "/" ? step.path : "/");
          const resp = await gotoReady(page, target, cfg);
          await page.waitForTimeout(cfg.settleMs || 1200);
          note = "HTTP " + (resp?.status() ?? "?");
          // Auth detection: URL or content shows Google login.
          const cur = page.url();
          let bodyTxt = "";
          try {
            bodyTxt = (await page.evaluate(() => (document.body && document.body.innerText) || "")) || "";
          } catch {
            /* ignore */
          }
          if (GOOGLE_AUTH_RE.test(cur) || GOOGLE_AUTH_RE.test(bodyTxt)) authGated = true;
          break;
        }
        case "click": {
          if (step.selector) {
            await page.locator(step.selector).first().click({ timeout: 8000 });
          } else if (step.text) {
            await page.getByText(step.text, { exact: false }).first().click({ timeout: 8000 });
          }
          await page.waitForTimeout(step.ms || 800);
          break;
        }
        case "type": {
          if (step.selector) {
            await page.locator(step.selector).first().fill(step.text || "", { timeout: 8000 });
          }
          await page.waitForTimeout(step.ms || 400);
          break;
        }
        case "scroll": {
          await page.mouse.wheel(0, step.amount || 600);
          await page.waitForTimeout(step.ms || 600);
          break;
        }
        case "wait": {
          await page.waitForTimeout(step.ms || 1000);
          break;
        }
        default:
          ok = false;
          note = "unknown action";
      }
    } catch (e) {
      ok = false;
      note = String(e.message || e).split("\n")[0].slice(0, 160);
    }
    const rec = { action: step.action, ok, note, ms: Date.now() - started };
    executed.push(rec);
    emit({ type: "step", step: rec });
  }

  // Give the recorder a beat to capture the final frame, then close to flush video.
  await page.waitForTimeout(800);
  const video = page.video();
  await context.close(); // flushes the .webm to outDir
  context = undefined;
  try {
    if (video) videoPath = await video.path();
  } catch {
    /* fall through to dir scan */
  }
} catch (e) {
  emit({ type: "error", message: "recording failed: " + String(e.message).split("\n")[0] });
} finally {
  if (context) await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

// Playwright names the video with a random id; rename to a stable demo.webm so the
// orchestrator/UI has a predictable URL.
let finalPath = videoPath;
try {
  const files = (await readdir(cfg.outDir)).filter((f) => f.endsWith(".webm"));
  if (files.length) {
    const src = cfg.outDir + "/" + (videoPath ? videoPath.split("/").pop() : files[files.length - 1]);
    finalPath = cfg.outDir + "/demo.webm";
    await rename(src, finalPath).catch(() => {});
  }
} catch {
  /* best-effort */
}

emit({ type: "done", videoPath: finalPath || null, authGated, steps: executed });
process.exit(0);
