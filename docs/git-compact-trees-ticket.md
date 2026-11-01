# LFG-8 — compact activity trees

## Scope and persisted tasks
- [x] Read both Git specifications and accepted b31a0073 compact preview (same design as 99d36dd0); unrelated Venture Analyst documents supply no additional in-scope work.
- [x] Normalize nullable real GitHub/GitLab commit summary/date in bounded immutable history pages; preserve metadata through buildHistory, including its explicit 12-root/3-call limit and discoverable deferred roots.
- [x] Sort head lanes by known head date descending, unknown last, stable branch/SHA/row ties. Sort epics by maximum known current linked-head activity, stable name/SHA/ID ties. Historical PR heads do not determine epic activity.
- [x] Reserve sorted head label lanes; deduplicate commit SHAs, retain walk/rank parent ancestry and multi-parent joins. Shared-head labels explicitly identify the shared revision. No destination-derived graph edges.
- [x] Compact lane-adjacent labels, summaries, relative/exact update times, actual destination comparisons and available PR draft/open/merged state. Unknown checks/reviews are never passed/approved; existing authorized merge detail fetch remains unchanged.
- [x] Collapsible epic/Other sections, persisted in-view collapse state, compact scoped theme styles, keyboard focus, narrow horizontal scrolling; no dashboard or pairwise maps.
- [x] Retain full branch/destination selection, review-first and guarded mutations, All open PRs, partial/unavailable/branchless states and existing diagnostics.
- [x] Targeted provider/history/API/browser/review/safety regressions, build, typecheck, actual server/database smoke check and screenshot comparison.
- [ ] Authenticated real-provider history verification: sandbox has no users/projects/connected Git accounts. No fabricated credentials or live mutations used.

## Acceptance mapping and evidence
1. `public/js/git-tab.js`, `public/css/git-tab.css`: dense overview, lane-adjacent fixed non-overlapping text columns, collapsible trees and separate PR view. Chromium captures actual ChatPage at desktop and 390px, both themes; compared against captures of accepted HTML at the same widths. 13px body / 14px headings / 12–20px padding; graph height grows only with observed lanes. Test-only partial data includes extra diagnostics/deferred-ref controls absent from sketch; real DAG geometry is intentionally not the sketch's invented sample edges.
2. `git-provider.ts` normalizes provider fields (GitHub commit.message/committer.date, GitLab title/committed_date), no extra requests. `git-history.ts` retains nulls and metadata unchanged. Browser tests deliberately scramble heads and verify known descending activity, equal-date branch ties, unknown last, epic max linked date, real summary text/escaping, comparison destination, draft PR and unknown time. Exact dates/full summaries available in tooltips/details.
3. `git-history.test.ts` verifies nullable/invalid fields, immutable paging, safe failures, preserved metadata, shared SHAs, merge parents and 12-root/3-concurrent limit. `git-navigation.test.ts` verifies shared head label collision avoidance, distinct sorted label slots, one node per SHA and every parent x < child x. Missing/partial roots remain inspectable/loadable.
4. Chromium keyboard selects full branch/destination details, toggles epic sections, uses All open PRs, tests narrow tab overflow, history loading and correlated failure/retry. Existing review and safety UI regressions exercise guarded flows with TEST-ONLY fixtures, without provider mutations.

## Verification and runtime
- Install: `bun install --frozen-lockfile --ignore-scripts` passed; Bun 1.2.23, Node 22.22.2, Chromium 136, installed Hono/Drizzle/Playwright/TypeScript reused.
- `bun build src/index.ts --target=bun --packages=external --outdir=/tmp/lfg-import-check` passed; `/tmp` resolves under `/data/tmp`.
- `bun run typecheck` and `git diff --check` passed.
- Targeted six-file Git test run passed; final browser rerun also passed. See runtime report for commands.
- `bun run scripts/check-git-web.ts` starts `bun run src/index.ts` in `/data/project` on `0.0.0.0:8080`, with existing `.env`/resolved environment and existing auth secret. Health, database-backed invalid login and correlated private Git endpoint denials verified; temporary server stopped. Existing in-web review runner only; no new worker/job/schema/configuration.
- Existing `logGitRequest` stdout/stderr diagnostics retained. API fixtures verify correlated success and provider-denial events with timestamps, service, outcomes, durations, safe provider request IDs/error categories/retry count and no token/body leakage. Runtime auth failures recorded as AUTH_REQUIRED; no live-provider success claimed. Platform owns collected log rotation; no new application log files.
- PostgreSQL was reachable but Git tables absent. Backed up to `/data/recovery/lfg8-before-git-migrations.dump`, applied existing `drizzle/pg/0001_git_reviews.sql` and `0002_git_mutations.sql` transactionally; read-only required-schema probe passes. Users/projects/sessions were each zero before and after. No fresh database, reset, restoration claim or startup recipe.

## Visual comparison
Evidence in `/data/git-evidence/`: `desktop.png`, `desktop-light.png`, `narrow.png`, `narrow-light.png`, `narrow-epics.png`, `approved-desktop.png`, `approved-narrow.png`. Reviewed rendered images, not only DOM counts: labels stay near lanes rather than remote ends, text columns cannot collide, text halos preserve readability across real ancestry curves, desktop density follows preview, narrow view keeps labels visible with horizontal access to summaries. Existing workspace navigation/diagnostic controls remain; partial fixtures are intentionally taller than complete sample design.

## Separate delivery facts / gaps
Implementation is uncommitted source changes atop ab174e00bc93c05d09c57970c4b5c8d8ac6077be. No commit/push/merge/deployment performed. Temporary running revision was that checkout plus working changes, now stopped. Live Git history and AI-review-to-PR remain unverified without connected accounts/provider credentials; unchanged AI workflows are outside this presentation ticket. All fixtures are confined to labelled tests, never app fallbacks.
