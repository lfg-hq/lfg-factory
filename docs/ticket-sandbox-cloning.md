# Ticket sandbox cloning

New CLI and API ticket build sandboxes clone the project's prepared preview when
available. The source is resolved from project_environment for the same project;
no shared checkout is edited or stashed. Magpie pauses the source during copying,
so busy or unavailable sources rejected with 404/409 use fresh provisioning.
The clone inherits disk-installed SDKs. Its copied /data/project is removed before
Git checkout so preview patches, ignored application configuration and local-only
branches do not become ticket source. Other disk files, including credentials and
copied service data, are inherited by the clone; this is not a sanitized image.
Validation continues to provision independent services and databases.

Clone intents are recorded in sandbox with workspace_type=ticket-clone before
submission. Accepted request IDs are persisted and polled every 10 seconds for up
to eleven minutes. An interrupted poll resumes that ID. Unknown submission outcomes
block automatic resubmission. Provider errors remain explicit blockers, especially
source rollback/resume failures. Ready ticket registration replaces the intent.
No source sandbox is deleted by this path. Storage-corruption recovery continues
to provision fresh, avoiding another copy of potentially broken storage.

The environment worker takes a tracked-source snapshot before the coding agent
starts. It checks that snapshot in parallel with coding. Both must finish before
publication. For a verified .NET manifest/installed SDK match, saved preview
knowledge avoids probing and installation; unknown or changed requirements fall
back to discovery. Exact-commit runtime validation still checks the finished code,
including SDK changes made during implementation, fresh schema and baseline upgrade.
Installation/build/test background commands retain 30-second polling.

This version clones the current prepared project preview directly; it does not
maintain a separate golden-image sandbox. Existing ticket sandboxes are reused.
Ticket-chat provisioning retains its existing flow. Magpie's clone endpoint and
supporting agent binary must be deployed for cloning to work. Live clone behavior
has not been exercised by local unit tests.

## 2026-09-15 — SQL client download and validation recovery

### Failure and cause

COH-25 stopped in fresh candidate environment preparation, before its application
validation could run. The saved toolchain used `https://aka.ms/sqlcmd-linux-amd64`.
A direct check returned HTTP 200 with approximately 67 KB of HTML, redirected to
Bing. `curl --fail` consequently reported success; extracting the response produced
`tar: invalid magic` and `tar: short read`. This is an installer URL failure, not
evidence of a CoHire schema failure.

### Implementation

- Before candidate validation, LFG repairs these known obsolete sqlcmd aliases in
  toolchain and dependency-install commands to Microsoft's pinned v1.10.0 release
  assets. Literal amd64/arm64 and shell architecture variables are preserved, as
  are surrounding commands. Explicit versioned URLs and unrelated downloads are
  unchanged. Existing recipes are corrected without reprobe; newly probed and
  baseline recipes receive the same check.
- Candidate recipe changes are written into `.lfg-validation.json` and included in
  the existing server-owned commit checkpoint before validation. A write failure
  blocks progress. No database mappings, migration order or tests are discarded.
- Probe and environment-repair instructions now cover HTTP-200 HTML responses,
  archive verification, architecture, executable checks and reuse of an existing
  SQL client. Generic environment repair remains bounded to two attempts.
- Archive diagnostics survive long curl progress output. Validation errors put the
  cause before the command and retain environment/source classification. Exhausted
  or unchanged recovery states explain why recovery stopped.
- Both ticket execution paths pass the actual diagnostic into the Agent failure
  card instead of replacing it with a generic publication failure. Commands stay
  in operation details; credentials in HTTP URL diagnostics are redacted.

### Validation and rollout

Regression coverage checks URL preservation/idempotence, persisted recipe repair,
write failure, archive-failure classification, commit-before-revalidation, and
refusal to publish failed candidates. The official Linux amd64 release archive
was downloaded, listed and extracted; `sqlcmd -?` reported v1.10.0 in a local
Alpine 3.24 container (the ARM host executes the amd64 binary through emulation).
TypeScript and the application import bundle are checked separately.

Deploy this worktree's updated LFG image, then retry COH-25. No reprobe or database
reset is needed for this URL failure. Deployment and the complete live Magpie /
CoHire validation sequence are not performed by this change. An unrelated later
runtime failure must still pass recovery and validation before publication.

## 2026-09-15 — Schema recovery and blocked-attempt messages

The next COH-25 attempt reached SQL execution but returned SQL Server message 208:
`Invalid object name 'dbo.GetBenchSalesPosts'`. The supplied output does not prove
whether the object was omitted, a script ran out of order, or the connection was
wrong. LFG now preserves schema failures as a distinct error through validation
and supplies a database-specific repair prompt covering creation scripts, ALTER
before CREATE, connection targets, migration order, and fresh/upgrade compatibility.
The server continues to commit repairs before validating fresh isolated databases;
no live or shared database is dropped by this change.

The repeated-error check now includes the candidate commit for source/schema
failures as it already did for environment failures. A changed candidate can use
the remaining repair attempt even when it still produces the same error. An
unchanged candidate stops, and two unsuccessful source/schema repairs exhaust the
budget. Both paths explain the stop and cannot publish a failed revision.

