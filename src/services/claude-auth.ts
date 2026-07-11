/**
 * Claude Code CLI Authentication Service
 *
 * Ports the Django factory/claude_code_utils.py auth flow to TypeScript.
 *
 * Flow:
 *  1. startClaudeAuth(workspaceName)
 *     - Installs Node, Claude CLI, expect in a Mags VM
 *     - Runs an expect script that launches `claude` and captures the OAuth URL
 *     - Returns { status: 'pending', oauthUrl } or { status: 'already_authenticated' }
 *
 *  2. submitAuthCode(workspaceName, code)
 *     - Writes the code to /tmp/claude_code.txt inside the VM
 *     - The expect script picks it up and completes the OAuth flow
 *     - Polls /tmp/claude_status.txt until SUCCESS
 *
 *  3. checkAuthStatus(workspaceName)
 *     - Checks ~/.claude/.credentials.json exists and has accessToken
 *     - Optionally verifies by running claude -p "reply just the word Hello"
 *
 *  4. saveCredentialsToDB(workspaceName, userId)
 *     - Reads ~/.claude/.credentials.json from VM, stores in profiles table
 *
 *  5. loadCredentialsFromDB(userId, workspaceName)
 *     - Reads credentials from profiles table, writes to VM
 */

import { execOnWorkspace } from "./mags.ts";
import { db } from "../config/db.ts";
import { profiles } from "../db/schema/users.ts";
import { eq } from "drizzle-orm";

// ── Auth status check ─────────────────────────────────────────────────────

export interface AuthStatusResult {
  authenticated: boolean;
  message: string;
  sandboxTimeout?: boolean;
  tokenExpired?: boolean;
}

/**
 * Check if Claude Code is authenticated in the VM.
 * First does a cheap file check, then optionally runs `claude -p "..."` to verify.
 */
export async function checkAuthStatus(workspaceName: string): Promise<AuthStatusResult> {
  // Quick credentials check
  let quickOut: string;
  try {
    const r = await execOnWorkspace(workspaceName,
      `if [ -f ~/.claude/.credentials.json ] && [ -s ~/.claude/.credentials.json ]; then echo CREDS_EXIST; grep -q "accessToken" ~/.claude/.credentials.json 2>/dev/null && echo HAS_TOKEN; else echo NO_CREDS; fi`,
      { timeout: 20_000 }
    );
    quickOut = r.output;
  } catch {
    return { authenticated: false, message: "Workspace unresponsive", sandboxTimeout: true };
  }

  if (quickOut.includes("NO_CREDS")) {
    return { authenticated: false, message: "No credentials found" };
  }

  if (!quickOut.includes("HAS_TOKEN")) {
    return { authenticated: false, message: "Credentials incomplete" };
  }

  // Verify token by running a quick claude prompt
  try {
    const r = await execOnWorkspace(workspaceName,
      `[ -f /etc/profile ] && . /etc/profile; [ -f ~/.profile ] && . ~/.profile; export PATH=/root/node/current/bin:/root/.npm-global/bin:$PATH; cd ~; timeout 12 claude -p "reply just the word Hello" 2>&1 | head -20`,
      { timeout: 20_000 }
    );
    const out = r.output.toLowerCase();

    if (r.exitCode === 0 && out.includes("hello")) {
      return { authenticated: true, message: "Claude Code is authenticated" };
    }

    // Explicit auth errors — check these BEFORE timeout fallback
    if (out.includes("not logged in") || out.includes("authenticate") ||
        out.includes("oauth") || out.includes("expired") || out.includes("please run /login") ||
        out.includes("401") || out.includes("authentication_error")) {
      await execOnWorkspace(workspaceName, "rm -f /root/.claude/.credentials.json", { timeout: 10_000 }).catch(() => {});
      return { authenticated: false, message: "Token expired — please reconnect", tokenExpired: true };
    }

    // Timeout or killed — VM is slow but creds exist, assume authenticated
    if (out.includes("killed") || out.includes("timed out") || [137, 124].includes(r.exitCode)) {
      return { authenticated: true, message: "Credentials found (verification skipped due to timeout)" };
    }

    // Non-zero but no explicit auth error — assume ok (transient issue)
    return { authenticated: true, message: "Credentials found (verification inconclusive)" };
  } catch {
    return { authenticated: true, message: "Credentials found (could not verify)" };
  }
}

