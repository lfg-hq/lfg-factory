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
