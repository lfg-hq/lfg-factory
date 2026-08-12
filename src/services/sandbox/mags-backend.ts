/**
 * Mags VM backend — wrapper around @magpiecloud/mags v1.8.11+
 *
 * Key SDK methods used:
 *  - client.new(name, opts)             → create persistent VM, polls until running
 *  - client.exec(nameOrId, cmd, opts)   → run command via SSH on existing VM (handles chroot)
 *  - client.findJob(nameOrId)           → find running/sleeping job by name or workspace ID
 *  - client.url(nameOrId, port)         → enable HTTP access and return proxy URL
 *  - client.stop(nameOrId)              → terminate VM
 *
 * exec() is preferred over runAndWait() — it goes directly via SSH, no polling loop.
 * For multi-line scripts, base64-encode the payload yourself:
 *   const b64 = btoa(script); execOnWorkspace(name, `echo ${b64} | base64 -d | sh`)
 *
 * This is one of two interchangeable sandbox backends (see ./types.ts). It is
 * selected when SANDBOX_BACKEND=mags (the default). ../mags.ts is the facade.
 */

// @ts-ignore — CJS module, no bundled types
import MagsClient from "@magpiecloud/mags";

export interface MagsExecResult {
  exitCode: number;
  output: string;
  stderr: string;
}

function getClient(timeoutMs = 120_000) {
  const token = process.env.MAGS_API_TOKEN;
  if (!token) throw new Error("MAGS_API_TOKEN not set");
  // HTTP socket timeout — MUST exceed the command's own timeout, else a long
  // command (a big `dotnet restore`) is cut off at the socket, not the command.
  return new MagsClient({ apiToken: token, timeout: timeoutMs });
}

/**
 * Create a new persistent VM workspace.
 * Delegates polling to client.new() — resolves when VM is running.
 * Returns the workspaceId (= name) and jobId (request_id).
 */
export async function newWorkspace(name: string, opts?: {
  baseWorkspaceId?: string;
  rootfsType?: string;
  startupCommand?: string;
  /** Skip JuiceFS/S3 sync: omit workspace_id, keep only a friendly name. No storage cost. */
  noSync?: boolean;
  /** Idle reaper window in minutes (env __MAGS_IDLE_MIN) — matches CLI `-e <minutes>`. */
  idleMinutes?: number;
  /** Never idle-reap (env __MAGS_KEEP_ALIVE) — matches CLI `--no-sleep`. Use for
   *  DB sandboxes / anything that must stay live (a DB shouldn't reap mid-write). */
  keepAlive?: boolean;
  /** Disk size in GB. Mags defaults to 2GB — too small for a full Next.js install. */
  diskGb?: number;
  /** RAM in GB (env __MAGS_MEM_GB). Mags defaults to ~2GB — too small for Pi + a
   *  concurrent Next build, which OOM-kills Pi mid-run. 4GB is the floor. */
  memGb?: number;
}): Promise<{
  jobId: string;
  workspaceId: string;
}> {
  const client = getClient();
  // VMs usually materialize a vm_id in ~5s, but a larger box / a loaded scheduler can
  // take longer — 10s was spuriously failing valid VMs. 25s is still fail-fast enough to
  // catch a job that never attaches a microVM. Override with MAGS_VM_START_TIMEOUT_MS.
  const timeout = parseInt(process.env.MAGS_VM_START_TIMEOUT_MS || "25000", 10);
  const pollInterval = 1_000;
  const rootfsType = opts?.rootfsType ?? "claude";

  // client.new() doesn't forward rootfsType, so call run() directly (same logic as client.new())
  console.log(`[mags] newWorkspace '${name}': calling client.run (rootfs=${rootfsType})...`);
  const runStart = Date.now();
  const useEnvRootfs = !!opts?.memGb;
  const runOpts: Record<string, unknown> = {
    persistent: true,
    ...(useEnvRootfs ? {} : { rootfsType }),
    ...(opts?.diskGb ? { diskGb: opts.diskGb } : {}),
    ...(opts?.baseWorkspaceId ? { baseWorkspaceId: opts.baseWorkspaceId } : {}),
    ...(opts?.startupCommand ? { startupCommand: opts.startupCommand } : {}),
  };
  if (opts?.noSync) {
    runOpts.name = name; // no workspace_id → no S3 sync
  } else {
    runOpts.workspaceId = name; // workspace_id → JuiceFS/S3 sync (persisted)
  }
  const environment: Record<string, string> = {};
  if (useEnvRootfs) environment.__MAGS_ROOTFS_TYPE = rootfsType;
  if (opts?.idleMinutes) environment.__MAGS_IDLE_MIN = String(opts.idleMinutes);
  if (opts?.keepAlive) environment.__MAGS_KEEP_ALIVE = "true";
  if (opts?.memGb) environment.__MAGS_MEM_GB = String(opts.memGb);
  if (Object.keys(environment).length) runOpts.environment = environment;
  const result = await client.run("sleep infinity", runOpts);
  const requestId = result.request_id as string;
  console.log(`[mags] newWorkspace '${name}': run accepted in ${Date.now() - runStart}ms (request_id=${requestId}), polling for running...`);

  const deadline = Date.now() + timeout;
  let polls = 0;
  while (Date.now() < deadline) {
    const st = await client.status(requestId);
    polls++;
    console.log(`[mags] newWorkspace '${name}': poll #${polls} status=${st.status}${st.vm_id ? ` vm_id=${st.vm_id}` : ""} (${Date.now() - runStart}ms elapsed)`);
    if (st.status === "running" && st.vm_id) {
      return { jobId: requestId, workspaceId: name };
    }
    if (st.status === "completed" || st.status === "error") {
      throw new Error(`VM '${name}' ended unexpectedly with status: ${st.status}`);
    }
    await sleep(pollInterval);
  }

  throw new Error(`VM '${name}' did not start within ${timeout}ms (last poll count: ${polls})`);
}

