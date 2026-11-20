/**
 * The right Node.js for a project's preview.
 *
 * A Mac often has several Node versions (nvm, fnm, Volta, asdf, Homebrew…), and the shell's
 * default one may be too old for the app (Next.js 16 needs >= 20.9). This works out what the
 * project needs (.nvmrc, .node-version, .tool-versions, package.json "engines", and the
 * "engines" of its direct dependencies), picks a matching Node that is already installed,
 * and, only with the person's OK, downloads the official build from nodejs.org into
 * ~/LFG/runtimes (checked against nodejs.org's published SHA-256 sums).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { run } from "./proc.ts";

export type Version = [number, number, number];
export interface Requirement { range: string; source: string }
export interface NodeInstall { version: Version; bin: string; source: string }

export function parseVersion(v: string): Version | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}
export const fmt = (v: Version) => `${v[0]}.${v[1]}.${v[2]}`;
const cmp = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** One comparator ("^18.18.0", ">=20", "20.x", "~22.1") → the versions it allows, as a test. */
function comparator(raw: string): ((v: Version) => boolean) | null {
  const c = raw.trim();
  if (!c || c === "*" || /^x$/i.test(c) || c === "latest" || c === "lts" || /^lts\//i.test(c) || c === "node") return () => true;
  const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/i.exec(c);
  if (!m) return null;
  const op = m[1] ?? "";
  const wild = (s?: string) => s === undefined || /^[x*]$/i.test(s);
  const major = Number(m[2]);
  if (wild(m[2])) return () => true;
  const minor = wild(m[3]) ? null : Number(m[3]);
  const patch = wild(m[4]) ? null : Number(m[4]);
  const base: Version = [major, minor ?? 0, patch ?? 0];
  switch (op) {
    case ">=": return v => cmp(v, base) >= 0;
    case ">": return minor === null ? v => v[0] > major : patch === null ? v => cmp(v, [major, minor, Infinity]) > 0 : v => cmp(v, base) > 0;
    case "<=": return minor === null ? v => v[0] <= major : patch === null ? v => v[0] < major || (v[0] === major && v[1] <= minor) : v => cmp(v, base) <= 0;
    case "<": return v => cmp(v, base) < 0;
    case "^": return v => cmp(v, base) >= 0 && (major > 0 ? v[0] === major : v[0] === 0 && v[1] === base[1]);
    case "~": return v => cmp(v, base) >= 0 && v[0] === major && (minor === null || v[1] === minor);
    default: // "20", "20.9", "20.9.0", "=20.9.0"
      return v => v[0] === major && (minor === null || v[1] === minor) && (patch === null || v[2] === patch);
  }
}

/** Does `v` satisfy an npm-style range? Unparseable ranges count as satisfied (we can't judge them). */
export function satisfies(v: Version, range: string): boolean {
  const alts = range.split("||").map(a => a.trim().replace(/\s+-\s+/g, " - "));
  return alts.some(alt => {
    const hyphen = /^(\S+) - (\S+)$/.exec(alt);
    const parts = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : alt.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
    const tests = parts.map(comparator);
    if (tests.some(t => t === null)) return true;
    return tests.every(t => t!(v));
  });
}

const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const readText = (file: string): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };

