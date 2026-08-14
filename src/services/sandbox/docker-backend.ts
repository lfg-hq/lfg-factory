/**
 * Docker sandbox backend — self-hosted alternative to Magpie Cloud micro-VMs.
 *
 * Each "workspace" is a long-lived Docker container started from a prebuilt image
 * (node + python + claude-code + pi — see Dockerfile.sandbox). Coding agents run
 * inside it via `docker exec`, exactly mirroring the Mags SSH-exec model, so the
 * rest of the app is backend-agnostic.
 *
 * Selected when SANDBOX_BACKEND=docker. ../mags.ts is the facade.
 *
 * Networking (SANDBOX_DOCKER_NETWORK):
 *   "bridge" (default) — each container is network-isolated, exactly like a VM.
 *     The app's internal port (SANDBOX_APP_PORT, default 8080) is published to a
 *     UNIQUE auto-assigned host port, so many apps run concurrently with no
 *     collisions and the preview is SANDBOX_PREVIEW_HOST:<mapped-port>. Works on
 *     macOS and Linux. The in-container app stays on its own loopback, so the
 *     in-sandbox readiness probe (curl localhost:8080) works.
 *   "host" — container shares the host network and binds the port directly
 *     (Linux only; apps must use distinct ports and 8080 must be free).
 *
 * Preview URLs are localhost URLs — reachable from the LFG host / a browser on
 * the same machine; not publicly shareable without a tunnel (the self-host model).
 */

import { spawn } from "node:child_process";
import { env } from "../../config/env.ts";
import type {
  BrowserSession,
  JobInfo,
  JobStatus,
  NewWorkspaceOpts,
  NewWorkspaceV2Opts,
  SandboxExecResult,
  WorkspaceRef,
} from "./types.ts";

// Re-export the shared result type under the legacy name for the facade.
export type MagsExecResult = SandboxExecResult;

// Remembers the last preview URL enabled per workspace, so setStableUrl() can
// return a consistent URL (the localhost model has no separate alias system).
const _urlByWorkspace = new Map<string, string>();

// ── docker CLI helper ─────────────────────────────────────────────────

interface DockerRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runDocker(
  args: string[],
  opts: { timeout?: number } = {}
): Promise<DockerRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`docker ${args[0]} timed out after ${opts.timeout}ms`));
      }, opts.timeout);
    }

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      // ENOENT ⇒ docker binary not installed/on PATH.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("DOCKER_NOT_INSTALLED"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

// ── Availability & image checks ───────────────────────────────────────

let _dockerChecked = false;

