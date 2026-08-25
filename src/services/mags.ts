/**
 * Sandbox facade.
 *
 * Historically this file wrapped the Magpie Cloud SDK directly; the rest of the
 * app imports its functions (execOnWorkspace, newWorkspace, …) from here. It is
 * now a thin selector over two interchangeable backends:
 *
 *   SANDBOX_BACKEND=mags   → ./sandbox/mags-backend.ts   (hosted Firecracker VMs)
 *   SANDBOX_BACKEND=docker → ./sandbox/docker-backend.ts (local Docker containers)
 *
 * The exported surface is identical either way, so callers are backend-agnostic.
 * The filename is kept as mags.ts to avoid churning ~18 import sites.
 */

import { env } from "../config/env.ts";
import * as magsBackend from "./sandbox/mags-backend.ts";
import * as dockerBackend from "./sandbox/docker-backend.ts";
import type { SandboxBackend, SandboxExecResult } from "./sandbox/types.ts";

/** Legacy alias kept for existing imports (`import { type MagsExecResult }`). */
export type MagsExecResult = SandboxExecResult;

const useDocker = env.SANDBOX_BACKEND === "docker";
const backend: SandboxBackend = useDocker ? dockerBackend : magsBackend;

console.log(`[sandbox] backend = ${env.SANDBOX_BACKEND}`);

export const newWorkspace = backend.newWorkspace;
export const newWorkspaceV2 = backend.newWorkspaceV2;
export const execOnWorkspace = backend.execOnWorkspace;
export const findJob = backend.findJob;
export const enableHttpAccess = backend.enableHttpAccess;
export const setStableUrl = backend.setStableUrl;
export const stopWorkspace = backend.stopWorkspace;
export const setNoSleep = backend.setNoSleep;
export const startBrowserSession = backend.startBrowserSession;
export const deleteWorkspace = backend.deleteWorkspace;
export const getJobStatus = backend.getJobStatus;

// URL normalization differs per backend (Mags rewrites its cloud subdomain; the
// docker backend already returns localhost URLs). Both export it.
export const normalizeMagsAppUrl = useDocker
  ? dockerBackend.normalizeMagsAppUrl
  : magsBackend.normalizeMagsAppUrl;

/**
 * Pull a sandbox's clock into line with ours.
 *
 * These microVMs resume from snapshots without an NTP client, so their clocks drift —
 * and a clock that is BEHIND breaks TLS in a way that reads like anything but a clock
 * problem: `npm error code CERT_NOT_YET_VALID … certificate is not yet valid` on a
 * perfectly valid registry cert, and identical failures on any git fetch or token
 * refresh over HTTPS. (Seen in the wild 13 days behind, which broke the OpenAI Codex
 * connect flow entirely.)
 *
 * Cheap, idempotent, and a no-op inside a couple of minutes of tolerance. Best-effort:
 * an unwritable clock (unprivileged container) resolves quietly rather than failing the
 * caller — the caller's real work still gets its chance.
 */
export async function syncWorkspaceClock(workspaceId: string): Promise<{ skewSeconds: number; corrected: boolean }> {
  const now = new Date();
  const epoch = Math.floor(now.getTime() / 1000);
  const iso = now.toISOString().slice(0, 19).replace("T", " ");   // "2026-08-25 17:49:12"
  const p = (n: number) => String(n).padStart(2, "0");
  // Legacy set-format understood by busybox and coreutils alike: MMDDhhmmYYYY.ss
  const legacy = `${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}${now.getUTCFullYear()}.${p(now.getUTCSeconds())}`;
  const script = `
NOW=${epoch}
CUR=$(date -u +%s 2>/dev/null || echo 0)
DIFF=$((NOW - CUR)); [ "$DIFF" -lt 0 ] && DIFF=$((0 - DIFF))
if [ "$DIFF" -gt 120 ]; then
  date -u -s "@$NOW" >/dev/null 2>&1 \\
    || date -u -s "${iso}" >/dev/null 2>&1 \\
    || date -u "${legacy}" >/dev/null 2>&1 \\
    || true
  hwclock -w >/dev/null 2>&1 || true
  NEWDIFF=$((NOW - $(date -u +%s 2>/dev/null || echo 0))); [ "$NEWDIFF" -lt 0 ] && NEWDIFF=$((0 - NEWDIFF))
  if [ "$NEWDIFF" -le 120 ]; then echo "CLOCK_FIXED:$DIFF"; else echo "CLOCK_STUCK:$DIFF"; fi
else
  echo "CLOCK_OK:$DIFF"
fi`;
  try {
    const b64 = Buffer.from(script).toString("base64");
    const r = await execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | sh`, { timeout: 20_000 });
    const m = (r.output ?? "").match(/CLOCK_(FIXED|STUCK|OK):(-?\d+)/);
    const skewSeconds = m ? Math.abs(parseInt(m[2]!, 10)) : 0;
    if (m?.[1] === "FIXED") {
      console.log(`[sandbox] ${workspaceId}: clock was ${skewSeconds}s off — corrected`);
      return { skewSeconds, corrected: true };
    }
    if (m?.[1] === "STUCK") {
      console.warn(`[sandbox] ${workspaceId}: clock is ${skewSeconds}s off and would not set — TLS may fail`);
    }
    return { skewSeconds, corrected: false };
  } catch {
    return { skewSeconds: 0, corrected: false };
  }
}
