# Preview VM ownership and recovery

Project previews have one persistent workspace. Its `/data` disk must never be
attached read/write to independent VMs at the same time. A provider job marked
completed is not evidence that its VM released the disk.

## LFG behavior

- Running and sleeping jobs are reused. A command against the exact job ID probes
  the existing VM and uses Magpie's exec/wake path. Failed wake/exec never triggers
  replacement.
- The first successful insertion of the project environment row owns initial
  creation. The row is written before contacting Magpie, preventing duplicate
  submissions across concurrent callers or application restarts. Calls in one
  process also share an in-flight operation.
- A creation failure is reconciled by looking up the workspace. If a runnable job
  exists, LFG probes it. Otherwise it reports the unresolved outcome without
  stopping anything or submitting another creation. Subsequent calls inspect the
  existing workspace; they do not acquire initial-creation permission again.
- This conservative behavior also blocks creation if LFG crashed after recording
  intent but before sending the request. An operator must establish the provider
  state before resetting that intent; do not delete environment records blindly.
- Job lookup follows all result pages and rejects multiple nonterminal matches.
  Lookup failures, provisioning states, and missing jobs are not proof of absence.
- Workspace names are resolved to real job IDs for stop/status/no-sleep operations.
- Explicit hard replacement of Magpie preview VMs is disabled until a provider
  contract can confirm exclusive disk ownership. No stop request is made by that
  blocked action. Normal app restart and waking the existing VM remain available.
- The local Docker backend retains its container restart behavior.

## Provider responsibility

Magpie must ensure that old VM processes actually exit/release their disk and
reject conflicting attachments. Client-side status checks cannot establish host
disk ownership. Existing filesystem corruption needs separate provider recovery;
these code changes do not repair Calendar's volume.

## Verification

`bun test tests/project-sandbox-lifecycle.test.ts tests/sandbox-clone.test.ts tests/ticket-sandbox-clone.test.ts`

The lifecycle tests cover sleeping VM reuse, failed wake, unresolved creation,
subsequent requests, concurrent calls, pagination, and duplicate active jobs.
No production VM mutation is required for these tests.

## Required background workers

The runtime profile and manifest now include `backgroundProcesses` for queue consumers and schedulers that do not listen on an HTTP port. Existing Node profiles are upgraded from explicit `worker` / `worker:*` package scripts. Other stacks declare foreground commands in the profile. Workers are never account initialization or replay actions.

Start/rebuild and Restart apply the selected checkout's environment to its workers. The worker controller stops prior owned process groups, records PID birth identities, and checks declared database settings against the live web listener. A worker startup failure, mismatched environment or missing required worker prevents a healthy preview report. Known ready messages are checked after the new launch, never from an old log. Preview Stop also stops workers. App logs show the selected checkout's web and worker output, rather than the newest file across unrelated checkouts.

Clean replay uses a temporary `preview-check-*` Git worktree to verify that saved runtime repairs work from clean source. It does not start queue workers against the live database. Cleanup stops processes rooted in that specific scratch tree before removing it. Existing unmanaged worker copies are retired only when their declared entrypoint and preview/scratch working directory match; arbitrary Node processes and database containers are not selected by this cleanup.

Validation: `bun test tests/preview-workers.test.ts tests/preview-restart.test.ts tests/preview-start.test.ts tests/preview-runtime-boundary.test.ts`; Linux integration uses `python3 scripts/test-preview-workers.py src/services/preview-workers.py` with disposable fixture workers and an isolated state file. It checks branch/settings changes, restart/stop, startup failures, database mismatch and scratch cleanup without touching project data.

Worker commands that explicitly require a Node `--env-file` (for example `.env.local`) declare that filename in the runtime profile. Before launch, missing declared files link to the selected checkout's canonical `.env`, so atomic settings updates remain visible; existing files are never overwritten. Regression coverage launches an actual `npm run worker` with this requirement, changes settings, restarts it, and verifies existing local configuration is preserved. Process cleanup also tolerates npm child processes exiting while their process group is being stopped.

## Chat data maintenance

`handlePreview manage_data` exposes worker status/pause/resume and `databaseTransaction` alongside account and inspection tools. Related data changes run on one selected PostgreSQL connection in one transaction, with parameterized statements, inspected row limits and optional `expectedRows` assertions before commit. A later SQL error, exceeded limit or failed assertion rolls back the whole transaction. Cleanup may exceed the former 20-row account-edit limit without splitting it into partial commits.

The data operation shares the preview lifecycle queue and checks branch identity before and during execution. Transactions pause managed consumers and schedulers; operation completion/failure/cancellation restores only workers that were running beforehand. A user Stop or changed selection prevents automatic restoration into a different runtime. Source, dependency, script and schema changes remain ticket work. These tools do not replay cleanup during startup.

Local validation: `bun test tests/preview-data-operations.test.ts tests/preview-worker-maintenance.test.ts tests/preview-action-tools.test.ts`; `PG_BIN=/path/to/postgres/bin bun scripts/test-preview-data-reset.ts` creates a disposable database and real auth fixture to verify multi-table cleanup, rollback, unrelated-data preservation and login after cleanup. It does not access a project database.