/** Everything the project says about the Node it needs. */
export function nodeRequirements(dir: string): Requirement[] {
  const out: Requirement[] = [];
  const add = (range: unknown, source: string) => { if (typeof range === "string" && range.trim()) out.push({ range: range.trim(), source }); };
  for (const f of [".nvmrc", ".node-version"]) {
    const t = readText(join(dir, f))?.split("\n")[0]?.trim();
    // "lts/*" or "node" pins nothing specific; a version (or major) does.
    if (t && parseVersion(t)) add(t.replace(/^v/, ""), f);
  }
  const tool = readText(join(dir, ".tool-versions"))?.split("\n").find(l => /^nodejs\s/.test(l))?.split(/\s+/)[1];
  if (tool) add(tool, ".tool-versions");
  const pkg = readJson(join(dir, "package.json"));
  if (!pkg) return out;
  add(pkg.engines?.node, "package.json");
  // Dependencies: only the oldest Node each one accepts counts. Many packages list narrow,
  // out-of-date ranges ("^14 || ^16") that newer Node runs fine; their floor is what matters.
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  const lock = readJson(join(dir, "package-lock.json"));
  let highest: { floor: Version; name: string } | null = null;
  for (const name of deps) {
    const installed = readJson(join(dir, "node_modules", name, "package.json"))?.engines?.node;
    const locked = lock?.packages?.[`node_modules/${name}`]?.engines?.node;
    const range = installed ?? (typeof locked === "string" ? locked : undefined);
    const f = typeof range === "string" ? floor(range) : null;
    if (f && (!highest || cmp(f, highest.floor) > 0)) highest = { floor: f, name };
  }
  if (highest) add(`>=${fmt(highest.floor)}`, highest.name);
  return out;
}

/** The oldest version a range accepts (null when it sets no floor). */
export function floor(range: string): Version | null {
  let low: Version | null = null;
  for (const alt of range.split("||")) {
    const m = /(>=|>|\^|~|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(alt.trim().replace(/^<=?\s*\S+\s*/, ""));
    if (!m || /^</.test(alt.trim())) return null; // an alternative with no lower bound: any old Node will do
    const v: Version = [Number(m[2]), /^\d+$/.test(m[3] ?? "") ? Number(m[3]) : 0, /^\d+$/.test(m[4] ?? "") ? Number(m[4]) : 0];
    if (m[1] === ">") v[2] += 1;
    if (!low || cmp(v, low) < 0) low = v;
  }
  return low;
}

export const unmet = (v: Version, reqs: Requirement[]) => reqs.filter(r => !satisfies(v, r.range));

function listDirs(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }

/** Node installs on this computer, newest first. */
export function installedNodes(workRoot: string, home = os.homedir()): NodeInstall[] {
  const found: NodeInstall[] = [];
  const add = (bin: string, label: string, source: string) => {
    const v = parseVersion(label);
    if (v && existsSync(join(bin, "node"))) found.push({ version: v, bin, source });
  };
  const fnmRoots = [join(home, ".local/share/fnm/node-versions"), join(home, "Library/Application Support/fnm/node-versions"), join(home, ".fnm/node-versions")];
  for (const d of listDirs(join(workRoot, "runtimes"))) add(join(workRoot, "runtimes", d, "bin"), d.replace(/^node-/, ""), "LFG");
  for (const d of listDirs(join(home, ".nvm/versions/node"))) add(join(home, ".nvm/versions/node", d, "bin"), d, "nvm");
  for (const root of fnmRoots) for (const d of listDirs(root)) add(join(root, d, "installation/bin"), d, "fnm");
  for (const d of listDirs(join(home, ".volta/tools/image/node"))) add(join(home, ".volta/tools/image/node", d, "bin"), d, "Volta");
  for (const d of listDirs(join(home, ".asdf/installs/nodejs"))) add(join(home, ".asdf/installs/nodejs", d, "bin"), d, "asdf");
  for (const d of listDirs("/usr/local/n/versions/node")) add(join("/usr/local/n/versions/node", d, "bin"), d, "n");
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    for (const d of listDirs(join(prefix, "Cellar/node"))) add(join(prefix, "Cellar/node", d, "bin"), d, "Homebrew");
    for (const f of listDirs(join(prefix, "Cellar"))) if (/^node@\d+$/.test(f)) for (const d of listDirs(join(prefix, "Cellar", f))) add(join(prefix, "Cellar", f, d, "bin"), d, "Homebrew");
  }
  const seen = new Set<string>();
  return found.filter(n => !seen.has(n.bin) && seen.add(n.bin)).sort((a, b) => cmp(b.version, a.version));
}

