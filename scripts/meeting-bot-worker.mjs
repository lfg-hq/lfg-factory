/**
 * The LFG meeting bot: joins a Google Meet call as a guest in a remote Chromium (Mags) and
 * reports what is said. Node owns the browser connection because Playwright's
 * connectOverCDP hangs under Bun; the server talks to this process in JSON lines.
 *
 *   stdin, first line   { wsEndpoint | localChrome, meetingUrl, botName, greeting }
 *   stdin, afterwards   { cmd: "chat", text } | { cmd: "screenshot", id } | { cmd: "leave" }
 *   stdout              { type: "status", status, detail } | { type: "speech" | "chat", speaker, text }
 *                       | { type: "screenshot", id, presenting, jpegBase64 } | { type: "log", message }
 *
 * Meet's page is not an API and changes without notice. Everything that depends on its
 * markup is in the SELECTORS and page-reading functions below, matched by accessible
 * labels and text rather than class names, with a screenshot logged when a step fails.
 */
import { chromium } from "playwright-core";
import { createInterface } from "node:readline";
import { createCaptionAssembler } from "./meeting-captions.mjs";

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (message) => emit({ type: "log", message: String(message).slice(0, 500) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const cfg = JSON.parse((await lines.next()).value);

const SELECTORS = {
  nameInput: 'input[aria-label="Your name"], input[placeholder="Your name"]',
  joinButton: /^(Ask to join|Join now|Join anyway|Join)$/i,
  dismissButton: /^(Got it|Dismiss|Continue without microphone and camera|Not now|Close)$/i,
  micOff: '[role="button"][aria-label*="Turn off microphone" i], button[aria-label*="Turn off microphone" i]',
  cameraOff: '[role="button"][aria-label*="Turn off camera" i], button[aria-label*="Turn off camera" i]',
  leaveButton: '[aria-label="Leave call"], button[aria-label*="Leave call" i]',
  captionsOn: 'button[aria-label*="Turn on captions" i]',
  chatButton: 'button[aria-label*="Chat with everyone" i]',
  chatInput: 'textarea[aria-label*="Send a message" i]',
};
const CANNOT_JOIN = /You can't join this video call|Check your meeting code|Invalid video call name|couldn.t find the meeting|not allowed to join|This meeting is locked/i;
const DENIED = /denied your request|No one responded to your request|You can't join this video call|Your request to join was declined/i;
const CALL_OVER = /You've been removed from the meeting|You left the meeting|The meeting has ended|The call ended|Return to home screen|Returning to home screen/i;
const WAIT_TO_BE_ADMITTED_MS = Number(cfg.admitTimeoutMs ?? 10 * 60_000);
const ALONE_LEAVE_MS = Number(cfg.aloneTimeoutMs ?? 5 * 60_000);
const MAX_CALL_MS = Number(cfg.maxCallMs ?? 4 * 60 * 60_000);
const POLL_MS = Number(cfg.pollMs ?? 600);

let browser, page;
let status = "joining";
const setStatus = (next, detail = null) => { if (next !== status || detail) { status = next; emit({ type: "status", status: next, detail }); } };
const bodyText = () => page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
const seen = (selector) => page.locator(selector).first().isVisible().catch(() => false);
async function clickIfThere(target, timeout = 1500) {
  const button = typeof target === "string" ? page.locator(target).first() : page.getByRole("button", { name: target }).first();
  if (!(await button.isVisible().catch(() => false))) return false;
  return button.click({ timeout }).then(() => true, () => false);
}
async function evidence(what) {
  // A small screenshot in the server log is the fastest way to see what Meet showed the bot.
  const shot = await page?.screenshot({ type: "jpeg", quality: 35, timeout: 8000 }).catch(() => null);
  log(`${what}; page says: ${(await bodyText()).replace(/\s+/g, " ").slice(0, 300)}`);
  if (shot) emit({ type: "debug-screenshot", what, jpegBase64: shot.toString("base64") });
}

/** The caption blocks on screen: one per speaker, first line the name, the rest what they said. */
function readCaptions() {
  const region = document.querySelector('[role="region"][aria-label*="aption" i]') || document.querySelector('[aria-label="Captions"]');
  if (!region) return null;
  const blocks = [];
  const found = new Set();
  region.querySelectorAll("img").forEach((img) => {
    let block = img;
    while (block.parentElement && block.parentElement !== region && !/\n/.test(block.innerText || "")) block = block.parentElement;
    if (found.has(block)) return;
    found.add(block);
    const parts = (block.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return;
    block.__lfgId = block.__lfgId || "c" + (window.__lfgSeq = (window.__lfgSeq || 0) + 1);
    blocks.push({ id: block.__lfgId, speaker: parts[0].slice(0, 80), text: parts.slice(1).join(" ") });
  });
  return blocks;
}

/** Messages in the open chat panel that have not been reported yet. */
function readChat() {
  const out = [];
  document.querySelectorAll("[data-message-id]").forEach((node) => {
    if (node.__lfgSeen) return;
    node.__lfgSeen = true;
    const text = (node.innerText || "").trim();
    if (!text) return;
    // The sender's name heads the group of messages this one belongs to.
    let speaker = "";
    for (let group = node.parentElement, depth = 0; group && depth < 6 && !speaker; group = group.parentElement, depth++) {
      const first = (group.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      if (first && first !== text.split("\n")[0] && first.length < 80) speaker = first.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)?$/i, "").trim();
    }
    out.push({ speaker: speaker || "Someone", text });
  });
  return out;
}

const sent = new Set(); // our own chat messages come back through readChat; don't report them
async function sendChat(text) {
  if (!(await seen(SELECTORS.chatInput))) await clickIfThere(SELECTORS.chatButton, 4000);
  const input = page.locator(SELECTORS.chatInput).first();
  await input.waitFor({ state: "visible", timeout: 8000 });
  sent.add(text.trim());
  await input.fill(text);
  await input.press("Enter");
}

async function join() {
  await page.goto(cfg.meetingUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const deadline = Date.now() + 90_000;
  let asked = false;
  while (!asked) {
    if (Date.now() > deadline) { await evidence("Never reached the join button"); throw new Error("Google Meet did not show a way to join."); }
    if (/accounts\.google\.com/.test(page.url())) throw new Error("This meeting only lets signed-in Google accounts join, and the bot joins as a guest.");
    const text = await bodyText();
    if (CANNOT_JOIN.test(text)) { await evidence("Meet refused the bot"); throw new Error("Google Meet would not let the bot into this call. The link may be wrong, or the meeting may not allow guests."); }
    await clickIfThere(SELECTORS.dismissButton);
    // The browser has a microphone and camera; the bot only listens, so join with both off.
    await clickIfThere(SELECTORS.micOff);
    await clickIfThere(SELECTORS.cameraOff);
    const name = page.locator(SELECTORS.nameInput).first();
    if (await name.isVisible().catch(() => false)) await name.fill(cfg.botName).catch(() => {});
    asked = await clickIfThere(SELECTORS.joinButton, 3000);
    if (!asked && (await seen(SELECTORS.leaveButton))) break; // let straight in
    if (!asked) await sleep(1000);
  }
  setStatus("waiting_room");
  const admitBy = Date.now() + WAIT_TO_BE_ADMITTED_MS;
  while (!(await seen(SELECTORS.leaveButton))) {
    if (Date.now() > admitBy) throw new Error("Nobody let the bot in.");
    if (DENIED.test(await bodyText())) throw new Error("Someone in the call declined the bot's request to join.");
    await clickIfThere(SELECTORS.dismissButton);
    await sleep(1000);
  }
  setStatus("in_call");
  await clickIfThere(SELECTORS.dismissButton);
  if (!(await clickIfThere(SELECTORS.captionsOn, 4000))) {
    await page.keyboard.press("c").catch(() => {}); // Meet's shortcut for captions
    await sleep(800);
    if ((await page.evaluate(readCaptions).catch(() => null)) === null) await evidence("Could not turn on captions");
  }
  if (cfg.greeting) await sendChat(cfg.greeting).catch((e) => log("greeting not sent: " + e.message));
}

async function listen() {
  const captions = createCaptionAssembler();
  const started = Date.now();
  let leaveMissing = 0, lastChat = 0, othersSeenAt = Date.now(), everHadOthers = false;
  while (status === "in_call") {
    await sleep(POLL_MS);
    const shown = await page.evaluate(readCaptions).catch(() => null);
    if (shown) for (const line of captions.update(shown)) emit({ type: "speech", ...line });
    if (Date.now() - lastChat > 2000) {
      lastChat = Date.now();
      for (const message of await page.evaluate(readChat).catch(() => [])) {
        if (sent.delete(message.text.trim())) continue;
        emit({ type: "chat", ...message });
      }
      const others = await page.evaluate(() => document.querySelectorAll("[data-participant-id]").length).catch(() => 0);
      if (others > 1) { everHadOthers = true; othersSeenAt = Date.now(); }
      if (everHadOthers && Date.now() - othersSeenAt > ALONE_LEAVE_MS) { for (const line of captions.flush()) emit({ type: "speech", ...line }); return "Everyone else left."; }
    }
    leaveMissing = (await seen(SELECTORS.leaveButton)) ? 0 : leaveMissing + 1;
    if (leaveMissing >= 4 || CALL_OVER.test(await bodyText())) { for (const line of captions.flush()) emit({ type: "speech", ...line }); return "The call ended."; }
    if (Date.now() - started > MAX_CALL_MS) { for (const line of captions.flush()) emit({ type: "speech", ...line }); return "The call ran past the bot's time limit."; }
  }
  for (const line of captions.flush()) emit({ type: "speech", ...line });
  return "Removed from the call.";
}

// Commands from the server, handled alongside the listening loop.
(async () => {
  for (;;) {
    const next = await lines.next();
    if (next.done) { if (status !== "ended" && status !== "failed") status = "leaving"; return; }
    let command;
    try { command = JSON.parse(next.value); } catch { continue; }
    try {
      if (command.cmd === "chat" && status === "in_call") await sendChat(String(command.text));
      else if (command.cmd === "screenshot") {
        const presenting = /is presenting|You are presenting|presentation/i.test(await bodyText());
        const shot = await page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 });
        emit({ type: "screenshot", id: command.id, presenting, jpegBase64: shot.toString("base64") });
      } else if (command.cmd === "leave") status = "leaving";
    } catch (error) {
      log(`${command.cmd} failed: ${error.message}`);
      if (command.cmd === "screenshot") emit({ type: "screenshot", id: command.id, presenting: false, jpegBase64: "" });
    }
  }
})();

let outcome = { status: "ended", detail: null };
try {
  browser = cfg.localChrome
    ? await chromium.launch({ executablePath: cfg.localChrome, headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] })
    : await chromium.connectOverCDP(cfg.wsEndpoint, { timeout: 30_000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  await context.grantPermissions(["microphone", "camera"]).catch(() => {});
  page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  page.setDefaultTimeout(8000);
  await join();
  outcome.detail = await listen();
  await clickIfThere(SELECTORS.leaveButton, 3000);
} catch (error) {
  outcome = { status: status === "in_call" ? "ended" : "failed", detail: error.message.split("\n")[0].slice(0, 300) };
} finally {
  setStatus(outcome.status, outcome.detail);
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
process.exit(0);
