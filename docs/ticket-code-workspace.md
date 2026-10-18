# Ticket code workspace

Ticket cards and the detail drawer link to `/projects/:projectId/tickets/:ticketId/diff` in a new browsing context. `?base=main&file=src/app.ts` preserves the selected comparison and file.

The workspace uses a locally served Monaco Editor, with a searchable changed/all-files list, side-by-side comparison against the local merge base, an editable working tree, language and word suggestions, and formatting for supported languages. Suggestions are Monaco language features, not AI completions or a server language service.

Opening Coding now uses `openTicketWorkspace`: reuse a responsive checkout, wake a sleeping VM, or restore a confirmed expired workspace into an independent clone of the prepared project environment. Recovery never resets a live checkout. Project editors can provision replacements; viewers can use or wake existing checkouts. Unknown provider/transport failures do not trigger replacement. The browser polls HTTP 202 responses for recovery progress, so clone startup is not tied to a single long HTTP request.

Recovery prefers a private checkpoint containing Git history (including local commits), the index, tracked working files, deletions, and non-ignored untracked files. Legacy tickets without a checkpoint restore their recorded commit, or their ticket branch if no commit was recorded; recovery never falls back to main. Missing branches/commits fail explicitly. Ignored runtime configuration and dependencies are inherited from the prepared environment. This does not recover ignored files unique to an expired ticket VM.

Checkpoints are verified by SHA-256 and atomically replaced under `data/ticket-checkpoints` on the LFG server's persistent data volume, with private file permissions. `TICKET_CHECKPOINT_DIR` can override the location and must point to persistent private storage. Keep this directory in server backups. The archive and expanded payload are limited to 64 MB; unresolved index conflicts, submodules, oversize archives, and storage/transfer failures block checkpointing and leave the dedicated VM awake. No secrets or credentials from `.git/config` are included. Git-ignored files are omitted.

Build/chat wind-down and Coding mutations checkpoint before releasing the dedicated VM's awake pin. Chat continuation and isolated API build retries share the recovery service and preserve existing edits. A database lock row serializes recovery and Coding mutations across application processes. An interrupted process deliberately leaves its lock: reconcile any saved clone intent before removing `ticket-workspace-lock-<ticketId>` from `sandbox`. Never clear a lock for a running operation. Progress polling uses process memory; the current single-server deployment is supported, and multi-server deployment needs sticky routing plus shared checkpoint storage.

Saving writes only the selected UTF-8 text file (up to 1 MB), preserving its permissions. A content version rejects stale writes; symlinks and paths outside the repository are rejected. A dialog then offers an optional local commit of that file. It does not push or merge, and unrelated staged files are excluded. Project edit permission is required for saving, committing, or running commands. Mutations are blocked while the ticket's execution queue or chat turn is active.

The terminal is a command runner in the ticket directory with a 60-second timeout and capped output. Each command starts a fresh shell; use `cd subdir && command` within a command. Interactive programs and persistent PTY sessions are not supported.

Validation:

- `npm run typecheck`
- `bun test tests/ticket-workspace.test.ts` — lifecycle, legacy recovery, permission, uncertainty, and duplicate-opening checks.
- `python3 scripts/test-ticket-checkpoint.py` — actual Git checkpoint round trips, staged/unstaged files, local commits, deletions, untracked binary files, and failure guards.
- `python3 scripts/test-ticket-code.py` — real temporary Git repositories, diff scope, file-only commits, stale saves, invalid paths, binary files, and wrong branches.
- `node scripts/test-ticket-code-browser.cjs` — Node 20+, Chrome (override with `CHROME_PATH`); local mocked sandbox API with the actual Monaco assets. Tests diff/editor views, save/optional commit, terminal, filtering, responsive layout, conflict preservation, and read-only mode. Screenshots are written to a temporary directory.

The Coding script URL includes its content hash so deployments cannot reuse an older cached client against the recovery API. Tree responses are validated before replacing the current file list. For workspace recovery only, a prepared preview with an app/branch error can still be cloned after its `/data/project` checkout passes a live Git probe; ordinary build provisioning retains its working-preview requirement.
