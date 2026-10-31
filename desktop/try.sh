#!/usr/bin/env bash
# One-click LFG Desktop test.
#
# Starts a throwaway LFG server on its own SQLite database (your Postgres, builds and
# bots are untouched), seeds a demo project + ticket backed by a local Git repo,
# pairs this computer, and launches LFG Desktop already connected. Everything lives
# in .desktop-test/. Quit the app (menu bar "LFG" → Quit) to stop the server too.
#
#   desktop/try.sh                  the desktop app, with your real Claude Code
#   desktop/try.sh --fake-claude    a stand-in for Claude Code (no usage, ~2 seconds)
#   desktop/try.sh --headless       the runner in this terminal instead of the app
#   desktop/try.sh --reset          start over with a fresh database and demo repo
#
# Port: 8100, or set LFG_DESKTOP_TEST_PORT. Google sign-in is offered only on port 8000,
# the callback your Google OAuth client allows; elsewhere use the printed test account.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${LFG_DESKTOP_TEST_PORT:-8100}"
DIR="$ROOT/.desktop-test"
URL="http://localhost:$PORT"
MODE=app FAKE=0 RESET=0
for arg in "$@"; do
  case "$arg" in
    --headless) MODE=headless ;;
    --fake-claude) FAKE=1 ;;
    --reset) RESET=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Prerequisites ─────────────────────────────────────────────────
say "Checking prerequisites"
for tool in bun git npm node curl; do command -v "$tool" >/dev/null || die "$tool is not installed."; done
[ -f .env ] || die "No .env in $ROOT. Copy the one from your main checkout."
if [ "$FAKE" = 0 ]; then
  command -v claude >/dev/null || die "Claude Code isn't installed. Install it and run 'claude' once to sign in, or use --fake-claude."
  echo "  Claude Code $(claude --version 2>/dev/null | head -1)"
fi
if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "Port $PORT is busy. Stop whatever uses it, or run: LFG_DESKTOP_TEST_PORT=8200 $0"
fi

# ── 2. Dependencies ──────────────────────────────────────────────────
[ -e node_modules ] || { say "Installing server dependencies"; bun install; }
[ -d desktop/node_modules ] || { say "Installing desktop dependencies"; (cd desktop && npm install --no-audit --no-fund); }
say "Building LFG Desktop"
(cd desktop && npm run build --silent)

# ── 3. Isolated environment ──────────────────────────────────────────
[ "$RESET" = 1 ] && { say "Resetting .desktop-test"; rm -rf "$DIR"; }
mkdir -p "$DIR/work" "$DIR/uploads"
# Your .env minus anything that would touch shared state: database, URLs, captcha,
# outgoing email, the Telegram bot and file storage are replaced below.
# Google only accepts the callback URLs registered for your OAuth client (normally
# port 8000). On any other port its button would just fail, so it's left out.
GOOGLE_KEYS=""; if [ "$PORT" != 8000 ]; then GOOGLE_KEYS="|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET"; fi
grep -vE '^(DATABASE_DRIVER|DATABASE_URL|POSTGRES_(HOST|PORT|DB|USER|PASSWORD)|PORT|APP_URL|BETTER_AUTH_URL|TURNSTILE_SITE_KEY|TURNSTILE_SECRET_KEY|TELEGRAM_PUBLIC_BOT_TOKEN|TELEGRAM_PUBLIC_BOT_OWNER_ID|SENDGRID_API_KEY|FILE_STORAGE_TYPE|LOCAL_STORAGE_DIR'"$GOOGLE_KEYS"')=' .env > "$DIR/test.env"
cat >> "$DIR/test.env" <<EOF

# ── desktop/try.sh overrides ──
DATABASE_DRIVER=sqlite
DATABASE_URL=$DIR/lfg.db
PORT=$PORT
APP_URL=$URL
BETTER_AUTH_URL=$URL
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
TELEGRAM_PUBLIC_BOT_TOKEN=
TELEGRAM_PUBLIC_BOT_OWNER_ID=
SENDGRID_API_KEY=
FILE_STORAGE_TYPE=local
LOCAL_STORAGE_DIR=$DIR/uploads
EOF
chmod 600 "$DIR/test.env"

