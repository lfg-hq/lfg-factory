/**
 * Git service — runs git operations inside Mags VMs via execOnWorkspace.
 *
 * Phase 1 (setup):  clone/update repo, create feature branch
 * Phase 2 (commit): stage all changes, commit, push
 * Phase 3 (merge):  create PR or merge feature → lfg-agent via GitHub API
 */

import { execOnWorkspace } from "./mags.ts";

export interface GitSetupOptions {
  workspaceId: string;
  repoUrl: string;         // HTTPS with token embedded, or SSH URL
  branch: string;          // base branch to branch off (e.g. "main")
  featureBranch: string;   // e.g. "feature/ticket-<id>"
  projectDir: string;      // where to clone/use, e.g. /workspace/project
  githubToken?: string;
}

export interface GitCommitOptions {
  workspaceId: string;
  projectDir: string;
  commitMessage: string;
  authorName?: string;
  authorEmail?: string;
  featureBranch: string;
  repoUrl: string;
  githubToken?: string;
  /** Auth username for the embedded HTTPS credential: "x-access-token" for GitHub
   *  (default), "oauth2" for GitLab. */
  tokenUser?: string;
}

export interface GitMergeOptions {
  repoOwner: string;
  repoName: string;
  featureBranch: string;
  targetBranch: string;    // typically "lfg-agent"
  title: string;
  body?: string;
  githubToken: string;
}

export interface GitCommitResult {
  sha: string;
  branch: string;
}

export interface GitPrResult {
  prNumber: number;
  prUrl: string;
}

export interface GitMergeResult {
  prNumber?: number;
  prUrl?: string;
  mergeCommitSha?: string;
}

// ── Input validation ──────────────────────────────────────────────────
// These values are string-interpolated into shell scripts run inside the
// sandbox. They originate server-side today, but validate defensively so a
// future caller that lets a user influence a branch/dir name can't turn it
// into shell injection. Reject anything outside a conservative allow-list.
const SAFE_REF = /^[A-Za-z0-9._\-/]+$/;      // git branch/ref names
const SAFE_PATH = /^[A-Za-z0-9._\-/ ]+$/;    // filesystem paths