SQL message headers and missing-object/column diagnostics take precedence over
row-count progress. The Agent card labels validation as blocked, identifies the
failure, and refers to the message box below rather than telling users already in
Actions to open Actions. It no longer tells them to adjust ticket requirements to
fix infrastructure/schema errors. The environment sleep message distinguishes a
stopped attempt from successful validation/publication and no longer calls a
sleeping VM "kept warm."

Verification: regression tests exercise identical SQL errors across changed and
unchanged commits, bounded repair exhaustion, publication refusal, SQL diagnostic
selection, and existing validation behavior. TypeScript and application bundling
are checked. The actual CoHire procedure and live Magpie run have not been changed
or verified; deploy LFG and retry to exercise the improved recovery workflow.

## 2026-09-15 — Five HTTP probes and Retry validation

HTTP route verification now makes at most five attempts, with a three-second curl
limit and two-second gaps (no final sleep). The first 2xx/3xx response succeeds.
Failure output includes the target URL, HTTP status and curl exit/error, app PID
state, available listening sockets, focused/deduplicated application output,
headers and a bounded response excerpt. Capture files live in the isolated
validation directory and are removed by normal validation cleanup; diagnostics
are returned through the existing step/log path. They are not durable standalone
artifacts. Certificates are not bypassed.

HTTP failures retain a dedicated type through repair exhaustion. Repair instructions
use port, launch-profile, routing and exception evidence. The Agent message uses
that type rather than finding the word "schema" inside a retry-budget sentence.

The ticket drawer now has **Retry validation** next to Build. It posts to the
project-scoped retry-validation endpoint, checks ticket and code-edit permission,
rejects busy tickets, and uses the saved dedicated build sandbox and prior
validation baseline. A missing sandbox, wrong branch, missing baseline or dirty
checkout produces a blocker without resetting or overwriting source. Shared
preview worktrees are not supported by this action. The operation shares the chat
lock and build guard; queue admission uses a conditional update to avoid a race.

This path bypasses implementation and tests the saved commit with the existing
validator/repair loop. It still compiles a clean checkout and prepares isolated
services so tests cannot accidentally use old binaries. Repairs are checkpointed
locally and revalidated; this action does not push or merge and does not confer
review readiness. Successful unpublished/previously failed work is left open.
Publication/integration remains a separate build-finalization workflow. Server
restart does not automatically resume an interrupted validation-only operation;
the existing worker recovery clears its executing state, and the user can retry.

Development uses the selected coding runner. Test execution is server-controlled
commands, not an independent QA agent. On failure the server starts a separate
repair-agent invocation using the configured model, then independently reruns
validation. Optional QA is a separate opt-in workflow.

Checks cover five-probe bounds, immediate HTTP success, HTTP 500/connection-refusal
diagnostics, typed HTTP recovery, clean saved-commit retry without publication,
wrong-branch and dirty-checkout refusal, plus existing publication/repair tests.
TypeScript, generated inline JavaScript and application import bundling pass.
Deployment and the live CoHire/Magpie rerun remain outstanding.

### Retry-validation project lookup correction

The first deployed Retry validation endpoint incorrectly compared the URL's public
project ID with `project_ticket.project_id`, which stores the internal project ID.
It now uses `access.project.id`, matching the existing Build endpoint. The failure
occurred before validation dispatch; it did not indicate a missing sandbox or lost
code. An API regression test uses a real SQLite ticket lookup with different public
and internal IDs, verifies successful dispatch, and rejects another project's
ticket, missing tickets and callers without the required permissions. No schema
migration is required.

## 2026-09-16 — Restore incomplete deployment checkout

The Docker import check correctly rejected the local deployment folder because
`src/services/sandbox/mags-backend.ts` and
`src/services/build-environment-worker.ts` were absent. Both were already tracked
in HEAD. Their deletions, plus the missing worker test and preflight document,
were restored exactly from HEAD. The available evidence does not identify the
process that removed them.

`node_deploy.sh` now checks Git metadata and missing tracked application/build
files before loading production credentials or contacting the server. Deploy,
setup and redeploy use this check; rollback is not blocked by local source damage.
The existing Docker import check remains in place for other missing imports.
The new guard reports incomplete checkouts; it does not automatically overwrite
intentional edits or prevent another process from deleting files later.

## 2026-09-16 — Compiler termination during validation

Compiler exit 137 and explicit memory allocation failures now enter bounded environment recovery, including when raised by acceptance tests. They no longer consume source/schema repair attempts. Exit 137 suggests SIGKILL; it does not establish an OOM kill.

Failed resource commands capture available cgroup memory counters/limits and free memory before cleanup. These are post-failure snapshots, not proof that an accumulated OOM counter belongs to this attempt. Diagnostic collection cannot replace the original failure. Environment repair can persist lower MSBuild concurrency and disable compiler/node reuse in build/test recipe commands, while preserving required tests and analyzers. Capacity blockers must be reported rather than disguised as application defects.

Validation: 12 focused tests passed, TypeScript check passed, server import bundle passed. The remote CoHire build has not been rerun; this change does not establish available sandbox memory or guarantee that its compiler will fit.
