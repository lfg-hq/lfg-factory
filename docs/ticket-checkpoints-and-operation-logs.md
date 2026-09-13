# Ticket checkpoints and operation logs

Ticket coding instructions require a local implementation commit before builds, tests, or application execution. Fixes are separate commits, never amendments. The server remains responsible for validated publication. This instruction governs agent-run commands; the server's formal validation gate independently enforces validation of a clean immutable commit.

Formal validation logs the candidate SHA and attempt. Server-requested repair agents edit source without running validation; the server commits each repair checkpoint and validates it. Failed candidates are not published. Preview-only modifications and credentials must remain excluded from ticket commits.

The ticket chat groups background polling snapshots by job ID, retains the command and latest output, and displays completion separately. Expanded details survive refreshes. Historical jobs without a completion record are labelled accordingly. Raw log records remain available; separate commands are not guessed to be duplicates. Existing command rows with attached tool results show command and result separately.

Background commands retain 30-second polling and now include a running output tail and a final exit-status message. A missing launch response never causes automatic command relaunch.

SDK installation failures previously bypassed runtime repair. Confirmed nonzero installation exits now feed diagnostics back into the probe to revise the environment recipe, with at most two repairs. Identical repeated failures stop; uncertain transport/process outcomes are not retried. The probe is instructed to inspect package requirements and available versions, reuse installed tools, and avoid modifying application source. A download failure alone does not establish a database or upstream-ticket failure.

Validation: background command, operation grouping, preflight and Git publication tests; TypeScript and JavaScript syntax checks. Live sandbox/provider behavior has not been verified by these checks.

## Invalid validation recipe recovery

Malformed JSON and schema-invalid recipes now go through the structured app-profile probe before the general source-repair loop. The probe reads the current recipe and repository, receives the schema diagnostics, and must preserve real test, fixture, route, directive and database requirements. It must not substitute engines merely to satisfy the enum. Replacement output is parsed against the actual schema and checked for real tests before being written. A failed probe or invalid replacement leaves the existing file untouched. Valid recipes skip probing.

The repaired recipe is saved to the ticket checkout; the existing publication gate commits it before independently validating the exact revision. This does not change preview source-repair or publication rules.

## Visible commit confirmations

The publication gate emits a persisted `agent_progress` card for the confirmed implementation commit before recipe preparation, so a subsequent recipe error cannot hide that checkpoint. The card lists the SHA, branch and up to four actual commit subjects, then announces live validation. Recipe/fix/document commits receive their own confirmations before execution. Both ticket views render these as Agent cards without treating them as terminal responses or clearing the running state. These messages confirm local commits, not successful validation or remote publication.
