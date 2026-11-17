/**
 * Headless coding agents on this computer: Claude Code, OpenAI Codex CLI and GitHub
 * Copilot CLI. Each adapter builds the command line for a non-interactive run and
 * translates that CLI's JSON output into the shared AgentEvent shape (protocol.ts), so
 * the rest of the runner and the server never deal with three formats.
 *
 * Every agent runs with the person's own login on this computer. Nothing here handles
 * their credentials. An LFG MCP server (url + bearer token for one turn) can be attached
 * so the agent reads and writes LFG's data (documents, tickets) through LFG's own tools.
 *
 * Verified against real output: Claude Code. Codex follows its documented `codex exec
 * --json` events; Copilot's JSON output isn't documented, so it's parsed defensively.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { AGENT_KINDS, type AgentEffort, type AgentEvent, type AgentKind, type AgentLimitWindow } from "./protocol.ts";

export interface AgentRunInput {
  prompt: string;
  /** Standing instructions (LFG's assistant prompt). */
  instructions?: string;
  /** "replace": the instructions are the whole system prompt, where the CLI allows it (Claude Code). */
  instructionsMode?: "replace" | "append";
  /** Model alias or id, and effort level; absent: the CLI's own default. */
  model?: string;
  effort?: AgentEffort;
  /** Answer and use LFG's tools only: no edits or shell commands on this computer. */
  readOnly?: boolean;
  cwd: string;
  /** Resume this agent's earlier session (Claude Code, Codex). */
  sessionId?: string;
  /** LFG's MCP server for this turn. */
  mcp?: { url: string; token: string };
  /** Claude Code tool allow-list (other agents use their own sandbox settings). */
  allowedTools?: string[];
  maxTurns?: number;
}

export interface AgentInvocation {
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

/** Translates one line of a CLI's stdout. Keeps whatever state that CLI's format needs. */
export type LineParser = (line: string) => AgentEvent[];

export interface AgentAdapter {
  kind: AgentKind;
  label: string;
  bin: string;
  invocation(input: AgentRunInput): AgentInvocation;
  parser(): LineParser;
}

const asText = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.map(b => (typeof b === "string" ? b : (b as { text?: string })?.text ?? "")).join("\n") : v == null ? "" : JSON.stringify(v);

// ── Claude Code ──────────────────────────────────────────────────────

const claude: AgentAdapter = {
  kind: "claude", label: "Claude Code", bin: "claude",
  invocation(i) {
    const tools = [...(i.readOnly ? ["Read", "Glob", "Grep", "WebSearch", "WebFetch"] : i.allowedTools ?? []), ...(i.mcp ? ["mcp__lfg"] : [])];
    return {
      bin: "claude",
      args: [
        "-p", i.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", i.readOnly ? "default" : "acceptEdits",
        ...(i.instructions ? [i.instructionsMode === "replace" ? "--system-prompt" : "--append-system-prompt", i.instructions] : []),
        ...(i.model ? ["--model", i.model] : []),
        ...(i.effort ? ["--effort", i.effort] : []),
        ...(tools.length ? ["--allowedTools", tools.join(",")] : []),
        ...(i.maxTurns ? ["--max-turns", String(i.maxTurns)] : []),
        ...(i.sessionId ? ["--resume", i.sessionId] : []),
        ...(i.mcp ? ["--mcp-config", JSON.stringify({ mcpServers: { lfg: { type: "http", url: i.mcp.url, headers: { Authorization: `Bearer ${i.mcp.token}` } } } })] : []),
      ],
      // LFG's tools can wait on the person (askUser), so give MCP calls room.
      env: i.mcp ? { MCP_TOOL_TIMEOUT: String(30 * 60_000) } : undefined,
    };
  },
  parser() {
    return (line) => {
      const e = JSON.parse(line) as Record<string, any>;
      const out: AgentEvent[] = [];
      if (e.type === "system" && e.subtype === "init" && typeof e.session_id === "string") out.push({ type: "session", id: e.session_id });
      if (e.type === "system" && e.subtype === "compact_boundary") {
        const meta = e.compact_metadata ?? {};
        out.push({ type: "compacted", trigger: typeof meta.trigger === "string" ? meta.trigger : undefined, preTokens: typeof meta.pre_tokens === "number" ? meta.pre_tokens : undefined });
      }
      if (e.type === "rate_limit_event" && e.rate_limit_info) {
        const windows = claudeLimitWindows(e.rate_limit_info);
        if (windows.length) out.push({ type: "limits", windows });
      }
      const blocks: any[] = Array.isArray(e.message?.content) ? e.message.content : [];
      if (e.type === "assistant") {
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ type: "text", text: b.text });
          if (b.type === "tool_use" && typeof b.name === "string") out.push({ type: "tool_start", id: String(b.id ?? ""), name: b.name, input: b.input ?? {} });
        }
      } else if (e.type === "user") {
        for (const b of blocks) {
          if (b.type === "tool_result") out.push({ type: "tool_result", id: String(b.tool_use_id ?? ""), output: asText(b.content), isError: !!b.is_error });
        }
      } else if (e.type === "result") {
        out.push({
          type: "result", isError: !!e.is_error, text: typeof e.result === "string" ? e.result : e.subtype,
          usage: e.usage ? {
            inputTokens: (e.usage.input_tokens ?? 0) + (e.usage.cache_read_input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0),
            outputTokens: e.usage.output_tokens,
            costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined,
          } : undefined,
        });
      }
      return out;
    };
  },
};

