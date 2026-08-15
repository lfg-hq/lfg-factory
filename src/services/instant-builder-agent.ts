/**
 * Instant Builder Agent — provider-agnostic build runner.
 *
 * An alternative to the Claude Code CLI path (claude-cli.ts). Instead of handing
 * the build to `claude -p` inside the VM, this drives a multi-step AI-SDK agent
 * loop (any provider — DeepSeek, Kimi, OpenAI, …) from the server and gives it
 * tools that execute over the Mags VM via SSH (`execOnWorkspace`).
 *
 * Used when the user has no Claude Code OAuth connection and no Anthropic key,
 * but does have a non-Anthropic build credential (OpenAI Codex / DeepSeek / Kimi).
 */

import { generateText, stepCountIs, tool, zodSchema } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { getLiteModelKeyFor, getModel, getProviderName } from "../ai/provider.ts";
import { execOnWorkspace } from "./mags.ts";
import { hasOpenAICodexCredentials } from "./openai-codex-auth.ts";

export interface UserApiKeys {
  anthropic?: string;
  openai?: string;
  google?: string;
  kimi?: string;
  deepseek?: string;
  glm?: string;
}

export interface AgentBuilderSelection {
  modelKey: string;
  provider: string;
  userApiKeys: UserApiKeys;
  subscriptionAuth?: "openai-codex";
}

export interface AgentBuildOptions {
  workspaceId: string;
  systemPrompt: string;
  userPrompt: string;
  userId: string;
  modelKey: string;
  userApiKeys: UserApiKeys;
  envVars?: Record<string, string>;
  maxSteps?: number;
  projectDir?: string; // absolute, e.g. "/data/project"
  onProgress?: (message: string) => void;
}

export interface AgentBuildResult {
  ok: boolean;
  steps: number;
  finishReason: string;
  text: string;
}

const DEFAULT_PROJECT_DIR = "/data/project";
const MAX_TOOL_OUTPUT = 6_000;
const RUN_COMMAND_DEFAULT_TIMEOUT = 120_000;
const RUN_COMMAND_MAX_TIMEOUT = 420_000;

/**
 * Decide which non-Anthropic model to drive the sandbox builder with.
 * A deliberately connected OpenAI Codex subscription wins, followed by API-key
 * providers. Returns null when the user has no usable build credential.
 */
export async function resolveAgentBuilder(
  userId: string
): Promise<AgentBuilderSelection | null> {
  const [keys] = await db
    .select({
      openai: llmApiKeys.openaiApiKey,
      anthropic: llmApiKeys.anthropicApiKey,
      google: llmApiKeys.googleApiKey,
      kimi: llmApiKeys.kimiApiKey,
      deepseek: llmApiKeys.deepseekApiKey,
      glm: llmApiKeys.glmApiKey,
    })
    .from(llmApiKeys)
    .where(eq(llmApiKeys.userId, userId))
    .limit(1);

  const userApiKeys: UserApiKeys = {
    openai: keys?.openai ?? undefined,
    anthropic: keys?.anthropic ?? undefined,
    google: keys?.google ?? undefined,
    kimi: keys?.kimi ?? undefined,
    deepseek: keys?.deepseek ?? undefined,
    glm: keys?.glm ?? undefined,
  };

  if (await hasOpenAICodexCredentials(userId)) {
    return {
      modelKey: getLiteModelKeyFor("openai") ?? "gpt-5.6-luna",
      provider: "openai",
      userApiKeys,
      subscriptionAuth: "openai-codex",
    };
  }
  if (keys?.deepseek) {
    return { modelKey: "deepseek_v4_pro", provider: "deepseek", userApiKeys };
  }
  if (keys?.kimi) {
    return { modelKey: "kimi_k2.5", provider: "kimi", userApiKeys };
  }
  if (keys?.glm) {
    return { modelKey: "glm_5.2", provider: "glm", userApiKeys };
  }
  return null;
}

/**
 * Resolve the SSH builder for a SPECIFIC user-selected model (from the composer
 * model picker). Returns null when the model is Anthropic (→ use the Claude Code
 * CLI path instead) or when the user has no key for that model's provider.
 */
