# Ticket execution in the prepared sandbox

Ticket runtime uses the existing checkout and database state. New Magpie ticket sandboxes must come from the prepared preview; failed clone requests do not silently become empty VMs. Retry preserves uncommitted repairs and skips initial feature implementation.

## One continuous repair session

LFG launches Pi in RPC mode and sends verification feedback to that same process and conversation. Failed commands are tool results, not agent restarts. If the process dies, it can restart twice using the same persisted Pi session file, with instructions to inspect in-flight work before repeating it. There is no three-turn repair cap. One configurable wall-clock budget (`TICKET_RUNTIME_BUDGET_MINUTES`, default 60, range 1–240 minutes) covers agent work and verification, rather than five minutes for each restarted agent. The existing six-minute no-activity guard remains independent of that budget. Expiry reports validation paused, retains uncommitted work, and blocks dependent tickets. This ceiling includes waiting; it is not an expected duration or an active-CPU timer.

Pi's ticket-specific tool extension caps diagnostics at 30 seconds, restore/build commands at five minutes and recognizable test commands at two minutes. It blocks repeating the same failed shell command until an intervening edit or successful potentially mutating command. This is a heuristic; it cannot prove that a repair is causally relevant. Controller checks also reject resubmission of an unchanged failed check without changed source or a new documented environment repair.

The server checks cancellation throughout the session and terminates its recorded launcher/descendants on exit. If cleanup cannot be confirmed, it does not silently replace the agent. RPC progress is emitted during tool activity and every 20 seconds while waiting. Session control files live under /tmp/lfg-pi-recovery so a full /data filesystem does not prevent the recovery prompt from being written.

## Recovery and reuse

Before heavy work, the agent gets current memory, disk, inode, process and container information. The controller may terminate orphan compiler servers scoped to the checkout. Pi may stop confirmed stale processes/unused containers and remove verified obsolete validation worktrees or disposable artifacts. It preserves current source edits, active worktrees and database data. It targets at least 2 GiB free, adjusted for expected build output.

Pi checks database connectivity, starts existing containers, or provisions a missing local development database. It applies real migrations/seed data and verifies queries. It never modifies the main preview or external databases. It reuses successful build output until source/dependency changes invalidate it, recording successful setup/build inputs and repair progress in the runtime directory. These reuse decisions remain agent-directed.

## Required verification

The agent writes a result report with the run ID, summary, local app URL and executable checks. For the COH-25 workforce organisation ticket, application mode and runtime checks for database/migrations, authentication, CRUD, persistence, tenant isolation and hierarchy are mandatory. Static-only reports cannot satisfy these categories. The server executes the supplied assertions; each required check must emit a final JSON receipt with its category, execution runtime and passed true after successful assertions. The controller enforces coverage and execution, but the agent still implements the actual endpoint-specific assertions.

The server probes the local HTTP URL five times (three seconds per request, two seconds between requests). It then executes each feature check with a two-minute limit, bounded by the remaining session budget. Failures are returned to the live Pi conversation. Required test records are disposable and cleaned up by the checks. Libraries/documents can use non-application checks; this exemption cannot bypass COH-25 runtime requirements.

Project variables use the preview AES-GCM decoder and known values are redacted. Unreadable secrets fail explicitly. A missing report does not erase the prior diagnosis or authorize a commit.

## Completion

Before committing, LFG verifies that HEAD/branch and staged source stayed stable during tests. Implementation and repairs are committed once, after checks pass; runtime evidence is saved. Retry does not push/merge. Build publication retains remote-head checks. Integration tests the merged working tree before committing and requires cleanup of its temporary app process.

Local tests cover session continuity, process-death recovery, deadlines, cancellation, tool timeout policy, repeated failures, coverage and commit timing. A protocol smoke test against installed Pi can validate RPC/extension compatibility without model calls. Neither establishes that the CoHire application passes its actual runtime tests; that needs a deployed ticket run.

## Generic prerequisites and report feedback

The builder and repair agent identify required tools, runtimes, packages, libraries and services from the approved scope and repository. They check versions and functional availability, reuse existing installations, install or repair supported sandbox-local dependencies, and verify the capability afterward. There is no fixed tool list or hard-coded installer. Missing tools are setup work; unsupported environments must be reported with the actual error and attempted remedy.

Runtime reports include a required `prerequisites` array: each entry names the dependency, explains why it is needed, and provides a bounded `verificationCommand` and optional `timeoutSeconds` (default 30, maximum 300). The controller executes these checks in the ticket sandbox before committing. Failed checks return to the same agent for repair. These checks must target the real required environment, preserve source and data, and clean up temporary resources. Inventory completeness and choice of verification commands remain agent-directed; the controller enforces execution and successful exit for every declared prerequisite.

Malformed reports return exact schema issues to the same agent. `featureTest.kind: not_applicable` cannot contain applicable browser/API criteria; non-UI assertions belong in runtime checks. A structured environment blocker stops validation immediately and preserves work for retry. Installation cannot change host privileges or external systems.

### Validation connection recovery

The controller retries read-only agent output polling at the same offset (up to three attempts). It never sends a second repair prompt because an output read timed out. Concurrent requests are rejected, and uncertain prompt delivery blocks further requests until process cleanup is confirmed. Persistent connection failures pause verification with saved source retained; they are not reported as feature assertion failures.

Validation progress records named prerequisite, HTTP health, and requirement checks as pending, running, passed, failed, or connection-blocked. Persisted phase tags keep agent activity in Validation when only a recent page of logs is loaded. The action panel shows the check list above expandable technical diagnostics. No additional tools are hardcoded into the builder's dependency inventory.