/**
 * Create a BIG persistent VM via the raw v2 API (bypasses the SDK).
 */
export async function newWorkspaceV2(
  name: string,
  opts: { vcpus?: number; memoryMb?: number; diskGb?: number; keepAlive?: boolean; idleMinutes?: number; rootfsType?: string; noSync?: boolean; startupCommand?: string } = {},
): Promise<{ jobId: string; workspaceId: string }> {
  const token = process.env.MAGS_API_TOKEN;
  if (!token) throw new Error("MAGS_API_TOKEN not set");
  const base = (process.env.MAGS_API_URL || "https://api.magpiecloud.com").replace(/\/+$/, "");

  const payload: Record<string, unknown> = {
    script: "sleep infinity",
    type: "inline",
    persistent: true,
    name,
    vcpus: opts.vcpus ?? 4,
    memory_mb: opts.memoryMb ?? 8192,
    startup_command: opts.startupCommand ?? "sleep infinity",
  };
  if (!opts.noSync) payload.workspace_id = name;
  if (opts.diskGb) payload.disk_gb = opts.diskGb;
  if (opts.keepAlive) payload.no_sleep = true;
  if (opts.rootfsType) payload.rootfs_type = opts.rootfsType;

  console.log(`[mags] newWorkspaceV2 '${name}': POST ${base}/api/v2/mags-jobs (vcpus=${payload.vcpus} mem=${payload.memory_mb}MB disk=${opts.diskGb ?? "-"} no_sleep=${!!opts.keepAlive})`);
  const resp = await fetch(`${base}/api/v2/mags-jobs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await resp.json().catch(() => ({}))) as { request_id?: string; message?: string };
  if (!resp.ok || !json.request_id) {
    throw new Error(`Mags v2 create failed: HTTP ${resp.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  const requestId = json.request_id;

  const deadline = Date.now() + 60_000;
  let polls = 0;
  while (Date.now() < deadline) {
    const st = await getJobStatus(requestId).catch(() => null);
    polls++;
    if (st?.status === "running" && st.vm_id) {
      console.log(`[mags] newWorkspaceV2 '${name}': running vm_id=${st.vm_id} (poll ${polls})`);
      return { jobId: requestId, workspaceId: name };
    }
    if (st?.status === "completed" || st?.status === "error") {
      throw new Error(`VM '${name}' ended unexpectedly with status: ${st.status}`);
    }
    await sleep(1000);
  }
  throw new Error(`VM '${name}' did not start within 60s (polls=${polls})`);
}

/**
 * Execute a command on an existing persistent VM via SSH.
 * Retries up to 3 times on transient SSH connection failures.
 */
export async function execOnWorkspace(
  nameOrId: string,
  command: string,
  opts: { timeout?: number } = {}
): Promise<MagsExecResult> {
  const timeout = opts.timeout ?? 300_000; // 5 min default
  const client = getClient(timeout + 30_000);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(5000);

    try {
      const result = await client.exec(nameOrId, command, { timeout });
      return result as MagsExecResult;
    } catch (err) {
      lastError = err as Error;
      const msg = (lastError.message ?? "").toLowerCase();
      const transient = msg.includes("no running") || msg.includes("no vm") ||
        msg.includes("connection refused") || msg.includes("ssh") ||
        msg.includes("not running") || msg.includes("no job found");
      if (transient) {
        console.log(`[mags] exec attempt ${attempt + 1} failed (${msg.slice(0, 80)}), retrying...`);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("exec failed after retries");
}

/**
 * Find a running or sleeping job by name or workspace ID.
 */
export async function findJob(nameOrId: string): Promise<{
  jobId: string;
  workspaceId: string;
  status: string;
} | null> {
  const client = getClient();
  const job = await client.findJob(nameOrId);
  if (!job) return null;
  return {
    jobId: (job.request_id ?? job.id ?? "") as string,
    workspaceId: (job.workspace_id ?? nameOrId) as string,
    status: job.status as string,
  };
}

/**
 * Normalize a Mags public URL to the live app domain.
 */
export function normalizeMagsAppUrl(url: string | null | undefined): string {
  const appDomain = process.env.MAGS_APP_DOMAIN || "app.lfg.run";
  return (url ?? "").replace(/\.apps\.magpiecloud\.com/i, `.${appDomain}`);
}

async function magsApi(method: string, path: string, body?: unknown): Promise<any> {
  const token = process.env.MAGS_API_TOKEN;
  if (!token) throw new Error("MAGS_API_TOKEN not set");
  const base = (process.env.MAGS_API_URL || "https://api.magpiecloud.com").replace(/\/+$/, "");
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Mags ${method} ${path} → HTTP ${resp.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

/**
 * Enable HTTP access on a port and return the public proxy URL.
 */
export async function enableHttpAccess(
  nameOrId: string,
  port = 8080
): Promise<string> {
  await magsApi("POST", `/api/v2/mags-jobs/${encodeURIComponent(nameOrId)}/access`, { port });
  const st = await magsApi("GET", `/api/v2/mags-jobs/${encodeURIComponent(nameOrId)}/status`);
  const raw = (st.url as string) || (st.subdomain ? `https://${st.subdomain}.${process.env.MAGS_APP_DOMAIN || "app.lfg.run"}` : "");
  const url = normalizeMagsAppUrl(raw);
  if (!url) throw new Error(`No URL returned for VM '${nameOrId}' (status had no url/subdomain)`);
  return url;
}

/**
 * Point a STABLE subdomain alias at a workspace so the app's public URL stays the
 * same across VM reaps/restores.
 */
export async function setStableUrl(
  subdomain: string,
  workspaceId: string,
): Promise<string> {
  const appDomain = process.env.MAGS_APP_DOMAIN || "app.lfg.run";
  await magsApi("POST", `/api/v2/mags-url-aliases`, { subdomain, workspace_id: workspaceId, domain: appDomain })
    .catch((e) => { if (!/exist|conflict|already/i.test((e as Error).message)) throw e; });
  return `https://${subdomain}.${appDomain}`;
}

/**
 * Stop a workspace VM.
 */
export async function stopWorkspace(nameOrId: string): Promise<void> {
  const client = getClient();
  await client.stop(nameOrId);
}

/**
 * Toggle a VM's auto-sleep at runtime (PATCH /api/v2/mags-jobs/{id}).
 * noSleep=true  → never idle-sleep (pin awake while actively working)
 * noSleep=false → re-enable idle-sleep (let it pause when idle to save cost)
 * Requires the VM to be persistent (it always is for us). Accepts a job/request id
 * or a workspace name (resolved via findJob).
 */
export async function setNoSleep(nameOrId: string, noSleep: boolean): Promise<void> {
  const client = getClient();
  const jobId = nameOrId.includes("-") && nameOrId.length >= 32
    ? nameOrId
    : (await findJob(nameOrId))?.jobId ?? nameOrId;
  await client.updateJob(jobId, { noSleep });
}

/**
 * Start an ephemeral Chromium browser session and return its CDP WebSocket endpoint.
 */
export async function startBrowserSession(opts?: {
  name?: string;
  timeout?: number;
}): Promise<{ requestId: string; wsEndpoint: string; cdpHttpUrl: string }> {
  const client = getClient();
  const r = await client.browser(opts ?? {});
  let wsEndpoint: string | undefined = r.wsEndpoint;
  if (!wsEndpoint && r.cdpHttpUrl && r.cdpUrl) {
    const ver = (await fetch(`${r.cdpHttpUrl.replace(/\/+$/, "")}/json/version`).then((x) => x.json())) as {
      webSocketDebuggerUrl?: string;
    };
    if (ver.webSocketDebuggerUrl) {
      wsEndpoint = r.cdpUrl.replace(/\/+$/, "") + new URL(ver.webSocketDebuggerUrl).pathname;
    }
  }
  if (!wsEndpoint) throw new Error("Mags browser session did not return a usable wsEndpoint");
  return { requestId: r.requestId, wsEndpoint, cdpHttpUrl: r.cdpHttpUrl };
}

/**
 * Delete a persistent workspace's stored data (frees S3/JuiceFS storage cost).
 */
export async function deleteWorkspace(name: string): Promise<void> {
  const client = getClient();
  await client.deleteWorkspace(name);
}

/**
 * Get raw job status from the API.
 */
export async function getJobStatus(nameOrId: string): Promise<{
  status: string;
  exit_code?: number;
  workspace_id?: string;
  [key: string]: unknown;
}> {
  const client = getClient();
  const jobId = nameOrId.includes("-") && nameOrId.length >= 32
    ? nameOrId
    : (await findJob(nameOrId))?.jobId ?? nameOrId;
  return client.status(jobId);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
