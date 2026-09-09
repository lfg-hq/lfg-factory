# Ticket and epic runtime validation

Implemented on `codex/preview-reliable-replay`, following the preview replay changes.

## Ownership and flow

- Ticket worker (CLI and API builders), ticket chat finalization, recovery, manual push/merge, and QA commits pass a validation context into shared Git publication.
- The server commits a local candidate, reads/probes its recipe, and validates a **clean detached checkout of the exact commit** before pushing. No-change runs still validate and push.
- `validated-git.ts` owns publication. It allows at most two source repair attempts with the configured coding CLI, commits those edits, and revalidates from scratch. Agent prose does not authorize success. A repeated unchanged failure stops early.
- Epic integration happens in a separate temporary merge worktree. Conflicts go to the coding agent; the server commits and tests the result. Existing target regression commands and feature routes are retained in the merged recipe alongside the ticket's coverage. The original ticket checkout remains intact. A failed integration does not move the epic branch or mark the ticket ready for review.
- Epic review requires merged tickets and passing integration evidence for the current remote epic commit. GitHub promotion creates a PR, allocates a fresh validation VM, tests the current base + epic candidate, and pushes the exact tested merge using an explicit target lease. Branch protection can reject that push; there is no force fallback bypassing it. GitLab retains its existing external MR promotion flow, so external GitLab merges require a separate CI gate.

## Runtime contract

`.lfg-validation.json` is a **tracked root file** matching `appProfileSchema`, with `validation.kind`, nonempty `validation.tests`, and, for SQL upgrades, `validation.upgradeSetup` unless baseline seeds supply representative data. The probe derives the initial recipe; the coding agent adds or repairs actual tests. Missing tests, unsupported configuration, or unrepaired failures block publication.

The recipe contains runtime/toolchain, installation/build/run commands, every database connection environment key, logical `databaseName` where several SQL databases are required, ordered schema steps and seed assertions, feature verification routes, and executable replay actions. SQL scripts require a read-only verification assertion; ambiguous multi-database scripts must use an explicit command identifying their target. Runtime source patches and encrypted preview overrides are not accepted in this committed recipe. Source repairs belong in commits.

`runtime-plan.ts` compiles the ordered stages for both preview and build validation. Preview prefers the recipe committed with its selected branch. This avoids silently using an old prebuilt DLL or relying only on saved step checkmarks. .NET static asset casing is checked before and after build.

Validation runs restore/build/schema/start/HTTP smoke checks plus recorded acceptance tests. Libraries/documents must declare their kind and real tests; they don't require an HTTP server. Companion application behavior needs coverage in the recorded acceptance commands; the validator currently launches the primary application itself.

## Infrastructure and database checks

`validation-sandbox.ts` receives the **explicit build workspace ID**. It never resolves a project's preview workspace or calls project-wide database reset/provisioning. Each validation pass uses new labelled Docker containers, random credentials, localhost dynamic ports, and a separate checkout. Supported engines: PostgreSQL, MySQL, SQL Server, Redis. Real queries/ping determine readiness. No production environment-variable values are copied into validation.

1. Fresh: create services, execute the full candidate schema recipe and tests.
2. Upgrade: create a second isolated environment, recreate the pinned baseline's schema, run baseline startup checks, load representative fixture data, then apply the candidate's migrations and tests against that same database.

Different baseline/candidate service mappings currently produce an explicit blocker; automatic topology conversion is not attempted. External APIs need test substitutes. Tests are only as strong as their assertions; an HTTP 200 alone cannot prove feature correctness. Docker/VM capacity and toolchain availability remain real prerequisites.

Commands have deadlines and process-group cleanup. Normal completion, failure, and cancellation remove the run's containers and worktrees. A hard server/VM crash can leave labelled resources; they cannot produce passing evidence, and operators should clean abandoned `lfg.validation` resources only after confirming the corresponding validation is no longer active. Existing project preview containers are never swept by this cleanup.

## Evidence and deployment

The new `runtime_validation` table stores commit/tree, baseline, plan/environment hashes, status, phase results, timestamps and the failure reason. App launcher secrets are omitted from persisted steps; generated DB credentials are redacted from command output. Ticket Actions receive live stage logs. `GET /api/projects/:projectId/tickets/:ticketId/runtime-validation` (under the existing tickets API mount) returns up to 20 access-scoped runs with their steps. This change does not add a separate validation UI panel.

Apply the normal schema update (`bun run db:push`) before starting the new worker, for SQLite or PostgreSQL. The existing `start`/`dev` scripts already run it. No historical run is backfilled as passing. Existing branches must pass a new validation; deployment does not itself repair COH-24.

## Verification and rollout

Local regression checks:

```
bun test tests/preview-plan.test.ts tests/runtime-validation.test.ts
bun test tests/validated-git.test.ts
bun run typecheck
```

Tests execute generated Python with a fake Docker executable and real Git operations against temporary bare repositories. They cover failure gates, exact commit publication, no-change runs, merge isolation, target movement, migration/startup stops, DB readiness wiring and cleanup boundaries. The local sandbox forbids opening listening sockets, so its port-allocation test substitutes the socket result. Git tests decode payloads through Python because the host base64 wrapper cannot open redirected /dev/stdout. The installed Bun 1.2.23 runner crashed during one combined run; the suites passed when run separately as above.

Before production rollout, run COH-24 and a known-good CoHire branch in staging with real SQL Server, validate both fresh and seeded upgrade paths, force one source repair, cancel during migration, and switch preview A → B → A. Also check the deployment user's protected-branch permissions. These live Docker/CoHire scenarios were not exercised locally.
