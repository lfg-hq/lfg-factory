/**
 * Wire protocol between the LFG server and LFG Desktop runners.
 *
 * The runner connects OUT to `/ws/runner` with `Authorization: Bearer <device token>`.
 * The server only ever offers whole jobs of a known type. It never sends shell
 * commands, so a compromised server cannot run arbitrary code on a laptop; the
 * runner decides how to carry out a job and the person can decline it.
 *
 * desktop/src/protocol.ts is a copy of this file. Keep the two in sync and bump
 * RUNNER_PROTOCOL_VERSION on any incompatible change.
 */

export const RUNNER_PROTOCOL_VERSION = 3;

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
  | { type: "result"; text?: string; isError?: boolean; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }
  /** The agent condensed its own conversation to fit its context (Claude Code's auto-compact). */
  | { type: "compacted"; trigger?: string; preTokens?: number }
  /** The person's plan limits as the agent last saw them (Claude Code reports these each turn). */
  | { type: "limits"; windows: AgentLimitWindow[] };

/** One usage window of the person's plan: utilization 0–1, resetsAt in epoch seconds. */
export interface AgentLimitWindow { kind: string; utilization?: number; resetsAt?: number; status?: string }

/** Effort levels the agents understand (Claude Code takes all; Codex low/medium/high). */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export const isAgentEffort = (v: unknown): v is AgentEffort => typeof v === "string" && (AGENT_EFFORTS as readonly string[]).includes(v);
/** A model name an agent CLI accepts: an alias (opus, sonnet…) or a full id. Nothing that could be a flag. */
export const isAgentModel = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/.test(v);

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
  /** Model and effort for the agent (absent: the agent's own default). */
  model?: string;
  effort?: AgentEffort;
  /** A ticket build (not a ticket-chat follow-up): its finish advances any build run. Server-side only. */
  build?: boolean;
}

/** One chat turn answered by the agent on the person's computer (no repo, no git). */
export interface ChatTurnPayload {
  protocol: number;
  agent: AgentKind;
  conversationId: string;
  /** The person's message, plus the conversation so far when there's no session to resume. */
  prompt: string;
  /** LFG's instructions for the assistant (the chat's system prompt). */
  instructions: string;
  /** Continue this agent session (later turns of the same conversation). */
  sessionId?: string;
  /** The prompt to use instead when that session can't be continued here: carries the conversation so far. */
  freshPrompt?: string;
  /** "replace": LFG's instructions are the whole system prompt (chat), not an addition to the agent's own. */
  instructionsMode?: "replace" | "append";
  model?: string;
  effort?: AgentEffort;
  /** LFG's MCP server for this turn: the agent reads and writes LFG's data through it. */
  mcp: { url: string; token: string };
}

/** The app's own commands for running a preview, from its saved preview plan. */
export interface PreviewPlan {
  stack?: string;
  installCmd?: string;
  buildCmd?: string;
  /** Starts the main app in the foreground on `port`. */
  runCmd: string;
  port: number;
  /** Extra apps in the same repo that are switched on (the main one is runCmd/port). */
  services?: Array<{ name: string; runCmd: string; buildCmd?: string; port: number; dir?: string }>;
  /** Databases the app connects to, and the variable it reads each connection from. */
  databases: Array<{ engine: "postgres" | "mysql" | "redis" | "mssql"; connectionEnvVar: string; connectionFormat: string; databaseName?: string }>;
  migrations?: string[];
  seedCmd?: string;
}

/** Run the project's app on the person's computer (protocol 3). */
export interface PreviewPayload {
  protocol: number;
  /** The project's public id: names this preview's folder on the computer. */
  projectId: string;
  projectName: string;
  repoUrl: string;
  /** Branch to run; null runs the repository's default branch. */
  branch: string | null;
  /** What the person picked, e.g. "REC-23 — SDR backend". */
  label: string;
  /** Fetch the latest code and install again (Update & rebuild), rather than reuse what's there. */
  refresh: boolean;
  /** null: LFG has no saved plan yet, so the computer works one out from the repository. */
  plan: PreviewPlan | null;
  /** The project's environment variables (the person can already read them on the Env tab). */
  env: Record<string, string>;
}

export type PreviewPhase = "detecting" | "provisioning" | "installing" | "seeding" | "starting" | "running" | "error" | "stopped";
export type PreviewStepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export interface PreviewStep { id: string; label: string; status: PreviewStepStatus; command?: string }
export interface PreviewUrl { name: string; url: string; port: number; primary?: boolean }

/** What a preview on the computer reports back, any field optional. */
export interface PreviewUpdate {
  status?: PreviewPhase;
  steps?: PreviewStep[];
  /** New setup / app log lines. */
  lines?: string[];
  urls?: PreviewUrl[];
  error?: string;
}

export type RunnerJobOffer =
  | { id: string; type: "claude_task"; payload: ClaudeTaskPayload }
  | { id: string; type: "chat_turn"; payload: ChatTurnPayload }
  | { id: string; type: "preview"; payload: PreviewPayload };

export type ServerToRunner =
  | { type: "welcome"; deviceId: string; deviceName: string; protocol: number }
  | { type: "job.offer"; job: RunnerJobOffer }
  | { type: "job.cancel"; jobId: string }
  | { type: "ping" }
  | { type: "error"; message: string };

export type RunnerToServer =
  | { type: "hello"; appVersion?: string; platform?: string; claudeVersion?: string | null; activeJobIds?: string[];
      /** Agents installed on this computer, with their versions (protocol 2). */
      agents?: Array<{ kind: AgentKind; version: string }>;
      /** The protocol this runner speaks (protocol 3 and later; absent means 2). */
      protocol?: number }
  | { type: "job.accepted"; jobId: string }
  | { type: "job.rejected"; jobId: string; reason?: string }
  /** A short human status line from the runner itself (cloning, pushing…). */
  | { type: "job.progress"; jobId: string; text: string }
  /** One Claude Code `--output-format stream-json` event, passed through as-is (protocol 1). */
  | { type: "job.agent_event"; jobId: string; event: Record<string, unknown> }
  /** One normalized agent event, from any agent (protocol 2). */
  | { type: "job.event"; jobId: string; event: AgentEvent }
  /** A preview's progress, log lines and local address (protocol 3). */
  | { type: "job.preview"; jobId: string; update: PreviewUpdate }
  | { type: "job.finished"; jobId: string; ok: boolean; branch?: string; commitSha?: string | null; summary?: string; error?: string; sessionId?: string }
  | { type: "pong" };
