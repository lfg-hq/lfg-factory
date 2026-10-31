/**
 * LFG Desktop: a window onto the company's LFG server, plus a runner that does the
 * coding on this computer with the Claude Code login already here.
 *
 * Signing in happens in the person's own browser (see browser-signin.ts), which hands
 * back this computer's runner token and a session of the app's own. The app never
 * shows the website's login page and never signs in to Google inside its window.
 *
 * Stored locally: the server URL, the runner token (encrypted with the OS keychain via
 * safeStorage), this computer's device id, and the "don't ask again" project list.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage, session, shell, Tray, nativeImage, type IpcMainInvokeEvent } from "electron";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runner, defaultWorkRoot, type RunnerState } from "./runner.ts";
import { nodeSocketFactory } from "./socket.ts";
import { signInWithBrowser, SignInCancelled } from "./browser-signin.ts";
import type { RunnerJobOffer } from "./protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface Config {
  serverUrl?: string;
  /** base64 of safeStorage.encryptString(runner token) */
  token?: string;
  deviceId?: string;
  email?: string;
  /** Projects whose jobs run without asking. */
  trustedProjects?: string[];
  workRoot?: string;
}

// Development overrides, set by desktop/try.sh: a throwaway profile pointed at a local test server.
if (process.env.LFG_DESKTOP_PROFILE) app.setPath("userData", `${app.getPath("userData")}-${process.env.LFG_DESKTOP_PROFILE}`);

/**
 * The server this build signs in to: LFG Cloud, or a company's own deployment named in
 * server.json next to the app ({"serverUrl": "https://lfg.example.com"}). try.sh points
 * it at a local test server with LFG_SERVER_URL. People only change it by choice.
 */
function defaultServerUrl(): string {
  if (process.env.LFG_SERVER_URL) return new URL(process.env.LFG_SERVER_URL).origin;
  try {
    const bundled = JSON.parse(readFileSync(join(here, "..", "server.json"), "utf8")) as { serverUrl?: string };
    if (bundled.serverUrl) return new URL(bundled.serverUrl).origin;
  } catch { /* none bundled */ }
  return "https://lfg.run";
}

const configPath = () => join(app.getPath("userData"), "config.json");
function loadConfig(): Config {
  try { return JSON.parse(readFileSync(configPath(), "utf8")); } catch { return {}; }
}
function saveConfig() {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
function readToken(): string | null {
  if (!config.token) return null;
  try { return safeStorage.decryptString(Buffer.from(config.token, "base64")); } catch { return null; }
}

/** GUI apps on macOS don't get the login shell's PATH, so `claude` and `git` wouldn't be found. */
function loginShellEnv(): NodeJS.ProcessEnv {
  if (process.platform === "win32") return process.env;
  const shellPath = process.env.SHELL || "/bin/zsh";
  const r = spawnSync(shellPath, ["-ilc", "env -0"], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const pair of r.stdout.split("\0")) {
    const i = pair.indexOf("=");
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return { ...process.env, ...env };
}

let config: Config = {};
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runner: Runner | null = null;
let runnerStatus: { state: RunnerState; detail?: string } = { state: "disconnected" };
let shellEnv: NodeJS.ProcessEnv = process.env;
let signIn: AbortController | null = null;
let signInNotice = "";

const origin = () => (config.serverUrl ? new URL(config.serverUrl).origin : "");
const deviceName = () => (process.platform === "darwin" ? spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).stdout.trim() : "") || hostname().replace(/\.local$/, "");

// ── Window ───────────────────────────────────────────────────────────

function ensureWindow(): BrowserWindow {
  if (mainWindow) return mainWindow;
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 480, minHeight: 560, title: "LFG",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  // The website's sign-in pages mean "not signed in here": show the app's own sign-in.
  const isSignInPage = (url: URL) => url.origin === origin() && /^\/auth\/(login|register)\/?$/.test(url.pathname);
  const guard = (event: Electron.Event, raw: string) => {
    let url: URL;
    try { url = new URL(raw); } catch { return; }
    if (url.protocol === "file:") return;
    if (isSignInPage(url)) { event.preventDefault(); showSignIn(); return; }
    // Other sites open in the person's browser, not inside the app.
    if (url.origin !== origin()) { event.preventDefault(); void shell.openExternal(raw); }
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin()) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => { mainWindow = null; });
  mainWindow = win;
  return win;
}

