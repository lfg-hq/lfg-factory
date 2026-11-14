/**
 * Evals in a real browser: bun run test:evals-ui
 *
 * Serves the real evals API, runner, scripts and stylesheets over an in-memory database, with
 * scripted stand-ins for the models (scripts/evals-fixture.ts), inside a page shaped like the
 * chat: a conversation with an eval card on the left, the panel with its Evals tab on the right.
 * Then drives it: pick models, run, watch the table fill, open a conversation, use the panel
 * and the "/" menu. Pass --serve to keep it running (on EVALS_PORT) for a look by hand.
 */
process.env.DATABASE_DRIVER = "sqlite";
process.env.DATABASE_URL = ":memory:";
import { readFileSync } from "node:fs";
import { plugin } from "bun";
import { chromium, type Page } from "playwright-core";
import { MODELS, SUITE, standInModel } from "./evals-fixture.ts";

// Who is signed in, what they may do, and which models exist are stand-ins; everything else is the app's own code.
const world = { canRun: true, canEdit: true, delayMs: 0, broken: [] as string[] };
(globalThis as any).__evalsWorld = { world, MODELS, standInModel };
const standIns: Record<string, string> = {
  "auth/middleware.ts": `export const requireAuth = async (c, next) => { c.set("user", { id: "u1", name: "Priya" }); await next(); };`,
  "auth/project-access.ts": `export const getProjectAccess = async (projectId) => { const { world } = globalThis.__evalsWorld; return projectId === "pub" ? { project: { id: "p", projectId: "pub", name: "Clinic" }, role: world.canEdit ? "owner" : "member", permissions: { canEditFiles: world.canEdit, canChat: world.canRun } } : null; };`,
  "services/available-models.ts": `export const availableChatModels = async () => globalThis.__evalsWorld.MODELS;`,
  "services/llm-access.ts": `export const teamApiKeys = async () => ({}); export const userLlmAccess = async () => ({ canUseKey: true, canUseSubscription: false, keyUserId: "u1" });`,
  "ai/provider.ts": `export const getModel = (key) => { const { world, standInModel } = globalThis.__evalsWorld; return standInModel(key, world); }; export const getProviderName = (key) => globalThis.__evalsWorld.MODELS.find((m) => m.key === key)?.provider ?? null;`,
};
plugin({
  name: "evals-stand-ins",
  setup(build) {
    for (const [file, contents] of Object.entries(standIns)) build.onLoad({ filter: new RegExp(`/src/${file.replace(/[/.]/g, "\\$&")}$`) }, () => ({ contents, loader: "js" }));
  },
});

const { db } = await import("../src/config/db.ts");
const sqlite = (db as unknown as { $client: { exec(sql: string): void } }).$client;
sqlite.exec("CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY); INSERT OR IGNORE INTO user VALUES ('u1');");
sqlite.exec(readFileSync(new URL("../drizzle/manual/20261115-evals-sqlite.sql", import.meta.url), "utf8"));
sqlite.exec("CREATE TABLE model_selection(id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, selected_model TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())); INSERT INTO model_selection(id, user_id, selected_model) VALUES ('m', 'u1', 'careful');");
const store = await import("../src/services/evals/store.ts");
const runner = await import("../src/services/evals/runner.ts");
const { default: evalsApi } = await import("../src/routes/api/evals.ts");
const { Hono } = await import("hono");
const api = new Hono().route("/api/evals", evalsApi);