// ── OAuth flow ────────────────────────────────────────────────────────────

export interface StartAuthResult {
  status: "already_authenticated" | "pending" | "error";
  oauthUrl?: string;
  message?: string;
  error?: string;
}

/**
 * Start the Claude OAuth flow on an existing VM.
 * Spawns the full `claude` interactive TUI via expect, navigates onboarding
 * prompts automatically, captures the OAuth URL, and waits for the user to
 * paste the auth code back.
 */
export async function startClaudeAuth(workspaceName: string, opts?: { skipCredCheck?: boolean }): Promise<StartAuthResult> {
  if (!opts?.skipCredCheck) {
    try {
      const quickCheck = await execOnWorkspace(workspaceName,
        `if [ -f /root/.claude/.credentials.json ] && grep -q "accessToken" /root/.claude/.credentials.json 2>/dev/null; then echo HAS_CREDS; else echo NO_CREDS; fi`,
        { timeout: 10_000 }
      );
      if (quickCheck.output.includes("HAS_CREDS")) {
        const test = await execOnWorkspace(workspaceName,
          `export HOME=/root; export PATH=/root/node/current/bin:/root/.npm-global/bin:$PATH; claude -p "return hello" --max-turns 1 2>&1 | head -20`,
          { timeout: 10_000 }
        );
        const testOut = test.output.toLowerCase();
        if (test.exitCode === 0 && testOut.includes("hello") && !testOut.includes("error") && !testOut.includes("expired")) {
          return { status: "already_authenticated", message: "Claude Code is already authenticated" };
        }
        // Stale — clear
        await execOnWorkspace(workspaceName,
          "rm -f /root/.claude/.credentials.json 2>/dev/null; echo CLEARED",
          { timeout: 10_000 }
        ).catch(() => {});
      }
    } catch {
      // VM unresponsive — proceed anyway
    }
  }

  const t0 = Date.now();
  const log = (msg: string) => console.log(`[startClaudeAuth +${Date.now() - t0}ms] ${msg}`);
  log(`workspace=${workspaceName}, skipCredCheck=${!!opts?.skipCredCheck}`);

  // Wrapper script: sources profile + sets PATH + forces dumb terminal, then execs claude
  // NO_COLOR=1 + TERM=dumb prevents @clack/prompts from using ANSI escape codes / full-screen TUI
  // $PATH, $@ are shell variables — safe in TS template (no {} = no interpolation)
  const wrapperScript = `#!/bin/sh
[ -f /etc/profile ] && . /etc/profile
[ -f ~/.profile ] && . ~/.profile
[ -f ~/.bashrc ] && . ~/.bashrc
export PATH=/usr/local/bin:/root/node/current/bin:/root/.npm-global/bin:$PATH
export TERM=dumb
export NO_COLOR=1
export FORCE_COLOR=0
export COLORTERM=""
# Try known claude locations in order
CLAUDE_BIN=""
for p in /usr/local/bin/claude /root/.npm-global/bin/claude /root/node/current/bin/claude; do
  [ -x "$p" ] && CLAUDE_BIN="$p" && break
done
[ -z "$CLAUDE_BIN" ] && CLAUDE_BIN=$(command -v claude 2>/dev/null)
[ -z "$CLAUDE_BIN" ] && echo "ERROR: claude not found" && exit 1
exec "$CLAUDE_BIN" "$@"
`;

  // Expect script — handles both old (text) and new (ANSI TUI) Claude CLI.
  // With NO_COLOR=1 + TERM=dumb the new TUI falls back to plain text prompts.
  // All Tcl variables ($CR, $url, $f, $code, $i) are safe in TS template literals
  // because JS only interpolates ${...} (with braces), not bare $name.
  const expectScript = `log_user 1
set timeout 300
set CR [format %c 13]

spawn /tmp/claude_wrapper.sh

expect {
    -re {\\.\\.\\.} {
        exp_continue
    }
    -re {trust the files|Yes, proceed|trust.*folder|Allow} {
        after 300
        send $CR
        exp_continue
    }
    -re {theme|dark|light|color scheme|appearance} {
        after 300
        send $CR
        exp_continue
    }
    -re {How would you like|log in|login method|choose.*account|sign in|Select.*account|authenticate|subscription|API key} {
        after 300
        send $CR
        exp_continue
    }
    -re {(https://claude\\.ai/oauth[!-~]+)} {
        set url $expect_out(1,string)
        set f [open "/tmp/claude_url.txt" w]
        puts $f $url
        close $f
        exp_continue
    }
    -re {[Pp]aste.*code|[Ee]nter.*code|authorization code|[Cc]ode:|code here} {
        puts "WAITING_FOR_CODE"
        for {set i 0} {$i < 300} {incr i} {
            if {[file exists "/tmp/claude_code.txt"]} {
                set f [open "/tmp/claude_code.txt" r]
                set code [string trim [read $f]]
                close $f
                file delete "/tmp/claude_code.txt"
                send -- "$code"
                after 500
                send $CR
                break
            }
            after 1000
        }
        exp_continue
    }
    -re {Login successful|Logged in as|successfully authenticated|logged in} {
        set f [open "/tmp/claude_status.txt" w]
        puts $f "SUCCESS"
        close $f
        after 1000
        send $CR
        exp_continue
    }
    -re {What can I help|help you with|How can I|Tips:|Human:} {
        if {![file exists "/tmp/claude_status.txt"]} {
            set f [open "/tmp/claude_status.txt" w]
            puts $f "ALREADY_AUTH"
            close $f
        }
        after 500
        send "/exit"
        send $CR
    }
    -re {[Ee]rror|[Ii]nvalid|expired|failed} {
        set f [open "/tmp/claude_status.txt" w]
        puts $f "ERROR"
        close $f
    }
    timeout {
        if {![file exists "/tmp/claude_status.txt"]} {
            set f [open "/tmp/claude_status.txt" w]
            puts $f "TIMEOUT"
            close $f
        }
    }
}
expect eof
`;

  const wrapperB64 = Buffer.from(wrapperScript).toString("base64");
  const expectB64 = Buffer.from(expectScript).toString("base64");

  // Pre-write Claude settings.json to skip onboarding prompts (theme, trust, etc.)
  const claudeSettings = JSON.stringify({
    theme: "dark",
    hasCompletedOnboarding: true,
    onboardingComplete: true,
    autoUpdates: false,
  });
  const settingsB64 = Buffer.from(claudeSettings).toString("base64");

  log("running setup (expect + wrapper scripts)...");
  const setup = await execOnWorkspace(workspaceName,
    `[ -f /etc/profile ] && . /etc/profile; [ -f ~/.profile ] && . ~/.profile; [ -f ~/.bashrc ] && . ~/.bashrc; ` +
    `rm -f /tmp/claude_url.txt /tmp/claude_code.txt /tmp/claude_status.txt /tmp/claude_auth.exp; ` +
    `mkdir -p /dev/pts 2>/dev/null || true; ` +
    `mount -t devpts devpts /dev/pts 2>/dev/null || true; ` +
    `mkdir -p /root/.claude; echo ${settingsB64} | base64 -d > /root/.claude/settings.json; ` +
    `if ! command -v expect >/dev/null 2>&1; then apk add --no-cache expect >/dev/null 2>&1 || echo EXPECT_INSTALL_FAILED; fi; ` +
    `echo ${wrapperB64} | base64 -d > /tmp/claude_wrapper.sh && chmod +x /tmp/claude_wrapper.sh; ` +
    `echo ${expectB64} | base64 -d > /tmp/claude_auth.exp; ` +
    `echo SETUP_COMPLETE`,
    { timeout: 60_000 }
  );

  log(`setup result: exit=${setup.exitCode}, output="${setup.output.slice(0, 300)}"`);
  if (setup.output.includes("EXPECT_INSTALL_FAILED")) {
    return { status: "error", error: "Failed to install expect" };
  }
  if (!setup.output.includes("SETUP_COMPLETE")) {
    return { status: "error", error: `Setup failed: ${setup.output.slice(0, 200)}` };
  }

  log("starting expect in background...");
  const bg = await execOnWorkspace(workspaceName,
    `[ -f /etc/profile ] && . /etc/profile; [ -f ~/.profile ] && . ~/.profile; export PATH=/root/node/current/bin:/root/.npm-global/bin:$PATH; nohup expect /tmp/claude_auth.exp > /tmp/claude_auth.log 2>&1 & echo "BG_PID=$!"`,
    { timeout: 30_000 }
  );

  log(`expect bg result: exit=${bg.exitCode}, output="${bg.output.slice(0, 200)}"`);
  if (!bg.output.includes("BG_PID=")) {
    return { status: "error", error: "Failed to start auth process" };
  }

  // Poll for URL (up to 45s), restart expect up to 3 times if it dies
  let expectRestarts = 0;
  log("polling for OAuth URL (up to 45s)...");
  for (let i = 0; i < 45; i++) {
    await sleep(1000);

    const checkScript = `
if [ -f /tmp/claude_url.txt ]; then
    FILE_URL=$(cat /tmp/claude_url.txt)
    if [ \${#FILE_URL} -gt 100 ]; then
        echo URL_FOUND
        echo "$FILE_URL"
        exit 0
    else
        rm -f /tmp/claude_url.txt
    fi
fi
if [ -f /tmp/claude_status.txt ]; then
    echo STATUS_FOUND
    cat /tmp/claude_status.txt
    exit 0
fi
if [ -f /tmp/claude_auth.log ]; then
    URL=$(cat /tmp/claude_auth.log | tr -d '\\n\\r' | grep -oE 'https://claude[.]ai/oauth[A-Za-z0-9_.~:/?#@!$&()*+,;=%=-]+' | head -1)
    if [ -n "$URL" ] && [ \${#URL} -gt 100 ]; then
        echo "$URL" > /tmp/claude_url.txt
        echo URL_FOUND
        echo "$URL"
        exit 0
    fi
fi
echo WAITING
pgrep -x expect >/dev/null 2>&1 || echo NO_EXPECT_RUNNING
`;
    const check = await execOnWorkspace(workspaceName,
      b64script(checkScript),
      { timeout: 10_000 }
    ).catch(() => ({ output: "WAITING", exitCode: -1, stderr: "" }));

    if (i % 5 === 0 || check.output.includes("URL_FOUND") || check.output.includes("STATUS_FOUND") || check.output.includes("NO_EXPECT")) {
      log(`poll #${i}: "${check.output.slice(0, 150).replace(/\n/g, "\\n")}"`);
    }

    if (check.output.includes("URL_FOUND")) {
      const lines = check.output.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("https://claude.ai/oauth")) {
          return { status: "pending", oauthUrl: trimmed.replace(/[\x00-\x1f\x7f]/g, "") };
        }
      }
    }

    if (check.output.includes("STATUS_FOUND")) {
      if (check.output.includes("ALREADY_AUTH") || check.output.includes("SUCCESS")) {
        return { status: "already_authenticated", message: "Already authenticated" };
      }
      const authLog = await execOnWorkspace(workspaceName,
        "cat /tmp/claude_auth.log 2>/dev/null | tail -50",
        { timeout: 5_000 }
      ).catch(() => ({ output: "(could not read log)", exitCode: -1, stderr: "" }));
      log(`STATUS=ERROR, auth log tail:\n${authLog.output.slice(0, 500)}`);
      return { status: "error", error: "Authentication error" };
    }

    // Restart expect if it died before we got the URL
    if (check.output.includes("NO_EXPECT_RUNNING") && expectRestarts < 3) {
      expectRestarts++;
      log(`expect died, restarting (attempt ${expectRestarts}/3)...`);
      await execOnWorkspace(workspaceName,
        `pkill -9 claude 2>/dev/null || true; pkill -9 expect 2>/dev/null || true; rm -f /tmp/claude_auth.log; sleep 2; [ -f /etc/profile ] && . /etc/profile; export PATH=/root/node/current/bin:/root/.npm-global/bin:$PATH; nohup expect /tmp/claude_auth.exp > /tmp/claude_auth.log 2>&1 & echo RESTARTED`,
        { timeout: 30_000 }
      ).catch(() => {});
      await sleep(3000);
    }
  }

  // Dump auth log to help diagnose what went wrong
  const authLog = await execOnWorkspace(workspaceName,
    "cat /tmp/claude_auth.log 2>/dev/null | tail -30",
    { timeout: 5_000 }
  ).catch(() => ({ output: "(unreadable)", exitCode: -1, stderr: "" }));
  log(`TIMEOUT: auth log tail:\n${authLog.output.slice(0, 800)}`);
  return { status: "error", error: `Timeout waiting for OAuth URL. Auth log: ${authLog.output.slice(0, 300)}` };
}