/** The Node the shell would run now. */
export async function currentNode(env: NodeJS.ProcessEnv): Promise<Version | null> {
  const r = await run("node", ["-v"], { env, timeoutMs: 15_000 }).catch(() => null);
  return r && r.code === 0 ? parseVersion(r.stdout) : null;
}

/** The newest installed Node that meets every requirement, preferring the newest LTS-numbered (even) major. */
export function pickInstalled(installs: NodeInstall[], reqs: Requirement[]): NodeInstall | null {
  const ok = installs.filter(n => unmet(n.version, reqs).length === 0);
  return ok.find(n => n.version[0] % 2 === 0) ?? ok[0] ?? null;
}

/** Put this Node first on PATH. */
export function withNode(env: NodeJS.ProcessEnv, bin: string): NodeJS.ProcessEnv {
  const rest = (env.PATH ?? "").split(":").filter(p => p && p !== bin);
  return { ...env, PATH: [bin, ...rest].join(":") };
}

/** The newest LTS release from nodejs.org that meets the requirements. */
export async function chooseDownload(reqs: Requirement[], fetchImpl: typeof fetch = fetch): Promise<Version | null> {
  const res = await fetchImpl("https://nodejs.org/dist/index.json");
  if (!res.ok) throw new Error(`nodejs.org answered ${res.status}`);
  const list = (await res.json()) as Array<{ version: string; lts: string | false }>;
  const versions = list.map(r => ({ v: parseVersion(r.version), lts: !!r.lts })).filter((r): r is { v: Version; lts: boolean } => !!r.v && unmet(r.v, reqs).length === 0);
  return (versions.find(r => r.lts) ?? versions[0])?.v ?? null;
}

/** Download and unpack the official Node build into <workRoot>/runtimes/node-<version>. */
export async function downloadNode(version: Version, workRoot: string, log: (line: string) => void, fetchImpl: typeof fetch = fetch): Promise<NodeInstall> {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  if (!platform) throw new Error("Downloading Node.js is only set up for macOS and Linux.");
  const name = `node-v${fmt(version)}-${platform}-${arch}`;
  const base = `https://nodejs.org/dist/v${fmt(version)}`;
  const runtimes = join(workRoot, "runtimes");
  const target = join(runtimes, `node-${fmt(version)}`);
  if (existsSync(join(target, "bin", "node"))) return { version, bin: join(target, "bin"), source: "LFG" };
  mkdirSync(runtimes, { recursive: true });

  log(`Downloading Node.js ${fmt(version)} from nodejs.org…`);
  const sums = await fetchImpl(`${base}/SHASUMS256.txt`);
  if (!sums.ok) throw new Error(`Couldn't get Node.js checksums (HTTP ${sums.status}).`);
  const expected = (await sums.text()).split("\n").find(l => l.trim().endsWith(`${name}.tar.gz`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`nodejs.org has no ${name}.tar.gz.`);
  const tar = await fetchImpl(`${base}/${name}.tar.gz`);
  if (!tar.ok) throw new Error(`Couldn't download Node.js (HTTP ${tar.status}).`);
  const bytes = Buffer.from(await tar.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("The Node.js download didn't match nodejs.org's checksum, so it wasn't used.");

  const archive = join(runtimes, `${name}.tar.gz`);
  const staging = join(runtimes, `.${name}-${process.pid}`);
  writeFileSync(archive, bytes);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const r = await run("tar", ["-xzf", archive, "-C", staging, "--strip-components", "1"], { timeoutMs: 5 * 60_000 });
  rmSync(archive, { force: true });
  if (r.code !== 0) { rmSync(staging, { recursive: true, force: true }); throw new Error(`Couldn't unpack Node.js: ${r.stderr.trim().slice(0, 300)}`); }
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  log(`Node.js ${fmt(version)} is in ${target}.`);
  return { version, bin: join(target, "bin"), source: "LFG" };
}

export function describe(reqs: Requirement[]): string {
  return reqs.map(r => `${r.source} needs Node ${r.range}`).join("; ");
}
