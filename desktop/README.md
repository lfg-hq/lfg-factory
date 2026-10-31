# LFG Desktop

Your company's LFG in a window, plus a runner that builds tickets on this computer with
the Claude Code login already here. See `../docs/desktop-runner.md` for how it fits together.

## Use it

1. Install and sign in to Claude Code: run `claude` once in a terminal.
2. Make sure `git` can push to the project's repository from this computer.
3. In LFG: Settings → Integrations → Computers → **Connect a computer**.
4. Start the app and paste the address and token.
5. On a ticket, choose **Run on my computer**. Approve it when LFG Desktop asks.

Work happens in `~/LFG/repos` (clones) and `~/LFG/worktrees` (one per ticket branch).

## Try it in one step

From the repository root, or by double-clicking `desktop/Try LFG Desktop.command` in Finder:

```sh
desktop/try.sh                 # the app, with your real Claude Code
desktop/try.sh --fake-claude   # a stand-in for Claude Code: no usage, done in seconds
desktop/try.sh --headless      # the runner in the terminal instead of the app
desktop/try.sh --reset         # start over
```

It starts a separate LFG server on http://localhost:8100 with its own SQLite database
in `.desktop-test/`, so your Postgres, running builds, Telegram bot and email are not
touched. It seeds a test account, a "Desktop runner demo" project backed by a local Git
repo, and one ticket; pairs this computer; and opens LFG Desktop already connected. The
terminal prints the test sign-in. On the ticket, pick **Build on my computer** in the
Run menu and click **Run**. Quitting the app stops the server.

## Develop

```sh
npm install
npm start          # build and launch the app
npm run runner -- --server http://localhost:8000 --token lfgr_… --auto-approve   # headless
npm run dist       # package with electron-builder (unsigned)
```

`src/runner.ts` is plain Node with no Electron imports, so the app, the CLI and the
tests in `../tests/runner-e2e.test.ts` all use the same code. `src/protocol.ts` is a
copy of the server's `src/services/runner/protocol.ts`; keep them in sync.

Claude Code tools allowed by default: Read, Edit, Write, Glob, Grep, Bash. A job can ask
for fewer, never more.
