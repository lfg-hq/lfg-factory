/**
 * Wire protocol between the LFG server and LFG Desktop runners.
 *
 * The runner connects OUT to `/ws/runner` with `Authorization: Bearer <device token>`.
 * The server only ever offers whole jobs of a known type. It never sends shell
 * commands, so a compromised server cannot run arbitrary code on a laptop; the
 * runner decides how to carry out a job and the person can decline it.
 *
 * This is a copy of src/services/runner/protocol.ts on the server. Keep the two in sync and bump
 * RUNNER_PROTOCOL_VERSION on any incompatible change.
 */

export const RUNNER_PROTOCOL_VERSION = 1;

export interface ClaudeTaskPayload {
  protocol: number;
  projectName: string;
  ticketKey: string | null;
  ticketTitle: string;
  /** Clone URL. The runner uses the person's own Git credentials, never a server token. */
  repoUrl: string;
  /** Branch the work lands on (created if missing, pushed when done). */
  branch: string;
  /** Branches to cut a new `branch` from, first that exists on the remote wins. */
  startFrom: string[];
  prompt: string;
  commitMessage: string;
  /** Suggested Claude Code tools. The runner intersects these with its own allow-list. */
  allowedTools?: string[];
  maxTurns?: number;
}

export interface RunnerJobOffer {
  id: string;
  type: "claude_task";
  payload: ClaudeTaskPayload;
}

export type ServerToRunner =
  | { type: "welcome"; deviceId: string; deviceName: string; protocol: number }
  | { type: "job.offer"; job: RunnerJobOffer }
  | { type: "job.cancel"; jobId: string }
  | { type: "ping" }
  | { type: "error"; message: string };

export type RunnerToServer =
  | { type: "hello"; appVersion?: string; platform?: string; claudeVersion?: string | null; activeJobIds?: string[] }
  | { type: "job.accepted"; jobId: string }
  | { type: "job.rejected"; jobId: string; reason?: string }
  /** A short human status line from the runner itself (cloning, pushing…). */
  | { type: "job.progress"; jobId: string; text: string }
  /** One Claude Code `--output-format stream-json` event, passed through as-is. */
  | { type: "job.agent_event"; jobId: string; event: Record<string, unknown> }
  | { type: "job.finished"; jobId: string; ok: boolean; branch?: string; commitSha?: string | null; summary?: string; error?: string }
  | { type: "pong" };