// ── Submit code ───────────────────────────────────────────────────────────

export interface SubmitCodeResult {
  status: "success" | "error";
  message?: string;
  error?: string;
}

/**
 * Submit the OAuth code to the expect process running inside the VM.
 * Polls /tmp/claude_status.txt until SUCCESS (or timeout).
 */
export async function submitAuthCode(
  workspaceName: string,
  authCode: string
): Promise<SubmitCodeResult> {
  const t0 = Date.now();
  const log = (msg: string) => console.log(`[submitAuthCode +${Date.now() - t0}ms] ${msg}`);

  const codeB64 = Buffer.from(authCode).toString("base64");
  log(`writing code to VM (${authCode.length} chars)...`);
  // Also pre-create an enter-signal file so the expect loop sends Enter after success
  const write = await execOnWorkspace(workspaceName,
    `echo ${codeB64} | base64 -d > /tmp/claude_code.txt && echo CODE_WRITTEN`,
    { timeout: 30_000 }
  );
  log(`write result: ${write.output.slice(0, 100)}`);

  if (!write.output.includes("CODE_WRITTEN")) {
    return { status: "error", error: "Failed to write auth code" };
  }

  // Poll for completion (60s max — browser times out around 90s)
  for (let i = 0; i < 60; i++) {
    await sleep(1000);

    const pollScript = `
if [ -f /tmp/claude_status.txt ]; then
    echo "STATUS_FOUND"
    cat /tmp/claude_status.txt
elif [ -f /root/.claude/.credentials.json ] && grep -q "accessToken" /root/.claude/.credentials.json 2>/dev/null; then
    echo "STATUS_FOUND"
    echo "SUCCESS"
elif grep -qi "login.*success\\|logged in\\|authenticated\\|credentials saved" /tmp/claude_auth.log 2>/dev/null; then
    echo "STATUS_FOUND"
    echo "SUCCESS"
else
    echo "WAITING"
    pgrep -x expect >/dev/null 2>&1 && echo "EXPECT_RUNNING" || echo "EXPECT_DEAD"
    if [ -f /tmp/claude_auth.log ]; then
        echo "LOG_TAIL:"
        tail -3 /tmp/claude_auth.log 2>/dev/null
    fi
fi
`;
    const check = await execOnWorkspace(workspaceName,
      b64script(pollScript),
      { timeout: 10_000 }
    ).catch(() => ({ output: "WAITING", exitCode: -1, stderr: "" }));

    if (i % 5 === 0 || !check.output.includes("WAITING")) {
      log(`poll #${i}: "${check.output.slice(0, 300).replace(/\n/g, "\\n")}"`);
    }

    if (check.output.includes("STATUS_FOUND")) {
      if (check.output.includes("SUCCESS") || check.output.includes("ALREADY_AUTH")) {
        return { status: "success", message: "Authenticated successfully" };
      }
      if (check.output.includes("ERROR")) {
        const authLog = await execOnWorkspace(workspaceName,
          "tail -30 /tmp/claude_auth.log 2>/dev/null",
          { timeout: 5_000 }
        ).catch(() => ({ output: "(unreadable)", exitCode: -1, stderr: "" }));
        log(`STATUS=ERROR, auth log:\n${authLog.output.slice(0, 500)}`);
        return { status: "error", error: "Authentication failed — code may be invalid or expired" };
      }
      if (check.output.includes("TIMEOUT")) {
        return { status: "error", error: "Authentication timed out" };
      }
    }

    if (check.output.includes("EXPECT_DEAD")) {
      const authLog = await execOnWorkspace(workspaceName,
        "tail -30 /tmp/claude_auth.log 2>/dev/null",
        { timeout: 5_000 }
      ).catch(() => ({ output: "(unreadable)", exitCode: -1, stderr: "" }));
      log(`EXPECT_DEAD, auth log:\n${authLog.output.slice(0, 500)}`);
      return { status: "error", error: "Authentication process died. Please start again." };
    }
  }

  log("TIMEOUT after 120 polls");
  return { status: "error", error: "Timeout waiting for authentication result" };
}

