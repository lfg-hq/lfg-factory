# LFG Desktop runner — "Use my computer for AI"

Created: 2026-10-31. Status: first working version on `claude/desktop-runner`.

## What it is

Chat, documents, tickets, logs and branches stay on the company's LFG server, visible
to everyone with access. Coding for a ticket can instead run on the requester's own
computer: LFG Desktop receives the job, runs Claude Code there with the login already
on that machine, then commits and pushes the ticket branch with that person's own Git
credentials. Neither a Claude credential nor a Git token leaves the computer.

```
Company LFG server (Postgres)                     Jane's computer: LFG Desktop
  tickets, docs, chat, logs     ◄── wss /ws/runner ──  runner (outbound only)
  runner hub: routes jobs                              ├ git clone/fetch (Jane's creds)
  to the requester's devices                           ├ worktree on the ticket branch
                                                       ├ claude -p (Jane's Claude Code)
                                                       └ commit + push
```

## Use my computer for AI

One switch per person (Settings → Integrations), plus an agent choice: **Claude Code**,
**OpenAI Codex** or **GitHub Copilot** — whichever is installed and signed in on their
computer. When it's on, that person's AI work runs on their computer; everything it
produces is saved in LFG for the team.

| What | Where it runs when on |
|---|---|
| Project chat (planning, PRDs, tickets) | the agent on their computer, via LFG's MCP tools |
| **Build** on a ticket (button, chat tools, build runs) | the agent on their computer, in a worktree; pushes the branch |
| Ticket chat follow-ups | the agent on their computer, continuing its session on that ticket |
| Instant apps, custom agents, checks/preview/merge | LFG's server, as before |

How a chat turn flows: `stream-handler.ts` builds the turn as usual, then
`services/runner/chat-turn.ts` sends it to LFG Desktop as a `chat_turn` job with a
one-turn MCP token. The agent answers read-only on the computer and uses LFG's tools at
`/mcp/turn/:turnId` (`routes/mcp-server.ts`, tokens in `services/runner/turn-tokens.ts`),
so documents and tickets land in the DB. Its events come back as AI SDK stream events,
so cards, document panels, activity and saving work as for any chat. The agent's session
is continued on the next turn.

**Model, effort, prompt.** The chat's Model menu offers the agent's own default or, for
Claude Code, Opus, Sonnet, Haiku or Fable (`--model`); an Effort menu sets `--effort`
(Codex: `model_reasoning_effort`, up to high). Saved per person (`profiles.local_model`,
`profiles.local_effort`) and used for chat turns and builds. For chat turns LFG's prompt
*replaces* Claude Code's own (`--system-prompt`), so the chat answers as it does on the
web; builds keep Claude Code's prompt and add LFG's.

**Context and compaction.** Each turn carries the same per-turn block as the web chat
(@ticket context, branch, notes, plan). The agent's session is continued per
conversation and the agent compacts it itself; LFG shows that as "condensed earlier
context". When there is no session on that computer (first turn there, another
computer, an expired session) the agent starts from LFG's saved summary of older turns
plus the latest messages. LFG doesn't refresh its own summary after local turns.

**Plan usage.** Claude Code reports the plan's 5-hour and weekly windows on every turn
(`rate_limit_event`). The runner forwards them, the server keeps the latest per person
(`profiles.local_agent_usage`, `GET /api/settings/local-usage`, pushed live as
`local_agent_usage`), and the composer shows a usage ring with a popover. Codex and
Copilot don't report plan limits; the popover then shows the last turn's tokens.

Agent adapters live in `desktop/src/agents.ts` (one per CLI, all producing the same
events). Claude Code's output format is verified; Codex follows its documented
`codex exec --json` events; Copilot CLI's JSON output isn't documented and is parsed
defensively — check both with real installs.

## Rules the code enforces

- **Opt-in, per person.** "Use my computer for AI" is off until the person turns it on
  in Settings → Integrations (`profiles.desktop_builds_enabled`, `profiles.local_agent`).
  Off: everything uses LFG's server AI as before.
- **A job runs only on the requester's devices.** `runner_job.userId` is the person who
  clicked "Run on my computer"; the hub never offers it to anyone else's device, and a
  device can only report on jobs offered to it.
