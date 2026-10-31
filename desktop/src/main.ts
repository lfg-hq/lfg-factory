/**
 * LFG Desktop: a window onto the company's LFG server, plus a runner that does the
 * coding on this computer with the Claude Code login already here.
 *
 * Nothing is stored locally except the server URL, this computer's runner token
 * (encrypted with the OS keychain via safeStorage) and the "don't ask again" list.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage, shell, Tray, nativeImage } from "electron";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runner, defaultWorkRoot, type RunnerState } from "./runner.ts";
import { nodeSocketFactory } from "./socket.ts";
import type { RunnerJobOffer } from "./protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface Config {
  serverUrl?: string;
  /** base64 of safeStorage.encryptString(token) */
  token?: string;
  /** Projects whose jobs run without asking. */
  trustedProjects?: string[];
  workRoot?: string;
}

const configPath = () => join(app.getPath("userData"), "config.json");
function loadConfig(): Config {
  try { return JSON.parse(readFileSync(configPath(), "utf8")); } catch { return {}; }
}
function saveConfig(config: Config) {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
function readToken(config: Config): string | null {
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
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runner: Runner | null = null;
let runnerStatus: { state: RunnerState; detail?: string } = { state: "disconnected" };
let shellEnv: NodeJS.ProcessEnv = process.env;

function openMain() {
  if (!config.serverUrl) return openSetup();
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({ width: 1400, height: 900, title: "LFG", webPreferences: { contextIsolation: true, sandbox: true } });
  const origin = new URL(config.serverUrl).origin;
  // Links to other sites open in the person's browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); void shell.openExternal(url); }
  });
  void mainWindow.loadURL(config.serverUrl);
  mainWindow.on("closed", () => { mainWindow = null; });
}

function openSetup() {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 560, height: 560, title: "Connect LFG Desktop", resizable: false,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  void setupWindow.loadFile(join(here, "setup.html"));
  setupWindow.on("closed", () => { setupWindow = null; });
}

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
    saveConfig(config);
  }
  return { approved: true as const };
}

function startRunner() {
  runner?.stop();
  runner = null;
  const token = readToken(config);
  if (!config.serverUrl || !token) return;
  runner = new Runner({
    serverUrl: config.serverUrl,
    token,
    workRoot: config.workRoot ?? defaultWorkRoot(),
    createSocket: nodeSocketFactory,
    env: shellEnv,
    appVersion: app.getVersion(),
    approve,
    onState: (state, detail) => { runnerStatus = { state, detail }; refreshTray(); },
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

function statusLabel(): string {
  switch (runnerStatus.state) {
    case "connected": return `Connected${runnerStatus.detail ? ` as ${runnerStatus.detail}` : ""}`;
    case "connecting": return "Connecting…";
    case "unauthorized": return "Not paired: pair this computer again";
    case "stopped": return "Runner stopped";
    default: return `Disconnected${runnerStatus.detail ? `: ${runnerStatus.detail}` : ""}, retrying`;
  }
}

function refreshTray() {
  if (!tray) return;
  const busy = runner?.active.size ?? 0;
  tray.setToolTip(`LFG: ${statusLabel()}`);
  if (process.platform === "darwin") tray.setTitle(busy ? `LFG ●${busy}` : runnerStatus.state === "connected" ? "LFG" : "LFG ○");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    ...(busy ? [{ label: `${busy} job running`, enabled: false }] : []),
    { type: "separator" },
    { label: "Open LFG", click: openMain },
    { label: "Open work folder", click: () => { const dir = config.workRoot ?? defaultWorkRoot(); mkdirSync(dir, { recursive: true }); void shell.openPath(dir); } },
    { label: "Pair this computer again…", click: openSetup },
    { type: "separator" },
    { label: "Quit LFG", role: "quit" },
  ]));
}

ipcMain.handle("lfg:get-setup", () => ({ serverUrl: config.serverUrl ?? "", paired: !!readToken(config), encryption: safeStorage.isEncryptionAvailable() }));
ipcMain.handle("lfg:save-setup", async (_e, input: { serverUrl: string; token: string }) => {
  let url: URL;
  try { url = new URL(input.serverUrl.trim()); } catch { return { ok: false, error: "Enter the full address, like https://lfg.yourcompany.com" }; }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) return { ok: false, error: "Use an https:// address." };
  const token = input.token.trim();
  if (!token.startsWith("lfgr_")) return { ok: false, error: "That doesn't look like a computer token. Copy it from Settings → Computers." };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: "This system has no secure storage for the token." };
  config = { ...config, serverUrl: url.origin, token: safeStorage.encryptString(token).toString("base64") };
  saveConfig(config);
  startRunner();
  setupWindow?.close();
  openMain();
  return { ok: true };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", openMain);
  app.whenReady().then(() => {
    shellEnv = loginShellEnv();
    config = loadConfig();
    tray = new Tray(nativeImage.createEmpty());
    refreshTray();
    startRunner();
    openMain();
    app.on("activate", openMain);
  });
  // Keep running in the tray so jobs can still arrive with no window open.
  app.on("window-all-closed", () => { /* stay alive */ });
  app.on("before-quit", () => runner?.stop());
}