say "Seeding the demo account, project, ticket and Git repo"
SETUP="$(bun --env-file="$DIR/test.env" scripts/desktop-test-setup.ts "$DIR" 2>"$DIR/setup.log" | tail -1)" \
  || { cat "$DIR/setup.log" >&2; die "Seeding failed (see above)."; }
field() { SETUP_JSON="$SETUP" FIELD="$1" bun -e 'console.log(JSON.parse(process.env.SETUP_JSON)[process.env.FIELD])'; }
EMAIL="$(field email)"; PASSWORD="$(field password)"; TOKEN="$(field token)"
PROJECT_URL="$URL$(field projectUrl)"; TICKET="$(field ticketKey) $(field ticketName)"; ORIGIN="$(field origin)"

# ── 4. Server ────────────────────────────────────────────────────────
say "Starting the test server on $URL (log: .desktop-test/server.log)"
bun --env-file="$DIR/test.env" src/index.ts >"$DIR/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for _ in $(seq 1 90); do
  curl -sf -o /dev/null "$URL/auth/login" && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -30 "$DIR/server.log" >&2; die "The server stopped while starting."; }
  sleep 1
done
curl -sf -o /dev/null "$URL/auth/login" || { tail -30 "$DIR/server.log" >&2; die "The server didn't come up within 90 seconds."; }

# ── 5. Optional stand-in for Claude Code ─────────────────────────────
if [ "$FAKE" = 1 ]; then
  cat > "$DIR/fake-claude" <<'EOF'
#!/bin/bash
# Stand-in for `claude -p`: makes a small real change and prints stream-json.
if [ "$1" = "--version" ]; then echo "0.0.0 (stand-in for Claude Code)"; exit 0; fi
cat >> style.css <<'CSS'
body.dark { background: #111; color: #eee; }
CSS
sed -i '' 's#</body>#  <button onclick="document.body.classList.toggle(\x27dark\x27)">Toggle dark mode</button>\n</body>#' index.html 2>/dev/null || true
echo '{"type":"system","subtype":"init"}'
sleep 1
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"index.html"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Added a toggle button"}]}}'
sleep 1
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Added a dark mode toggle (stand-in run, not real Claude Code)."}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added a dark mode toggle."}'
EOF
  chmod +x "$DIR/fake-claude"
  export LFG_CLAUDE_BIN="$DIR/fake-claude"
fi

# ── 6. Go ────────────────────────────────────────────────────────────
cat <<EOF

  ┌─ LFG Desktop test ─────────────────────────────────────────────
  │ Server     $URL   (isolated: .desktop-test/lfg.db)
  │ Sign in    $EMAIL
  │ Password   $PASSWORD
  │ Project    $PROJECT_URL
  │ Ticket     $TICKET  →  open it, click "Run on my computer"
  │ Claude     $([ "$FAKE" = 1 ] && echo "stand-in (--fake-claude)" || echo "your Claude Code login (uses your plan)")
  │ See result git --git-dir "$ORIGIN" log --all --oneline --stat
  └────────────────────────────────────────────────────────────────

EOF

export LFG_SERVER_URL="$URL" LFG_RUNNER_TOKEN="$TOKEN" LFG_RUNNER_ALLOW_LOCAL_REPOS=1 LFG_WORK_ROOT="$DIR/work"
if [ "$MODE" = headless ]; then
  say "Runner running here (Ctrl+C to stop). Open $PROJECT_URL in your browser and sign in with the details above."
  node desktop/dist/cli.js --server "$URL" --token "$TOKEN" --auto-approve --work-root "$DIR/work"
else
  say "Opening LFG Desktop. Sign in inside the app window. Quit it from the menu bar (LFG → Quit LFG) to stop everything."
  LFG_DESKTOP_PROFILE=test desktop/node_modules/.bin/electron desktop
fi
