// Previews on the person's computer pick the Node.js the app needs, not just the shell's default.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { floor, installedNodes, nodeRequirements, parseVersion, pickInstalled, satisfies, unmet, withNode, chooseDownload } from "../desktop/src/node-runtime.ts";

const v = (s: string) => parseVersion(s)!;

test("npm-style ranges", () => {
  expect(satisfies(v("18.18.2"), ">=20.9.0")).toBe(false);
  expect(satisfies(v("22.19.0"), ">=20.9.0")).toBe(true);
  expect(satisfies(v("18.18.2"), "^18.18.0 || ^19.8.0 || >= 20.0.0")).toBe(true);
  expect(satisfies(v("20.1.0"), "20.x")).toBe(true);
  expect(satisfies(v("21.0.0"), "20")).toBe(false);
  expect(satisfies(v("22.1.0"), "~22.1")).toBe(true);
  expect(satisfies(v("23.0.0"), ">=18 <23")).toBe(false);
  expect(satisfies(v("20.0.0"), "18 - 20")).toBe(true);
  expect(satisfies(v("16.0.0"), "lts/*")).toBe(true);
  expect(floor(">=20.9.0")).toEqual([20, 9, 0]);
  expect(floor("^14 || ^16 || >=18")).toEqual([14, 0, 0]);
  expect(floor("<18")).toBeNull();
});

function project(files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "lfg-node-req-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

test("a Next.js 16 app needs Node 20.9+, found from the installed package (as in Recruiting)", () => {
  const dir = project({
    "package.json": { dependencies: { next: "16.0.0", "left-pad": "1.0.0" } },
    "node_modules/next/package.json": { engines: { node: ">=20.9.0" } },
    "node_modules/left-pad/package.json": { engines: { node: "^14 || ^16" } }, // narrow and old: only its floor counts
  });
  const reqs = nodeRequirements(dir);
  expect(reqs).toEqual([{ range: ">=20.9.0", source: "next" }]);
  expect(unmet(v("18.18.2"), reqs).length).toBe(1);
  expect(unmet(v("22.19.0"), reqs).length).toBe(0);
});

test("before install, package-lock.json, .nvmrc and engines say the same", () => {
  const dir = project({
    "package.json": { engines: { node: ">=20" }, dependencies: { next: "16.0.0" } },
    "package-lock.json": { packages: { "node_modules/next": { engines: { node: ">=20.9.0" } } } },
    ".nvmrc": "v22\n",
  });
  expect(nodeRequirements(dir).map(r => r.source).sort()).toEqual([".nvmrc", "next", "package.json"]);
  expect(satisfies(v("22.19.0"), nodeRequirements(dir)[0].range)).toBe(true);
});

test("finds Node installed with nvm and picks one that fits", () => {
  const home = mkdtempSync(join(tmpdir(), "lfg-home-"));
  for (const ver of ["v18.18.2", "v22.19.0", "v23.1.0"]) {
    mkdirSync(join(home, ".nvm/versions/node", ver, "bin"), { recursive: true });
    writeFileSync(join(home, ".nvm/versions/node", ver, "bin/node"), "");
  }
  const all = installedNodes(join(home, "LFG"), home);
  expect(all.map(n => n.version[0])).toEqual([23, 22, 18]);
  const picked = pickInstalled(all, [{ range: ">=20.9.0", source: "next" }]);
  expect(picked?.version).toEqual([22, 19, 0]); // even (LTS-line) major preferred
  expect(picked?.source).toBe("nvm");
  expect(pickInstalled(all, [{ range: ">=24", source: "x" }])).toBeNull();
  expect(withNode({ PATH: "/usr/bin:/bin" }, picked!.bin).PATH).toBe(`${picked!.bin}:/usr/bin:/bin`);
});

test("a download is the newest LTS that fits", async () => {
  const index = [{ version: "v25.0.0", lts: false }, { version: "v24.11.1", lts: "Krypton" }, { version: "v22.21.0", lts: "Jod" }];
  const fake = (async () => new Response(JSON.stringify(index))) as unknown as typeof fetch;
  expect(await chooseDownload([{ range: ">=20.9.0", source: "next" }], fake)).toEqual([24, 11, 1]);
  expect(await chooseDownload([{ range: "22", source: ".nvmrc" }], fake)).toEqual([22, 21, 0]);
});
