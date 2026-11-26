// A build on someone's computer ends with a recorded walkthrough: the agent's report and the
// browser's frames become the ticket's feature-testing evidence (video + checks).
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWalkthrough, withRepoLock } from "../desktop/src/runner.ts";
import { FrameRecorder, allowedUrl } from "../desktop/src/preview-browser.ts";
import { cleanReport, encodeFrames, walkthroughMessage, walkthroughOutcome } from "../src/services/runner/walkthrough.ts";
import { buildRunnerPrompt } from "../src/services/runner/ticket-job.ts";

test("the agent's walkthrough report is read from the JSON block at the end", () => {
  const r = parseWalkthrough('Done.\n```json\n{"applicable": true, "checks": [{"label": "Invite a recruiter", "status": "passed", "actual": "Shown in Team"}, {"label": "404 across companies", "status": "nope"}]}\n```');
  expect(r).toEqual({ applicable: true, checks: [
    { label: "Invite a recruiter", status: "passed", actual: "Shown in Team" },
    { label: "404 across companies", status: "failed" },
  ] });
  expect(parseWalkthrough('```json\n{"applicable": false, "reason": "Backend only", "checks": []}\n```')).toEqual({ applicable: false, reason: "Backend only", checks: [] });
  expect(parseWalkthrough("no json here")).toBeNull();
});

test("the ticket log line names the outcome the Feature testing step reads, and links the video", () => {
  const url = "/uploads/ticket-tests/t1/r1";
  const pass = walkthroughMessage(cleanReport({ checks: [{ label: "A", status: "passed" }] }), "Mac", url, true);
  expect(pass).toStartWith("Feature testing passed on Mac");
  expect(pass).toContain("[Watch recording](/uploads/ticket-tests/t1/r1/recording.mp4)");
  const fail = walkthroughMessage(cleanReport({ checks: [{ label: "A", status: "passed" }, { label: "B", status: "failed", actual: "Blank page" }] }), "Mac", url, false);
  expect(fail).toStartWith("Feature testing failed on Mac: 1 of 2");
  expect(fail).toContain("- B: Blank page");
  expect(fail).toContain("/status.json)");
  expect(walkthroughMessage(cleanReport({ applicable: false, reason: "Data migration only" }), "Mac", null, false)).toBe("Feature testing not applicable: Data migration only");
});

test("a criterion that couldn't be tried on the computer is not a failure of the feature", () => {
  expect(parseWalkthrough('```json\n{"applicable": true, "checks": [{"label": "Call", "status": "blocked", "actual": "No OpenAI key"}]}\n```')?.checks[0]?.status).toBe("blocked");
  // Older Desktop builds said "failed" with a note that it couldn't be tried.
  const old = cleanReport({ checks: [{ label: "A", status: "passed" }, { label: "Call follows structure", status: "failed", actual: "Not verifiable here: no OPENAI_API_KEY" }] });
  expect(old.checks[1]!.status).toBe("blocked");
  expect(walkthroughOutcome(old)).toBe("incomplete");
  const msg = walkthroughMessage(old, "Mac", "/uploads/ticket-tests/t1/r1", true);
  expect(msg).toStartWith("Feature testing incomplete on Mac: 1 of 2 acceptance checks confirmed; 1 couldn't be checked on this computer; none failed.");
  expect(msg).toContain("- Couldn't check: Call follows structure: Not verifiable here");
  const mixed = cleanReport({ checks: [{ label: "A", status: "failed", actual: "Blank page" }, { label: "B", status: "blocked" }] });
  expect(walkthroughOutcome(mixed)).toBe("failed");
  expect(walkthroughMessage(mixed, "Mac", null, false)).toStartWith("Feature testing failed on Mac: 0 of 2 acceptance checks confirmed; 1 couldn't be checked on this computer.");
});

test("recorded frames are written at a steady rate and become an MP4", async () => {
  const dir = mkdtempSync(join(tmpdir(), "walk-"));
  const file = join(dir, "frames.mjpeg");
  // A real 16x16 JPEG, made by ffmpeg.
  const jpg = join(dir, "one.jpg");
  Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48", "-frames:v", "1", jpg]);
  const rec = new FrameRecorder(file);
  rec.frame(readFileSync(jpg));
  for (let i = 0; i < 5; i++) rec.tick();
  rec.stop();
  expect(rec.frames).toBeGreaterThanOrEqual(5);
  await encodeFrames(file, join(dir, "out.mp4"));
  expect(statSync(join(dir, "out.mp4")).size).toBeGreaterThan(0);
});

test("a walkthrough may open any local address, never another site", () => {
  expect(allowedUrl("http://localhost:4123/login", [], true)).toBe(true);
  expect(allowedUrl("https://example.com", [], true)).toBe(false);
  expect(allowedUrl("http://localhost:4123/login", [])).toBe(false);
});

