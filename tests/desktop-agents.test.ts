// LFG Desktop agent adapters: each CLI's headless output becomes the same AgentEvent stream.
import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, detectAgents, runAgent } from "../desktop/src/agents.ts";
import type { AgentEvent } from "../desktop/src/protocol.ts";

const parseAll = (kind: keyof typeof AGENTS, lines: unknown[]) => {
  const parse = AGENTS[kind].parser();
  return lines.flatMap(l => parse(typeof l === "string" ? l : JSON.stringify(l)));
};

test("Claude Code stream-json", () => {
  const events = parseAll("claude", [
    { type: "system", subtype: "init", session_id: "s-1" },
    { type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "12 passing" }] }] } },
    { type: "result", subtype: "success", is_error: false, result: "Done.", usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  expect(events).toEqual([
    { type: "session", id: "s-1" },
    { type: "text", text: "Looking." },
    { type: "tool_start", id: "t1", name: "Bash", input: { command: "npm test" } },
    { type: "tool_result", id: "t1", output: "12 passing", isError: false },
    { type: "result", isError: false, text: "Done.", usage: { inputTokens: 10, outputTokens: 5 } },
  ]);
});

test("Codex exec --json (documented events)", () => {
  const events = parseAll("codex", [
    { type: "thread.started", thread_id: "th-9" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", aggregated_output: "README.md\n", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "index.html", kind: "update" }] } },
    { type: "item.started", item: { id: "item_3", type: "mcp_tool_call", server: "lfg", tool: "createTickets", arguments: { tickets: [] } } },
    { type: "item.completed", item: { id: "item_3", type: "mcp_tool_call", server: "lfg", tool: "createTickets", result: { content: [{ type: "text", text: "Created 2 tickets" }] } } },
    { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "Added dark mode." } },
    { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
  ]);
  expect(events).toEqual([
    { type: "session", id: "th-9" },
    { type: "tool_start", id: "item_1", name: "Bash", input: { command: "bash -lc ls" }, summary: "bash -lc ls" },
    { type: "tool_result", id: "item_1", output: "README.md\n", isError: false },
    { type: "tool_start", id: "item_2", name: "Edit", input: { files: ["index.html"] }, summary: "Edited index.html" },
    { type: "tool_result", id: "item_2", output: "index.html" },
    { type: "tool_start", id: "item_3", name: "mcp__lfg__createTickets", input: { tickets: [] } },
    { type: "tool_result", id: "item_3", output: "Created 2 tickets", isError: false },
    { type: "text", text: "Added dark mode." },
    { type: "result", usage: { inputTokens: 100, outputTokens: 20 } },
  ]);
  expect(parseAll("codex", [{ type: "turn.failed", error: { message: "rate limited" } }])).toEqual([{ type: "result", isError: true, text: "rate limited" }]);
});

test("Copilot CLI output is read defensively", () => {
  const events = parseAll("copilot", [
    { type: "assistant.message", data: { content: "Here's the plan." } },
    { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "shell", arguments: { command: "ls" } } },
    { type: "tool.execution_complete", data: { toolCallId: "c1", result: "a.txt" } },
    { type: "something.unknown", data: {} },
    "plain text line",
  ]);
  expect(events).toEqual([
    { type: "text", text: "Here's the plan." },
    { type: "tool_start", id: "c1", name: "shell", input: { command: "ls" } },
    { type: "tool_result", id: "c1", output: "a.txt", isError: false },
    { type: "text", text: "plain text line" },
  ]);
});

test("command lines: MCP attached, resume, no credentials", () => {
  const mcp = { url: "https://lfg.run/mcp/turn/t1", token: "SECRET-TURN-TOKEN-123" };
  const c = AGENTS.claude.invocation({ prompt: "hi", cwd: "/w", sessionId: "s-1", mcp, allowedTools: ["Read"] });
  expect(c.args).toContain("--resume");
  expect(c.args[c.args.indexOf("--allowedTools") + 1]).toBe("Read,mcp__lfg");
  expect(JSON.parse(c.args[c.args.indexOf("--mcp-config") + 1]!).mcpServers.lfg.url).toBe(mcp.url);

  const x = AGENTS.codex.invocation({ prompt: "hi", cwd: "/w", sessionId: "th-9", mcp });
  expect(x.args.slice(0, 2)).toEqual(["exec", "--json"]);
  expect(x.args.slice(-3)).toEqual(["resume", "th-9", "hi"]);
  expect(x.args.join(" ")).not.toContain("SECRET-TURN-TOKEN-123"); // token via env, not argv
  expect(x.env).toEqual({ LFG_MCP_TOKEN: "SECRET-TURN-TOKEN-123" });

  const p = AGENTS.copilot.invocation({ prompt: "hi", cwd: "/w", mcp });
  expect(p.args).toEqual(expect.arrayContaining(["-p", "hi", "--allow-all-tools", "--no-ask-user", "--output-format", "json"]));
});

test("runAgent drives a CLI and reports its events; detectAgents finds installed ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lfg-agents-"));
  const fake = join(dir, "codex");
  writeFileSync(fake, `#!/bin/bash
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
echo '{"type":"thread.started","thread_id":"th-1"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello from codex, token '"$LFG_MCP_TOKEN"'"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  chmodSync(fake, 0o755);
  const events: AgentEvent[] = [];
  const out = await runAgent("codex", { prompt: "hi", cwd: dir, env: process.env, bin: fake, mcp: { url: "http://x/mcp", token: "abc" }, onEvent: e => events.push(e) });
  expect(out).toEqual({ sessionId: "th-1", summary: "Hello from codex, token abc" });
  expect(events.map(e => e.type)).toEqual(["session", "text", "result"]);

  const found = await detectAgents(process.env, { codex: fake, claude: join(dir, "missing-claude"), copilot: join(dir, "missing-copilot") });
  expect(found).toEqual([{ kind: "codex", version: "codex-cli 9.9.9" }]);

  await expect(runAgent("copilot", { prompt: "hi", cwd: dir, env: process.env, bin: join(dir, "nope"), onEvent: () => {} })).rejects.toThrow("GitHub Copilot isn't installed");
});
