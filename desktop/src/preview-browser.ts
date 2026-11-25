/**
 * A browser for the chat agent, limited to the previews running on this computer.
 *
 * LFG Desktop starts this as a stdio MCP server next to each Claude Code chat turn
 * (runner.ts → agents.ts). It drives the person's installed Chrome (or Edge/Chromium/
 * Brave), headless, so the agent can sign in to the app at http://localhost:<port>, click
 * through a feature and look at screenshots instead of only reading code.
 *
 * Limits:
 * - Pages may only be opened at the addresses of previews LFG is running here (read from
 *   the runner's state file on every call, so a preview started mid-turn counts). Any
 *   other top-level navigation is blocked; the app's own requests to APIs/CDNs still load.
 * - Each project keeps its own saved session (cookies, storage), so a sign-in survives between messages.
 *
 * The MCP stdio transport is newline-delimited JSON-RPC 2.0; stdout carries nothing else.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { BrowserContext, Locator, Page } from "playwright-core";

export interface PreviewStateEntry { project: string; projectName?: string; dir?: string; urls: Array<{ name: string; url: string; port: number; primary?: boolean }> }
export interface PreviewState { previews: PreviewStateEntry[] }

type LocatorSpec = { role?: string; name?: string; label?: string; text?: string; placeholder?: string; testId?: string; selector?: string; exact?: boolean };
export interface BrowserInput {
  action: "open" | "click" | "fill" | "select" | "press" | "check" | "uncheck" | "hover" | "read" | "snapshot" | "screenshot" | "wait" | "back" | "reload";
  url?: string;
  locator?: LocatorSpec;
  value?: string;
  key?: string;
  text?: string;
  ms?: number;
  fullPage?: boolean;
  screenshot?: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The previews this turn may open: the turn's project when known, else every preview here. */
export function readPreviews(stateFile: string | undefined, project: string | undefined): PreviewStateEntry[] {
  if (!stateFile || !existsSync(stateFile)) return [];
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as PreviewState;
    const all = Array.isArray(state.previews) ? state.previews.filter(p => Array.isArray(p.urls) && p.urls.length) : [];
    return project ? all.filter(p => p.project === project) : all;
  } catch { return []; }
}

/** Whether `url` is one of those previews' addresses (same local host and port). */
export function allowedUrl(url: string, previews: PreviewStateEntry[], anyLocal = false): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (!["http:", "https:"].includes(u.protocol) || !LOCAL_HOSTS.has(u.hostname) || u.username || u.password) return false;
  if (anyLocal) return true; // a build's walkthrough: the app the agent started on this computer
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return previews.some(p => p.urls.some(x => x.port === port));
}

