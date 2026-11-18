// A build on the person's computer reports clear stages, not just "Building".
import { test, expect } from "bun:test";
import { ticketStage } from "../src/services/build-progress.ts";

const running = { status: "in_progress", queueStatus: "executing" };
const at = (...lines: string[]) => ticketStage(running, lines.map((text) => ({ text, type: "agent_progress" })));

test("each step of a computer build has its own stage (newest log first)", () => {
  expect(at("Waiting for your computer. Open LFG Desktop and this build starts there.")).toBe("computer");
  expect(at("Cloning https://github.com/acme/app…", "Sent to Ana's Mac. Waiting for it to start.")).toBe("setup");
  expect(at("Checking out feature/x from origin/main…")).toBe("setup");
  expect(at("Starting Claude Code…", "Checking out feature/x from origin/main…")).toBe("building");
  expect(at("Pushing feature/x…", "Starting Claude Code…")).toBe("pushing");
});

test("cloud builds still read as before, with setup shown first", () => {
  expect(at("Creating VM workspace...", "Isolated build: spinning up a fresh sandbox")).toBe("setup");
  expect(at("Starting Pi build (anthropic/sonnet)...", "Setting up repo: acme/app (github)")).toBe("building");
});
