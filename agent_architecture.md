# Agent Architecture

This doc explains how an LFG agent is wired end-to-end: lifecycle, tool-calling, connectors, data room, memory, secrets, and scheduling. Reading it should be enough to debug or extend any individual subsystem without spelunking through code.

## 1. What an agent is

An agent is a per-user, conversation-scoped autonomous worker with:

- Its own **chat conversation** (`conversations` + `messages` rows)
- Its own **Mags VM workspace** (a Firecracker microVM provisioned on demand)
- An opt-in set of **Composio integrations** (per-agent gated)
- An opt-in set of **agent secrets** (encrypted API keys)
- A persistent **long-term memory** (Markdown blob)
- Optional **schedules** (cron triggers for unattended runs)
- A **Data Room** (S3-backed file storage that round-trips into the VM)

Storage layout:
- `agents` — name, instructions, personality, `composioToolkits[]`, `memoryContent`, `sandboxId`, status, run/idle timeouts
- `agent_secrets` — encrypted key/value pairs (AES-256-GCM)
- `agent_data_files` — references to S3 objects in the Data Room
- `agent_schedules` — cron expressions + commands
- `agent_runs`, `agent_events` — observability
- `sandboxes` — Mags workspace handle (`magsWorkspaceId`)

## 2. Lifecycle

```
POST /api/agents          → create agent row (no VM yet)
chat starts               → ensureWorkspace() lazily provisions Mags VM
tool call                 → execOnWorkspace() into VM
idle reaper               → VM sleeps after auto_stop_after_idle_ms
next tool call            → wakes the same workspace (or creates fresh if gone)
DELETE /api/agents/:id    → stop workspace + delete row
```

The VM is lazy: a freshly created agent costs nothing until its first tool call.

`ensureWorkspace(agentId, userId, progress?)` in `agent-manager.ts`:
1. If `agent.sandboxId` exists and Mags reports the job as `running`/`sleeping` → reuse it
2. Otherwise → `newWorkspace()` creates a fresh VM, persist `magsWorkspaceId`
3. Inject agent secrets (`/root/.env`)
4. Inject Data Room files (skip ones already on disk at matching size)
5. Bootstrap the persistent **Python kernel server** if not running

## 3. Sandbox + Python kernel

Two interfaces into the VM:

**`runInSandbox(command)`** — generic shell. Base64-wraps the command (`echo <b64> | base64 -d | bash`) so heredocs / nested quotes / multiline survive the SSH exec layer.

**`runPython(code)`** — POSTs Python code to a long-lived Flask kernel server inside the VM. The kernel exposes `/exec` and runs code in a persistent namespace, so variables / DataFrames / imports survive across tool calls within the same agent session.

Kernel bootstrap (`ensurePythonKernel` in `agent-manager.ts`):
- Creates `/root/venv`, pip-installs (wheels only) `flask pandas numpy matplotlib plotly openpyxl`
- Launches the server with `setsid` + full fd redirect so it survives SSH session close
- Health check on `127.0.0.1:8765/health` for up to 30s

Both `runInSandbox` and `runPython` follow a 3-phase pattern with explicit log markers:
1. **ensureWorkspace** — VM up, secrets/data injected, kernel ready
2. **exec** — actually run the command/code
3. **syncDataRoom** — sweep `/root/data` for new/changed files, upload to S3, broadcast

Each phase's timing is logged with `[runPython 42fe6f44] [phase 2/3] kernel done in 1424ms`.

Output cap: tool results are truncated to 8 KB before being returned to the LLM, so a runaway `print(df.to_string())` can't blow the context window.

## 4. Data Room (S3-backed file storage)

The Data Room is the durable file store for an agent. Files live in S3 under `agents/<agentId>/data/<filename>` and are mirrored into the VM at `/root/data/<filename>` on every workspace bring-up.

**Upload paths:**

