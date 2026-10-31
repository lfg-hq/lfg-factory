# LFG Desktop

Your company's LFG in a window, plus a runner that builds tickets on this computer with
the Claude Code login already here. See `../docs/desktop-runner.md` for how it fits together.

## Use it

1. Install and sign in to Claude Code: run `claude` once in a terminal.
2. Make sure `git` can push to the project's repository from this computer.
3. Open LFG Desktop and click **Sign in with your browser**. Sign in there as usual
   (Google, SSO or password) and choose **Connect**. That signs the app in and connects
   this computer; there is no token to copy.
4. On a ticket, pick **Build on my computer** in the Run menu. Approve it when LFG Desktop asks.

Work happens in `~/LFG/repos` (clones) and `~/LFG/worktrees` (one per ticket branch).
**Sign out on this computer** (menu bar) disconnects it again.

## Which server

The app signs in to LFG Cloud (`https://lfg.run`); it never shows or asks for a server
address. `desktop/try.sh --local` points it at a local test server instead
(`LFG_SERVER_URL`, a developer-only override).

## How sign-in works

The standard flow for desktop apps (OAuth for native apps, RFC 8252), the same one
Slack, Linear or VS Code use. Nothing is signed in to inside the app window.

1. The app listens on a random `127.0.0.1` port and opens `/desktop/authorize` in your browser.
2. Signed in there, you confirm "Connect LFG Desktop on <computer>?".
3. The browser goes to the app's `127.0.0.1` callback with a one-time code (valid 5 minutes).
4. The app sends the code with its PKCE verifier to `/api/desktop/token` and gets this
   computer's runner token and a one-time token that opens a session of its own.

The server accepts only `127.0.0.1` callbacks and same-site confirmations, and a code is
useless without the verifier that never leaves the app.

## Try it in one step

From the repository root, or by double-clicking `desktop/Try LFG Desktop.command` in Finder:

```sh
desktop/try.sh                         # build and open the app, signed in to lfg.run
desktop/try.sh --local                 # a throwaway local server with a demo project instead
desktop/try.sh --local --fake-claude   # …with a stand-in for Claude Code: no usage
desktop/try.sh --local --headless      # …with the runner in the terminal instead of the app
desktop/try.sh --local --reset         # …starting over
```

`--local` runs its own LFG server on its own SQLite database in `.desktop-test/`, so
your Postgres, running builds, Telegram bot and email are not touched. It seeds a test
account, a "Desktop runner demo" project backed by a local Git repo, and one ticket.
The terminal prints the test sign-in. On the ticket, pick **Build on my computer** in
the Run menu and click **Run**. Quitting the app stops the server.

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
