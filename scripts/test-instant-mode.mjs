#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_OUTPUT_DIR = "out/instant-mode";

function fail(message) {
  console.error(`[instant-test] ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[instant-test] ${message}`);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing required env var ${name}.`);
  return value;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Expected a positive integer, got "${value}".`);
  }
  return parsed;
}

function trimTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function timestampStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeForFileName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
}

function summarizeText(value, max = 240) {
  if (!value) return "";
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeText(filePath, value) {
  await fs.writeFile(filePath, value, "utf8");
}

async function screenshot(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: true });
}

async function importPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    fail(
      "Missing the `playwright` package. Install it in the project root with `bun add -d playwright && bunx playwright install chromium` or `npm i -D playwright && npx playwright install chromium`."
    );
  }
}

async function loginWithUi(page, config) {
  log("Attempting UI login.");

  await page.locator("#login-email").fill(config.email);
  await page.locator("#login-password").fill(config.password);

  const tokenReady = await page
    .waitForFunction(() => Boolean(globalThis.loginTurnstileToken), null, {
      timeout: 15_000,
    })
    .then(() => true)
    .catch(() => false);

  if (!tokenReady) {
    if (config.authMode === "ui") {
      throw new Error("Turnstile token never became available on the login page.");
    }
    return false;
  }

  await page.locator("#login-form button[type='submit']").click();

  try {
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/login"), {
      timeout: 30_000,
    });
  } catch (error) {
    const authError = (await page.locator("#auth-error").textContent().catch(() => ""))?.trim();
    throw new Error(authError || `UI login did not complete: ${error.message}`);
  }

  return true;
}

async function loginWithApi(page, config) {
  log("Attempting API login.");

  const result = await page.evaluate(
    async ({ email, password }) => {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email,
          password,
          turnstileToken: globalThis.loginTurnstileToken || "playwright-test-token",
        }),
      });

      const bodyText = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        bodyText,
      };
    },
    { email: config.email, password: config.password }
  );

  if (!result.ok) {
    throw new Error(`API login failed with status ${result.status}: ${summarizeText(result.bodyText)}`);
  }

  await page.goto(`${config.baseUrl}/projects`, { waitUntil: "domcontentloaded" });
}

