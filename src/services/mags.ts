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
export const startBrowserSession = backend.startBrowserSession;
export const deleteWorkspace = backend.deleteWorkspace;
export const getJobStatus = backend.getJobStatus;

// URL normalization differs per backend (Mags rewrites its cloud subdomain; the
// docker backend already returns localhost URLs). Both export it.
export const normalizeMagsAppUrl = useDocker
  ? dockerBackend.normalizeMagsAppUrl
  : magsBackend.normalizeMagsAppUrl;