test("git steps on one clone take turns while other work runs side by side", async () => {
  const order: string[] = [];
  const step = (name: string, ms: number) => withRepoLock("repo", async () => { order.push(`${name}+`); await Bun.sleep(ms); order.push(`${name}-`); });
  await Promise.all([step("a", 30), step("b", 5), withRepoLock("other", async () => { order.push("x"); })]);
  expect(order.indexOf("a-")).toBeLessThan(order.indexOf("b+"));
  expect(order.indexOf("x")).toBeLessThan(order.indexOf("a-"));
});

test("builds are told other tickets may be building alongside", () => {
  expect(buildRunnerPrompt({ ticketKey: "A-1", name: "x", description: "y", acceptanceCriteria: [] })).toContain("Other tickets may be building on this computer at the same time");
});

test("a confirm dialog is answered OK, as the person clicking would", async () => {
  const { findBrowser, PreviewBrowser } = await import("../desktop/src/preview-browser.ts");
  if (!findBrowser()) return; // no Chrome on this machine
  const server = Bun.serve({ port: 0, fetch: () => new Response(`<button onclick="document.title = confirm('Switch to Live?') ? 'live' : 'test'">Live</button>`, { headers: { "content-type": "text/html" } }) });
  const browser = new PreviewBrowser({ anyLocal: true });
  try {
    await browser.call({ action: "open", url: `http://localhost:${server.port}/` });
    const r = await browser.call({ action: "click", locator: { role: "button", name: "Live" } });
    expect(r.content[0]!.type === "text" && r.content[0]!.text).toContain('confirm: "Switch to Live?" (answered OK)');
    expect(r.content[0]!.type === "text" && r.content[0]!.text).toContain('"live"');
  } finally { await browser.close(); server.stop(true); }
}, 60000);

test("the report is found even when the agent spoke again after it", () => {
  const r = parseWalkthrough([
    "Starting the app.",
    'All done.\n```json\n{"applicable": true, "checks": [{"label": "A", "status": "passed"}]}\n```',
    "That notice is only the dev server finishing. The results in my previous message stand.",
  ]);
  expect(r?.checks).toEqual([{ label: "A", status: "passed" }]);
});

test("a step that can't use its element says what the locator matched", async () => {
  const { findBrowser, PreviewBrowser } = await import("../desktop/src/preview-browser.ts");
  if (!findBrowser()) return;
  const server = Bun.serve({ port: 0, fetch: () => new Response(`<label>From <input type="time" id="f"></label><label>Hidden <select style="display:none"><option>1</option></select></label>`, { headers: { "content-type": "text/html" } }) });
  const browser = new PreviewBrowser({ anyLocal: true });
  try {
    await browser.call({ action: "open", url: `http://localhost:${server.port}/` });
    const text = async (r: Promise<{ content: Array<{ type: string; text?: string }> }>) => (await r).content[0]!.text ?? "";
    expect(await text(browser.call({ action: "select", locator: { label: "From" }, value: "09:00" }))).toContain('<input type="time">, visible, enabled. (select only works on a <select>; for a time, date or number input use fill');
    expect(await text(browser.call({ action: "select", locator: { label: "Until" }, value: "x" }))).toContain("matched nothing on this page");
    expect(await text(browser.call({ action: "fill", locator: { label: "From" }, value: "09:00" }))).toContain("fill done.");
  } finally { await browser.close(); server.stop(true); }
}, 60000);

test("a build's checks report is read from what it said, and shows as the Validation step", async () => {
  const { parseBuildReport } = await import("../desktop/src/runner.ts");
  const { checksMessages } = await import("../src/services/runner/hub.ts");
  const r = parseBuildReport(["Working.", 'Done.\n```json\n{"checks": [{"name": "Tests", "command": "npm test", "status": "preexisting", "detail": "143 of 148"}, {"name": "Typecheck", "status": "passed"}], "howToRun": "nvm use 22 && npm test"}\n```', "Notice handled."]);
  expect(r).toEqual({ checks: [
    { name: "Tests", status: "preexisting", command: "npm test", detail: "143 of 148" },
    { name: "Typecheck", status: "passed" },
  ], howToRun: "nvm use 22 && npm test" });
  const rows = checksMessages(r!.checks, "Mac");
  expect(rows[0]).toStartWith("[Validation] Validation check: ⚠ Tests (`npm test`): fails the same way without this ticket — 143 of 148");
  expect(rows.at(-1)).toBe("[Validation] ✅ Validation passed on Mac: 1 of 2 checks passed; Tests already failed before this ticket.");
  expect(checksMessages([{ name: "Build", status: "failed" }], "Mac").at(-1)).toBe("[Validation] ❌ Checks failed on Mac: Build.");
  // A walkthrough's block is not a build report.
  expect(parseBuildReport(['```json\n{"applicable": true, "checks": []}\n```'])).toBeNull();
});