- **Jobs, not commands.** The server sends a `claude_task` (repo, branch, prompt). It
  never sends shell commands. The runner validates branch names and repository URLs,
  and limits Claude Code's tools to its own allow-list (a job can only narrow it).
  The one exception is a `preview` job: it carries the project's saved preview plan
  (install / build / run commands), so LFG Desktop shows those exact commands and asks
  before running them, and asks again whenever they change (see below).
- **The person approves.** LFG Desktop asks before each job, unless they ticked
  "always run jobs for this project". The headless CLI declines everything unless
  started with `--auto-approve`.
- **No silent fallback.** If the computer is offline the ticket waits ("Waiting for
  your computer"). It never moves to a cloud sandbox or another key on its own.
- **Sign-in happens in the person's browser**, never inside the app window (RFC 8252,
  as Slack, Linear and VS Code do). Signing in to the app pairs the computer; there is
  no token to copy. Tokens from Settings are only for the headless `lfg-runner`.
- **Device tokens** are random, shown once at pairing, stored on the server only as a
  SHA-256 hash, and revocable (revoking disconnects the device immediately). On the
  computer the token is encrypted with the OS keychain (Electron `safeStorage`).

## Pieces

| Where | File |
|---|---|
| Tables `runner_device`, `runner_job` | `src/db/schema/{sqlite,pg}/runners.ts` |
| Wire protocol | `src/services/runner/protocol.ts` (copied to `desktop/src/protocol.ts`) |
| Connections, routing, job state, ticket logs | `src/services/runner/hub.ts` |
| Ticket → job (prompt, branch, base branches) | `src/services/runner/ticket-job.ts` |
| Pair / list / revoke computers | `src/routes/api/runner.ts` (`/api/runner/*`) |
| Desktop sign-in (browser, PKCE, 127.0.0.1 callback) | `src/routes/desktop.ts`, `src/services/runner/desktop-auth.ts`, `desktop/src/browser-signin.ts` |
| Start on a ticket | `POST /api/projects/:projectId/tickets/:ticketId/run-local` |
| Stop | the existing ticket Stop also cancels runner jobs |
| WebSocket | `/ws/runner` in `src/index.ts` (Bearer device token, no session) |
| Settings UI | Settings → Integrations → Computers: the opt-in switch, computers, headless tokens (`public/js/runner-computers.js`, `src/services/runner/opt-in.ts`) |
| Ticket UI | "Build on my computer" in the Tickets drawer Run menu, only when turned on (`tickets-list.tsx`) |
| Desktop app | `desktop/` (Electron shell, runner core, headless CLI) |

## Previews on your computer

With "Use my computer for AI" on, the Preview tab runs the app on the person's computer
instead of starting a cloud (Mags) sandbox. It falls back to the cloud only when the
setting is off, the ticket's "Build with" is `cloud`, or the person picks "Run in the
cloud instead" (remembered per project in that browser).

- **Server:** `src/services/runner/preview-job.ts`. A `preview` runner job (protocol 3)
  carries the repo, the branch (a ticket's, an epic's, or the default), the saved plan
  from `project_environment.setup_manifest` (install, build, run, ports, the switched-on
  companion apps, databases, migrations, seed) and the project's env vars. The preview's
  state (status, steps, log, `http://localhost` addresses) is kept on that person's job
  row, not on the project's shared preview row, because it only exists on their computer.
  Starting another preview of the same project (branch switch, Update & rebuild, Restart)
  cancels the previous job first. `GET/POST /api/projects/:id/preview*` route to it.
- **Computer:** `desktop/src/preview.ts`. Each project has one folder,
  `~/LFG/previews/<project>`: a git worktree of the same clone builds use
  (`~/LFG/repos/<hash>`), checked out detached. It is separate from the build worktrees
  (`~/LFG/worktrees/<branch>`) because a build recreates its worktree from scratch and
  would pull files out from under a running app; detached, it never holds a branch a
  build needs. A plain restart reuses what's installed; Update & rebuild fetches and
  installs again. Apps are told `HOST=127.0.0.1` and `0.0.0.0` in commands becomes
  `127.0.0.1`, so they aren't reachable from the local network.
- **Approval:** the first run of a plan shows its commands and asks; "Don't ask again for
  these commands" remembers project + a hash of the commands, so a changed plan asks
  again. A project without a saved plan is worked out from the repository (package.json,
  manage.py, Gemfile); with none of those, it says to run it once in the cloud.
