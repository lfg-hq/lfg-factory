// Builds on this computer: effort follows the ticket's complexity, the instructions keep
// full test runs to one, and installed packages carry over between tickets.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildEffort, buildRunnerPrompt } from "../src/services/runner/ticket-job.ts";
import { restorePackages, savePackages } from "../desktop/src/runner.ts";
import { dependencyFingerprint } from "../desktop/src/preview.ts";

test("a simple ticket thinks one level less, a complex one gets high when nothing was chosen", () => {
  expect(buildEffort("claude", null, "simple")).toBe("low");
  expect(buildEffort("claude", "high", "simple")).toBe("medium");
  expect(buildEffort("claude", "low", "simple")).toBe("low");
  expect(buildEffort("claude", null, "medium")).toBeNull();
  expect(buildEffort("claude", "medium", "medium")).toBe("medium");
  expect(buildEffort("claude", null, "complex")).toBe("high");
  expect(buildEffort("claude", "max", "complex")).toBe("max");
  expect(buildEffort("copilot", null, "simple")).toBeNull();
  expect(buildEffort("claude", "xhigh", null)).toBe("xhigh");
});

test("the build runs targeted tests while working and the full suite once", () => {
  const prompt = buildRunnerPrompt({ ticketKey: "REC-1", name: "Thing", description: "Do it", acceptanceCriteria: ["a", "b"] });
  expect(prompt).toContain("run only the tests for what you changed");
  expect(prompt).toContain("once, at the end");
  expect(prompt).toContain("don't reinstall");
});

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
function worktree() {
  const dir = mkdtempSync(join(tmpdir(), "ticket-wt-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "package.json"), '{"name":"a"}');
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "init");
  return dir;
}

test("packages installed for one ticket are reused by the next with the same package files", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "ticket-deps-"));
  const first = worktree();
  const key = (await dependencyFingerprint(first, "ticket-build", null))!;
  expect(key).toBeTruthy();
  mkdirSync(join(first, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(first, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  await savePackages(first, join(cacheRoot, key), key, process.env);
  expect(existsSync(join(cacheRoot, key, "node_modules", "left-pad", "index.js"))).toBe(true);

  const second = worktree();
  expect(await dependencyFingerprint(second, "ticket-build", null)).toBe(key);
  expect(await restorePackages(join(cacheRoot, key), second, process.env)).toBe(true);
  expect(readFileSync(join(second, "node_modules", "left-pad", "index.js"), "utf8")).toBe("module.exports = 1;");
  // Already there: left alone.
  expect(await restorePackages(join(cacheRoot, key), second, process.env)).toBe(false);
});

test("packages are not kept when the ticket changed the package files", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "ticket-deps-"));
  const dir = worktree();
  const key = (await dependencyFingerprint(dir, "ticket-build", null))!;
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"a","dependencies":{"x":"1"}}');
  await savePackages(dir, join(cacheRoot, key), key, process.env);
  expect(existsSync(join(cacheRoot, key))).toBe(false);
});