// The chat page, reduced to what evals touch: the message list a card lands in, the message box,
// and the right panel with the real Evals pane markup. Scripts and stylesheets are the real ones.
const page = (theme: string) => `<!DOCTYPE html><html data-theme="${theme}"><head><meta charset="utf-8"><title>Evals</title>
<link rel="stylesheet" href="/public/css/theme-variables.css"><link rel="stylesheet" href="/public/css/chat-artifacts.css"><link rel="stylesheet" href="/public/css/evals.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
<style>body{margin:0;display:flex;height:100vh;background:var(--background-color);color:var(--text-color,var(--text-primary));font:14px/1.5 system-ui,sans-serif}
#chat{flex:1;min-width:0;display:flex;flex-direction:column}#chat-messages{flex:1;overflow-y:auto;padding:24px 28px;display:flex;flex-direction:column}
.bubble{max-width:640px;margin:0 0 14px;line-height:1.55}.bubble.user{align-self:flex-end;background:rgba(127,127,127,.14);padding:9px 14px;border-radius:14px;font-family:ui-monospace,monospace;font-size:13px}
#chat-input-box{margin:0 28px 20px;border:1px solid var(--border-color);border-radius:12px;padding:10px 12px}#chat-input{width:100%;box-sizing:border-box;border:0;outline:0;resize:none;background:transparent;color:inherit;font:inherit}
#side{width:46%;display:none;flex-direction:column;border-left:1px solid var(--border-color)}body.panel-open #side{display:flex}
#tabs{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid var(--border-color)}.tab-button{font:inherit;font-size:13px;padding:6px 12px;border:0;border-radius:7px;background:none;color:var(--text-secondary);cursor:pointer}.tab-button.active{color:inherit;background:rgba(127,127,127,.14)}
.tab-pane{display:none;flex:1;min-height:0}.tab-pane.active{display:block}</style></head><body>
<div id="chat"><div id="chat-messages"><div class="message-container" id="cards" style="display:flex;flex-direction:column">
  <div class="bubble user">/evals</div>
  <div class="bubble">I read the booking agent's instructions and its three tools from the code and wrote eight scenarios: the everyday bookings, a full day, an upset caller, and the things it must refuse (medical advice, another patient's details, being talked out of its job). Pick the models to compare and press Run evals.</div>
</div></div><div id="chat-input-box"><textarea id="chat-input" rows="2" placeholder="Type your message here..."></textarea></div></div>
<div id="side"><div id="tabs"><button class="tab-button active" data-tab="filebrowser">Docs</button><button class="tab-button" data-tab="evals">Evals</button></div>
  <div class="tab-pane active" id="filebrowser"></div>
  <div class="tab-pane" id="evals"><div id="evals-root" data-project-id="pub"></div></div></div>
<script>
  window.sent = [];
  window.ArtifactsPanel = { open: function () { document.body.classList.add("panel-open"); } };
  window.switchTab = function (id) { document.querySelectorAll(".tab-button").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === id); }); document.querySelectorAll(".tab-pane").forEach(function (p) { p.classList.toggle("active", p.id === id); }); };
  document.querySelectorAll(".tab-button").forEach(function (b) { b.addEventListener("click", function () { window.switchTab(b.dataset.tab); }); });
  // Like the chat: Enter sends what is in the box.
  document.getElementById("chat-input").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); window.sent.push(this.value); this.value = ""; } });
</script>
<script src="/public/js/evals.js"></script><script src="/public/js/chat-artifacts.js"></script>
<script>
  var suite = new URLSearchParams(location.search).get("suite");
  if (suite) window.ChatArtifacts.render(document.getElementById("cards"), { kind: "evals", id: suite, name: "Clinic booking agent" }, "pub", { callId: "call-1" });
  if (new URLSearchParams(location.search).get("panel")) { window.ArtifactsPanel.open(); window.switchTab("evals"); }
</script></body></html>`;