/** Verify the Docker daemon is reachable, with an actionable error if not. */
async function ensureDocker(): Promise<void> {
  if (_dockerChecked) return;
  try {
    const r = await runDocker(["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
    if (r.code !== 0) {
      throw new Error(
        `Docker is installed but the daemon is not reachable:\n${r.stderr.trim()}\n` +
          `Start Docker, or run scripts/setup-docker.sh to install & start it.`
      );
    }
  } catch (err) {
    if ((err as Error).message === "DOCKER_NOT_INSTALLED") {
      throw new Error(
        "Docker is not installed (or not on PATH). The 'docker' sandbox backend needs it.\n" +
          "Install it from https://docs.docker.com/engine/install/ or run scripts/setup-docker.sh, " +
          "then set SANDBOX_BACKEND=docker."
      );
    }
    throw err;
  }
  _dockerChecked = true;
}

const _pulledImages = new Set<string>();

/** Ensure an image is present locally, pulling it on first use. */
async function ensureImage(image: string): Promise<void> {
  if (_pulledImages.has(image)) return;
  const inspect = await runDocker(["image", "inspect", image], { timeout: 15_000 }).catch(() => null);
  if (inspect && inspect.code === 0) {
    _pulledImages.add(image);
    return;
  }
  console.log(`[docker] pulling sandbox image '${image}' (first use)...`);
  const pull = await runDocker(["pull", image], { timeout: 600_000 });
  if (pull.code !== 0) {
    throw new Error(
      `Failed to pull sandbox image '${image}':\n${pull.stderr.trim()}\n` +
        `Build & push it first (scripts/build-sandbox-image.sh) and set SANDBOX_IMAGE.`
    );
  }
  _pulledImages.add(image);
}

// ── Name / state helpers ──────────────────────────────────────────────

const PREFIX = "lfg-";

/** Map a workspace name to a deterministic, docker-safe container name. Idempotent. */
function containerName(nameOrId: string): string {
  if (nameOrId.startsWith(PREFIX)) return nameOrId;
  const safe = nameOrId.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^[-.]+/, "");
  return `${PREFIX}${safe}`;
}

function baseName(nameOrId: string): string {
  return nameOrId.startsWith(PREFIX) ? nameOrId.slice(PREFIX.length) : nameOrId;
}

/** Container state: "running" | "exited" | "created" | ... | null (does not exist). */
async function containerState(cname: string): Promise<string | null> {
  const r = await runDocker(["inspect", "-f", "{{.State.Status}}", cname], { timeout: 10_000 }).catch(
    () => ({ code: 1, stdout: "", stderr: "" })
  );
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

function previewHostBase(): string {
  return env.SANDBOX_PREVIEW_HOST.replace(/\/+$/, "");
}

const HOST_MODE = env.SANDBOX_DOCKER_NETWORK === "host";

/** Ask Docker which host port a container's internal port was published to. */
async function dockerHostPort(cname: string, containerPort: number): Promise<number | null> {
  const r = await runDocker(["port", cname, String(containerPort)], { timeout: 10_000 }).catch(
    () => null
  );
  if (!r || r.code !== 0) return null;
  // e.g. "127.0.0.1:49153" (may include a tcp/udp line each) → take the port.
  const m = r.stdout.match(/:(\d+)\s*$/m);
  return m ? parseInt(m[1]!, 10) : null;
}

// ── Lifecycle ─────────────────────────────────────────────────────────

async function createContainer(
  name: string,
  resources: { cpus?: number; memoryMb?: number } = {}
): Promise<WorkspaceRef> {
  await ensureDocker();
  const image = env.SANDBOX_IMAGE;
  if (!image) {
    throw new Error("SANDBOX_IMAGE is not set — required for the docker sandbox backend.");
  }
  await ensureImage(image);

  const cname = containerName(name);
  const state = await containerState(cname);
  if (state === "running") return { jobId: cname, workspaceId: name };
  if (state) {
    // Exists but stopped — restart it (persistent workspace semantics).
    await runDocker(["start", cname], { timeout: 30_000 });
    return { jobId: cname, workspaceId: name };
  }

  const args = [
    "run",
    "-d",
    "--name",
    cname,
    "--label",
    "lfg.sandbox=1",
    "--network",
    env.SANDBOX_DOCKER_NETWORK,
    "--restart",
    "unless-stopped",
  ];
  if (!HOST_MODE) {
    // Publish the app's internal port to a UNIQUE auto-assigned host port (":0")
    // bound to loopback. Each container keeps its own APP_PORT internally, so any
    // number of apps run concurrently without fighting over a host port.
    args.push("-p", `127.0.0.1:0:${env.SANDBOX_APP_PORT}`);
  }
  if (resources.cpus) args.push("--cpus", String(resources.cpus));
  if (resources.memoryMb) args.push("--memory", `${resources.memoryMb}m`);
  // Keep the container alive so we can exec into it, mirroring `sleep infinity`.
  args.push(image, "sh", "-c", "sleep infinity");

  const r = await runDocker(args, { timeout: 120_000 });
  if (r.code !== 0) {
    throw new Error(`docker run failed for '${cname}':\n${r.stderr.trim()}`);
  }
  return { jobId: cname, workspaceId: name };
}

export async function newWorkspace(name: string, opts: NewWorkspaceOpts = {}): Promise<WorkspaceRef> {
  return createContainer(name, { memoryMb: opts.memGb ? opts.memGb * 1024 : undefined });
}

export async function newWorkspaceV2(name: string, opts: NewWorkspaceV2Opts = {}): Promise<WorkspaceRef> {
  return createContainer(name, { cpus: opts.vcpus, memoryMb: opts.memoryMb });
}

export async function execOnWorkspace(
  nameOrId: string,
  command: string,
  opts: { timeout?: number } = {}
): Promise<SandboxExecResult> {
  const cname = containerName(nameOrId);
  const timeout = opts.timeout ?? 300_000;
  // Pass the command as a single argv element to `sh -c` — no host-side shell is
  // involved, so there is no shell-injection surface from `command` here.
  const r = await runDocker(["exec", cname, "sh", "-c", command], { timeout });
  return { exitCode: r.code, output: r.stdout, stderr: r.stderr };
}

export async function findJob(nameOrId: string): Promise<JobInfo | null> {
  const cname = containerName(nameOrId);
  const state = await containerState(cname);
  if (!state) return null;
  return {
    jobId: cname,
    workspaceId: baseName(nameOrId),
    status: state === "running" ? "running" : "sleeping",
  };
}

export async function enableHttpAccess(nameOrId: string, port = env.SANDBOX_APP_PORT): Promise<string> {
  let hostPort = port;
  if (!HOST_MODE) {
    // Bridge mode: translate the app's internal port to the container's published
    // host port. Fall back to APP_PORT's mapping, then to the requested port.
    const cname = containerName(nameOrId);
    hostPort =
      (await dockerHostPort(cname, port)) ??
      (await dockerHostPort(cname, env.SANDBOX_APP_PORT)) ??
      port;
  }
  const url = `${previewHostBase()}:${hostPort}`;
  _urlByWorkspace.set(baseName(nameOrId), url);
  return url;
}

export async function setStableUrl(_subdomain: string, workspaceId: string, _port?: number): Promise<string> {
  // No separate alias system in localhost mode — the app's URL is already stable
  // for the life of the container. Return the last-enabled URL if we have it.
  return _urlByWorkspace.get(baseName(workspaceId)) ?? previewHostBase();
}

export async function stopWorkspace(nameOrId: string): Promise<void> {
  const cname = containerName(nameOrId);
  await runDocker(["stop", cname], { timeout: 30_000 }).catch(() => {});
}

/** No sleep/idle concept for local Docker containers — no-op. */
export async function setNoSleep(_nameOrId: string, _noSleep: boolean): Promise<void> {
  /* intentionally a no-op */
}

export async function deleteWorkspace(name: string): Promise<void> {
  const cname = containerName(name);
  _urlByWorkspace.delete(baseName(name));
  await runDocker(["rm", "-f", cname], { timeout: 30_000 }).catch(() => {});
}

export async function getJobStatus(nameOrId: string): Promise<JobStatus> {
  const cname = containerName(nameOrId);
  const state = await containerState(cname);
  if (!state) return { status: "completed" };
  return {
    status: state === "running" ? "running" : "sleeping",
    vm_id: cname,
    workspace_id: baseName(nameOrId),
  };
}

// ── Browser sessions (QA / screenshots) ───────────────────────────────

/** Facade compatibility: normalize is a no-op for docker (URLs are already local). */
export function normalizeMagsAppUrl(url: string | null | undefined): string {
  return url ?? "";
}

export async function startBrowserSession(
  opts: { name?: string; timeout?: number } = {}
): Promise<BrowserSession> {
  await ensureDocker();
  const image = env.SANDBOX_BROWSER_IMAGE;
  await ensureImage(image);

  // Internal CDP port. In host mode it must be unique per session (shared host
  // net), so randomize; in bridge mode it stays 9222 and is published to a unique
  // host port.
  const internalPort = HOST_MODE ? 9222 + Math.floor(Math.random() * 4000) : 9222;
  const cname = containerName(`browser-${opts.name ?? "cdp"}-${internalPort}`);
  await runDocker(["rm", "-f", cname], { timeout: 15_000 }).catch(() => {});

  const args = ["run", "-d", "--name", cname, "--label", "lfg.sandbox=1", "--network", env.SANDBOX_DOCKER_NETWORK];
  if (!HOST_MODE) args.push("-p", `127.0.0.1:0:${internalPort}`);
  args.push(
    image,
    "--no-sandbox",
    "--headless=new",
    "--disable-gpu",
    "--remote-debugging-address=0.0.0.0",
    `--remote-debugging-port=${internalPort}`,
    "about:blank"
  );
  const r = await runDocker(args, { timeout: 60_000 });
  if (r.code !== 0) {
    throw new Error(`Failed to start browser container '${cname}':\n${r.stderr.trim()}`);
  }

  const httpBase = previewHostBase();
  const port = HOST_MODE ? internalPort : (await dockerHostPort(cname, internalPort)) ?? internalPort;
  const cdpHttpUrl = `${httpBase}:${port}`;
  const wsHost = new URL(httpBase).host; // e.g. localhost

  // Poll /json/version until Chromium's CDP endpoint is up.
  const deadline = Date.now() + (opts.timeout ?? 30_000);
  let wsEndpoint = "";
  while (Date.now() < deadline) {
    try {
      const ver = (await fetch(`${cdpHttpUrl}/json/version`).then((x) => x.json())) as {
        webSocketDebuggerUrl?: string;
      };
      if (ver.webSocketDebuggerUrl) {
        // Keep the public host:port, take only Chromium's /devtools/... path.
        wsEndpoint = `ws://${wsHost}:${port}${new URL(ver.webSocketDebuggerUrl).pathname}`;
        break;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!wsEndpoint) {
    await runDocker(["rm", "-f", cname], { timeout: 15_000 }).catch(() => {});
    throw new Error(`Browser container '${cname}' did not expose a CDP endpoint in time.`);
  }

  return { requestId: cname, wsEndpoint, cdpHttpUrl };
}