// ── Credential persistence ────────────────────────────────────────────────

/**
 * Read /root/.claude/.credentials.json from the VM and save it to the DB.
 */
export async function saveCredentialsToDB(
  workspaceName: string,
  userId: string
): Promise<boolean> {
  try {
    const r = await execOnWorkspace(workspaceName,
      `cat /root/.claude/.credentials.json 2>/dev/null || echo "__NO_CREDS__"`,
      { timeout: 15_000 }
    );
    const creds = r.output.trim();
    if (!creds || creds === "__NO_CREDS__" || r.exitCode !== 0) {
      console.warn(`[claude-auth] saveCredentialsToDB: no credentials found on VM ${workspaceName}`);
      return false;
    }

    const parsed = JSON.parse(creds);
    console.log(`[claude-auth] saveCredentialsToDB: saving credentials for user ${userId}, len=${creds.length}, hasAccessToken=${!!parsed.accessToken}`);

    await db.update(profiles)
      .set({
        claudeCodeCredentials: creds,
        claudeCodeAuthenticated: true,
        claudeCodeCredentialsUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(profiles.userId, userId));

    return true;
  } catch (err) {
    console.error(`[claude-auth] saveCredentialsToDB failed:`, err);
    return false;
  }
}

/**
 * Write credentials from DB into the VM's ~/.claude/.credentials.json.
 */
export async function loadCredentialsFromDB(
  userId: string,
  workspaceName: string
): Promise<boolean> {
  try {
    const [row] = await db.select({ creds: profiles.claudeCodeCredentials })
      .from(profiles)
      .where(eq(profiles.userId, userId));

    if (!row?.creds) return false;

    const b64 = Buffer.from(row.creds).toString("base64");
    const r = await execOnWorkspace(workspaceName,
      `mkdir -p ~/.claude && echo ${b64} | base64 -d > ~/.claude/.credentials.json`,
      { timeout: 15_000 }
    );
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Generate a unique workspace name for Claude auth sandboxes. */
export function generateAuthWorkspaceName(): string {
  return `claude-auth-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * Wrap a multi-line shell script as a single-line base64 exec command.
 * Avoids issues with newlines/heredocs over SSH exec.
 */
function b64script(script: string): string {
  return `echo ${Buffer.from(script).toString("base64")} | base64 -d | sh`;
}