function assertSafe(value: string, pattern: RegExp, label: string): void {
  if (!value || !pattern.test(value) || value.includes("..")) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────

/**
 * Clone the repo (or pull if already cloned) and create the feature branch.
 */
export async function setupRepo(opts: GitSetupOptions): Promise<void> {
  const { workspaceId, repoUrl, branch, featureBranch, projectDir, githubToken } = opts;
  assertSafe(branch, SAFE_REF, "base branch");
  assertSafe(featureBranch, SAFE_REF, "feature branch");
  assertSafe(projectDir, SAFE_PATH, "project directory");

  // Build authenticated URL if token provided
  const authUrl = githubToken
    ? repoUrl.replace("https://", `https://x-access-token:${githubToken}@`)
    : repoUrl;

  const script = `
set -e
if [ -d "${projectDir}/.git" ]; then
  cd "${projectDir}"
  git fetch origin 2>&1
  git checkout ${branch} 2>&1
  git pull origin ${branch} 2>&1
else
  git clone "${authUrl}" "${projectDir}" 2>&1
  cd "${projectDir}"
fi

cd "${projectDir}"
git config user.email "agent@lfg.dev"
git config user.name "LFG Agent"

# Create or switch to feature branch
if git show-ref --verify --quiet refs/remotes/origin/${featureBranch}; then
  git checkout -b ${featureBranch} origin/${featureBranch} 2>/dev/null || git checkout ${featureBranch}
else
  git checkout -b ${featureBranch} 2>/dev/null || git checkout ${featureBranch}
fi

echo "GIT_SETUP_OK"
`;

  // exec() breaks with multi-line commands — base64-encode
  const scriptB64 = Buffer.from(script).toString("base64");
  const result = await execOnWorkspace(workspaceId, `echo ${scriptB64} | base64 -d | sh`, {
    timeout: 120_000,
  });

  if (!result.output.includes("GIT_SETUP_OK")) {
    throw new Error(`Git setup failed:\n${result.output}`);
  }
}

// ── Commit & Push ─────────────────────────────────────────────────────

/**
 * Stage all changes, commit, and push to origin.
 */
// Library/build/cache dirs + runtime state that must NEVER be committed. Committing
// .venv/node_modules bloats the push (hundreds of MB → gateway 524 timeouts); committing
// a LIVE binary SQLite DB (app.db, with -wal/-shm sidecars written while the app runs)
// causes binary churn, lock/corruption errors, and push exit-128 failures. DBs are
// runtime state, not source — they don't belong in git. Covers every instant stack.
const LFG_GITIGNORE = [
  "node_modules/", ".next/", "out/", "dist/", "build/", ".turbo/", ".svelte-kit/", ".vite/",
  ".venv/", "venv/", "env/", ".Python", "__pycache__/", "*.py[cod]", "*.egg-info/",
  ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", ".ipynb_checkpoints/",
  ".cache/", ".parcel-cache/", "coverage/", ".nyc_output/",
  // Runtime database files (SQLite + its WAL/SHM/journal sidecars).
  "*.db", "*.sqlite", "*.sqlite3", "*.db-wal", "*.db-shm", "*.db-journal", "*.sqlite-wal", "*.sqlite-shm",
  ".lfg/", "dev.log", "build.log", "npm-debug.log*", "yarn-error.log",
  ".env", ".env.*", "!.env.example", ".DS_Store", "Thumbs.db",
].join("\n");
const LFG_GITIGNORE_B64 = Buffer.from(LFG_GITIGNORE).toString("base64");

// Shell: merge LFG_GITIGNORE into .gitignore (dedup, keep the user's existing entries) and
// untrack any library/build dirs a PRIOR build may have already committed — so the next
// push both stops adding them AND removes them from the repo. Must run BEFORE `git add -A`.
const ENSURE_GITIGNORE_SH = `
# Clear a stale index.lock left by a killed/interrupted prior git process (a common cause
# of "fatal: Unable to create '.git/index.lock'" → exit 128 on the next commit).
rm -f .git/index.lock 2>/dev/null || true
touch .gitignore
echo '${LFG_GITIGNORE_B64}' | base64 -d | while IFS= read -r gi_line; do
  if [ -n "$gi_line" ]; then
    grep -qxF "$gi_line" .gitignore 2>/dev/null || echo "$gi_line" >> .gitignore
  fi
done
for gi_d in node_modules .next out dist build .turbo .venv venv env __pycache__ .pytest_cache .mypy_cache .ruff_cache .cache .parcel-cache; do
  git rm -r --cached --quiet "$gi_d" 2>/dev/null || true
done
# Untrack any DB files a prior build committed (they now match .gitignore), anywhere in the tree.
git ls-files -z 2>/dev/null | grep -zE '\\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$' | xargs -0 -r git rm --cached --quiet 2>/dev/null || true
`;

export async function commitAndPush(opts: GitCommitOptions): Promise<GitCommitResult> {
  const { workspaceId, projectDir, commitMessage, featureBranch, repoUrl, githubToken } = opts;
  const tokenUser = opts.tokenUser ?? "x-access-token"; // GitHub default; "oauth2" for GitLab

  const authorName = opts.authorName ?? "LFG Agent";
  const authorEmail = opts.authorEmail ?? "agent@lfg.dev";
  const msgB64 = Buffer.from(commitMessage).toString("base64");

  // Build authenticated remote URL (provider-aware credential prefix)
  const authUrl = githubToken
    ? repoUrl.replace("https://", `https://${tokenUser}:${githubToken}@`)
    : repoUrl;

  const script = `
set -e
# Capture stderr in the returned output so failures are never silent (exit 128
# with empty output used to leave us blind to the real git error).
exec 2>&1
cd "${projectDir}"

# Some VMs restore /data/project owned by a different uid than the pusher; without
# this git aborts with "detected dubious ownership" (exit 128, message on stderr,
# which some exec channels swallow → the '0-char, exit 128' failure). Mark BOTH the
# project dir AND everything ('*') safe — a worktree's real gitdir lives elsewhere,
# so marking only projectDir misses it and git still aborts.
git config --global --add safe.directory "${projectDir}" 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true

# Self-heal: a restored / freshly-built VM may have no .git at all (exit 128 on the
# first git command). Re-initialize and line up on the existing remote so push works.
# Use -e (exists) NOT -d (dir): in a git WORKTREE, .git is a FILE pointing at the
# real gitdir — treating it as "missing" and running git init CORRUPTS the worktree.
if [ ! -e .git ]; then
  echo "NO_GIT_REPO: initializing and reconciling with origin"
  git init -q
  git remote add origin "${authUrl}" 2>/dev/null || git remote set-url origin "${authUrl}"
  if git fetch --depth 1 origin "${featureBranch}" 2>/dev/null; then
    # Sit our pending commit on top of the remote tip (keeps the working tree).
    git reset --soft FETCH_HEAD 2>/dev/null || true
  fi
  git checkout -B "${featureBranch}" 2>/dev/null || true
fi

# Configure author
git config user.email "${authorEmail}"
git config user.name "${authorName}"

# Ensure a comprehensive .gitignore (library/build/cache dirs never committed) and
# untrack any that a prior build already committed — BEFORE staging.
${ENSURE_GITIGNORE_SH}

# Ensure we're on the feature branch (create if needed)
CURRENT=$(git branch --show-current 2>/dev/null || echo "")
if [ "$CURRENT" != "${featureBranch}" ]; then
  git checkout "${featureBranch}" 2>/dev/null || git checkout -b "${featureBranch}"
fi

# Safety check: abort if critical directories were deleted
# This prevents accidental propagation of directory deletions through merges
DELETED_DIRS=""
for d in src public; do
  if [ -d ".git" ] && git ls-tree -d HEAD "$d" >/dev/null 2>&1 && [ ! -d "$d" ]; then
    DELETED_DIRS="$DELETED_DIRS $d"
  fi
done
if [ -n "$DELETED_DIRS" ]; then
  echo "SAFETY_ABORT: Critical directories missing:$DELETED_DIRS"
  echo "Restoring from HEAD..."
  git checkout HEAD -- $DELETED_DIRS 2>/dev/null || true
fi

# Stage all changes (including untracked)
git add -A

# Double-check: refuse to commit if staged changes delete too many files
DELETED_COUNT=$(git diff --cached --name-only --diff-filter=D | wc -l | tr -d ' ')
if [ "$DELETED_COUNT" -gt 50 ]; then
  echo "SAFETY_ABORT: $DELETED_COUNT files staged for deletion — aborting commit"
  git reset HEAD >/dev/null 2>&1
  exit 1
fi

# Check if there's anything to commit
if git diff --cached --quiet; then
  echo "NO_CHANGES"
  git rev-parse HEAD
  exit 0
fi

# Commit
COMMIT_MSG=$(echo ${msgB64} | base64 -d)
git commit -m "$COMMIT_MSG"

# Set remote with auth token
git remote set-url origin "${authUrl}" 2>/dev/null || true

# Push. These AI feature branches are owned by the build, so on a REBUILD (where the
# VM's remote-tracking ref is stale) a plain push is rejected non-fast-forward and
# force-with-lease can bail with "stale info" — fall back to a plain --force so the
# branch reliably lands. Capture the output; do NOT trust the exit code alone.
PUSH_OUT=$(git push origin ${featureBranch} --force-with-lease 2>&1) \
  || PUSH_OUT=$(git push origin ${featureBranch} 2>&1) \
  || PUSH_OUT=$(git push origin ${featureBranch} --force 2>&1)
echo "$PUSH_OUT"

SHA=$(git rev-parse HEAD)

# VERIFY the push actually landed: a swallowed push failure otherwise reports
# "Committed + pushed" while origin never received the branch — which then breaks
# the Git tab ("branch not found") and the ticket preview ("is it pushed?").
REMOTE_SHA=$(git ls-remote --heads origin ${featureBranch} 2>/dev/null | awk '{print $1}')
if [ "$REMOTE_SHA" != "$SHA" ]; then
  echo "PUSH_FAILED: origin/${featureBranch} is at '\${REMOTE_SHA:-<absent>}', expected $SHA"
  exit 1
fi
echo "COMMIT_SHA:$SHA"
`;

  // exec() breaks with multi-line commands — base64-encode
  const scriptB64 = Buffer.from(script).toString("base64");
  console.log(`[git] commitAndPush: running on workspace ${workspaceId}, projectDir=${projectDir}, branch=${featureBranch}`);
  const result = await execOnWorkspace(workspaceId, `echo ${scriptB64} | base64 -d | sh`, {
    timeout: 120_000,
  });
  console.log(`[git] commitAndPush output (${result.output.length} chars): ${result.output.slice(0, 500)}`);
  console.log(`[git] commitAndPush exitCode: ${result.exitCode}`);

  const shaMatch = result.output.match(/COMMIT_SHA:([a-f0-9]{40})/);
  if (!shaMatch) {
    if (result.output.includes("NO_CHANGES")) {
      console.log(`[git] commitAndPush: no changes to commit`);
      // Nothing to commit — get HEAD SHA
      const headResult = await execOnWorkspace(
        workspaceId,
        `cd "${projectDir}" && git rev-parse HEAD`,
        { timeout: 15_000 }
      );
      return { sha: headResult.output.trim(), branch: featureBranch };
    }
    // exit 128 with empty output = the script's captured stderr was lost (the shell
    // died before `exec 2>&1`, or git failed at a layer we didn't capture). Run a
    // plain diagnostic so the REAL cause is surfaced instead of a blind "failed".
    let diag = result.output.trim();
    if (!diag) {
      const d = await execOnWorkspace(
        workspaceId,
        `cd "${projectDir}" 2>&1 || echo "NO_DIR ${projectDir}"; echo "--- pwd ---"; pwd 2>&1; echo "--- .git ---"; ls -la .git 2>&1 | head -5; echo "--- status ---"; git status 2>&1 | head -8; echo "--- remote ---"; git remote -v 2>&1; echo "--- head ---"; git rev-parse --abbrev-ref HEAD 2>&1`,
        { timeout: 30_000 }
      ).catch((e) => ({ output: `diagnostic exec failed: ${(e as Error).message}`, exitCode: 1 }));
      diag = `(no output from commit script — exit ${result.exitCode}). Diagnostics:\n${d.output.slice(0, 1200)}`;
    }
    throw new Error(`Commit/push failed:\n${diag}`);
  }

  console.log(`[git] commitAndPush: committed and pushed sha=${shaMatch[1]} to ${featureBranch}`);
  return { sha: shaMatch[1]!, branch: featureBranch };
}

// ── Merge feature → lfg-agent (direct push, no PR) ──────────────────

/**
 * Merge a feature branch into lfg-agent and push.
 * Runs on the VM via exec. No GitHub API / PR involved.
 */
export async function mergeToLfgAgent(opts: {
  workspaceId: string;
  projectDir: string;
  featureBranch: string;
  repoUrl: string;
  githubToken: string;
  tokenUser?: string;
}): Promise<{ sha: string }> {
  const { workspaceId, projectDir, featureBranch, repoUrl, githubToken } = opts;
  const tokenUser = opts.tokenUser ?? "x-access-token";
  const authUrl = repoUrl.replace("https://", `https://${tokenUser}:${githubToken}@`);

  const script = `
set -e
exec 2>&1
cd "${projectDir}"

git config --global --add safe.directory "${projectDir}" 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true
git config user.email "ai@lfg.dev"
git config user.name "LFG AI"
git remote set-url origin "${authUrl}" 2>/dev/null || true

# Fetch latest
git fetch origin

# Checkout lfg-agent (create from main if doesn't exist)
if git rev-parse --verify origin/lfg-agent 2>/dev/null; then
  git checkout lfg-agent 2>/dev/null || git checkout -b lfg-agent origin/lfg-agent
  git reset --hard origin/lfg-agent
else
  git checkout main 2>/dev/null || git checkout -b main
  git checkout -b lfg-agent
fi

# Merge feature branch into lfg-agent
git merge ${featureBranch} -m "Merge ${featureBranch} into lfg-agent"

# Push lfg-agent
git push origin lfg-agent 2>&1

# Switch back to feature branch
git checkout ${featureBranch} 2>/dev/null || true

SHA=$(git rev-parse lfg-agent)
echo "MERGE_SHA:$SHA"
`;

  const scriptB64 = Buffer.from(script).toString("base64");
  const result = await execOnWorkspace(workspaceId, `echo ${scriptB64} | base64 -d | sh`, {
    timeout: 120_000,
  });

  const shaMatch = result.output.match(/MERGE_SHA:([a-f0-9]{40})/);
  if (!shaMatch) {
    throw new Error(`Merge to lfg-agent failed:\n${result.output}`);
  }

  return { sha: shaMatch[1]! };
}

// ── GitHub API Merge ──────────────────────────────────────────────────

/**
 * Create a PR via the GitHub REST API. Does NOT merge.
 * If a PR already exists for the same head→base, returns the existing one.
 */
export async function createPullRequest(opts: GitMergeOptions): Promise<GitPrResult> {
  const { repoOwner, repoName, featureBranch, targetBranch, title, body, githubToken } = opts;

  const baseApiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}`;
  const headers = ghHeaders(githubToken);

  // Try to create PR
  const prResp = await fetch(`${baseApiUrl}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title,
      body: body ?? "",
      head: featureBranch,
      base: targetBranch,
    }),
  });

  if (prResp.ok) {
    const prData = await prResp.json() as { number: number; html_url: string };
    return { prNumber: prData.number, prUrl: prData.html_url };
  }

  // 422 = PR may already exist
  if (prResp.status === 422) {
    const searchResp = await fetch(
      `${baseApiUrl}/pulls?head=${repoOwner}:${featureBranch}&base=${targetBranch}&state=open`,
      { headers }
    );
    const existing = await searchResp.json() as Array<{ number: number; html_url: string }>;
    const first = existing[0];
    if (first) {
      return { prNumber: first.number, prUrl: first.html_url };
    }
  }

  throw new Error(`Failed to create PR: ${await prResp.text()}`);
}

