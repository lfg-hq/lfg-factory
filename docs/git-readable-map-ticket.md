# LFG-9 · Readable branch map

## Scope and persisted tasks
Latest authoritative scope: ticket LFG-9, PRD 4886d65e, technical revision d3b0931f, accepted preview 856179bd. Earlier primary DAG layouts are superseded; actual provider ancestry remains advanced detail. Read all five supplied documents, including shared venture constraints (no venture changes required).

- [x] Inspect assigned checkout and preserve LFG-7/8 foundation (clean starting worktree).
- [x] Inventory/verify existing prerequisites; reuse Bun/Hono/Drizzle, provider adapters and in-process review runner.
- [x] Add default inclusion separately from intended parent/destination comparisons, cached by immutable SHA pair within existing provider budget.
- [x] Replace primary DAG with compact ticket/branch/status/PR maps and explicit semantic legend.
- [x] Keep initial activity order with deterministic ties/unknown last; preserve established order and collapse state across refresh/selection.
- [x] Add independently styled bounded right drawer, full refs/SHAs/evidence, keyboard close/focus return and narrow overflow.
- [x] Preserve All open PRs, detailed review-first creation, confirmation dialogs, auth and guarded merge/delete destinations.
- [x] Verify scoped server/provider/history tests, rendered desktop/light/narrow layouts, review/safety regressions, build and real app startup.
- [x] Repair missing existing Git tables in sandbox DB without resets; read-only queue/schema checks pass.
- [ ] Live authenticated provider/AI workflow: sandbox has no connected project/user/provider account; not claimed verified. No live repository mutations performed.

## Acceptance evidence
| Criterion | Implementation | Verification |
| --- | --- | --- |
| AC1 provider default; stacked parent and ticket comparisons separate | `git-workspace.ts` returns `defaultComparison` on epic/Other rows, preserves `destination`, `baseSha`, stored base and parent ID; overview uses `defaultBranch.branch`; preview only on verified ticket row | Workspace tests use release default, parent→stacked→preview ticket, distinct default not-included/unknown versus parent included; API test verifies response and partial comparison. Exact-head squash/rebase/later-commit fixtures retained. |
| AC2 compact readable map, partial truth | `git-tab.js`/CSS fixed 84px rows, explicit ticket/key, actual branch, PR identity/state, inclusion/base, separate ref existence and colored textual legend; no branchless connection; primary history controls removed | Chromium real ChatPage assertions for labels, unknowns, no primary graph/dashboard/history clutter, initial activity/tie/unknown order and refresh stability; screenshots inspected against accepted preview. Partial PR listing says unknown, not zero. |
| AC3 fixed right details | Nonmodal aside independent of review dialogs; bounded 420px/95vw, viewport height/scroll; full refs, named destination/default evidence, commit metadata and existing safe actions | Desktop geometry confirms right edge at viewport, unchanged row rectangles. Narrow 390px bounds and overflow, close/Escape/focus return, Shift+Tab wrap pass. |
| AC4 regressions and safeguards | Existing provider, review and safety handlers retained; actual parent history edges only in advanced section | `git-review[-provider/-ui]`, `git-safety[-provider/-ui]`, workspace/history/API tests pass. UI confirmations retain typed inputs on failure, stale reviews block creation, drafts/forks shown. All test responses visibly labelled fixtures. |

## Runtime and observability
- Web: `bun run src/index.ts`, working directory `/data/project`, binds `0.0.0.0:8080`; existing bounded DB-backed Git review runner is in this same process/environment/database. No new worker or settings.
- stdout/stderr remain platform-collected/rotated; no new application log files. Added bounded `git.default-comparison.completed/failed` records via existing logger, with timestamp, level, service, correlation, outcome, duration, provider/request IDs, retry count and useful failure code. API tests prove success and access-denied failure without leaking token/provider bodies. Existing request/auth/review/safety logging retained.
- Exact install/build/start commands executed successfully. Typecheck and schema parity pass. Real health/home 200, database-backed invalid-login 401 and correlated private Git endpoint 401 confirmed; these are startup/access checks, not proof of a provider workflow. Temporary web and browser servers stopped. Empty queue checked with actual recovery/claim queries; no review job submitted/executed.
- Sandbox PostgreSQL was connected and base schema usable, but runner returned PostgreSQL `42P01`, relation `git_reviews` missing. Inspected local container logs/mount `/data/pgdata`, port and disk. Backed up to `/data/recovery/lfg9-20261101/before-git-migrations.dump`, then applied checked-in additive PG 0001/0002 transactionally. Git tables now exist; users/projects remained zero. No fresh database, credential reset, data deletion or restoration claimed; no recovery operation added to Git/startup.
- No new third-party secret required by this ticket. Existing Integrations Git credentials and selected model access are required for live provider/review verification. No live provider call or AI generation is claimed.

## Visual evidence and limitations
`tests/git-navigation.test.ts` generates `/data/git-evidence/{desktop,desktop-light,desktop-drawer,narrow,narrow-drawer,approved-desktop,approved-narrow}.png`. Actual rendered shell and maps were visually inspected alongside the latest accepted HTML: compact title/ref rows, semantic connections, epic sections, horizontal narrow table overflow and overlaid right drawer retained. The required default overview supersedes the preview's older overview heading. Test data, timestamps, references and states are test-only, not production values. Screenshots are temporary artifacts, regenerated by the test.

## Delivery facts
Starting revision: `86430ac169e426a1f63dca4381477c6b1cea4517`. Implementation is uncommitted source changes; no commit/push/merge made by agent. Verified running source was this working tree, temporary process now stopped; no deployed/running revision claimed. Machine-readable checks/prerequisites: `git-readable-map-runtime-report.json`.