/** Claude Code's rate_limit_event → plan windows (five_hour, seven_day, …). */
export function claudeLimitWindows(info: Record<string, any>): AgentLimitWindow[] {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const windows = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows as Record<string, any> : null;
  if (windows) {
    return Object.entries(windows).filter(([, w]) => w && typeof w === "object")
      .map(([kind, w]) => ({ kind: kind.slice(0, 40), utilization: num(w.utilization), resetsAt: num(w.resetsAt), status: typeof w.status === "string" ? w.status.slice(0, 40) : undefined }));
  }
  return typeof info.rateLimitType === "string"
    ? [{ kind: info.rateLimitType.slice(0, 40), utilization: num(info.utilization), resetsAt: num(info.resetsAt), status: typeof info.status === "string" ? info.status.slice(0, 40) : undefined }]
    : [];
}

// ── OpenAI Codex CLI ─────────────────────────────────────────────────

const codex: AgentAdapter = {
  kind: "codex", label: "OpenAI Codex", bin: "codex",
  invocation(i) {
    const mcp = i.mcp ? ["-c", `mcp_servers.lfg.url=${JSON.stringify(i.mcp.url)}`, "-c", `mcp_servers.lfg.bearer_token_env_var="LFG_MCP_TOKEN"`, "-c", "mcp_servers.lfg.tool_timeout_sec=1800"] : [];
    const effort = i.effort ? (i.effort === "xhigh" || i.effort === "max" ? "high" : i.effort) : undefined;
    const common = ["--json", "--sandbox", i.readOnly ? "read-only" : "workspace-write", "--skip-git-repo-check", ...mcp,
      ...(i.model ? ["-m", i.model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
    // No system-prompt flag: instructions lead the first message; a resumed session has them.
    const prompt = i.instructions && !i.sessionId ? `${i.instructions}\n\n---\n\n${i.prompt}` : i.prompt;
    return {
      bin: "codex",
      args: i.sessionId ? ["exec", ...common, "resume", i.sessionId, prompt] : ["exec", ...common, prompt],
      env: i.mcp ? { LFG_MCP_TOKEN: i.mcp.token } : undefined,
    };
  },
  parser() {
    return (line) => {
      const e = JSON.parse(line) as Record<string, any>;
      const item = e.item as Record<string, any> | undefined;
      switch (e.type) {
        case "thread.started": return typeof e.thread_id === "string" ? [{ type: "session", id: e.thread_id }] : [];
        case "turn.completed": return [{ type: "result", usage: e.usage ? { inputTokens: e.usage.input_tokens, outputTokens: e.usage.output_tokens } : undefined }];
        case "turn.failed": return [{ type: "result", isError: true, text: asText(e.error?.message ?? e.error) }];
        case "error": return [{ type: "result", isError: true, text: asText(e.message ?? e.error) }];
      }
      if (!item || typeof item.type !== "string") return [];
      const id = String(item.id ?? "");
      if (e.type === "item.started") {
        if (item.type === "command_execution") return [{ type: "tool_start", id, name: "Bash", input: { command: item.command }, summary: String(item.command ?? "") }];
        if (item.type === "mcp_tool_call") return [{ type: "tool_start", id, name: `mcp__${item.server ?? "mcp"}__${item.tool ?? "tool"}`, input: item.arguments ?? {} }];
        return [];
      }
      if (e.type !== "item.completed") return [];
      switch (item.type) {
        case "agent_message": return item.text ? [{ type: "text", text: String(item.text) }] : [];
        case "command_execution": return [{ type: "tool_result", id, output: asText(item.aggregated_output ?? item.output ?? ""), isError: typeof item.exit_code === "number" && item.exit_code !== 0 }];
        case "mcp_tool_call": return [{ type: "tool_result", id, output: asText(item.result?.content ?? item.result ?? item.error ?? ""), isError: !!item.error }];
        case "file_change": {
          const files = Array.isArray(item.changes) ? item.changes.map((c: any) => c.path).filter(Boolean) : [];
          return [{ type: "tool_start", id, name: "Edit", input: { files }, summary: `Edited ${files.join(", ") || "files"}` }, { type: "tool_result", id, output: files.join("\n") }];
        }
        default: return [];
      }
    };
  },
};

// ── GitHub Copilot CLI ───────────────────────────────────────────────

const copilot: AgentAdapter = {
  kind: "copilot", label: "GitHub Copilot", bin: "copilot",
  invocation(i) {
    return {
      bin: "copilot",
      args: [
        "-p", i.instructions ? `${i.instructions}\n\n---\n\n${i.prompt}` : i.prompt, "--allow-all-tools", "--no-ask-user", "--output-format", "json",
        ...(i.readOnly ? ["--deny-tool", "shell", "--deny-tool", "write"] : []),
        ...(i.mcp ? ["--additional-mcp-config", JSON.stringify({ mcpServers: { lfg: { type: "http", url: i.mcp.url, headers: { Authorization: `Bearer ${i.mcp.token}` }, tools: ["*"] } } })] : []),
      ],
    };
  },
  parser() {
    // The JSONL schema isn't documented: take what looks like assistant text or tool use,
    // and treat a non-JSON line as text.
    return (line) => {
      let e: Record<string, any>;
      try { e = JSON.parse(line); } catch { return line.trim() ? [{ type: "text", text: line }] : []; }
      const type = String(e.type ?? e.event ?? "").toLowerCase();
      const data = (e.data && typeof e.data === "object" ? e.data : e) as Record<string, any>;
      if (/session/.test(type) && typeof (data.sessionId ?? data.session_id) === "string") return [{ type: "session", id: data.sessionId ?? data.session_id }];
      if (/tool/.test(type) && /(start|call|request)/.test(type)) {
        return [{ type: "tool_start", id: String(data.toolCallId ?? data.id ?? ""), name: String(data.toolName ?? data.name ?? "tool"), input: data.arguments ?? data.input ?? {} }];
      }
      if (/tool/.test(type) && /(result|complete|end)/.test(type)) {
        return [{ type: "tool_result", id: String(data.toolCallId ?? data.id ?? ""), output: asText(data.result ?? data.output ?? ""), isError: !!data.error }];
      }
      if (/(error|fail)/.test(type)) return [{ type: "result", isError: true, text: asText(data.message ?? data.error) }];
      if (/(result|complete|done|end)$/.test(type) && !/message/.test(type)) return [{ type: "result", text: asText(data.result ?? data.content ?? "") || undefined }];
      const text = data.content ?? data.text ?? data.message;
      if (/(assistant|message|response)/.test(type) && typeof text === "string" && text.trim()) return [{ type: "text", text }];
      return [];
    };
  },
};

export const AGENTS: Record<AgentKind, AgentAdapter> = { claude, codex, copilot };

// ── Running ──────────────────────────────────────────────────────────

/** Which agents are installed here, with versions. A missing or broken CLI is left out. */
export async function detectAgents(env: NodeJS.ProcessEnv, bins: Partial<Record<AgentKind, string>> = {}): Promise<Array<{ kind: AgentKind; version: string }>> {
  const found = await Promise.all(AGENT_KINDS.map(kind => new Promise<{ kind: AgentKind; version: string } | null>((resolve) => {
    let out = "";
    let child: ChildProcess;
    try { child = spawn(bins[kind] ?? AGENTS[kind].bin, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 10_000);
    child.stdout!.on("data", d => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", code => { clearTimeout(timer); resolve(code === 0 && out.trim() ? { kind, version: out.trim().split("\n")[0]!.slice(0, 80) } : null); });
  })));
  return found.filter((a): a is { kind: AgentKind; version: string } => !!a);
}

export interface AgentRunOptions extends AgentRunInput {
  env: NodeJS.ProcessEnv;
  /** Override the executable (tests, or a CLI outside PATH). */
  bin?: string;
  onEvent(event: AgentEvent): void;
  /** Receives the child so it can be cancelled. */
  onSpawn?(child: ChildProcess): void;
}

/** Runs one headless agent turn to completion. Resolves with the session id and final text. */
export function runAgent(kind: AgentKind, opts: AgentRunOptions): Promise<{ sessionId?: string; summary?: string }> {
  const adapter = AGENTS[kind];
  const call = adapter.invocation(opts);
  const parse = adapter.parser();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawn(opts.bin ?? call.bin, call.args, { cwd: opts.cwd, env: { ...opts.env, ...call.env }, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { reject(missing(adapter, e)); return; }
    opts.onSpawn?.(child);
    let buffer = "", stderr = "", sessionId: string | undefined, summary: string | undefined, failure: string | undefined, lastText: string | undefined;
    const handle = (line: string) => {
      let events: AgentEvent[] = [];
      try { events = parse(line); } catch { return; } // not JSON from a JSON-only CLI
      for (const event of events) {
        if (event.type === "session") sessionId = event.id;
        if (event.type === "text") lastText = event.text;
        if (event.type === "result") { if (event.isError) failure = event.text || `${adapter.label} reported an error`; else summary = event.text || lastText; }
        opts.onEvent(event);
      }
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(line);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", e => reject(missing(adapter, e)));
    child.on("close", (code, signal) => {
      if (buffer.trim()) handle(buffer.trim());
      if (signal) { reject(new Error("Cancelled")); return; }
      if (failure) { reject(new Error(failure)); return; }
      if (code !== 0) {
        const hint = /log ?in|auth|credential|401|unauthor/i.test(stderr) ? ` Open a terminal and sign in to ${adapter.label} (run \`${adapter.bin}\`).` : "";
        reject(new Error(`${adapter.label} exited with code ${code}.${hint} ${stderr.trim().slice(-800)}`.trim()));
        return;
      }
      resolve({ sessionId, summary: summary ?? lastText });
    });
  });
}

function missing(adapter: AgentAdapter, e: unknown): Error {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT"
    ? new Error(`${adapter.label} isn't installed on this computer. Install it, run \`${adapter.bin}\` once to sign in, then try again.`)
    : e instanceof Error ? e : new Error(String(e));
}