/**
 * Merge an existing PR by number via the GitHub REST API.
 */
export async function mergePullRequest(opts: {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  githubToken: string;
}): Promise<{ mergeCommitSha: string }> {
  const { repoOwner, repoName, prNumber, githubToken } = opts;
  const baseApiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}`;
  const headers = ghHeaders(githubToken);

  const mergeResp = await fetch(`${baseApiUrl}/pulls/${prNumber}/merge`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      merge_method: "squash",
      commit_title: `feat: ticket implementation (#${prNumber})`,
    }),
  });

  if (!mergeResp.ok) {
    throw new Error(`Failed to merge PR #${prNumber}: ${await mergeResp.text()}`);
  }

  const mergeData = await mergeResp.json() as { sha?: string };
  return { mergeCommitSha: mergeData.sha ?? "" };
}

/**
 * Create a PR and merge it via the GitHub REST API (convenience wrapper).
 */
export async function mergeViaGitHub(opts: GitMergeOptions): Promise<GitMergeResult> {
  const { prNumber, prUrl } = await createPullRequest(opts);
  const { mergeCommitSha } = await mergePullRequest({
    repoOwner: opts.repoOwner,
    repoName: opts.repoName,
    prNumber,
    githubToken: opts.githubToken,
  });
  return { prNumber, prUrl, mergeCommitSha };
}