/** A full address for `url`: absolute local URLs as given, paths against the main preview. */
export function resolveUrl(url: string | undefined, previews: PreviewStateEntry[]): string {
  const urls = previews.flatMap(p => p.urls);
  const primary = urls.find(u => u.primary) ?? urls[0];
  if (!primary) {
    if (url && /^https?:\/\//i.test(url)) return url;
    throw new Error("No preview is running on this computer. Ask the person to start it in the Preview tab (Run on your computer), then try again. (In a build walkthrough, open the full http://localhost:<port> address of the app you started.)");
  }
  if (!url) return primary.url;
  if (/^https?:\/\//i.test(url)) return url;
  return new URL(url.startsWith("/") ? url : `/${url}`, primary.url).href;
}

/** Chrome, Edge, Chromium or Brave installed on this computer. LFG_BROWSER_PATH wins. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.LFG_BROWSER_PATH && existsSync(env.LFG_BROWSER_PATH)) return env.LFG_BROWSER_PATH;
  const home = os.homedir();
  const candidates = process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ] : process.platform === "win32" ? [
    `${env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
  return candidates.find(c => c && existsSync(c)) ?? null;
}

export const TOOL = {
  name: "browser",
  description: [
    "Use the app running in the Preview on this computer like a person would: open pages, sign in, click, type, and look at screenshots.",
    "Only the preview's own http://localhost addresses can be opened. The browser keeps its cookies between messages, so a sign-in stays signed in.",
    "Start with action \"open\" (no url = the preview's home page, or a path like \"/login\"). Each step answers with the page address, title, errors the page raised, and failed API calls; add screenshot:true to see the page, or use action \"screenshot\".",
    "Find elements the way a person sees them: locator {role:\"button\", name:\"Sign in\"}, {label:\"Email\"}, {placeholder:\"you@company.com\"}, {text:\"Welcome back\"}; use {selector} only as a last resort. If a step can't find an element it answers with the page's accessibility tree: pick the right name from it and try again.",
    "To test a feature, do what the person would do and check what appears (action \"read\" or a screenshot); report what you saw, with the step that failed if one did. Don't claim something works without having seen it here.",
    "For a sign-in, use credentials the person gave you or ones in the project's seed data; never guess repeatedly.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open", "click", "fill", "select", "press", "check", "uncheck", "hover", "read", "snapshot", "screenshot", "wait", "back", "reload"] },
      url: { type: "string", description: "open: a path (\"/login\") or the preview's full http://localhost address. Default: the preview's home page." },
      locator: {
        type: "object", description: "The element to act on.",
        properties: { role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, text: { type: "string" }, placeholder: { type: "string" }, testId: { type: "string" }, selector: { type: "string" }, exact: { type: "boolean" } },
        additionalProperties: false,
      },
      value: { type: "string", description: "fill: the text to type; select: the option's value or label." },
      key: { type: "string", description: "press: a key such as Enter, Tab, Escape." },
      text: { type: "string", description: "wait: text to wait for on the page." },
      ms: { type: "number", description: "wait: milliseconds to wait (max 15000) when not waiting for text." },
      fullPage: { type: "boolean", description: "screenshot: the whole page, not just the window." },
      screenshot: { type: "boolean", description: "Also return a screenshot after this step." },
    },
    required: ["action"],
    additionalProperties: false,
  },
} as const;

/**
 * Records what the browser shows, for a build's walkthrough video: the page's frames
 * (Chrome's screencast) written at a steady 2 per second as concatenated JPEGs, which
 * the server turns into an MP4. No ffmpeg needed on this computer.
 */
export class FrameRecorder {
  static readonly FPS = 2;
  static readonly MAX_FRAMES = 2 * 60 * 10; // 10 minutes, well under upload limits
  private latest: Buffer | null = null;
  private fd: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  frames = 0;
  constructor(private readonly file: string) {}
  /** A frame from the page; the newest one is what the next tick writes. */
  frame(jpeg: Buffer) { this.latest = jpeg; if (!this.timer) this.start(); }
  private start() {
    this.fd = openSync(this.file, "a");
    this.timer = setInterval(() => this.tick(), 1000 / FrameRecorder.FPS);
    this.timer.unref?.();
  }
  tick() {
    if (this.fd === null || !this.latest || this.frames >= FrameRecorder.MAX_FRAMES) return;
    writeSync(this.fd, this.latest);
    this.frames++;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.fd !== null) { this.tick(); closeSync(this.fd); this.fd = null; }
  }
}

type Content = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

export class PreviewBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private pageErrors: string[] = [];
  private failedRequests: string[] = [];
  private blocked: string[] = [];
  private dialogs: string[] = [];

  private recorder?: FrameRecorder;

  constructor(private readonly o: { stateFile?: string; project?: string; profileDir?: string; headless?: boolean; env?: NodeJS.ProcessEnv; anyLocal?: boolean; recordTo?: string }) {
    if (o.recordTo) this.recorder = new FrameRecorder(o.recordTo);
  }

  private allowed(url: string) { return allowedUrl(url, this.previews(), this.o.anyLocal); }

  private previews() { return readPreviews(this.o.stateFile, this.o.project); }

  /** Where the session (cookies, local storage) is kept between messages. */
  private sessionFile() { return this.o.profileDir ? join(this.o.profileDir, "session.json") : undefined; }

  private async saveSession() {
    const file = this.sessionFile();
    if (!file || !this.context) return;
    try { mkdirSync(this.o.profileDir!, { recursive: true }); await this.context.storageState({ path: file }); } catch { /* best effort */ }
  }

  private async open(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const executablePath = findBrowser(this.o.env);
    if (!executablePath) throw new Error("No Chrome, Edge, Chromium or Brave was found on this computer. Install Google Chrome to let the agent use the preview.");
    const { chromium } = await import("playwright-core");
    if (!this.context) {
      // A fresh browser each time, with the cookies and storage the last session saved.
      // (A real Chrome profile kept between runs swallowed clicks after a sign-in post.)
      const browser = await chromium.launch({ executablePath, headless: this.o.headless !== false, args: ["--no-first-run", "--no-default-browser-check"] });
      const saved = this.sessionFile();
      let storageState: string | undefined = saved && existsSync(saved) ? saved : undefined;
      this.context = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState }).catch(async () => {
        storageState = undefined; // an unreadable saved session: start signed out
        return browser.newContext({ viewport: { width: 1280, height: 800 } });
      });
      await this.context.route("**/*", route => {
        const req = route.request();
        let topLevel = false;
        try { topLevel = req.isNavigationRequest() && req.frame().parentFrame() === null; } catch { /* service worker request: no frame */ }
        if (topLevel && !this.allowed(req.url())) {
          this.blocked.push(req.url().slice(0, 300));
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
    }
    const page = this.context.pages()[0] ?? await this.context.newPage();
    page.setDefaultTimeout(8000);
    if (this.recorder) {
      const recorder = this.recorder;
      const cdp = await this.context.newCDPSession(page);
      cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
        recorder.frame(Buffer.from(f.data, "base64"));
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }).catch(() => {});
    }
    page.on("pageerror", e => this.pageErrors.push(String(e?.message ?? e).slice(0, 400)));
    // A confirm()/alert()/prompt() is answered the way the person clicking would: OK. Left
    // alone, the browser dismisses it, so "Switch to Live?" silently stayed on Test.
    page.on("dialog", d => {
      this.dialogs.push(`${d.type()}: "${d.message().slice(0, 200)}" (answered OK)`);
      void d.accept(d.type() === "prompt" ? d.defaultValue() : undefined).catch(() => {});
    });
    page.on("response", r => {
      const type = r.request().resourceType();
      if (r.status() >= 400 && (type === "fetch" || type === "xhr" || type === "document")) this.failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`);
    });
    this.page = page;
    return page;
  }

  private locate(page: Page, s: LocatorSpec | undefined): Locator {
    if (!s) throw new Error("This action needs a locator.");
    const exact = s.exact ?? true;
    const l = s.role ? page.getByRole(s.role as Parameters<Page["getByRole"]>[0], s.name ? { name: s.name, exact } : {})
      : s.label ? page.getByLabel(s.label, { exact })
      : s.placeholder ? page.getByPlaceholder(s.placeholder, { exact })
      : s.testId ? page.getByTestId(s.testId)
      : s.text ? page.getByText(s.text, { exact })
      : s.selector ? page.locator(s.selector)
      : null;
    if (!l) throw new Error("The locator needs one of role, label, placeholder, testId, text or selector.");
    return l.first();
  }

  /** Let a step's effects land (a form post, its redirect, API calls) before the next one. */
  private async settle(page: Page) {
    await page.waitForTimeout(150);
    await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  }

  /** Why a step's element couldn't be used: nothing matched, or it's hidden, disabled, or not that kind of field. */
  private async describeMatch(page: Page, spec: LocatorSpec, action: string): Promise<string> {
    try {
      const all = this.locateAll(page, spec);
      const count = await all.count();
      if (!count) return `The locator matched nothing on this page${spec.exact !== false && (spec.name || spec.label || spec.text) ? " (it matches the exact text; try exact:false, or pick the name from the tree below)" : ""}.`;
      const first = all.first();
      const [visible, enabled, tag, type] = await Promise.all([
        first.isVisible().catch(() => false), first.isEnabled().catch(() => false),
        first.evaluate(e => e.tagName.toLowerCase()).catch(() => "?"), first.getAttribute("type").catch(() => null),
      ]);
      return `The locator matched ${count} element${count === 1 ? "" : "s"}; the first is <${tag}${type ? ` type="${type}"` : ""}>, ${visible ? "visible" : "hidden"}, ${enabled ? "enabled" : "disabled"}.` +
        (action === "select" && tag !== "select" ? " (select only works on a <select>; for a time, date or number input use fill, and for a custom dropdown click it and then the option.)" : "");
    } catch { return ""; }
  }

  private locateAll(page: Page, s: LocatorSpec): Locator {
    const exact = s.exact ?? true;
    return s.role ? page.getByRole(s.role as Parameters<Page["getByRole"]>[0], s.name ? { name: s.name, exact } : {})
      : s.label ? page.getByLabel(s.label, { exact })
      : s.placeholder ? page.getByPlaceholder(s.placeholder, { exact })
      : s.testId ? page.getByTestId(s.testId)
      : s.text ? page.getByText(s.text, { exact })
      : page.locator(s.selector ?? "__none__");
  }

  private async tree(page: Page, max = 6000): Promise<string> {
    try { return (await page.locator("body").ariaSnapshot({ timeout: 8000 })).slice(0, max); } catch { return ""; }
  }

  private async shot(page: Page, fullPage = false) {
    return (await page.screenshot({ type: "jpeg", quality: 60, fullPage, timeout: 10000 })).toString("base64");
  }

  async call(input: BrowserInput): Promise<{ content: Content; isError: boolean }> {
    const lines: string[] = [];
    let image: string | undefined;
    let isError = false;
    let page: Page | undefined;
    try {
      page = await this.open();
      const a = input.action;
      if (a === "open") {
        const url = resolveUrl(input.url, this.previews());
        if (!this.allowed(url)) throw new Error(`Only the preview's own addresses can be opened (${this.previews().flatMap(p => p.urls.map(u => u.url)).join(", ") || "none running"}).`);
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        lines.push(`Opened ${url}${response ? ` (HTTP ${response.status()})` : ""}.`);
        lines.push("On the page (accessibility tree):\n" + await this.tree(page, 4000));
      } else if (a === "back") { await page.goBack({ waitUntil: "domcontentloaded" }); await this.settle(page); lines.push("Went back."); }
      else if (a === "reload") { await page.reload({ waitUntil: "domcontentloaded" }); await this.settle(page); lines.push("Reloaded."); }
      else if (a === "wait") {
        if (input.text) { await page.getByText(input.text).first().waitFor({ state: "visible", timeout: 15000 }); lines.push(`"${input.text}" is on the page.`); }
        else { await page.waitForTimeout(Math.min(Math.max(input.ms ?? 1000, 0), 15000)); lines.push("Waited."); }
      } else if (a === "snapshot") { lines.push("Accessibility tree:\n" + await this.tree(page, 12000)); }
      else if (a === "screenshot") { image = await this.shot(page, input.fullPage); lines.push("Screenshot attached."); }
      else if (a === "read") {
        const text = input.locator ? await this.locate(page, input.locator).innerText() : await page.locator("body").innerText();
        lines.push("Text:\n" + text.trim().slice(0, 6000));
      } else {
        const target = this.locate(page, input.locator);
        if (a === "click") await target.click();
        else if (a === "fill") await target.fill(input.value ?? "");
        else if (a === "select") await target.selectOption(input.value ?? "");
        else if (a === "press") await target.press(input.key ?? "Enter");
        else if (a === "check") await target.check();
        else if (a === "uncheck") await target.uncheck();
        else if (a === "hover") await target.hover();
        else throw new Error(`Unknown action "${a}".`);
        await this.settle(page);
        lines.push(`${a} done.`);
      }
    } catch (e) {
      isError = true;
      lines.push(`Failed: ${(e as Error).message.split("\n")[0]!.slice(0, 600)}`);
      if (page && !page.isClosed() && input.locator) lines.push(await this.describeMatch(page, input.locator, input.action));
      if (page && !page.isClosed() && input.action !== "snapshot") {
        lines.push("The page as it is now (accessibility tree):\n" + await this.tree(page));
        image ??= await this.shot(page).catch(() => undefined);
      }
    }
    if (page && !page.isClosed() && page.url().startsWith("chrome-error://") && this.blocked.length) {
      // A link out of the preview was blocked: stay on the app instead of Chrome's error page.
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
    }
    if (page && !page.isClosed()) {
      lines.unshift(`Page: ${page.url()} — "${await page.title().catch(() => "")}"`);
      if (input.screenshot && !image) image = await this.shot(page, input.fullPage).catch(() => undefined);
    }
    const take = (list: string[]) => list.splice(0, list.length).slice(-10);
    const errors = take(this.pageErrors), failed = take(this.failedRequests), blocked = take(this.blocked), dialogs = take(this.dialogs);
    if (dialogs.length) lines.push("Dialogs the page opened:\n- " + dialogs.join("\n- "));
    if (errors.length) lines.push("Errors the page raised:\n- " + errors.join("\n- "));
    if (failed.length) lines.push("Failed requests:\n- " + failed.join("\n- "));
    if (blocked.length) lines.push("Blocked navigation away from the preview:\n- " + blocked.join("\n- "));
    await this.saveSession();
    const content: Content = [{ type: "text", text: lines.join("\n\n") }];
    if (image) content.push({ type: "image", data: image, mimeType: "image/jpeg" });
    return { content, isError };
  }

  async close() { this.recorder?.stop(); await this.saveSession(); await this.context?.browser()?.close().catch(() => {}); }
}

