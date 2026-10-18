import { shellQuote as q } from './preview-plan.ts';

/** Refresh a reused ticket before starting implementation. Never discard local work. */
export function ticketFollowupBaselineScript(root: string, branch: string, anchor: string, authUrl: string): string {
  return `set -eu
cd ${q(root)}
test "$(git symbolic-ref --short HEAD)" = ${q(branch)}
git check-ref-format --branch ${q(anchor)} >/dev/null
git remote set-url origin ${q(authUrl)}
git fetch --no-tags origin ${q('refs/heads/' + anchor + ':refs/remotes/origin/' + anchor)} >/dev/null 2>&1
REMOTE_TICKET=$(git ls-remote --heads origin ${q('refs/heads/' + branch)} | cut -f1)
UPDATED=0
refresh_target() {
TARGET=$(git rev-parse "$1")
if git merge-base --is-ancestor "$TARGET" HEAD; then
  return 0
elif [ -n "$(git status --porcelain)" ]; then
  echo BASELINE_LOCAL_EDITS
  exit 2
else
  # Fast-forward a previously integrated ticket; merge only if it has unpublished commits.
  if ! git -c user.name='LFG Agent' -c user.email='agent@lfg.dev' merge --no-edit "$TARGET" >/dev/null 2>&1; then
    git merge --abort >/dev/null 2>&1 || true
    echo BASELINE_CONFLICT
    exit 3
  fi
  UPDATED=1
fi
}
if [ -n "$REMOTE_TICKET" ]; then
  git fetch --no-tags origin ${q('refs/heads/' + branch + ':refs/remotes/origin/' + branch)} >/dev/null 2>&1
  refresh_target ${q('refs/remotes/origin/' + branch)}
fi
refresh_target ${q('refs/remotes/origin/' + anchor)}
if [ "$UPDATED" = 1 ]; then echo BASELINE_UPDATED; else echo BASELINE_CURRENT; fi
git rev-parse HEAD
`;
}