- **Databases:** a connection variable already set in the project's Env tab is used
  as-is. Otherwise LFG Desktop uses Postgres / MySQL / Redis / SQL Server already
  running on its usual port, else starts one in Docker (`lfg-preview-<engine>`, with a
  named volume), else stops with a plain message naming what to install. Seed data runs
  once per database; migrations run every time.
- **Waiting / old app:** with no LFG Desktop connected the Preview tab shows "Waiting for
  your computer". A computer on protocol 2 (an older LFG Desktop) is never offered a
  preview; the tab says to update LFG Desktop or run it in the cloud.
- **Showing it:** the Preview tab frames `http://localhost:<port>` directly. In LFG
  Desktop that always works. In a normal browser on lfg.run it works in Chrome, Edge and
  Firefox, which treat `http://localhost` as a secure origin an https page may frame
  (Chrome may first ask to allow local network access); Safari blocks it as mixed
  content. Either way the address only works on the computer running the app, so the tab
  always shows "Open in new tab" next to it. The same-origin preview proxy is off for
  computer previews: it runs on LFG's server, which can't reach anyone's localhost.
- **Not covered yet:** background workers from the plan, raw `sqlScripts`, the App /
  Shell / database log panes (the app's output streams into the Setup log instead),
  screenshots, and the chat's `@preview` tools, which still act on the cloud sandbox.

## Staying connected

A laptop that sleeps or changes Wi-Fi can keep a socket that looks open on both ends but
carries nothing. The server pings every runner every 25 s and drops one silent for 75 s,
so its offered jobs go back to the queue. LFG Desktop reconnects when a pinging server
has been silent for 75 s, when a connection attempt stalls, and on waking from sleep.
While a chat turn waits for the computer, the chat shows where it is ("Waiting for your
computer…", "Claude Code on <computer> is working…").

## Job lifecycle

`queued` → `offered` (sent to a device) → `running` (accepted) → `succeeded` | `failed`.
Also `rejected` (declined on the computer) and `cancelled` (Stop).

- The ticket is set to `queueStatus: executing` from the start. `queued` would let the
  cloud ticket worker pick it up after a server restart.
- An offered job whose device disconnects goes back to `queued` for another of the
  same person's devices. A running job survives a disconnect for 2 minutes; if the
  device reconnects without it (app restarted), it fails right away.
- On success with changes the ticket moves to `review` with `githubBranch` and
  `githubCommitSha` set. With no changes it returns to `open`.

## Not covered yet

- **The cloud build pipeline doesn't run after a local build**: no validation,
  feature tests, preview, demo or merge. The ticket lands in `review` with the pushed
  branch. Running those checks from the pushed branch in a server sandbox is the
  natural next step (it also gives everyone a shareable preview).
- **Ticket chat** follow-ups still go to the cloud agent, not the computer.
- The prompt is a simpler version of the cloud build prompt (no addenda, directives,
  design references or attachments yet).
- Restarting the server clears the ticket's `executing` flag (the cloud worker resets
  it), though the job keeps running and still updates the ticket when it finishes.
- The desktop app isn't signed or notarized, and has no auto-update or tray icon art.

## Testing

```sh
bun test tests/runner-hub.test.ts   # routing, ownership, reconnects, cancel, decline
bun test tests/runner-e2e.test.ts   # real WebSocket + runner + git, stand-in `claude`
bun test tests/desktop-auth.test.ts # browser sign-in: PKCE, one-time codes, app session
bun test tests/desktop-opt-in.test.ts # setting, agent choice; Build and ticket chat go to the computer
bun test tests/runner-preview.test.ts # previews: where they run, waiting, old app, reports, restart/stop
bun test tests/desktop-preview.test.ts # LFG Desktop running a real repo's app: branches, ports, databases, cancel
bun test tests/desktop-agents.test.ts # Claude / Codex / Copilot output → one event shape
bun test tests/mcp-endpoint.test.ts   # LFG's tools over MCP: tokens, schemas, writes
bun test tests/local-chat-e2e.test.ts # a chat turn on the computer, through the real chat handler
cd desktop && npm install && npm run typecheck
```

Run DB-backed test files one at a time: they share one cached DB connection per process.

Try the whole flow in one step (isolated server, seeded demo, app already paired):

```sh
desktop/try.sh --local --fake-claude   # local test server; drop --fake-claude for real Claude Code
```

Or by hand: pair a computer in Settings → Integrations → Computers, then

```sh
cd desktop && npm start                                    # the app
cd desktop && npm run runner -- --server http://localhost:8000 --token lfgr_… --auto-approve
```