// ── Repo Creation ────────────────────────────────────────────────────

export interface CreateRepoOptions {
  repoName: string;
  description?: string;
  isPrivate?: boolean;
  githubToken: string;
}

export interface CreateRepoResult {
  owner: string;
  repoName: string;
  repoUrl: string;       // e.g. https://github.com/user/repo
  cloneUrl: string;       // e.g. https://github.com/user/repo.git
  created: boolean;       // true if newly created, false if already existed
}

/**
 * Create a new GitHub repository under the authenticated user's account.
 * If the repo already exists (HTTP 422), fetches the existing one instead.
 * Matches the Django implementation in tasks/task_definitions.py:get_or_create_github_repo().
 */
export async function createGitHubRepo(opts: CreateRepoOptions): Promise<CreateRepoResult> {
  const { repoName, description, isPrivate = true, githubToken } = opts;
  const headers = ghHeaders(githubToken);

  // Sanitize repo name: lowercase, spaces/underscores → hyphens
  const sanitizedName = repoName.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");

  // Try to create
  const createResp = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: sanitizedName,
      description: description ?? `LFG Project: ${repoName}`,
      private: isPrivate,
      auto_init: false,
    }),
  });

  if (createResp.ok) {
    const data = await createResp.json() as { owner: { login: string }; html_url: string; clone_url: string };
    return {
      owner: data.owner.login,
      repoName: sanitizedName,
      repoUrl: data.html_url,
      cloneUrl: data.clone_url,
      created: true,
    };
  }

  // 422 = repo already exists — fetch the existing one
  if (createResp.status === 422) {
    // Get authenticated user's login first
    const userResp = await fetch("https://api.github.com/user", { headers });
    if (!userResp.ok) throw new Error(`Failed to fetch GitHub user: ${userResp.status}`);
    const userData = await userResp.json() as { login: string };

    const repoResp = await fetch(`https://api.github.com/repos/${userData.login}/${sanitizedName}`, { headers });
    if (repoResp.ok) {
      const repoData = await repoResp.json() as { owner: { login: string }; html_url: string; clone_url: string };
      return {
        owner: repoData.owner.login,
        repoName: sanitizedName,
        repoUrl: repoData.html_url,
        cloneUrl: repoData.clone_url,
        created: false,
      };
    }
  }

  const errorText = await createResp.text();
  throw new Error(`Failed to create GitHub repo '${sanitizedName}': ${createResp.status} — ${errorText}`);
}

