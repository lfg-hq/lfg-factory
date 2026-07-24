/**
 * Pi coding-agent runner (pi.dev) — in-sandbox builder for non-Anthropic models.
 *
 * Mirrors claude-cli.ts but for Pi: the coding agent runs INSIDE the Mags VM, so
 * the user's LLM key is injected into the VM as the provider's env var and Pi
 * authenticates natively. This is the provider-agnostic equivalent of the Claude
 * Code CLI path (DeepSeek, OpenAI, Gemini are first-class Pi providers; Kimi is
 * configured as an OpenAI-compatible custom provider via models.json).
 *
 * Flow:
 *  1. Write prompt + env (export <PROVIDER>_API_KEY + app env) + runner script to VM.
 *  2. (Kimi only) write ~/.pi/agent/models.json for the Moonshot custom provider.
 *  3. Ensure `pi` is installed, then launch: pi -p "<prompt>" -a --model p/m --mode json
 *  4. Poll the JSONL output file with byte offset + alive check until the exit marker.
 */

import { execOnWorkspace } from "./mags.ts";

async function execLite(workspaceId: string, script: string, timeout = 15_000) {
  const b64 = Buffer.from(script).toString("base64");
  return execOnWorkspace(workspaceId, `echo ${b64} | base64 -d | bash`, { timeout });
}

// Project lives on the big /data volume (7.8GB), not /root (1.9GB) — avoids ENOSPC.
const WORKING_DIR = "/data";
const POLL_INTERVAL_MS = 5_000;

/** A full model entry for a Pi custom (OpenAI-compatible) provider's models.json. */
interface PiModelDef {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
}

// DeepSeek V4 requires a high minimum thinking level — reasoningEffortMap handles it.
const DEEPSEEK_REASONING_MAP = { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" };
const DEEPSEEK_MODELS: PiModelDef[] = [
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextWindow: 1000000,
    maxTokens: 384000,
    input: ["text"],
    reasoning: true,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
    compat: {
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
      reasoningEffortMap: DEEPSEEK_REASONING_MAP,
    },
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 1000000,
    maxTokens: 384000,
    input: ["text"],
    reasoning: true,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
    compat: {
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
      reasoningEffortMap: DEEPSEEK_REASONING_MAP,
    },
  },
];

