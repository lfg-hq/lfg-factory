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

export const RUNNER_PROTOCOL_VERSION = 2;

/** The coding agents a computer can run, headless. */
export const AGENT_KINDS = ["claude", "codex", "copilot"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AGENT_LABELS: Record<AgentKind, string> = { claude: "Claude Code", codex: "OpenAI Codex", copilot: "GitHub Copilot" };
export const isAgentKind = (v: unknown): v is AgentKind => typeof v === "string" && (AGENT_KINDS as readonly string[]).includes(v);

/**
 * What any agent CLI did, in one shape (each CLI's own output format is translated on the
 * computer, see desktop/src/agents.ts).
 */
export type AgentEvent =
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; input?: Record<string, unknown>; summary?: string }
  | { type: "tool_result"; id: string; output: string; isError?: boolean }
  | { type: "result"; text?: string; isError?: boolean; usage?: { inputTokens?: number; outputTokens?: number } };

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
  /** Which agent runs it. Absent (protocol 1): Claude Code. */
  agent?: AgentKind;
  /** Continue this agent session (a follow-up on the same ticket). */
  sessionId?: string;
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
  | { type: "hello"; appVersion?: string; platform?: string; claudeVersion?: string | null; activeJobIds?: string[];
      /** Agents installed on this computer, with their versions (protocol 2). */
      agents?: Array<{ kind: AgentKind; version: string }> }
  | { type: "job.accepted"; jobId: string }
  | { type: "job.rejected"; jobId: string; reason?: string }
  /** A short human status line from the runner itself (cloning, pushing…). */
  | { type: "job.progress"; jobId: string; text: string }
  /** One Claude Code `--output-format stream-json` event, passed through as-is (protocol 1). */
  | { type: "job.agent_event"; jobId: string; event: Record<string, unknown> }
  /** One normalized agent event, from any agent (protocol 2). */
  | { type: "job.event"; jobId: string; event: AgentEvent }
  | { type: "job.finished"; jobId: string; ok: boolean; branch?: string; commitSha?: string | null; summary?: string; error?: string }
  | { type: "pong" };