/**
 * Initialize a git repo on the workspace and push to GitHub.
 * Used when auto-creating a repo (empty repo, no clone needed).
 */
export async function initAndPushRepo(opts: {
  workspaceId: string;
  projectDir: string;
  repoUrl: string;
  branch: string;
  githubToken: string;
}): Promise<void> {
  const { workspaceId, projectDir, repoUrl, branch, githubToken } = opts;
  const authUrl = repoUrl.replace("https://", `https://x-access-token:${githubToken}@`);

  const script = `
set -e
cd "${projectDir}"

git init
git config user.email "ai@lfg.dev"
git config user.name "LFG AI"
git remote add origin "${authUrl}" 2>/dev/null || git remote set-url origin "${authUrl}"

# Comprehensive .gitignore so library/build/cache dirs (node_modules/.venv/...) are never
# committed — must run BEFORE the first git add.
${ENSURE_GITIGNORE_SH}

# Only add a placeholder README if the agent didn't write one (don't clobber it).
[ -f README.md ] || echo "# Project created by LFG" > README.md
git add -A
git commit -m "Initial commit" --allow-empty

# Push main
git push -u origin HEAD:main 2>&1

# Create lfg-agent branch from main and push it
git checkout -b lfg-agent
git push -u origin lfg-agent 2>&1

echo "INIT_PUSH_OK"
`;

  const scriptB64 = Buffer.from(script).toString("base64");
  console.log(`[git] initAndPushRepo: running on workspace ${workspaceId}, projectDir=${projectDir}, branch=${branch}`);
  const result = await execOnWorkspace(workspaceId, `echo ${scriptB64} | base64 -d | sh`, {
    timeout: 60_000,
  });
  console.log(`[git] initAndPushRepo output (${result.output.length} chars): ${result.output.slice(0, 500)}`);
  console.log(`[git] initAndPushRepo exitCode: ${result.exitCode}`);

  if (!result.output.includes("INIT_PUSH_OK")) {
    throw new Error(`Init+push failed:\n${result.output}`);
  }
}