export async function resolveAgentBuilderForModel(
  userId: string,
  modelKey: string
): Promise<AgentBuilderSelection | null> {
  const provider = getProviderName(modelKey);
  // Anthropic models build via the Claude Code CLI, not this agent.
  if (!provider || provider === "anthropic") return null;

  const [keys] = await db
    .select({
      openai: llmApiKeys.openaiApiKey,
      anthropic: llmApiKeys.anthropicApiKey,
      google: llmApiKeys.googleApiKey,
      kimi: llmApiKeys.kimiApiKey,
      deepseek: llmApiKeys.deepseekApiKey,
      glm: llmApiKeys.glmApiKey,
    })
    .from(llmApiKeys)
    .where(eq(llmApiKeys.userId, userId))
    .limit(1);

  const userApiKeys: UserApiKeys = {
    openai: keys?.openai ?? undefined,
    anthropic: keys?.anthropic ?? undefined,
    google: keys?.google ?? undefined,
    kimi: keys?.kimi ?? undefined,
    deepseek: keys?.deepseek ?? undefined,
    glm: keys?.glm ?? undefined,
  };

  if (provider === "openai" && await hasOpenAICodexCredentials(userId)) {
    return { modelKey, provider, userApiKeys, subscriptionAuth: "openai-codex" };
  }

  // The user must have a valid key for the selected model's provider.
  const providerKey = userApiKeys[provider as keyof UserApiKeys];
  if (!providerKey) return null;

  return { modelKey, provider, userApiKeys };
}

/** System prompt for the SSH-driven builder agent. */
export function getInstantBuilderSystemPrompt(): string {
  return `You are LFG Instant Builder — an autonomous coding agent that builds a full-stack
Next.js web app inside a cloud sandbox VM. You do NOT have direct shell access; you
operate the VM exclusively through these tools:

- run_command(command, timeout?) — run a bash command in the project directory.
  PATH, node, npm and NODE_OPTIONS are pre-configured for you. Returns stdout/stderr
  (truncated) and the exit code.
- write_file(path, content) — write a file (overwrites). Parent dirs are created.
  Paths are relative to the project directory unless absolute.
- read_file(path) — read a file (truncated).
- list_dir(path) — list a directory.

## How to work
- The project is ALREADY scaffolded (Next.js + TS + Tailwind + shadcn/ui + drizzle).
  Do NOT re-scaffold. Implement the requirements by writing files and running commands.
- Prefer write_file for source files. Use run_command for npm installs, builds, and
  starting the server.
- Work efficiently — batch related file writes, avoid redundant diagnostic commands
  (no whoami/env/node -v; the environment is correct).
- The app MUST end up running on 0.0.0.0:8080. Start it detached with nohup and
  redirect output to dev.log, exactly as the task instructions describe.
- When you have implemented everything, built successfully, and started the server,
  briefly confirm what you built and STOP. Do not keep calling tools after the server
  is verified running.

Follow the task instructions (requirements, design system, and memory/OOM rules) that
follow in the user message precisely.`;
}

function clampOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s;
  const head = s.slice(0, MAX_TOOL_OUTPUT - 1500);
  const tail = s.slice(-1500);
  return `${head}\n…[truncated ${s.length - MAX_TOOL_OUTPUT} chars]…\n${tail}`;
}

function resolvePath(projectDir: string, p: string): string {
  if (p.startsWith("/")) return p;
  return `${projectDir}/${p.replace(/^\.?\//, "")}`;
}

/**
 * Run the agentic build loop against the VM. Resolves when the model finishes or
 * the step budget is exhausted. Throws on model/provider errors (e.g. bad key).
 */
