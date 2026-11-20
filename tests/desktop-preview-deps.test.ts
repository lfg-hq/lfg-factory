// A preview on this computer reinstalls libraries only when the dependency files change.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { dependencyFingerprint } from "../desktop/src/preview.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "deps-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "package.json"), '{"name":"a"}');
  writeFileSync(join(dir, "package-lock.json"), "{}");
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "page.tsx"), "1");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "a");
  return dir;
}

test("app-code commits keep the fingerprint; dependency changes, Node and command change it", async () => {
  const dir = repo();
  const a = await dependencyFingerprint(dir, "npm ci", "22.19.0");
  expect(a).toBeString();

  writeFileSync(join(dir, "app", "page.tsx"), "2");
  git(dir, "commit", "-qam", "code only");
  expect(await dependencyFingerprint(dir, "npm ci", "22.19.0")).toBe(a!);

  expect(await dependencyFingerprint(dir, "npm ci", "20.0.0")).not.toBe(a!);
  expect(await dependencyFingerprint(dir, "npm install", "22.19.0")).not.toBe(a!);

  writeFileSync(join(dir, "package-lock.json"), '{"v":2}');
  expect(await dependencyFingerprint(dir, "npm ci", "22.19.0")).toBeNull(); // uncommitted: always install
  git(dir, "commit", "-qam", "lock");
  const b = await dependencyFingerprint(dir, "npm ci", "22.19.0");
  expect(b).not.toBe(a!);

  // A workspace package's manifest counts too.
  mkdirSync(join(dir, "packages", "ui"), { recursive: true });
  writeFileSync(join(dir, "packages", "ui", "package.json"), '{"name":"ui"}');
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "ws");
  expect(await dependencyFingerprint(dir, "npm ci", "22.19.0")).not.toBe(b!);
});

test("outside a git checkout there is no fingerprint, so it installs", async () => {
  expect(await dependencyFingerprint(mkdtempSync(join(tmpdir(), "nogit-")), "npm ci", null)).toBeNull();
});