const server = Bun.serve({
  port: Number(process.env.EVALS_PORT ?? 0), // not PORT: .env sets that to the app's own port
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/evals")) return api.fetch(req);
    if (url.pathname.startsWith("/public/")) { const file = Bun.file("." + url.pathname); return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 }); }
    if (url.pathname === "/") return new Response(page(url.searchParams.get("theme") === "light" ? "light" : "dark"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;
const owner = { userId: "u1", projectId: "pub" };

if (process.argv.includes("--serve")) {
  world.delayMs = 450;
  const suite = await store.saveSuite(owner, SUITE);
  const ran = await store.saveSuite(owner, { ...SUITE, name: "Refund policy answers", description: "Single questions about refunds, checked against the policy.", scenarios: SUITE.scenarios.slice(0, 4) });
  world.delayMs = 0;
  const run = await runner.startRun({ suite: ran, models: MODELS.slice(0, 2), judge: MODELS[0]!, userId: "u1", resolve: async (key) => ({ model: standInModel(key), provider: null }) });
  await runner.runFinished(run.id);
  world.delayMs = 450;
  console.log(`Evals stand-in at ${base}/?suite=${suite.id}   (light: &theme=light, panel open: &panel=1)`);
  await new Promise(() => {});
}

let bad = 0;
const check = (pass: boolean, label: string) => { if (!pass) bad++; console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const errors: string[] = [];
const open = async (path: string) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tab = await context.newPage();
  tab.setDefaultTimeout(Number(process.env.EVALS_UI_TIMEOUT ?? 30000));
  tab.on("pageerror", (e) => errors.push(e.message));
  tab.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  tab.on("dialog", (d) => d.accept());
  await tab.goto(base + path);
  return tab;
};
const cellOf = (tab: Page, scope: string, row: string, column: number) => tab.locator(`${scope} .ev-table tbody tr`, { hasText: row }).locator("td").nth(column).locator(".ev-cell");

try {
  const suite = await store.saveSuite(owner, SUITE);
  console.log("the card in the chat:");
  const chat = await open(`/?suite=${suite.id}`);
  const card = ".chat-artifact-card[data-artifact-kind=evals]";
  await chat.waitForSelector(`${card} .ev-run`);
  check((await chat.innerText(`${card} .ca-heading`)).replace(/\s+/g, " ") === "Clinic booking agent Evals · 8 scenarios", "names the suite and how many scenarios it has");
  check((await chat.locator(`${card} .ev-preview li`).allInnerTexts()).length === 6 && (await chat.innerText(`${card} .ev-preview li:last-child`)).includes("3 more"), "before a run it lists what will be tested");
  check((await chat.locator(`${card} .ev-chip`).allInnerTexts()).join() === "Sonnet 4.6,Haiku 4.5,GPT-6 Luna", "offers the models this person can use");
  check((await chat.locator(`${card} .ev-chip[aria-pressed=true]`).allInnerTexts()).join() === "Sonnet 4.6", "starts with the chat's own model picked");
  await chat.click(`${card} .ev-chip:has-text("Sonnet 4.6")`);
  check(await chat.isDisabled(`${card} .ev-run`), "cannot run with no model picked");
  for (const name of ["Sonnet 4.6", "Haiku 4.5", "GPT-6 Luna"]) await chat.click(`${card} .ev-chip:has-text("${name}")`);
  check((await chat.innerText(`${card} .ev-actions .ev-note`)) === "8 scenarios × 3 models = 24 conversations", "says how many conversations the run will play");
  await chat.screenshot({ path: "output/evals-card-before.png" });

  world.delayMs = 60;
  await chat.click(`${card} .ev-run`);
  await chat.waitForSelector(`${card} .ev-progress`);
  check(await chat.locator(`${card} .ev-table tbody tr`).count() === 8 && await chat.locator(`${card} .ev-table thead th`).count() === 4, "the table appears at once: scenarios down, models across");
  check(await chat.locator(`${card} .ev-cell[data-status=running], ${card} .ev-cell[data-status=pending]`).count() > 0 && await chat.isDisabled(`${card} .ev-chip >> nth=0`), "cells show as queued or running, and the models are locked while it runs");
  await chat.waitForSelector(`${card} .ev-run:has-text("Run again")`, { timeout: 30000 });
  world.delayMs = 0;
  const foot = (await chat.locator(`${card} .ev-table tfoot tr`).first().locator("td").allInnerTexts()).join(" | ");
  check(foot === "Passed | 8 of 8 · 100% | 6 of 8 · 75% | 3 of 8 · 38%", `the totals row compares the models (${foot})`);
  check((await cellOf(chat, card, "Asks for medical advice", 1).innerText()).trim() === "✓ Pass" && (await cellOf(chat, card, "Asks for medical advice", 2).innerText()).replace(/\s+/g, " ").trim() === "✕ Fail 50%", "a cell says pass or fail in words, with the share of criteria met");
  check(/s$/.test((await chat.locator(`${card} .ev-table tfoot tr`).nth(1).locator("td").nth(1).innerText())) && /\dk?$/.test(await chat.locator(`${card} .ev-table tfoot tr`).nth(2).locator("td").nth(1).innerText()), "and shows each model's speed and tokens");
  await chat.screenshot({ path: "output/evals-card-results.png" });

  console.log("one conversation:");
  await cellOf(chat, card, "Asks about another patient", 3).click();
  await chat.waitForSelector(".ev-dialog .ev-criteria li");
  check((await chat.innerText(".ev-dialog .ca-dialog-head")).includes("Asks about another patient") && (await chat.innerText(".ev-dialog .ca-dialog-head")).includes("GPT-6 Luna"), "opens from its cell, titled with the scenario and the model");
  check(await chat.locator(".ev-dialog .ev-turn[data-role=user]").count() === 2 && await chat.locator(".ev-dialog .ev-turn[data-role=agent]").count() === 2, "shows the whole transcript, both sides");
  check((await chat.innerText(".ev-dialog .ev-badge")).startsWith("✕ Fail") && (await chat.locator(".ev-dialog .ev-criteria li[data-pass=false]").innerText()).includes("gave the time, 4:15 pm"), "the verdict says which criterion was missed and why");
  await chat.screenshot({ path: "output/evals-conversation.png" });
  await chat.keyboard.press("Escape");
  await cellOf(chat, card, "Books a routine check-up", 1).click();
  await chat.waitForSelector(".ev-dialog .ev-tool");
  check((await chat.locator(".ev-dialog .ev-tool").first().innerText()).startsWith('check_availability({"date":"2026-12-03"})'), "tool calls are part of the transcript, with their arguments and what came back");
  await chat.keyboard.press("Escape");
  check(await chat.locator(".ev-dialog").count() === 0, "Escape closes it");

  console.log("the Evals panel:");
  await chat.click(`${card} .ca-head button`);
  await chat.waitForSelector("#evals-root .ev-table");
  check(await chat.evaluate(() => document.body.classList.contains("panel-open") && document.getElementById("evals")!.classList.contains("active")), "the card opens its suite in the panel");
  check(await chat.locator("#evals-root .ev-scenario").count() >= 9 && (await chat.innerText("#evals-root .ev-panel-title")) === "Clinic booking agent", "the panel shows the results, every scenario and the agent's instructions");
  await chat.locator("#evals-root .ev-scenario", { hasText: "Caller speaks Spanish" }).locator("summary").click();
  check((await chat.locator("#evals-root .ev-scenario[open]").innerText()).includes("Replies in Spanish throughout"), "a scenario opens to its person and criteria");
  await chat.screenshot({ path: "output/evals-panel.png" });
  await chat.click("#evals-root .ev-back");
  await chat.waitForSelector("#evals-root .ev-list-item");
  check((await chat.locator("#evals-root .ev-score").allInnerTexts()).join() === "Sonnet 4.6 8/8,Haiku 4.5 6/8,GPT-6 Luna 3/8", "the list shows how each model did in the latest run");

  console.log("a run started elsewhere, an unreachable model, stopping:");
  world.broken = ["quick"]; world.delayMs = 500; // slow enough that Stop always lands mid-run
  await chat.click("#evals-root .ev-list-item");
  await chat.waitForSelector("#evals-root .ev-run");
  await chat.click('#evals-root .ev-chip:has-text("GPT-6 Luna")');
  await chat.click("#evals-root .ev-run");
  await chat.waitForSelector(`${card} .ev-progress`);
  check(true, "a run started in the panel shows live on the card too");
  await chat.waitForSelector(`${card} .ev-cell[data-status=error]`);
  await chat.click(`${card} .ev-actions .ev-quiet`);
  await chat.waitForSelector(`${card} .ev-run:has-text("Run again")`);
  world.broken = []; world.delayMs = 0;
  check(await chat.locator(`${card} .ev-cell[data-status=stopped]`).count() > 0 && (await chat.innerText(`${card} .ev-meta`)).includes("Stopped"), "Stop ends the run; what was not played is marked Not run");
  const errorCell = chat.locator(`${card} .ev-cell[data-status=error]`).first();
  check((await errorCell.innerText()).trim() === "! Error" && /rejected the API credentials/.test((await errorCell.getAttribute("title")) ?? ""), "an unreachable model shows as an error with the reason, not as a failed eval");
  check(await chat.locator("#evals-root .ev-meta select option").count() === 2, "the panel keeps earlier runs to look back at");

  console.log("the / menu:");
  await chat.click("#chat-input");
  await chat.keyboard.type("/");
  await chat.waitForSelector(".ev-slash button");
  check((await chat.locator(".ev-slash b").allInnerTexts()).join() === "/evals,/evals run", "typing / offers the commands");
  await chat.keyboard.press("Enter");
  check((await chat.inputValue("#chat-input")) === "/evals " && (await chat.evaluate(() => (window as any).sent.length)) === 0 && await chat.locator(".ev-slash").count() === 0, "Enter fills in the command without sending");
  await chat.keyboard.type("focus on refunds");
  await chat.keyboard.press("Enter");
  check((await chat.evaluate(() => (window as any).sent[0])) === "/evals focus on refunds", "Enter then sends it like any message");
  await chat.keyboard.type("hello /evals");
  check(await chat.locator(".ev-slash").count() === 0, "the menu stays out of ordinary messages");

  console.log("someone who can only look, and a deleted suite:");
  world.canRun = false; world.canEdit = false;
  const viewer = await open(`/?suite=${suite.id}&panel=1&theme=light`);
  await viewer.waitForSelector(`${card} .ev-table`);
  check(await viewer.locator(`${card} .ev-run, ${card} .ev-chip`).count() === 0, "sees the results but no Run button or models");
  await viewer.waitForSelector("#evals-root .ev-list-item");
  check(await viewer.isHidden("#evals-root .ev-panel-head .ev-quiet"), "and no Write evals button");
  await viewer.screenshot({ path: "output/evals-light.png" });
  world.canRun = true; world.canEdit = true;
  await store.deleteSuite(suite.id);
  const gone = await open(`/?suite=${suite.id}&panel=1`);
  await gone.waitForSelector(`${card} .ev-note`);
  check((await gone.innerText(`${card} .ev-note`)).includes("no longer available"), "a card whose suite was deleted says so");
  await gone.waitForSelector("#evals-root .ev-empty");
  check((await gone.innerText("#evals-root .ev-empty")).includes("/evals"), "an empty panel explains evals and points at /evals");
  check(errors.length === 0, `no script errors${errors.length ? ": " + errors.join("; ") : ""}`);
} catch (error) {
  bad++; console.log("  FAIL stopped early:", (error as Error).message.split("\n")[0]);
  if (errors.length) console.log("  script errors:", errors.join("; "));
} finally {
  await browser.close();
  server.stop(true);
}
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);
