# LFG Desktop runner

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

## Rules the code enforces

- **A job runs only on the requester's devices.** `runner_job.userId` is the person who
  clicked "Run on my computer"; the hub never offers it to anyone else's device, and a
  device can only report on jobs offered to it.
- **Jobs, not commands.** The server sends a `claude_task` (repo, branch, prompt). It
  never sends shell commands. The runner validates branch names and repository URLs,
  and limits Claude Code's tools to its own allow-list (a job can only narrow it).
- **The person approves.** LFG Desktop asks before each job, unless they ticked
  "always run jobs for this project". The headless CLI declines everything unless
  started with `--auto-approve`.
- **No silent fallback.** If the computer is offline the ticket waits ("Waiting for
  your computer"). It never moves to a cloud sandbox or another key on its own.
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
| Start on a ticket | `POST /api/projects/:projectId/tickets/:ticketId/run-local` |
| Stop | the existing ticket Stop also cancels runner jobs |
| WebSocket | `/ws/runner` in `src/index.ts` (Bearer device token, no session) |
| Settings UI | Settings → Integrations → Computers (`public/js/runner-computers.js`) |
| Ticket UI | "Run on my computer" in the chat ticket panel (`public/js/ticket-agent.js`) and "Build on my computer" in the Tickets drawer Run menu (`tickets-list.tsx`) |
| Desktop app | `desktop/` (Electron shell, runner core, headless CLI) |

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
cd desktop && npm install && npm run typecheck
```

Run DB-backed test files one at a time: they share one cached DB connection per process.

Try the whole flow in one step (isolated server, seeded demo, app already paired):

```sh
desktop/try.sh --fake-claude   # or without the flag to use your real Claude Code
```

Or by hand: pair a computer in Settings → Integrations → Computers, then

```sh
cd desktop && npm start                                    # the app
cd desktop && npm run runner -- --server http://localhost:8000 --token lfgr_… --auto-approve
```
