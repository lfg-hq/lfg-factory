// LFG Desktop lands a ticket branch on its epic branch after pushing, like a cloud build.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mergeIntoTarget } from "../desktop/src/runner.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "merge-epic-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  execFileSync("git", ["clone", origin, seed], { stdio: "ignore" });
  writeFileSync(join(seed, "a.txt"), "base\n");
  sh(seed, "add", "-A"); sh(seed, ...ID, "commit", "-m", "base"); sh(seed, "push", "origin", "HEAD:refs/heads/main");
  sh(seed, "push", "origin", "HEAD:refs/heads/epic");
  sh(seed, "checkout", "-b", "ticket");
  writeFileSync(join(seed, "b.txt"), "ticket\n");
  sh(seed, "add", "-A"); sh(seed, ...ID, "commit", "-m", "ticket work"); sh(seed, "push", "origin", "HEAD:refs/heads/ticket");
  const repoDir = join(root, "repo");
  execFileSync("git", ["clone", origin, repoDir], { stdio: "ignore" });
  return { root, origin, seed, repoDir };
}

const ctx = (root: string, repoDir: string) => ({
  workRoot: root, agent: "claude" as const, allowedTools: [], env: process.env,
  progress() {}, agentEvent() {}, repoDir, identity: ID, check() {}, tools: [],
});
const payload = (mergeInto?: string) => ({ protocol: 3, projectName: "p", ticketKey: "T-1", ticketTitle: "t", repoUrl: "file://x",
  branch: "ticket", startFrom: ["epic"], prompt: "x", commitMessage: "x", ...(mergeInto ? { mergeInto } : {}) });

describe("mergeIntoTarget", () => {
  test("merges the ticket branch into the epic branch and pushes it", async () => {
    const { root, origin, repoDir } = setup();
    // The epic moved on since the ticket branched, so this is a real merge.
    const other = join(root, "other");
    execFileSync("git", ["clone", "-b", "epic", origin, other], { stdio: "ignore" });
    writeFileSync(join(other, "c.txt"), "other ticket\n");
    sh(other, "add", "-A"); sh(other, ...ID, "commit", "-m", "other"); sh(other, "push", "origin", "HEAD:refs/heads/epic");

    const r = await mergeIntoTarget(payload("epic"), ctx(root, repoDir));
    expect(r.mergeError).toBeUndefined();
    expect(r.mergeSha).toBe(sh(origin, "rev-parse", "epic"));
    const files = sh(origin, "ls-tree", "--name-only", "epic").split("\n");
    expect(files).toEqual(expect.arrayContaining(["a.txt", "b.txt", "c.txt"]));
  });

  test("an already-merged branch reports the epic's commit without a new merge", async () => {
    const { root, origin, seed, repoDir } = setup();
    sh(seed, "push", "origin", "ticket:refs/heads/epic");
    const before = sh(origin, "rev-parse", "epic");
    const r = await mergeIntoTarget(payload("epic"), ctx(root, repoDir));
    expect(r).toEqual({ mergeSha: before });
  });

  test("a missing epic branch is created from the ticket branch", async () => {
    const { root, origin, repoDir } = setup();
    const r = await mergeIntoTarget(payload("epic-new"), ctx(root, repoDir));
    expect(r.mergeSha).toBe(sh(origin, "rev-parse", "ticket"));
    expect(sh(origin, "rev-parse", "epic-new")).toBe(sh(origin, "rev-parse", "ticket"));
  });

  test("no merge target, nothing to do", async () => {
    const { root, repoDir } = setup();
    expect(await mergeIntoTarget(payload(), ctx(root, repoDir))).toEqual({});
  });
});