async function login(page, config) {
  await page.goto(`${config.baseUrl}/auth/login`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  if (!page.url().includes("/auth/login")) {
    log("Already authenticated.");
    return "existing-session";
  }

  if (config.authMode !== "api") {
    const completed = await loginWithUi(page, config);
    if (completed) return "ui";
    log("UI login could not get a Turnstile token; falling back to API login.");
  }

  await loginWithApi(page, config);
  return "api";
}

async function captureState(page) {
  return page.evaluate(() => {
    const iframe = document.getElementById("preview-iframe");
    const statusText = document.getElementById("status-text")?.textContent?.trim() ?? "";
    const buildingMessage = document.getElementById("building-message")?.textContent?.trim() ?? "";
    const envRequest = document.querySelector(".notice-env-request");
    const errorNotice = document.querySelector(".instant-build-notice.notice-error");
    const notices = Array.from(
      document.querySelectorAll(".instant-build-notice, .notice-env-request")
    )
      .slice(-8)
      .map((node) => node.textContent?.trim() ?? "")
      .filter(Boolean);

    return {
      pathname: window.location.pathname,
      appId: globalThis.INSTANT_CONFIG?.currentAppId ?? "",
      projectId: globalThis.INSTANT_CONFIG?.projectId ?? "",
      previewUrl: iframe?.getAttribute("src") ?? "",
      statusText,
      buildingMessage,
      envRequestText: envRequest?.textContent?.trim() ?? "",
      hasErrorNotice: Boolean(errorNotice),
      notices,
    };
  });
}

async function waitForOutcome(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = await captureState(page);
  let previousLine = "";

  while (Date.now() < deadline) {
    lastState = await captureState(page);
    const progressLine = [lastState.statusText, lastState.buildingMessage].filter(Boolean).join(" | ");
    if (progressLine && progressLine !== previousLine) {
      log(`Build status: ${progressLine}`);
      previousLine = progressLine;
    }

    if (lastState.previewUrl) {
      return { outcome: "ready", state: lastState };
    }
    if (lastState.envRequestText) {
      return { outcome: "env-request", state: lastState };
    }
    if (lastState.hasErrorNotice || /(^|\b)error(\b|$)/i.test(lastState.statusText)) {
      return { outcome: "error", state: lastState };
    }

    await page.waitForTimeout(5_000);
  }

  return { outcome: "timeout", state: lastState };
}

async function fetchLogs(page, state) {
  if (!state.appId) return "";

  return page.evaluate(async ({ appId, projectId }) => {
    const url = projectId
      ? `/api/instant/${projectId}/apps/${appId}/logs/?offset=0`
      : `/api/instant/apps/${appId}/logs/?offset=0`;

    try {
      const response = await fetch(url, { credentials: "same-origin" });
      const data = await response.json();
      if (typeof data.logs === "string" && data.logs) return data.logs;
      if (typeof data.error === "string" && data.error) return `ERROR: ${data.error}`;
      return "";
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  }, state);
}

async function openPreview(context, state, runDir, expectedText) {
  if (!state.previewUrl) {
    return { title: "", url: "" };
  }

  const previewPage = await context.newPage();
  try {
    await previewPage.goto(state.previewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await previewPage.waitForLoadState("networkidle").catch(() => {});

    if (expectedText) {
      await previewPage.getByText(expectedText, { exact: false }).first().waitFor({
        timeout: 20_000,
      });
    }

    await screenshot(previewPage, path.join(runDir, "preview.png"));
    const title = await previewPage.title();
    return { title, url: previewPage.url() };
  } finally {
    await previewPage.close();
  }
}

async function main() {
  const config = {
    baseUrl: trimTrailingSlash(process.env.LFG_BASE_URL?.trim() || DEFAULT_BASE_URL),
    email: requireEnv("LFG_LOGIN_EMAIL"),
    password: requireEnv("LFG_LOGIN_PASSWORD"),
    prompt: requireEnv("LFG_INSTANT_PROMPT"),
    authMode: (process.env.LFG_AUTH_MODE?.trim().toLowerCase() || "auto"),
    headless: parseBoolean(process.env.LFG_HEADLESS, false),
    buildTimeoutMs: parseInteger(process.env.LFG_BUILD_TIMEOUT_MS, DEFAULT_BUILD_TIMEOUT_MS),
    expectedText: process.env.LFG_EXPECT_TEXT?.trim() || "",
    outputRoot: path.resolve(process.cwd(), process.env.LFG_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR),
  };

  if (!["auto", "ui", "api"].includes(config.authMode)) {
    fail(`Unsupported LFG_AUTH_MODE "${config.authMode}". Use auto, ui, or api.`);
  }

  const runDir = path.join(config.outputRoot, `${timestampStamp()}-${sanitizeForFileName(config.prompt)}`);
  await ensureDir(runDir);

  const { chromium } = await importPlaywright();
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const summary = {
    baseUrl: config.baseUrl,
    prompt: config.prompt,
    authMode: config.authMode,
    buildTimeoutMs: config.buildTimeoutMs,
    runDir,
    loginMethod: "",
    outcome: "",
    previewUrl: "",
    previewTitle: "",
    appId: "",
    statusText: "",
    buildingMessage: "",
    notices: [],
    startedAt: new Date().toISOString(),
    finishedAt: "",
    expectedText: config.expectedText,
  };

  try {
    log(`Artifacts will be written to ${runDir}`);

    summary.loginMethod = await login(page, config);
    log(`Authenticated via ${summary.loginMethod}.`);

    await page.goto(`${config.baseUrl}/instant`, { waitUntil: "domcontentloaded" });
    await page.locator("#chat-input").waitFor({ timeout: 30_000 });
    await screenshot(page, path.join(runDir, "instant-before-submit.png"));

    log("Submitting instant-mode prompt.");
    await page.locator("#chat-input").fill(config.prompt);
    await page.locator("#send-btn").click();

    await page
      .waitForFunction(
        () =>
          Boolean(globalThis.INSTANT_CONFIG?.currentAppId) ||
          window.location.pathname.includes("/instant/app/"),
        null,
        { timeout: 60_000 }
      )
      .catch(() => {});

    const { outcome, state } = await waitForOutcome(page, config.buildTimeoutMs);
    summary.outcome = outcome;
    summary.previewUrl = state.previewUrl;
    summary.appId = state.appId;
    summary.statusText = state.statusText;
    summary.buildingMessage = state.buildingMessage;
    summary.notices = state.notices;

    await screenshot(page, path.join(runDir, "instant-final.png"));

    const logs = await fetchLogs(page, state);
    if (logs) {
      await writeText(path.join(runDir, "instant-logs.txt"), logs);
    }

    if (outcome === "ready") {
      const preview = await openPreview(context, state, runDir, config.expectedText);
      summary.previewUrl = preview.url || state.previewUrl;
      summary.previewTitle = preview.title;
      log(`Preview is available at ${summary.previewUrl}`);
    } else if (outcome === "env-request") {
      throw new Error(`The build requested environment variables: ${state.envRequestText}`);
    } else if (outcome === "error") {
      throw new Error(`Instant build reported an error. Last notices: ${state.notices.join(" | ")}`);
    } else {
      throw new Error(`Timed out waiting for the app to become ready. Last status: ${state.statusText || state.buildingMessage || "unknown"}`);
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    await writeText(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[instant-test] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