function showSignIn(notice = "") {
  signInNotice = notice;
  const win = ensureWindow();
  void win.loadFile(join(here, "setup.html"));
  win.show();
}

function showWorkspace(path = "/projects") {
  if (!config.serverUrl || !readToken()) return showSignIn();
  const win = ensureWindow();
  void win.loadURL(`${origin()}${path}`);
  win.show();
  win.focus();
}

/** Mark requests to the LFG server as coming from the app, so it skips the marketing site. */
function tagServerRequests() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (config.serverUrl && details.url.startsWith(origin() + "/")) headers["X-LFG-Desktop"] = app.getVersion();
    callback({ requestHeaders: headers });
  });
}

// ── Sign-in (from the local setup page only) ─────────────────────────

const fromSetupPage = (event: IpcMainInvokeEvent) => event.senderFrame?.url.startsWith("file://") ?? false;

ipcMain.handle("lfg:get-setup", (event) => {
  if (!fromSetupPage(event)) return null;
  return { serverUrl: config.serverUrl ?? defaultServerUrl(), email: config.email ?? "", notice: signInNotice, deviceName: deviceName() };
});

ipcMain.handle("lfg:sign-in", async (event, input: { serverUrl: string }) => {
  if (!fromSetupPage(event)) return { ok: false, error: "Not allowed" };
  let url: URL;
  try { url = new URL(String(input.serverUrl).trim()); } catch { return { ok: false, error: "Enter the full address, like https://lfg.yourcompany.com" }; }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) return { ok: false, error: "Use an https:// address." };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: "This system has no secure storage for the sign-in." };
  signIn?.abort();
  signIn = new AbortController();
  try {
    const result = await signInWithBrowser({
      serverUrl: url.origin,
      deviceName: deviceName(),
      replaceDeviceId: url.origin === origin() ? config.deviceId : undefined,
      openBrowser: (link) => shell.openExternal(link),
      signal: signIn.signal,
    });
    config = { ...config, serverUrl: url.origin, token: safeStorage.encryptString(result.runnerToken).toString("base64"), deviceId: result.deviceId, email: result.user.email };
    saveConfig();
    startRunner();
    ensureWindow();
    void mainWindow!.loadURL(`${url.origin}/desktop/session?token=${encodeURIComponent(result.sessionToken)}`);
    app.focus({ steal: true });
    mainWindow!.show();
    return { ok: true };
  } catch (error) {
    if (error instanceof SignInCancelled) return { ok: false, cancelled: true, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    signIn = null;
  }
});

ipcMain.handle("lfg:cancel-sign-in", (event) => { if (fromSetupPage(event)) signIn?.abort(); });