/**
 * Clone an existing repo into the project dir + restore deps. Used to RESUME a
 * reaped sandbox from GitHub instead of regenerating from scratch — restores the
 * exact last-committed code. Returns true on success.
 */
export async function cloneRepo(opts: {
  workspaceId: string;
  projectDir: string;
  repoUrl: string;
  githubToken: string;
}): Promise<boolean> {
  const { workspaceId, projectDir, repoUrl, githubToken } = opts;
  const authUrl = repoUrl.replace("https://", `https://x-access-token:${githubToken}@`);

  const script = `
export PATH=/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH
# npm cache on /data (big disk) — the 1.9GB root fills up during install (ENOSPC).
export npm_config_cache=/data/.npm-cache
export npm_config_legacy_peer_deps=true
export NODE_OPTIONS="--max-old-space-size=1536"
mkdir -p /data/.npm-cache
rm -rf "${projectDir}"
git clone --depth 1 "${authUrl}" "${projectDir}" 2>&1 || { echo CLONE_FAILED; exit 1; }
cd "${projectDir}"
git remote set-url origin "${authUrl}"
git config user.email "ai@lfg.dev"; git config user.name "LFG AI"
npm install 2>&1 || { echo CLONE_NPM_FAILED; exit 1; }
npm cache clean --force 2>/dev/null; rm -rf /data/.npm-cache/* 2>/dev/null; true
echo CLONE_OK
`;
  const scriptB64 = Buffer.from(script).toString("base64");
  console.log(`[git] cloneRepo: cloning ${repoUrl} into ${projectDir} on ${workspaceId}`);
  const result = await execOnWorkspace(workspaceId, `echo ${scriptB64} | base64 -d | bash`, { timeout: 240_000 });
  const ok = result.output.includes("CLONE_OK");
  console.log(`[git] cloneRepo ${ok ? "OK" : "FAILED"} (exit=${result.exitCode}); tail: ${result.output.slice(-300)}`);
  return ok;
}

// ── Helpers ──────────────────────────────────────────────────────────

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function featureBranchName(ticketId: string): string {
  return `feature/ticket-${ticketId}`;
}