const KIMI_MODELS: PiModelDef[] = [
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    contextWindow: 256000,
    maxTokens: 32000,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

const GLM_MODELS: PiModelDef[] = [
  {
    id: "glm-5.2",
    name: "GLM 5.2",
    contextWindow: 200000,
    maxTokens: 128000,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

/**
 * Map an LFG provider → how Pi authenticates it.
 *  - `envVar`: the env var Pi reads the key from (per pi.dev/docs/latest/providers).
 *  - `piName`: the provider name used in `--provider`/`--model` and models.json.
 *  - `custom`: present for OpenAI-compatible providers Pi doesn't ship natively
 *    (DeepSeek, Kimi) — written into ~/.pi/agent/models.json with full model defs.
 */
const PI_PROVIDERS: Record<
  string,
  { piName: string; envVar: string; custom?: { baseUrl: string; api: string; models: PiModelDef[] } }
> = {
  anthropic: { piName: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  openai: { piName: "openai", envVar: "OPENAI_API_KEY" },
  google: { piName: "google", envVar: "GEMINI_API_KEY" },
  deepseek: {
    piName: "deepseek",
    envVar: "DEEPSEEK_API_KEY",
    custom: { baseUrl: "https://api.deepseek.com", api: "openai-completions", models: DEEPSEEK_MODELS },
  },
  kimi: {
    piName: "moonshot",
    envVar: "MOONSHOT_API_KEY",
    custom: { baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions", models: KIMI_MODELS },
  },
  glm: {
    piName: "zai",
    envVar: "GLM_API_KEY",
    custom: { baseUrl: "https://api.z.ai/api/paas/v4", api: "openai-completions", models: GLM_MODELS },
  },
};

export interface PiRunOptions {
  workspaceId: string;
  prompt: string;
  projectDir: string; // relative to /root, e.g. "project"
  provider: string; // LFG provider name (deepseek/kimi/openai/google/anthropic)
  modelId: string; // provider-native model id, e.g. "deepseek-v4-pro"
  apiKey: string; // the user's key for that provider
  envVars?: Record<string, string>; // app env vars to expose to the build
  outputFile?: string;
  /** When set, an in-VM forwarder streams Pi's JSONL to LFG in real time (webhook
   *  push) instead of the server polling the VM. mode="instant" POSTs compact
   *  tool-call ops to /instant-progress (appId); mode="ticket" POSTs raw JSONL to
   *  /output (ticketId). Graceful no-op if the VM can't reach apiUrl. */
  forward?: { apiUrl: string; apiKey: string; appId?: string; mode?: "instant" | "ticket"; ticketId?: string };
}

export interface PiRunResult {
  outputFile: string;
  backgroundPid?: string;
}

export function isPiSupportedProvider(provider: string): boolean {
  return provider in PI_PROVIDERS;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Launch Pi in the VM (non-blocking, background). Returns the output file + pid.
 */
export async function startPiCli(opts: PiRunOptions): Promise<PiRunResult> {
  const cfg = PI_PROVIDERS[opts.provider];
  if (!cfg) throw new Error(`Pi runner: unsupported provider '${opts.provider}'`);

  const ts = Date.now();
  const outputFile = opts.outputFile ?? `/tmp/pi_output_${ts}.jsonl`;
  const promptFile = `/tmp/pi_prompt_${ts}.txt`;
  const envFile = `/tmp/pi_env_${ts}.sh`;
  const runnerScript = `/tmp/pi_runner_${ts}.sh`;
  const forwarderFile = `/tmp/pi_forward_${ts}.js`;
  const projectDirName = opts.projectDir.replace(/^\/(root|data)\//, "").replace(/^\//, "");

  // Env file: provider key + app env vars + (when forwarding) the LFG callback coords.
  // NEVER write PATH (or other machine-specific vars): the runner sources this file,
  // and a persisted PATH like "/data/.dotnet:…" would OVERWRITE the toolchain PATH →
  // `node`/`pi` "not found" → the reinstall/127 loop.
  const PI_UNSAFE_ENV = new Set(["PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "TERM", "HOSTNAME", "SHLVL", "_", "LD_LIBRARY_PATH", "LD_PRELOAD"]);
  const envExports = [
    `export ${cfg.envVar}=${JSON.stringify(opts.apiKey)}`,
    ...(opts.forward
      ? [
          `export LFG_API_URL=${JSON.stringify(opts.forward.apiUrl)}`,
          `export LFG_API_KEY=${JSON.stringify(opts.forward.apiKey)}`,
          ...(opts.forward.appId ? [`export LFG_INSTANT_APP_ID=${JSON.stringify(opts.forward.appId)}`] : []),
          ...(opts.forward.ticketId ? [`export LFG_TICKET_ID=${JSON.stringify(opts.forward.ticketId)}`] : []),
        ]
      : []),
    ...Object.entries(opts.envVars ?? {}).filter(([k]) => !PI_UNSAFE_ENV.has(k)).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
  ].join("\n");

  // In-VM forwarder: reads Pi's --mode json stream on stdin, extracts each tool call
  // (verb/path/command — small), and POSTs batches to LFG. The huge reasoning never
  // leaves the VM. Failures are swallowed (build proceeds even if LFG is unreachable).
  const FORWARDER_JS = `'use strict';
const API=process.env.LFG_API_URL, KEY=process.env.LFG_API_KEY, APP=process.env.LFG_INSTANT_APP_ID;
let buf='', batch=[], flushing=false;
// Pi --mode json streams tool inputs char-by-char AND re-echoes the whole accumulating
// message on every event, so each op arrives as many growing partials + hundreds of
// re-lists. Collapse: dedup completed ops (seen), and debounce-merge prefix partials of
// the SAME op (keep the longest, emit once it settles).
const seen=new Set();
let pend=null, pendTimer=null;
function val(o){ return o.p||o.c||''; }
function commit(o){ if(o){ const k=o.n+'|'+val(o); if(!seen.has(k)){ seen.add(k); batch.push(o); } } }
function settle(){ commit(pend); pend=null; pendTimer=null; }
function onOp(o){
  if(!val(o)) return;                 // drop arg-less partials ("Creating a file")
  if(seen.has(o.n+'|'+val(o))) return; // already emitted this exact op (kills re-lists)
  if(pend && o.n===pend.n){
    const a=val(o), b=val(pend);
    if(a.startsWith(b)||b.startsWith(a)){ if(a.length>=b.length) pend=o; clearTimeout(pendTimer); pendTimer=setTimeout(settle,200); return; }
  }
  commit(pend); pend=o; clearTimeout(pendTimer); pendTimer=setTimeout(settle,200);
}
function take(line){
  const t=line.trim(); if(t[0]!=='{') return;
  let e; try{ e=JSON.parse(t); }catch{ return; }
  const calls=[];
  const tn=e.toolName||e.tool||e.name, ta=e.input||e.arguments||e.args;
  if(typeof tn==='string' && ta && typeof ta==='object') calls.push([tn,ta]);
  const c=e.message&&e.message.content;
  if(Array.isArray(c)) for(const bl of c){ if(bl&&typeof bl==='object'&&/tool/.test(String(bl.type))&&(bl.name||bl.toolName)) calls.push([String(bl.name||bl.toolName), bl.input||bl.arguments||bl.args||{}]); }
  for(const [n,a] of calls){ onOp({ n, p:a.path||a.file_path||a.filePath||null, c:((a.command||a.cmd||'')+'').slice(0,160)||null }); }
}
async function flush(){
  if(flushing||!API||!KEY||!APP) return;
  flushing=true;
  while(batch.length){ const ops=batch.splice(0,40);
    try{ await fetch(API+'/api/v1/cli/instant-progress',{method:'POST',headers:{'X-CLI-API-Key':KEY,'Content-Type':'application/json','ngrok-skip-browser-warning':'true'},body:JSON.stringify({app_id:APP,ops})}); }catch{} }
  flushing=false;
}
const timer=setInterval(flush,800);
process.stdin.setEncoding('utf8');
process.stdin.on('data',d=>{ buf+=d; let i; while((i=buf.indexOf('\\n'))>=0){ take(buf.slice(0,i)); buf=buf.slice(i+1); } });
process.stdin.on('end',async()=>{ clearInterval(timer); clearTimeout(pendTimer); if(buf) take(buf); commit(pend); pend=null; await flush(); process.exit(0); });
`;

  // Ticket forwarder: streams Pi's raw JSONL lines (base64 batched) to LFG's
  // /api/v1/cli/output endpoint in real time — the SAME endpoint the Claude CLI
  // path uses, which parses + logs + broadcasts. This is a WEBHOOK push (no
  // server-side polling of the VM). Failures are swallowed.
  const TICKET_FORWARDER_JS = `'use strict';
const API=process.env.LFG_API_URL, KEY=process.env.LFG_API_KEY, TID=process.env.LFG_TICKET_ID;
let buf='', batch=[], flushing=false;
async function flush(){
  if(flushing||!API||!KEY||!TID||!batch.length) return;
  flushing=true;
  const chunk=batch.join('\\n'); batch=[];
  const data=Buffer.from(chunk).toString('base64');
  try{ await fetch(API+'/api/v1/cli/output',{method:'POST',headers:{'X-CLI-API-Key':KEY,'Content-Type':'application/json','ngrok-skip-browser-warning':'true'},body:JSON.stringify({ticket_id:TID,data})}); }catch{}
  flushing=false;
}
const timer=setInterval(flush,800);
process.stdin.setEncoding('utf8');
process.stdin.on('data',d=>{ buf+=d; let i; while((i=buf.indexOf('\\n'))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1); if(line.trim()) batch.push(line); } });
process.stdin.on('end',async()=>{ clearInterval(timer); if(buf.trim()) batch.push(buf); await flush(); process.exit(0); });
`;
  const forwarderScript = opts.forward?.mode === "ticket" ? TICKET_FORWARDER_JS : FORWARDER_JS;

  // OpenAI-compatible custom providers (DeepSeek, Kimi) need a models.json entry.
  // Native providers (openai, google, anthropic) need none.
  let modelsJsonInject = "";
  if (cfg.custom) {
    const modelsJson = {
      providers: {
        [cfg.piName]: {
          baseUrl: cfg.custom.baseUrl,
          api: cfg.custom.api,
          apiKey: `$${cfg.envVar}`,
          models: cfg.custom.models,
        },
      },
    };
    const modelsB64 = Buffer.from(JSON.stringify(modelsJson, null, 2)).toString("base64");
    modelsJsonInject = `
mkdir -p /root/.pi/agent
echo '${modelsB64}' | base64 -d > /root/.pi/agent/models.json`;
  }

  // Pi launch line. When forwarding, pipe the JSON stream through tee (→ outputFile, so
  // the completion/analysis poll still works) AND the forwarder (→ live ops). Use bash
  // PIPESTATUS[0] to recover Pi's real exit code from the pipeline.
  const piRun = `pi -p --provider ${cfg.piName} --model ${opts.modelId} --mode json "$(cat ${promptFile})"`;
  const piLaunch = opts.forward
    ? `${piRun} 2>&1 | tee -a ${outputFile} | node ${forwarderFile}\nPI_EXIT=\${PIPESTATUS[0]}`
    : `${piRun} >> ${outputFile} 2>&1\nPI_EXIT=\$?`;

  // Runner script — runs as root inside the VM.
  // pi installs into a global prefix on the big /data disk (root is only 1.9GB).
  const piInstallLog = `/tmp/pi_install_${ts}.log`;
  const runnerContent = `#!/bin/bash
export HOME=/root
# The "pi" rootfs ships node 22 + pi PREINSTALLED, but on the LOGIN/interactive PATH
# (nvm / ~/.bashrc / profile.d) which a non-login exec shell does NOT inherit — so a
# hardcoded PATH resolves \`node\` to an OLD system node ("too old") and can't find
# \`pi\`, and we needlessly bootstrap node + reinstall pi and fail with 127.
# (1) Replay the login+interactive rc files a real shell would source:
for rc in /etc/profile ~/.bash_profile ~/.profile ~/.bashrc; do [ -f "\$rc" ] && . "\$rc" >/dev/null 2>&1 || true; done
for f in /etc/profile.d/*.sh; do [ -f "\$f" ] && . "\$f" >/dev/null 2>&1 || true; done
export NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
[ -s "\$NVM_DIR/nvm.sh" ] && { . "\$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1; } || true
# (2) Mechanism-agnostic fallback: if pi still isn't on PATH, find its real binary and
# prepend that dir (which also holds the node 22 it was installed against).
if ! command -v pi >/dev/null 2>&1; then
  PI_REAL="\$(ls -1 \$HOME/.nvm/versions/node/*/bin/pi /usr/local/bin/pi /usr/lib/node_modules/.bin/pi 2>/dev/null | head -1)"
  [ -z "\$PI_REAL" ] && PI_REAL="\$(find /root /usr -maxdepth 7 -type f -name pi 2>/dev/null | head -1)"
  [ -n "\$PI_REAL" ] && export PATH="\$(dirname "\$PI_REAL"):\$PATH"
fi
export npm_config_prefix=/data/.npm-global
mkdir -p /data/.npm-global /data/.npm-cache
# Explicit PATH: /usr/local/bin (pi lives here) + /usr/bin (node 22 lives here) come
# BEFORE any legacy /root/node/current/bin — that dir held an OLD node 20.15.1 that
# was SHADOWING /usr/bin/node (v22) → the whole "node too old" + reinstall-pi loop.
export PATH=/data/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:\$PATH
export npm_config_cache=/data/.npm-cache
export NPM_CONFIG_CACHE=/data/.npm-cache
export NODE_OPTIONS="--max-old-space-size=1536"
source ${envFile}
# RE-ASSERT the toolchain PATH AFTER sourcing envFile — sourcing it can (and did)
# overwrite PATH with a persisted value that lacks /usr/bin, hiding node 22 + pi.
export PATH=/data/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:\$PATH
cd ${WORKING_DIR}/${projectDirName}
# DIAGNOSTIC (PATHFIX-v3): show the TRUTH — resolved node/pi, whether the binaries
# exist on disk, and the actual PATH — so we can see exactly what's wrong.
echo "[pi-runner] PATHFIX-v3 node=\$(command -v node || echo none) ver=\$(node -v 2>/dev/null || echo ?) pi=\$(command -v pi || echo none) | /usr/bin/node:\$([ -x /usr/bin/node ] && /usr/bin/node -v || echo MISSING) /usr/local/bin/pi:\$([ -x /usr/local/bin/pi ] && echo yes || echo MISSING) | PATH=\$PATH" >> ${outputFile}

# Pi's deps require node ^20.17 || >=22.9. Mags sometimes hands out a STALE rootfs
# snapshot with node 20.15.1 (and no preinstalled pi), where the pi install fails
# EBADENGINE → exit 127. Don't depend on which snapshot we land on: if node is too old,
# fetch a static node 22 into /data and prepend it so pi runs regardless. (No-op on the
# good snapshot, which already has node 22 — so the fast path is untouched.)
ensure_node() {
  V=\$(node -v 2>/dev/null | sed 's/v//')
  MAJ=\${V%%.*}; REST=\${V#*.}; MIN=\${REST%%.*}
  OK=0
  if [ -n "\$MAJ" ]; then
    if [ "\$MAJ" -ge 22 ]; then OK=1
    elif [ "\$MAJ" -eq 21 ]; then OK=1
    elif [ "\$MAJ" -eq 20 ] && [ "\${MIN:-0}" -ge 17 ]; then OK=1
    fi
  fi
  [ "\$OK" = "1" ] && return 0
  echo "[pi-runner] node \$V too old for pi (need >=20.17 / >=22.9) — installing node 22 to /data..." >> ${outputFile}
  NODE_DIR=/data/node22
  # Verify node actually RUNS (not just that the file exists) — a glibc binary on
  # musl has the exec bit set but can't run, so an -x check gives a false positive.
  if ! "\$NODE_DIR/bin/node" -v >/dev/null 2>&1; then
    case "\$(uname -m)" in x86_64) NA=x64;; aarch64|arm64) NA=arm64;; *) NA=x64;; esac
    NVER=v22.11.0
    # CRITICAL: Alpine is musl. The nodejs.org build is glibc-only and will NOT run
    # here (→ pi exit 127). Use the unofficial MUSL build on Alpine/musl.
    if ldd /bin/sh 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then
      NURL="https://unofficial-builds.nodejs.org/download/release/\$NVER/node-\$NVER-linux-\$NA-musl.tar.gz"
    else
      NURL="https://nodejs.org/dist/\$NVER/node-\$NVER-linux-\$NA.tar.gz"
    fi
    echo "[pi-runner] fetching \$NURL" >> ${outputFile}
    mkdir -p "\$NODE_DIR"
    curl -fsSL --retry 3 --retry-delay 2 "\$NURL" -o /tmp/node22.tar.gz \\
      && tar -xzf /tmp/node22.tar.gz -C "\$NODE_DIR" --strip-components=1
  fi
  if "\$NODE_DIR/bin/node" -v >/dev/null 2>&1; then
    export PATH="\$NODE_DIR/bin:\$PATH"
    echo "[pi-runner] now using node \$(node -v)" >> ${outputFile}
  else
    # Last resort: Alpine's own musl node via apk (often >=20.17 on recent Alpine).
    echo "[pi-runner] node 22 tarball unavailable — trying apk add nodejs npm..." >> ${outputFile}
    (command -v apk >/dev/null 2>&1 && (apk update >/dev/null 2>&1; apk add --no-cache nodejs-current npm >/dev/null 2>&1 || apk add --no-cache nodejs npm >/dev/null 2>&1)) || true
    hash -r 2>/dev/null || true
    echo "[pi-runner] node now: \$(node -v 2>/dev/null || echo none) (if 'none', the rootfs snapshot lacks node 22 AND the sandbox can't fetch it — the 'pi' rootfs needs node 22 preinstalled)" >> ${outputFile}
  fi
}
ensure_node

# Ensure a WORKING pi. Verify it actually RUNS (\`pi --version\`) — not just that the
# file exists — because a partial/interrupted install leaves a corrupt cli.js that
# bash tries to run as a script (→ exit 127). Reinstall cleanly and re-verify; only
# proceed once pi works.
PI_PKG="@mariozechner/pi-coding-agent"
ensure_pi() {
  pi --version >/dev/null 2>&1 && return 0
  echo "[pi-runner] installing \$PI_PKG..." >> ${outputFile}
  npm i -g "\$PI_PKG" > ${piInstallLog} 2>&1
  pi --version >/dev/null 2>&1 && return 0
  # Clean + retry once (clears any corrupt partial install / cache).
  echo "[pi-runner] first install did not yield a working pi — cleaning + retrying..." >> ${outputFile}
  rm -rf /data/.npm-global/lib/node_modules/@mariozechner /data/.npm-global/bin/pi 2>/dev/null
  npm cache clean --force >/dev/null 2>&1
  npm i -g "\$PI_PKG" >> ${piInstallLog} 2>&1
  pi --version >/dev/null 2>&1
}
if ! ensure_pi; then
  echo "[pi-runner] FATAL: pi could not be installed/run. Install log tail:" >> ${outputFile}
  tail -20 ${piInstallLog} >> ${outputFile} 2>/dev/null
  echo "" >> ${outputFile}
  echo "___PI_EXIT_CODE=127" >> ${outputFile}
  exit 127
fi
# Pre-launch confirmation of node + pi, written to the output file (preserved because
# the pi run below appends rather than truncates). The poller surfaces this line to the
# server console, so every build records exactly what node/pi it ran on.
echo "___PI_VERSIONS node=\$(node -v 2>/dev/null) pi=\$(pi --version 2>/dev/null)" >> ${outputFile}

# The provider key is exported in this shell (via the sourced env file), so the
# "\$${cfg.envVar}" reference in models.json resolves at runtime. --mode json streams
# events; matches the documented activation:
#   pi -p --provider deepseek --model deepseek-v4-pro "<prompt>"
# Append (>>), not truncate (>), so the confirmation line above is preserved.
${piLaunch}
echo "" >> ${outputFile}
echo "___PI_EXIT_CODE=\$PI_EXIT" >> ${outputFile}
`;

  const promptB64 = Buffer.from(opts.prompt).toString("base64");
  const envB64 = Buffer.from(envExports).toString("base64");
  const runnerB64 = Buffer.from(runnerContent).toString("base64");
  const forwarderInject = opts.forward
    ? `echo '${Buffer.from(forwarderScript).toString("base64")}' | base64 -d > ${forwarderFile}`
    : "";

  const startCmd = `export HOME=/root
export PATH=/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:\$PATH
echo '${promptB64}' | base64 -d > ${promptFile}
echo '${envB64}' | base64 -d > ${envFile}
${modelsJsonInject}
${forwarderInject}
echo '${runnerB64}' | base64 -d > ${runnerScript}
chmod 755 ${runnerScript}
touch ${outputFile}
mkdir -p ${WORKING_DIR}/${projectDirName}
# setsid (new session) so the runner survives the exec/SSH teardown when this start
# command returns — a bare nohup can still be reaped with the exec's process group.
setsid bash ${runnerScript} > /dev/null 2>&1 < /dev/null &
echo "___PI_BG_PID=\$!"
echo "PI_STARTED"
`;

  const startCmdB64 = Buffer.from(startCmd).toString("base64");
  const execCmd = `echo ${startCmdB64} | base64 -d | sh`;

  console.log(`[pi-cli] starting Pi for workspace ${opts.workspaceId}, model=${cfg.piName}/${opts.modelId}`);
  const result = await execOnWorkspace(opts.workspaceId, execCmd, { timeout: 60_000 });

  if (!result.output.includes("PI_STARTED")) {
    throw new Error("Pi CLI did not start. Output: " + result.output.slice(0, 500));
  }

  const pidMatch = result.output.match(/___PI_BG_PID=(\d+)/);
  const backgroundPid = pidMatch?.[1];
  console.log(`[pi-cli] Pi started, pid=${backgroundPid}, outputFile=${outputFile}`);

  return { outputFile, backgroundPid };
}

/** Extract the exit code written by the runner script. */
export function piExitCode(allOutput: string): number | null {
  const match = allOutput.match(/___PI_EXIT_CODE=(\d+)/);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

/**
 * Detect a FATAL Pi run error from the JSONL stream — the case where the agent
 * could not run at all (bad/expired key, quota, provider down) and produced ZERO
 * successful assistant output. Pi exits 0 even on a 401, so the exit code alone
 * can't catch this.
 *
 * Deliberately CONSERVATIVE to avoid false positives — it only flags when BOTH:
 *   1. the run ended with an assistant-level error (`stopReason: "error"` + errorMessage), AND
 *   2. NOT a single assistant turn ever succeeded (no content, no non-error stop).
 * This structurally ignores: failed tool calls / bash (those are toolResults, not
 * assistant stopReason), npm/TS warnings printed in tool output, "error" strings in
 * generated app code, and any error the agent recovered from after doing real work.
 * If the agent produced ANY successful assistant turn, this returns null.
 */
export function detectPiFatalError(allOutput: string): string | null {
  let hadSuccessfulAssistant = false;
  let lastErrorMessage: string | null = null;

  for (const line of allOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let evt: { message?: { role?: string; content?: unknown[]; stopReason?: string; errorMessage?: string } };
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const msg = evt.message;
    if (msg?.role !== "assistant") continue;

    const contentLen = Array.isArray(msg.content) ? msg.content.length : 0;
    const stop = msg.stopReason;
    if (stop === "error" && msg.errorMessage) {
      lastErrorMessage = String(msg.errorMessage);
    } else if (contentLen > 0 || (stop && stop !== "error")) {
      // The agent produced real output / a normal stop at least once.
      hadSuccessfulAssistant = true;
    }
  }

  return lastErrorMessage && !hadSuccessfulAssistant ? lastErrorMessage : null;
}

/**
 * Turn a Pi tool call into a human-readable progress line, reading the agent's
 * ACTUAL activity (no hard-coded dep names). Maps the tool + its args to a verb:
 *   bash `npm install X`  → "Installing X"
 *   bash <cmd>            → "Running <cmd>"
 *   write/create          → "Creating <path>"
 *   edit/str_replace      → "Editing <path>"
 *   read                  → "Reading <path>"
 *   grep/find/glob/search → "Searching <pattern>"
 *   ls/list               → "Listing <path>"
 */
export function describePiTool(name: string, args: Record<string, any> | undefined, maxLen = 90): string {
  const tool = name.toLowerCase();
  const path = args?.path ?? args?.file_path ?? args?.filePath;
  const cmd: string | undefined = args?.command ?? args?.cmd;
  const pattern = args?.pattern ?? args?.query ?? args?.regex;
  const short = (s: string, n = maxLen) => (s.length > n ? s.slice(0, n) + "…" : s);

  if (tool.includes("bash") || tool.includes("shell") || tool.includes("exec") || tool.includes("run")) {
    if (cmd) {
      const m = cmd.match(/npm\s+(?:install|i|add)\s+(?:-D\s+|--save-dev\s+)?([^\n&|;]+)/i);
      if (m?.[1]) return `Installing ${short(m[1].trim(), 80)}`;
      return `Running ${short(cmd)}`;
    }
    return "Running a command";
  }
  if (tool.includes("write") || tool.includes("create")) return path ? `Creating ${path}` : "Creating a file";
  if (tool.includes("edit") || tool.includes("replace") || tool.includes("patch")) return path ? `Editing ${path}` : "Editing a file";
  if (tool.includes("read") || tool.includes("cat") || tool.includes("view")) return path ? `Reading ${path}` : "Reading a file";
  if (tool.includes("grep") || tool.includes("find") || tool.includes("glob") || tool.includes("search")) {
    return pattern ? `Searching "${short(String(pattern), 60)}"` : (cmd ? `Searching ${short(cmd)}` : "Searching the project");
  }
  if (tool.includes("ls") || tool.includes("list")) return path ? `Listing ${path}` : "Listing files";
  // Unknown tool — surface whatever arg looks useful.
  if (path) return `${name}: ${path}`;
  if (cmd) return `${name}: ${short(cmd)}`;
  return `Running ${name}`;
}

/**
 * Turn a SINGLE Pi JSONL line into a human log label (or null to skip noise).
 * Pi's `--mode json` format differs from Claude CLI's — top-level toolName/name,
 * tool_use/text blocks inside an assistant message, or plain text/content — so the
 * Claude parser used by /api/v1/cli/output would drop all of it. This lets the
 * webhook handler log Pi ticket-build output line by line.
 */
// Generic "no args yet" tool descriptions — these are emitted while Pi is still
// STREAMING the tool call (the command/path hasn't arrived), so they're partials
// that get superseded a token later. Dropping them (like the instant path does)
// removes the "Running a command" / "Reading a file" noise and the redundant
// expand-bodies. A real call ("Running npm i", "Reading /x") is always kept.
const PI_ARGLESS_PARTIAL = new Set([
  "Running a command", "Creating a file", "Editing a file", "Reading a file",
  "Searching the project", "Listing files",
]);
function piToolOrNull(name: string, args: Record<string, any> | undefined, maxLen: number): string | null {
  const label = describePiTool(name, args, maxLen);
  return PI_ARGLESS_PARTIAL.has(label) ? null : label;
}

export function describePiLine(line: string, maxLen = 400): string | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  let evt: Record<string, any>;
  try { evt = JSON.parse(t); } catch { return null; }

  // Top-level tool call (skip argless partials — they're superseded moments later).
  const topName = evt.toolName ?? evt.tool ?? evt.name;
  if (typeof topName === "string") return piToolOrNull(topName, evt.input ?? evt.arguments ?? evt.args, Math.min(maxLen, 120));

  // Assistant message with content blocks (tool_use + text).
  const content = evt.message?.content ?? evt.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (/tool/.test(String(block.type)) && (block.name || block.toolName)) {
        const tl = piToolOrNull(String(block.name ?? block.toolName), block.input ?? block.arguments ?? block.args, Math.min(maxLen, 120));
        if (tl) parts.push(tl);
      } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        parts.push(block.text.trim().slice(0, maxLen));
      }
    }
    return parts.length ? parts.join("\n") : null;
  }

  // Tool result output.
  if (evt.type === "tool_result" || evt.toolResult != null) {
    const r = typeof evt.content === "string" ? evt.content : (evt.result ?? evt.output);
    if (typeof r === "string" && r.trim().length > 30) return r.trim().slice(0, maxLen);
    return null;
  }

  // Plain text / content string.
  const text = evt.text ?? (typeof evt.content === "string" ? evt.content : undefined);
  if (typeof text === "string" && text.trim()) return text.trim().slice(0, maxLen);
  return null;
}

/**
 * Best-effort progress line from Pi's JSONL stream. Pi's `--mode json` emits one
 * JSON object per line. We look for the most recent tool call (in any of the shapes
 * Pi uses: top-level toolName/name, or a tool_use block inside an assistant message)
 * and describe it; falling back to the latest assistant text.
 */
export function extractPiProgress(data: string, maxLen = 90): string | null {
  const textCap = maxLen >= 4000 ? maxLen : 160; // assistant-text cap scales too
  const lines = data.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith("{")) continue;
    let evt: Record<string, any>;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Shape 1: top-level tool call event.
    const topName = evt.toolName ?? evt.tool ?? evt.name;
    const topArgs = evt.input ?? evt.arguments ?? evt.args;
    if (typeof topName === "string") return describePiTool(topName, topArgs, maxLen);

    // Shape 2: tool_use block inside an assistant message's content array.
    const content = evt.message?.content;
    if (Array.isArray(content)) {
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j];
        if (block && typeof block === "object" && /tool/.test(String(block.type)) && (block.name || block.toolName)) {
          return describePiTool(String(block.name ?? block.toolName), block.input ?? block.arguments ?? block.args, maxLen);
        }
      }
      // Plain assistant text block.
      const textBlock = content.find((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
      if (textBlock) return `Agent: ${textBlock.text.trim().slice(0, textCap)}`;
    }

    const text = evt.text ?? (typeof evt.content === "string" ? evt.content : undefined);
    if (typeof text === "string" && text.trim()) return `Agent: ${text.trim().slice(0, textCap)}`;
  }
  return null;
}

/**
 * Poll Pi's run to completion WITHOUT transferring the (multi-MB) JSONL body.
 *
 * Pi's --mode json output can balloon to tens of MB (DeepSeek reasoning echoes the
 * full content in every event). Reading the whole delta each poll blew past Mags's
 * gRPC 4MB exec response cap ("ResourceExhausted") and would burn huge bandwidth.
 *
 * Instead each poll runs a tiny VM-side command returning only: alive flag, a done
 * marker, and the LAST ~4KB of the file (for progress). At the end, one more VM-side
 * grep returns the exit code + a fatal-error verdict. Total transfer per build: a few
 * KB, not the full output.
 */
export async function streamPiToCompletion(params: {
  workspaceId: string;
  outputFile: string;
  backgroundPid?: string;
  timeoutMs: number;
  onProgress?: (message: string) => void;
  /** Max chars of a command/text surfaced per progress line. Default 90 (compact
   *  UI); pass a large value to log the FULL command (e.g. dev-preview). */
  progressMaxLen?: number;
}): Promise<{ exitCode: number | null; fatalError: string | null; didWork: boolean; toolCalls: number; tail: string }> {
  const { workspaceId, outputFile, backgroundPid, timeoutMs, onProgress, progressMaxLen = 90 } = params;
  const f = JSON.stringify(outputFile);
  // Install log shares the timestamp suffix (set in startPiCli) — derive it so the
  // final analysis can surface it if Pi produced nothing.
  const installLog = JSON.stringify(outputFile.replace(/pi_output_(\d+)\.jsonl$/, "pi_install_$1.log"));
  const aliveCheck = backgroundPid ? `kill -0 ${backgroundPid} 2>/dev/null && echo yes || echo no` : `echo unknown`;

  let consecutiveErrors = 0;
  let lastProgressAt = 0;
  let polls = 0;
  let loggedVersions = false;
  // Stall guard: if the SAME progress line persists this many polls with nothing
  // new, the agent is stuck (e.g. re-running a failing command in a loop). The
  // threshold is deliberately high (~7.5 min at 5s polls) so a legitimately slow
  // single step never trips it — it only catches a genuine stall, well before the
  // full timeout. Defense-in-depth; the deterministic scaffold is the real fix.
  const STALL_LIMIT = 90;
  let lastStallSig: string | null = null;
  let stallCount = 0;
  let stalled = false;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    // Lightweight status: alive + done marker + last 4KB tail only (NOT the full file).
    const statusScript = `F=${f}
AL=$(${aliveCheck})
DN=$(grep -q ___PI_EXIT_CODE "$F" 2>/dev/null && echo yes || echo no)
TL=$(tail -c 4000 "$F" 2>/dev/null | base64 | tr -d '\\n')
printf 'PISTAT AL=%s DN=%s\\n' "$AL" "$DN"
printf 'TL=%s\\n' "$TL"`;
    let out = "";
    try {
      const res = await execLite(workspaceId, statusScript);
      out = res.output || "";
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.warn(`[pi-cli] poll error (${consecutiveErrors}/5):`, (err as Error).message?.slice(0, 120));
      if (consecutiveErrors >= 5) throw err;
      continue;
    }

    const alive = /\bAL=yes\b/.test(out) || /\bAL=unknown\b/.test(out);
    const done = /\bDN=yes\b/.test(out);
    const tlMatch = out.match(/TL=([A-Za-z0-9+/=]*)/);
    const tail = tlMatch?.[1] ? Buffer.from(tlMatch[1], "base64").toString("utf8") : "";

    // Surface the pre-launch node+pi confirmation to the server console, once.
    if (!loggedVersions) {
      const vm = tail.match(/___PI_VERSIONS (node=\S* pi=\S*)/);
      if (vm) {
        loggedVersions = true;
        console.log(`[pi-cli] confirmed in-VM before build: ${vm[1]}`);
      }
    }

    polls++;
    if (polls % 6 === 0) {
      console.log(`[pi-cli] still building — ${Math.round((Date.now() - startedAt) / 1000)}s elapsed, alive=${alive}, done=${done}`);
    }

    const progress = tail ? extractPiProgress(tail, progressMaxLen) : null;

    // Stall detection: the same progress line repeating with nothing new.
    if (progress) {
      if (progress === lastStallSig) {
        if (++stallCount >= STALL_LIMIT) {
          stalled = true;
          console.warn(`[pi-cli] agent stalled — "${progress.slice(0, 80)}" repeated ${stallCount}× (~${Math.round((stallCount * POLL_INTERVAL_MS) / 60000)}min) with no progress; aborting.`);
          break;
        }
      } else {
        lastStallSig = progress;
        stallCount = 0;
      }
    }

    if (progress && onProgress && Date.now() - lastProgressAt > 5_000) {
      lastProgressAt = Date.now();
      onProgress(progress);
    }

    // Done marker present (runner writes it as its last action) → finished.
    // Process gone without a marker → it died; stop and let the analysis decide.
    if (done || !alive) break;
  }

  // Final analysis — cheap VM-side grep + a capped tail (256KB, well under the 4MB
  // gRPC cap) for diagnosis. Returns: exit code, fatal verdict, whether Pi did real
  // work (any tool call), tool-call count, and the tail.
  let exitCode: number | null = null;
  let fatalError: string | null = null;
  let toolCalls = 0;
  let tail = "";
  let didWork = false;
  try {
    // SUC: at least one assistant turn ended NORMALLY (any stopReason that isn't
    //   "error"). Verified against Pi's real format — errored turns carry
    //   stopReason:"error", successful ones carry tool_use/stop/end_turn/tool_calls/length.
    // TC: tool activity across every shape Pi might use (content-block tool_use,
    //   top-level tool_call/toolName, and tool_result events).
    // OOM/MEM/INST: only meaningful when Pi produced nothing — captures the kernel
    // OOM-killer log (the runner bash dies on SIGKILL WITHOUT writing the exit marker,
    // so this is the only trace), current memory headroom, and the npm install log.
    const analysisScript = `F=${f}
EXIT=$(grep -o '___PI_EXIT_CODE=[0-9]\\{1,\\}' "$F" 2>/dev/null | tail -1 | grep -o '[0-9]\\{1,\\}')
SUC=$(grep -qE '"stopReason":"(tool_use|stop|end_turn|tool_calls|length|max_tokens)"' "$F" 2>/dev/null && echo yes || echo no)
TC=$(grep -oE '"type":"(tool_use|tool_call|tool_result)"|"toolName":' "$F" 2>/dev/null | wc -l | tr -d ' ')
ERR=$(grep -o '"errorMessage":"[^"]*"' "$F" 2>/dev/null | tail -1 | base64 | tr -d '\\n')
TL=$(tail -c 262144 "$F" 2>/dev/null | base64 | tr -d '\\n')
OOM=$(dmesg 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' | tail -3 | base64 | tr -d '\\n')
MEM=$(free -m 2>/dev/null | base64 | tr -d '\\n')
INST=$(tail -15 ${installLog} 2>/dev/null | base64 | tr -d '\\n')
printf 'EXIT=%s SUC=%s TC=%s\\n' "\${EXIT:-}" "$SUC" "\${TC:-0}"
printf 'ERR=%s\\n' "$ERR"
printf 'OOM=%s\\n' "$OOM"
printf 'MEM=%s\\n' "$MEM"
printf 'INST=%s\\n' "$INST"
printf 'TL=%s\\n' "$TL"`;
    const res = await execLite(workspaceId, analysisScript, 30_000);
    const out = res.output || "";
    const b64 = (re: RegExp) => {
      const m = out.match(re);
      return m?.[1] ? Buffer.from(m[1], "base64").toString("utf8") : "";
    };
    const em = out.match(/EXIT=(\d+)/);
    exitCode = em?.[1] ? parseInt(em[1], 10) : null;
    const hadSuccess = /\bSUC=yes\b/.test(out);
    toolCalls = parseInt(out.match(/TC=(\d+)/)?.[1] ?? "0", 10);
    const errRaw = b64(/ERR=([A-Za-z0-9+/=]*)/);
    const msg = errRaw.match(/"errorMessage":"([^"]*)"/)?.[1] ?? "";
    if (msg && !hadSuccess) fatalError = msg;
    tail = b64(/TL=([A-Za-z0-9+/=]*)/);

    // If Pi wrote no exit marker (exitCode null) it was killed, not exited — almost
    // always the OOM-killer. Surface the kernel OOM log, memory state, and install log
    // so the failure is diagnosable instead of an empty tail.
    if (exitCode === null) {
      const oom = b64(/OOM=([A-Za-z0-9+/=]*)/).trim();
      const mem = b64(/MEM=([A-Za-z0-9+/=]*)/).trim();
      const inst = b64(/INST=([A-Za-z0-9+/=]*)/).trim();
      const diag = [
        "── Pi died without an exit marker (process killed). Diagnostics: ──",
        oom ? `OOM-killer log:\n${oom}` : "OOM-killer log: (none found — not an OOM kill)",
        mem ? `Memory (MB):\n${mem}` : "",
        inst ? `npm install log tail:\n${inst}` : "",
      ].filter(Boolean).join("\n");
      if (oom) fatalError = fatalError ?? "Pi process was OOM-killed (out of memory) — see diagnostics.";
      tail = `${diag}\n\n── output file tail (${tail ? "below" : "EMPTY"}) ──\n${tail}`;
    }

    // didWork = Pi did SOMETHING real: a tool call OR any successful assistant turn.
    // Keying off hadSuccess (not just the tool-call grep) makes this format-robust —
    // a real build always has successful assistant turns, so it can never false-fail
    // even if Pi's tool-call event keys differ from the grep above. It's false ONLY
    // when EVERY turn errored (auth/quota/provider failure → genuinely no output).
    didWork = toolCalls > 0 || hadSuccess;
  } catch (err) {
    console.warn(`[pi-cli] final analysis failed:`, (err as Error).message?.slice(0, 120));
  }

  // A detected stall is a failure even if Pi did some work earlier — the build
  // never converged. Surface it so the caller marks the ticket failed.
  if (stalled && !fatalError) {
    fatalError = "agent stalled — repeated the same action for several minutes without progress";
  }

  return { exitCode, fatalError, didWork, toolCalls, tail };
}
