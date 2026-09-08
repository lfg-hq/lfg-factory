# Ticket code workspace

Ticket cards and the detail drawer link to `/projects/:projectId/tickets/:ticketId/diff` in a new browsing context. `?base=main&file=src/app.ts` preserves the selected comparison and file.

The workspace uses a locally served Monaco Editor, with a searchable changed/all-files list, side-by-side comparison against the local merge base, an editable working tree, language and word suggestions, and formatting for supported languages. Suggestions are Monaco language features, not AI completions or a server language service.

Files are read from the latest ticket sandbox or its shared worktree. A live checkout and its comparison branch are required; the page explains when to build/restore the ticket or fetch the base. It does not provision or overwrite a checkout merely by opening the page.

Saving writes only the selected UTF-8 text file (up to 1 MB), preserving its permissions. A content version rejects stale writes; symlinks and paths outside the repository are rejected. A dialog then offers an optional local commit of that file. It does not push or merge, and unrelated staged files are excluded. Project edit permission is required for saving, committing, or running commands. Mutations are blocked while the ticket's execution queue or chat turn is active.

The terminal is a command runner in the ticket directory with a 60-second timeout and capped output. Each command starts a fresh shell; use `cd subdir && command` within a command. Interactive programs and persistent PTY sessions are not supported.

Validation:

- `npm run typecheck`
- `python3 scripts/test-ticket-code.py` — real temporary Git repositories, diff scope, file-only commits, stale saves, invalid paths, binary files, and wrong branches.
- `node scripts/test-ticket-code-browser.cjs` — Node 20+, Chrome (override with `CHROME_PATH`); local mocked sandbox API with the actual Monaco assets. Tests diff/editor views, save/optional commit, terminal, filtering, responsive layout, conflict preservation, and read-only mode. Screenshots are written to a temporary directory.
