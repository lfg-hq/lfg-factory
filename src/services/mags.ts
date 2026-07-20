/**
 * Mags VM service — wrapper around @magpiecloud/mags v1.8.11+
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
 */

// @ts-ignore — CJS module, no bundled types
import MagsClient from "@magpiecloud/mags";


export interface MagsExecResult {
  exitCode: number;
  output: string;
  stderr: string;
}

function getClient() {
  const token = process.env.MAGS_API_TOKEN;
  if (!token) throw new Error("MAGS_API_TOKEN not set");
  // timeout here is the HTTP socket timeout — must be > any exec command we run
  return new MagsClient({ apiToken: token, timeout: 120_000 });
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
  // VMs materialize a vm_id in ~5s; fail fast (10s) rather than hanging if the
  // orchestrator never attaches a microVM.
  const timeout = 10_000;
  const pollInterval = 1_000;
  const rootfsType = opts?.rootfsType ?? "claude";

  // client.new() doesn't forward rootfsType, so call run() directly (same logic as client.new())
  console.log(`[mags] newWorkspace '${name}': calling client.run (rootfs=${rootfsType})...`);
  const runStart = Date.now();
  // Persistent VM: materializes an exec-able microVM (status returns vm_id in ~5s).
  // `persistent: true` is REQUIRED for exec — non-persistent jobs never get a vm_id.
  //
  // noSync (cost saver): OMIT workspace_id → no JuiceFS/S3 sync, zero storage cost.
  // Only the friendly `name` is sent, so exec/findJob/stop still resolve the VM.
  // The filesystem is local-only and lost when the VM is reaped (acceptable — the
  // build is pushed to GitHub and re-scaffolds on a fresh VM).
  // idleMinutes plumbs the per-VM idle reaper (env __MAGS_IDLE_MIN ≈ CLI `-e <minutes>`).
  // When a memory size is requested we must select the rootfs via the ENVIRONMENT
  // passthrough (__MAGS_ROOTFS_TYPE) rather than the top-level `rootfsType` option.
  // The top-level option builds a per-(rootfs,mem) golden-snapshot tag like `pi:4g`,
  // which Mags hasn't provisioned ("golden snapshot not ready"). The env passthrough
  // boots the good base rootfs (node 22 + Pi preinstalled) and sets RAM at runtime —
  // verified live to yield a clean 4GB VM. Non-mem callers keep the legacy top-level
  // option (proven for the claude/agent rootfs).
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
  // Memory, rootfs (when sizing memory), and the idle reaper all ride the `environment`
  // map (what the Mags API sends under the hood: __MAGS_ROOTFS_TYPE / __MAGS_MEM_GB / __MAGS_IDLE_MIN).
  const environment: Record<string, string> = {};
  if (useEnvRootfs) environment.__MAGS_ROOTFS_TYPE = rootfsType;
  if (opts?.idleMinutes) environment.__MAGS_IDLE_MIN = String(opts.idleMinutes);
  if (opts?.keepAlive) environment.__MAGS_KEEP_ALIVE = "true";
  if (opts?.memGb) environment.__MAGS_MEM_GB = String(opts.memGb);
  if (Object.keys(environment).length) runOpts.environment = environment;
  const result = await client.run("sleep infinity", runOpts);
  const requestId = result.request_id as string;
  console.log(`[mags] newWorkspace '${name}': run accepted in ${Date.now() - runStart}ms (request_id=${requestId}), polling for running...`);

  // Poll until VM is running (mirrors client.new() polling)
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
 * Create a BIG persistent VM via the raw v2 API (bypasses the SDK). The SDK's
 * run() hard-caps memGb at 2/4 and never sends vcpus/memory_mb — so for larger
 * boxes (verified live: 4 vCPU / 8GB) we POST /api/v2/mags-jobs directly. Reuses
 * the SDK client for status/exec/etc. Resolves once the VM is running.
 */
export async function newWorkspaceV2(
  name: string,
  opts: { vcpus?: number; memoryMb?: number; diskGb?: number; keepAlive?: boolean; idleMinutes?: number } = {},
): Promise<{ jobId: string; workspaceId: string }> {
  const token = process.env.MAGS_API_TOKEN;
  if (!token) throw new Error("MAGS_API_TOKEN not set");
  const base = (process.env.MAGS_API_URL || "https://mags.run").replace(/\/+$/, "");

  const environment: Record<string, string> = {};
  if (opts.keepAlive) environment.__MAGS_KEEP_ALIVE = "true";
  if (opts.idleMinutes) environment.__MAGS_IDLE_MIN = String(opts.idleMinutes);

  const payload: Record<string, unknown> = {
    script: "sleep infinity",
    type: "inline",
    persistent: true,
    name,
    workspace_id: name,
    startup_command: "sleep infinity",
    vcpus: opts.vcpus ?? 4,
    memory_mb: opts.memoryMb ?? 8192,
  };
  if (opts.diskGb) payload.disk_gb = opts.diskGb;
  if (Object.keys(environment).length) payload.environment = environment;

  console.log(`[mags] newWorkspaceV2 '${name}': POST ${base}/api/v2/mags-jobs (vcpus=${payload.vcpus} mem=${payload.memory_mb}MB disk=${opts.diskGb ?? "-"})`);
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

  // Poll to running (reuse the SDK status; requestId is a UUID → resolved directly).
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
 * Uses client.exec() which handles SSH auth + chroot wrapping automatically.
 *
 * For multi-line scripts, pass them already base64-encoded:
 *   const b64 = btoa(script);
 *   await execOnWorkspace(name, `echo ${b64} | base64 -d | sh`);
 *
 * Retries up to 3 times on transient SSH connection failures.
 */
export async function execOnWorkspace(
  nameOrId: string,
  command: string,
  opts: { timeout?: number } = {}
): Promise<MagsExecResult> {
  const client = getClient();
  const timeout = opts.timeout ?? 300_000; // 5 min default

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(5000);

    try {
      const result = await client.exec(nameOrId, command, { timeout });
      return result as MagsExecResult;
    } catch (err) {
      lastError = err as Error;
      const msg = (lastError.message ?? "").toLowerCase();
      // Treat connection/SSH errors and timeouts as transient (VM may not have SSH ready yet)
      if (
        msg.includes("no running") ||
        msg.includes("no vm") ||
        msg.includes("connection refused") ||
        msg.includes("ssh") ||
        msg.includes("not running") ||
        msg.includes("no job found") ||
        msg.includes("timed out") ||
        msg.includes("timeout")
      ) {
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
 * Delegates to client.findJob() — no manual pagination needed.
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
 * Enable HTTP access for a VM and return the public proxy URL.
 * Uses client.url() which calls enableAccess + constructs the URL.
 */
/**
 * Normalize a Mags public URL to the live domain. The SDK/API still builds URLs on
 * the legacy `apps.magpiecloud.com` domain, which is dead — the live domain is
 * `apps.mags.run` (overridable via MAGS_APP_DOMAIN). The subdomain is correct, so we
 * only swap the suffix. Safe to call on already-correct or empty URLs.
 */
export function normalizeMagsAppUrl(url: string | null | undefined): string {
  const appDomain = process.env.MAGS_APP_DOMAIN || "apps.mags.run";
  return (url ?? "").replace(/\.apps\.magpiecloud\.com/i, `.${appDomain}`);
}

export async function enableHttpAccess(
  nameOrId: string,
  port = 8080
): Promise<string> {
  const client = getClient();
  const result = await client.url(nameOrId, port);
  const url = normalizeMagsAppUrl((result.url ?? result.proxy_url ?? "") as string);
  if (!url) throw new Error(`No URL returned for VM '${nameOrId}'`);
  return url;
}

/**
 * Point a STABLE subdomain alias at a workspace so the app's public URL stays the
 * same across VM reaps/restores (each VM otherwise gets a fresh random subdomain).
 * Re-points on every call (delete + recreate) since the target workspace changes
 * when a fresh VM is provisioned. Returns the stable https URL.
 * Requires HTTP access already enabled on the port (enableHttpAccess).
 */
export async function setStableUrl(
  subdomain: string,
  workspaceId: string,
): Promise<string> {
  const client = getClient();
  const appDomain = process.env.MAGS_APP_DOMAIN || "apps.mags.run";
  await client.urlAliasDelete(subdomain).catch(() => {}); // clear any stale mapping
  await client.urlAliasCreate(subdomain, workspaceId, appDomain);
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
 * Start an ephemeral Chromium browser session and return its CDP WebSocket
 * endpoint. Drive `wsEndpoint` with Playwright's `chromium.connectOverCDP()`.
 * Stop it with `stopWorkspace(requestId)` when done.
 *
 * IMPORTANT: connect with `wsEndpoint`, NOT the http/CDP URL. Chromium's
 * /json/version reports its socket as ws://localhost/... (DevTools rejects
 * non-localhost Host headers), so connectOverCDP(httpUrl) connects to the
 * CLIENT's localhost → ECONNREFUSED. wsEndpoint keeps the public host with only
 * the /devtools/browser/<id> path. (SDK ≥1.13.1 resolves this for us.)
 */
export async function startBrowserSession(opts?: {
  name?: string;
  timeout?: number;
}): Promise<{ requestId: string; wsEndpoint: string; cdpHttpUrl: string }> {
  const client = getClient();
  const r = await client.browser(opts ?? {});
  // SDK ≥1.13.1 returns wsEndpoint directly. Fallback (older 1.13.x): re-derive
  // it from /json/version, keeping the public host + the /devtools path.
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
 * `stop` only kills the VM; the workspace data lingers until deleted. Call this
 * when an instant app is removed so storage doesn't accumulate.
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
  // status() expects a request_id; resolve via findJob if given a name
  const jobId = nameOrId.includes("-") && nameOrId.length >= 32
    ? nameOrId
    : (await findJob(nameOrId))?.jobId ?? nameOrId;
  return client.status(jobId);
}

// ── Internal helpers ──────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
