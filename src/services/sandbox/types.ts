/**
 * Sandbox backend contract.
 *
 * A "sandbox" is an isolated workspace where AI-generated code is built and run
 * (Instant apps + ticket execution). Two backends implement this interface:
 *   - mags-backend.ts   → Magpie Cloud Firecracker micro-VMs (hosted)
 *   - docker-backend.ts → local Docker containers (self-hosted)
 *
 * src/services/mags.ts is the facade that picks one based on SANDBOX_BACKEND and
 * re-exports these functions under the names the rest of the app already imports.
 */

export interface SandboxExecResult {
  exitCode: number;
  output: string;
  stderr: string;
}

export interface NewWorkspaceOpts {
  baseWorkspaceId?: string;
  rootfsType?: string;
  startupCommand?: string;
  noSync?: boolean;
  idleMinutes?: number;
  keepAlive?: boolean;
  diskGb?: number;
  memGb?: number;
}

export interface NewWorkspaceV2Opts {
  vcpus?: number;
  memoryMb?: number;
  diskGb?: number;
  keepAlive?: boolean;
  idleMinutes?: number;
  rootfsType?: string;
  noSync?: boolean;
  startupCommand?: string;
}

export interface WorkspaceRef {
  jobId: string;
  workspaceId: string;
}

export interface JobInfo {
  jobId: string;
  workspaceId: string;
  status: string;
}

export interface JobStatus {
  status: string;
  exit_code?: number;
  workspace_id?: string;
  [key: string]: unknown;
}

export interface BrowserSession {
  requestId: string;
  wsEndpoint: string;
  cdpHttpUrl: string;
}

export interface SandboxBackend {
  newWorkspace(name: string, opts?: NewWorkspaceOpts): Promise<WorkspaceRef>;
  newWorkspaceV2(name: string, opts?: NewWorkspaceV2Opts): Promise<WorkspaceRef>;
  execOnWorkspace(
    nameOrId: string,
    command: string,
    opts?: { timeout?: number }
  ): Promise<SandboxExecResult>;
  findJob(nameOrId: string): Promise<JobInfo | null>;
  enableHttpAccess(nameOrId: string, port?: number): Promise<string>;
  setStableUrl(subdomain: string, workspaceId: string, port?: number): Promise<string>;
  stopWorkspace(nameOrId: string): Promise<void>;
  /** Toggle auto-sleep at runtime (no-op on backends without a sleep concept). */
  setNoSleep(nameOrId: string, noSleep: boolean): Promise<void>;
  startBrowserSession(opts?: { name?: string; timeout?: number }): Promise<BrowserSession>;
  deleteWorkspace(name: string): Promise<void>;
  getJobStatus(nameOrId: string): Promise<JobStatus>;
}