export async function runAgenticBuild(
  opts: AgentBuildOptions
): Promise<AgentBuildResult> {
  const projectDir = opts.projectDir ?? DEFAULT_PROJECT_DIR;
  const maxSteps = opts.maxSteps ?? 120;
  const envVars = opts.envVars ?? {};

  // Shared shell preamble: PATH, npm cache, memory limit, and the app's env vars
  // so the dev server (started inside a run_command) inherits them.
  const preamble = [
    `export HOME=/root`,
    `export PATH=/root/node/current/bin:/root/.npm-global/bin:$PATH`,
    `export npm_config_cache=/tmp/npm-cache`,
    `export NODE_OPTIONS="--max-old-space-size=1536"`,
    ...Object.entries(envVars).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
  ].join("\n");

  async function execScript(script: string, timeout: number) {
    const wrapped = `${preamble}\ncd ${projectDir}\n${script}`;
    const b64 = Buffer.from(wrapped).toString("base64");
    return execOnWorkspace(opts.workspaceId, `echo ${b64} | base64 -d | bash`, {
      timeout,
    });
  }

  const tools = {
    run_command: tool({
      description:
        "Run a bash command in the project directory. Returns stdout+stderr (truncated) and exit code.",
      inputSchema: zodSchema(
        z.object({
          command: z.string().describe("The bash command to run"),
          timeout: z
            .number()
            .optional()
            .describe("Timeout in ms (default 120000, max 420000)"),
        })
      ),
      execute: async ({ command, timeout }) => {
        const t = Math.min(timeout ?? RUN_COMMAND_DEFAULT_TIMEOUT, RUN_COMMAND_MAX_TIMEOUT);
        try {
          const res = await execScript(command, t);
          return {
            exit_code: res.exitCode,
            output: clampOutput((res.output ?? "") + (res.stderr ? `\n[stderr]\n${res.stderr}` : "")),
          };
        } catch (err) {
          return { exit_code: -1, output: `Command failed: ${(err as Error).message}` };
        }
      },
    }),

    write_file: tool({
      description:
        "Write a file (overwrites if it exists). Parent directories are created automatically.",
      inputSchema: zodSchema(
        z.object({
          path: z.string().describe("File path, relative to the project dir or absolute"),
          content: z.string().describe("Full file content"),
        })
      ),
      execute: async ({ path, content }) => {
        const abs = resolvePath(projectDir, path);
        const contentB64 = Buffer.from(content).toString("base64");
        const script = `mkdir -p "$(dirname ${JSON.stringify(abs)})" && echo ${contentB64} | base64 -d > ${JSON.stringify(abs)} && echo WROTE ${JSON.stringify(abs)}`;
        try {
          const res = await execScript(script, 30_000);
          return { ok: res.output.includes("WROTE"), path: abs };
        } catch (err) {
          return { ok: false, path: abs, error: (err as Error).message };
        }
      },
    }),

    read_file: tool({
      description: "Read a file's contents (truncated if large).",
      inputSchema: zodSchema(
        z.object({
          path: z.string().describe("File path, relative to the project dir or absolute"),
        })
      ),
      execute: async ({ path }) => {
        const abs = resolvePath(projectDir, path);
        try {
          const res = await execScript(`cat ${JSON.stringify(abs)} 2>&1 | head -c 40000`, 20_000);
          return { path: abs, content: clampOutput(res.output ?? "") };
        } catch (err) {
          return { path: abs, content: `Read failed: ${(err as Error).message}` };
        }
      },
    }),

    list_dir: tool({
      description: "List a directory (ls -la).",
      inputSchema: zodSchema(
        z.object({
          path: z.string().optional().describe("Directory path (default: project dir)"),
        })
      ),
      execute: async ({ path }) => {
        const abs = path ? resolvePath(projectDir, path) : projectDir;
        try {
          const res = await execScript(`ls -la ${JSON.stringify(abs)} 2>&1`, 15_000);
          return { path: abs, output: clampOutput(res.output ?? "") };
        } catch (err) {
          return { path: abs, output: `List failed: ${(err as Error).message}` };
        }
      },
    }),
  };

  const model = getModel(opts.modelKey, opts.userApiKeys);

  let lastProgressAt = 0;
  const result = await generateText({
    model,
    system: opts.systemPrompt,
    prompt: opts.userPrompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
    onStepFinish: ({ toolCalls }) => {
      if (!opts.onProgress || !toolCalls?.length) return;
      const now = Date.now();
      if (now - lastProgressAt < 4_000) return;
      lastProgressAt = now;
      const tc = toolCalls[0] as { toolName: string; input?: Record<string, unknown> };
      opts.onProgress(describeToolCall(tc));
    },
  });

  return {
    ok: true,
    steps: result.steps?.length ?? 0,
    finishReason: result.finishReason,
    text: result.text,
  };
}

function describeToolCall(tc: { toolName: string; input?: Record<string, unknown> }): string {
  const input = tc.input ?? {};
  if (tc.toolName === "run_command" && typeof input.command === "string") {
    return `Running: ${input.command.slice(0, 90)}`;
  }
  if ((tc.toolName === "write_file" || tc.toolName === "read_file") && typeof input.path === "string") {
    return `${tc.toolName}: ${input.path}`;
  }
  return `Running: ${tc.toolName}`;
}