async function signOut() {
  const server = origin();
  if (server && config.deviceId) {
    // Unpair this computer while the session still exists, then end the session.
    await session.defaultSession.fetch(`${server}/api/runner/devices/${config.deviceId}`, { method: "DELETE", credentials: "include" }).catch(() => {});
    await session.defaultSession.fetch(`${server}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
  }
  await session.defaultSession.clearStorageData({ storages: ["cookies"] });
  runner?.stop();
  runner = null;
  runnerStatus = { state: "disconnected" };
  config = { ...config, token: undefined, deviceId: undefined, email: undefined };
  saveConfig();
  refreshTray();
  showSignIn("You're signed out on this computer.");
}

// ── Runner ───────────────────────────────────────────────────────────

async function approve(job: RunnerJobOffer) {
  const p = job.payload;
  if (config.trustedProjects?.includes(p.projectName)) return { approved: true as const };
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Run on this computer", "Decline"],
    defaultId: 0,
    cancelId: 1,
    message: `Run ${p.ticketKey ?? "this ticket"} with Claude Code?`,
    detail: `${p.ticketTitle}\n\nProject: ${p.projectName}\nRepository: ${p.repoUrl}\nBranch: ${p.branch}\n\n` +
      `Claude Code will edit files in a separate worktree under ${config.workRoot ?? defaultWorkRoot()}, ` +
      `then LFG Desktop commits and pushes the branch with your Git credentials.\n\n` +
      `${p.prompt.slice(0, 600)}${p.prompt.length > 600 ? "…" : ""}`,
    checkboxLabel: `Always run jobs for ${p.projectName} without asking`,
  });
  if (response !== 0) return { approved: false as const, reason: "Declined on this computer" };
  if (checkboxChecked) {
    config.trustedProjects = [...new Set([...(config.trustedProjects ?? []), p.projectName])];
    saveConfig();
  }
  return { approved: true as const };
}

function startRunner() {
  runner?.stop();
  runner = null;
  const token = readToken();
  if (!config.serverUrl || !token) return;
  runner = new Runner({
    serverUrl: config.serverUrl,
    token,
    claudeBin: process.env.LFG_CLAUDE_BIN,
    allowLocalRepos: process.env.LFG_RUNNER_ALLOW_LOCAL_REPOS === "1",
    workRoot: config.workRoot ?? defaultWorkRoot(),
    createSocket: nodeSocketFactory,
    env: shellEnv,
    appVersion: app.getVersion(),
    approve,
    onState: (state, detail) => {
      runnerStatus = { state, detail };
      refreshTray();
      if (state === "unauthorized") showSignIn("This computer was disconnected from LFG. Sign in again to reconnect it.");
    },
    onJob: (e) => {
      const body = e.phase === "started" ? "Started on this computer"
        : e.phase === "finished" ? (e.detail ?? "Done")
        : e.phase === "failed" ? `Failed: ${e.detail ?? ""}`.slice(0, 200)
        : e.phase === "cancelled" ? "Cancelled" : `Declined${e.detail ? `: ${e.detail}` : ""}`;
      if (Notification.isSupported()) new Notification({ title: e.title, body }).show();
      refreshTray();
    },
    log: (line) => console.log(line),
  });
  runner.start();
}

// ── Menu bar ─────────────────────────────────────────────────────────

function statusLabel(): string {
  if (!readToken()) return "Not signed in";
  switch (runnerStatus.state) {
    case "connected": return `Connected${config.email ? ` as ${config.email}` : ""}`;
    case "connecting": return "Connecting…";
    case "unauthorized": return "Disconnected: sign in again";
    case "stopped": return "Runner stopped";
    default: return `Offline${runnerStatus.detail ? `: ${runnerStatus.detail}` : ""}, retrying`;
  }
}

function refreshTray() {
  if (!tray) return;
  const busy = runner?.active.size ?? 0;
  const signedIn = !!readToken();
  tray.setToolTip(`LFG: ${statusLabel()}`);
  if (process.platform === "darwin") tray.setTitle(busy ? `LFG ●${busy}` : runnerStatus.state === "connected" ? "LFG" : "LFG ○");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    ...(busy ? [{ label: `${busy} job running`, enabled: false }] : []),
    { type: "separator" },
    { label: "Open LFG", click: () => showWorkspace() },
    ...(signedIn ? [{ label: "Open LFG in your browser", click: () => { void shell.openExternal(`${origin()}/projects`); } }] : []),
    { label: "Open work folder", click: () => { const dir = config.workRoot ?? defaultWorkRoot(); mkdirSync(dir, { recursive: true }); void shell.openPath(dir); } },
    { type: "separator" },
    signedIn ? { label: "Sign out on this computer", click: () => { void signOut(); } } : { label: "Sign in…", click: () => showSignIn() },
    { label: "Quit LFG", role: "quit" },
  ]));
}

// ── App ──────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWorkspace());
  app.whenReady().then(() => {
    shellEnv = loginShellEnv();
    config = loadConfig();
    if (process.env.LFG_SERVER_URL && origin() !== defaultServerUrl()) {
      config = { trustedProjects: config.trustedProjects, serverUrl: defaultServerUrl() };
    }
    if (process.env.LFG_WORK_ROOT) config.workRoot = process.env.LFG_WORK_ROOT;
    tagServerRequests();
    tray = new Tray(nativeImage.createEmpty());
    refreshTray();
    startRunner();
    showWorkspace();
    app.on("activate", () => showWorkspace());
  });
  // Keep running in the menu bar so jobs can still arrive with no window open.
  app.on("window-all-closed", () => { /* stay alive */ });
  app.on("before-quit", () => { signIn?.abort(); runner?.stop(); });
}