/** Serve the browser tool over stdio (MCP). */
export async function serve(input = process.stdin, output = process.stdout, env = process.env) {
  const browser = new PreviewBrowser({ stateFile: env.LFG_PREVIEW_STATE, project: env.LFG_PREVIEW_PROJECT || undefined, profileDir: env.LFG_PREVIEW_PROFILE, headless: env.LFG_PREVIEW_HEADLESS !== "0", env,
    anyLocal: env.LFG_BROWSER_ANY_LOCAL === "1", recordTo: env.LFG_BROWSER_RECORD || undefined });
  const send = (msg: unknown) => output.write(JSON.stringify(msg) + "\n");
  let queue: Promise<unknown> = Promise.resolve();
  const lines = createInterface({ input });
  lines.on("line", line => {
    let msg: { id?: string | number; method?: string; params?: Record<string, any> };
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || !msg.method) return; // notifications and responses
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize":
        return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lfg-preview-browser", version: "1.0.0" } });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: [TOOL] });
      case "tools/call":
        if (msg.params?.name !== TOOL.name) return fail(-32602, `Unknown tool ${msg.params?.name}`);
        // One browser, one step at a time.
        queue = queue.then(() => browser.call((msg.params?.arguments ?? {}) as BrowserInput)).then(reply, e => reply({ content: [{ type: "text", text: `Failed: ${(e as Error).message}` }], isError: true }));
        return;
      default: return fail(-32601, `Method not found: ${msg.method}`);
    }
  });
  await new Promise<void>(resolve => lines.on("close", () => resolve()));
  await queue.catch(() => {});
  await browser.close();
}

// Started as its own process (`node preview-browser.js`, or Electron with ELECTRON_RUN_AS_NODE).
if (process.argv[1] && /preview-browser\.(js|ts)$/.test(process.argv[1])) {
  void serve().then(() => process.exit(0), () => process.exit(1));
}

export const previewBrowserStateFile = (workRoot: string) => join(workRoot, "previews", "running.json");
