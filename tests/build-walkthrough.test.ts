// A build on someone's computer ends with a recorded walkthrough: the agent's report and the
// browser's frames become the ticket's feature-testing evidence (video + checks).
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWalkthrough, withRepoLock } from "../desktop/src/runner.ts";
import { FrameRecorder, allowedUrl } from "../desktop/src/preview-browser.ts";
import { cleanReport, encodeFrames, walkthroughMessage } from "../src/services/runner/walkthrough.ts";
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