- **User upload via chat-input paperclip** → `POST /api/agents/:id/data` → S3 → `agent_data_files` row → no broadcast (the user's bubble already shows the chip).
- **Agent-generated files** → LLM writes to `/root/data/...` from a tool call → `syncDataRoom()` scans the directory, uploads new/changed files to S3, broadcasts `agent_data_file_created`.

**Idempotency:** `injectDataFiles` lists `/root/data` with name+size and skips files already at the expected size (avoids re-curling a 15 MB CSV on every turn). `syncDataRoom` likewise skips files unchanged since last sync, and hard-caps anything over 2.5 MB to avoid the Mags gRPC 4 MB message limit.

**Frontend rendering:**
- Chart files (`.html`, `.png`, `.jpg`, `.svg`, etc.) appear inline in the chat **only when the LLM references them with `[CHART: filename.ext]`** in its response text. The marker is replaced by an iframe/img DOM slot.
- Data files (`.csv`, `.xlsx`, `.json`, `.txt`) never inline-render — they live in the Data Room tab only.

**Listing pipeline** in `agent-sandbox.ts` is base64-wrapped (`find + wc -c + basename`) so its inner quoting survives `ash -lc '<cmd>'` re-wrapping. Without that wrap, the pipeline silently returned empty under busybox/ash.

## 5. Connectors (Composio integrations)

Composio integrations are tiered:

- **User-level** — `composio_toolkits` table records which toolkits the user has globally connected via OAuth (Gmail, Drive, Slack, etc.). Source of truth is Composio's API.
- **Per-agent** — `agents.composioToolkits[]` records which subset is exposed to *this* agent. Strict opt-in: new agents start empty.

**Why two tiers:** users connect Gmail once. Each agent then chooses whether it wants Gmail. An agent without Gmail in its enabled list gets zero Gmail tools loaded — strict scope.

**Slug conventions:**
- **DB storage** (both tables, broadcasts, UI): `UPPERCASE` (`"GOOGLEDRIVE"`)
- **Composio SDK calls** (`session.authorize`, `toolkits.enable`): `lowercase` (`"googledrive"`)
- `getComposioTools()` normalizes to lowercase before passing to the SDK. **Skipping this normalization silently returns zero tools** — caused a long debug loop.

**Tool loading** (`getComposioTools` in `composio-manager.ts`):
- Opens a Composio session with `manageConnections: true` (exposes meta-tools `composio_search_tools` + `composio_execute_tool` rather than statically loading every action)
- Scopes to the agent's enabled toolkits via `toolkits: { enable: [...] }`
- Results are cached for **30 s** keyed on `userId|sorted(slugs)` to absorb the 4× call pattern of a multi-step turn
- Cache is invalidated on any mutation (`saveConnectedToolkit`, `disconnectToolkit`, `requestConnectorAuth` silent path, OAuth callback, settings panel save)

**The auth flow tools** (in `agent-tools.ts`):

- **`lookupComposioToolkits({query})`** — searches Composio's catalog by capability. Returns slugs + `[CONNECTED]` / `[NOT-CONNECTED]` flags. Mandatory first call when the user mentions any external service.

- **`requestConnectorAuth({toolkit})`** — three branches:
  - **Already enabled for this agent** → returns "use composio_search_tools to find the action" (loop guard).
  - **Connected at user level but not yet on this agent** → silently appends to `agent.composioToolkits` + broadcasts `connector_connected` + tells LLM to write a one-line "Connecting X and retrying…" and STOP. The frontend auto-resends the user's last message after the current stream ends.
  - **Not connected at all** → calls Composio's OAuth flow, broadcasts `connector_required`, surfaces the Connect button in chat.

- **`requestSecret({key, description, service})`** — fallback when no Composio connector exists. Renders an inline encrypted-input card; on submit the value is AES-256-GCM-encrypted into `agent_secrets` and the last user message auto-resends.

## 6. Auto-resend after silent enable

The trickiest UX flow:

1. User: "pull SOWs from drive"
2. LLM calls `requestConnectorAuth({GOOGLEDRIVE})` → silent enable → `connector_connected` WS event with `silent_enable: true`
3. LLM finishes its turn with one line: "Connecting Google Drive and retrying…"
4. Frontend (`agents.js`) sees the WS event mid-stream → queues it (`window.__pendingResubmit__`)
5. When the stream's `ai_chunk is_final` arrives, the queued resubmit fires
6. Resend uses **`window.__sendChatMessageSilent__`** — a chat.js bypass that sends the WS message *without* re-rendering a user bubble and *without* going through the form-submit path
7. New stream starts with the toolkit's tools now loaded → real answer streams back

This was iterated through several broken states (duplicate bubbles, infinite loops, "ask me again" UX) before settling on the queue + silent-send approach.

## 7. Secrets

`agent_secrets` table stores `key`, `value_encrypted`, `service`, `description`. Encryption is **AES-256-GCM** keyed off `ENCRYPTION_KEY` env var (`utils/crypto.ts`). Falls back to base64 with a warning if the env is missing (dev-only escape hatch).

**Injection:** every `ensureWorkspace` call decrypts and writes them to `/root/.env` inside the VM. The LLM's `runInSandbox` scripts can `source /root/.env` or read individual vars.

**Never exposed** in API responses or to the LLM directly — only the values inside the sandbox.

## 8. Memory (long-term)

`agents.memoryContent` is a Markdown blob the LLM controls via the **`updateMemory`** tool. The LLM is prompted to save:
- User preferences ("uses metric units", "prefers Slack DMs over email")
- Ongoing-work context ("currently building Conserva SOW v2")
- Patterns and findings worth retaining

It's overwritten in full each call (LLM provides the entire updated doc), not appended — keeps it from growing unbounded. Loaded into the system prompt on every turn.

## 9. Tool steps across turns (Option 1)

The most recent fix. Without it, the LLM saw only its own polished text from past turns, not the tool calls / results that led there. Asking "analyze the doc" right after "fetch the doc" produced "I need the doc content" because the 5.7 KB tool result wasn't in history.

**Fix:**
- Added `tool_steps jsonb` column on `messages`
- `stream-handler.ts` captures `streamText().response.messages` after the stream completes and saves it on the assistant row (200 KB cap)
- `agent-runner.ts` does the same for scheduled runs via `generateText().response.messages`
- On history load, rows with `tool_steps` are expanded verbatim into the next turn's messages array — the LLM sees its own past tool calls + results

Backward compatible: legacy rows have `tool_steps = null` and fall back to text-only replay.

## 10. Schedules

`agent_schedules` rows store `(cron_expression, command, timezone)`. The in-process **agent-scheduler** (`agent-scheduler.ts`) registers each row with a cron library and on fire calls `runAgentTask(agentId, command)` from `agent-runner.ts`.

`runAgentTask` is a non-streaming variant of the chat pipeline:
- Same tools, same system prompt, same per-agent gating
- Uses `generateText` instead of `streamText` (no WS to push chunks to)
- Persists the result as an assistant message in the agent's conversation (including `tool_steps`)
- Broadcasts an `agent_run_completed` event so any open tabs can refresh

Manual triggers: `POST /api/agents/:id/run` or the inline webhook URL on each agent.

## 11. WebSocket event taxonomy

All events fan out via `broadcastToUser(userId, payload)` — every tab open for that user receives them. Filtered client-side by `agentId` when relevant.

| Event | Sender | Frontend handler |
|---|---|---|
| `agent_status` | lifecycle changes | Updates the status badge |
| `agent_progress` | `ensureWorkspace` / `ensurePythonKernel` phases | Renders the centered "Spinning up…" / "Installing libs…" chip |
| `agent_data_file_created` | `syncDataRoom` after upload | Adds to `artifactsByName` registry; fills any pending `[CHART:]` slot |
| `connector_required` | `requestConnectorAuth` OAuth path | Inline "Connect Service" button |
| `connector_connected` | OAuth callback OR silent enable | Auto-resend last user message (queued if mid-stream) |
| `secret_required` | `requestSecret` | Centered dismissable secret card |

## 12. Streaming pipeline (chat side)

`src/ws/chat-handler.ts` is the WS entry point. On a user message:
1. Save user row to `messages`
2. Load recent history (20 messages, expanding `tool_steps`)
3. Resolve model + Composio tools + per-agent tools
4. Build system prompt (`getAgentSystemPrompt` for agents, otherwise the chat default)
5. `streamText({model, tools, messages, stopWhen: stepCountIs(80)})`
6. Forward `text-delta` events to the WS as `ai_chunk` chunks
7. Intercept tool calls for UI pills (`function-call-indicator`)
8. After stream ends, save assistant row with `content` + `toolSteps`
9. Send `ai_chunk is_final` to mark stream complete

**Step cap:** 80 — generous enough for multi-step agent flows (lookup → connect → search → execute → runInSandbox), bounded enough to prevent runaway loops.

## 13. Progress + status UX

Two visual layers when a tool is running:
- **Generic tool pill** (`function-call-indicator` from chat.js) — fires for any tool call in any mode
- **Phase chip** (`agent-progress-chip` from agents.js) — fires for the long-running phases inside `runInSandbox` / `runPython` (provisioning, installing, kernel start, running)

The phase chip carries strictly more info, so CSS (`#chat-messages:has(.agent-progress-chip) .function-call-indicator { display: none }`) hides the generic pill while a phase chip is active. When the phase chip clears, both are gone.

**Scroll anchoring:** `.chat-messages { overflow-anchor: auto }` so removing transient elements (typing indicator, progress chip, file notifications) doesn't reflow the whole conversation up. Those transient elements get `overflow-anchor: none` so the browser anchors to real messages above them.

## 14. Performance notes

| Hot path | Cost | Notes |
|---|---|---|
| `ensureWorkspace` cold start | ~5-7 s | Fresh Mags VM provisioning |
| `ensureWorkspace` warm | ~1-2 s | Just secret + data injection |
| `ensurePythonKernel` cold | ~15-20 s | pip install + flask boot |
| `ensurePythonKernel` warm | ~0.5 s | Single health-check ping |
| `getComposioTools` uncached | ~150-300 ms | Composio session create + tools fetch |
| `getComposioTools` cached | ~1 ms | 30 s TTL |
| `syncDataRoom` | ~1 s + 1 s/MB | gRPC cap blocks >2.5 MB; large files skipped |

A multi-step agent turn (lookup → connect → search → execute → runInSandbox) typically: ~25 s cold (mostly kernel install), ~5-8 s warm. Composio call latency dominates the warm path.

## 15. Prompt rules (high level)

Worth knowing what `agent.ts` enforces; the model's behavior follows these:

- **Catalog lookup is mandatory** when the user mentions any external service ("Drive", "Gmail", "my CRM") — call `lookupComposioToolkits` first, don't speculate from training data.
- **OAuth before raw key.** `requestConnectorAuth` for any service Composio has a connector for; `requestSecret` only as a last resort for proprietary APIs.
- **Don't bounce back to the user** if a tool returned a URL — fetch it via `runInSandbox` + Python `urllib`.
- **Prefer content-returning actions** over file-returning ones when both exist (`get_document_text` over `export_file`).
- **Trust your own history.** If a tool worked on a past turn, it works now. Don't claim "no working X connector" after successful use.
- **Every chart needs a `[CHART: name.html]` marker** in the response text — otherwise it won't render inline.

## 16. Where to look when something breaks

- LLM picks wrong tool / refuses → `src/ai/prompts/agent.ts`
- Tool call doesn't fire / hangs → grep server log for `[runInSandbox <agentId>]` or `[runPython <agentId>]` 3-phase markers
- Drive/Gmail loops on `requestConnectorAuth` → check `composioToolkits` slug case (must lowercase for Composio SDK; uppercase in DB)
- Chart never renders inline → check the response text for the `[CHART: filename]` marker; check `agent_data_files` row exists for that filename
- "I need that doc" right after fetching it → `tool_steps` not being persisted; check `messages` row for the prior assistant turn
- Workspace stuck "Spinning up sandbox VM…" → Mags health; `[ensureWorkspace]` log lines
- Kernel install timeout → `/tmp/kernel.log` dump appears in server log on failure
- Stale connector list → bump or invalidate the `getComposioTools` cache (`invalidateComposioToolsCache(userId)`)
