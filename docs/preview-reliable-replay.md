# Preview replay and recovery

Implemented on `codex/preview-reliable-replay`.

## Execution contract

Setup and branch restart use the same ordered executor for toolchain, configuration,
dependency install, build, schema, startup, feature-route checks, asset checks and
DB health. Infrastructure and companion/audit rows are shown alongside these steps.
Old `done` IDs are not trusted as evidence. Commands execute again unless a read-only
assertion proves the required state. Restore/build commands can use their native caches.

Profiles are selected by project and actual branch. A changed Git tree triggers a
fresh branch probe; this deliberately favors correctness over selective invalidation.
The probe receives previous instructions and discoveries. Re-probing merges directives,
learnings, patches, executable actions, and branch environment overrides. New branches
inherit general instructions, not another branch's literal source/config patches.
Profile JSON edits and re-probes operate on the currently selected preview branch.

`schemaSteps` preserves the original order and all seeds. The older manifest arrays
remain readable as a migration fallback. Raw scripts/seeds require a read-only `verify`
command; zero means already applied. After applying, that assertion must pass. Required
migration errors stop execution. Recovery can replace the complete ordered recipe.
Raw SQL with multiple possible logical databases fails instead of guessing a target.

`replayActions` contains `{id, phase, command, verify, note}`. Phases are `beforeBuild`,
`afterBuild`, `beforeSchema`, `verify`. Use these to turn a discovery into a repeatable
operation with an assertion. A text instruction alone is not a runtime assertion.

## Recovery

One AI recovery is allowed per execution. It receives the failed step and exception.
Identical failed commands against unchanged tracked source/environment aren't restarted.
Recovery writes commands, assertions, literal patches or encrypted branch environment
overrides back to the branch profile. Source additions/repairs are allowed only in an
isolated worktree, never automatically committed or pushed. Default-checkout source
errors remain explicit blockers. Recovery must not suppress EF model-change checks,
fake migration history, or recreate case aliases under `wwwroot`.

Successful recovery is provisional: a fresh detached checkout receives the saved patches
and environment, then runs the same recipe. Only after this passes does the selected
checkout run again. The disposable verification checkout is removed afterward. This
validates checkout replay with the existing VM/toolchain caches and branch database;
it is not proof of a completely fresh VM or an empty database. Assertions should check
real required schema, not merely whether a database exists.

Failures retain their real diagnostic rather than a stack-trace tail. Repeated identical
failures are recorded against revision, plan and environment, and do not launch another
AI investigation. Editing/re-probing the profile or changing the revision invalidates
the old blocker. Cancellation never enters recovery; expired shell commands are killed
before control returns. Database waits report progress and observe cancellation.

## Resource isolation

For branch previews, local SQL connections matching provisioned credentials are redirected
to stable branch-specific logical databases (SQL Server, PostgreSQL, MySQL). A → B → A
returns to A's database. MySQL provisioning uses the managed root credential to create
and grant access to the app user. Existing original databases are not reset or copied.
A branch must have a valid schema recipe for its initially empty database.

Managed `redis://` URLs use a separate persistent Redis container and dynamically exposed
localhost port per branch. No cache flush is performed. Other Redis connection formats
are not automatically isolated; encode an appropriate configuration action before using
those formats for branch isolation. External connections or connections not matching
managed credentials are unchanged. Docker containers/databases retained per branch need
an eventual retention policy; this change does not delete branch data automatically.

## Rollout / acceptance

No database migration for LFG is required: new fields live in existing profile JSON.
Existing profiles with unverified raw SQL/seed commands will need assertions added by
recovery or in Profile JSON. Strict patches now report stale/missing targets rather
than claiming success. Clean recovery adds build time and temporary disk use.

Local verification:

- `bun test tests/preview-plan.test.ts`
- `bun run typecheck`
- `node --check public/js/preview-tab.js`
- `node scripts/test-page-preview.mjs`
- `node scripts/test-preview-shell.mjs`

The script tests execute Python/shell with a fake Docker CLI, not real database servers.
Before production rollout, use a staging preview VM and CoHire's actual branches:

1. Run the working Epic #2 branch, then COH-24, then switch back and repeat.
2. Confirm COH-24's actual EF migration/source repair is saved in its scoped profile,
   rebuilds from the clean verification checkout, and its Workforce route responds.
3. Confirm case repairs do not introduce duplicate static assets on the next build.
4. Verify scripts/seeds skip only when their assertions pass and DBs stay branch-scoped.
5. Cancel during DB bring-up and compilation; ensure no recovery starts afterward.
6. Re-probe and verify directives/patches/actions survive; test stale patch reporting.
7. Repeat on a fresh VM, with the selected companion apps and supported real databases.

This code does not itself modify or commit COH-24's source: that repository is not in
this workspace. The live branch scenario and real Docker/database integrations remain
staging acceptance tests.
