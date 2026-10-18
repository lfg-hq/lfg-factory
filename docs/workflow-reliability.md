# Chat, ticket and preview reliability

These changes keep Preview in the project's Preview sandbox. Isolated tickets still build in their own sandbox. Shared-mode tickets may use the same VM, but preview refresh now uses a separate detached checkout and reserves the sandbox against concurrent ticket work.

## Preview lifecycle

- Ticket mentions add context only. Branch selection remains explicit.
- Companion settings belong to the selected branch profile. Starting a companion uses that branch's checkout and environment; a build failure prevents launching stale output.
- Ordinary restart uses the prepared checkout. Update & rebuild fetches the selected revision and performs an incremental build. Clean build explicitly removes only ignored, untracked generated output directories.
- Razor/project build-input changes invalidate ignored generated output in the preview checkout only; ordinary source refresh keeps warm output.
- Branch refresh never removes ticket worktrees. Source refresh uses `/data/preview-branch-<hash>` and preserves its ignored environment and installed dependencies. Checkout-mode projects retain their configured layout.
- Recipe fingerprints exclude styles, static assets and UI component files. Startup/configuration/dependency/schema changes invalidate the recipe. Failed recipes still enter bounded recovery.
- Supported Node installation commands record a receipt tied to dependency manifests, runtime version, command and environment. Other installers retain their native incremental behavior.

## Ticket follow-ups

`sendTicketMessage` validates project, conversation and actor permissions. Its result includes a durable operation ID; `getTicketOperationStatus` reads the result. Requests are deduplicated within a user turn, and an atomic claim prevents two workers executing one operation.

Answers, questions, failures and publication outcomes return to the initiating conversation. A blocking CLI question can be answered through `sendTicketMessage` from that conversation. The answer goes to the waiting agent instead of starting another agent.

After publication, an already-running preview refreshes only if it still selects the same relevant ticket/integration branch that was selected at dispatch. Otherwise it stays unchanged. Availability and complete user-workflow verification are reported separately.

After a server restart, unfinished operations become explicit failures requiring inspection/resumption; mutations are not silently replayed. The existing event dispatcher and shared-sandbox reservations are single-server mechanisms, not distributed leases.

`quickChange` supports one authorized small new change in an existing repository with self-contained scope and acceptance criteria. It creates one ticket and uses the normal build/validation queue without requiring PRD or technical-analysis documents. Existing-ticket repairs still use their existing ticket.

## Accounts and database identity

The existing deterministic per-branch database allocation remains in place. Refresh reuses that database; it does not clone a new database or reset accounts. Preview exposes the selected branch's database names in its status and diagnostics.

The data tools support PostgreSQL and managed local SQL Server. SQL Server uses the existing `mssql` container and `sqlcmd`, verifies the mapped port and requires parameterized `@p1`, `@p2` values. Related writes and assertions execute within one transaction. External databases and schema/server operations are refused.

Password generation supports better-auth, bcrypt/bcryptjs and ASP.NET Core Identity v3 (PBKDF2-HMAC-SHA512 with configurable iteration count). The agent must inspect the app's actual authentication scheme; custom schemes are not assumed compatible.

Newly generated logins can be saved only after authenticated-session verification. Credentials are encrypted with the configured `ENCRYPTION_KEY` and scoped to the branch profile plus database identity. They are not environment variables, startup commands or recurring password resets. If encryption is unavailable, saving fails explicitly without undoing or misreporting the login operation. Recalled credentials must be checked again before success is reported.

## Explicit validation policy

Mandatory runtime categories no longer depend on customer names or branch text. Configure them in the generated application's `.lfg-checks.json`, or set `details.requiredRuntimeChecks` on a ticket. Existing projects that relied on the previous customer-specific rule should add their categories before rollout.

Example application policy:

```json
{
  "requiredCategories": ["database", "authentication", "crud", "persistence", "tenant-isolation", "hierarchy"],
  "styleChecks": ["npm run test:styles"]
}
```

Only configure commands that exist in that application. When the complete change consists of styles and `styleChecks` is configured, validation runs those focused checks and applicable availability/feature checks. Changes to source, authentication, dependencies or schema retain full affected-feature validation. A repair that widens a style change invalidates focused validation.

A merge may reuse a recent passing ticket receipt only for an identical tree, unchanged baseline, same sandbox, environment/settings and ticket requirements. Receipts expire after ten minutes. Missing or mismatched evidence falls back to fresh merge validation. Existing validation and feature-testing settings remain authoritative.

Validation and merge logs include elapsed time; preview steps retain start/finish timestamps. Live before/after performance measurements and a real SQL Server login test remain deployment verification tasks.

## Verification

Regression tests exercise real temporary Git repositories and shell scripts, in-memory operation persistence and permission checks, database provisioning with controlled command adapters, SQL generation, password format verification, context budgeting, and shared-sandbox reservations. No live project database is changed by these tests.
