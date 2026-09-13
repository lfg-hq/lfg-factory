# Ticket checkpoints and operation logs

Ticket coding instructions require a local implementation commit before builds, tests, or application execution. Fixes are separate commits, never amendments. The server remains responsible for validated publication. This instruction governs agent-run commands; the server's formal validation gate independently enforces validation of a clean immutable commit.

Formal validation logs the candidate SHA and attempt. Server-requested repair agents edit source without running validation; the server commits each repair checkpoint and validates it. Failed candidates are not published. Preview-only modifications and credentials must remain excluded from ticket commits.

The ticket chat groups background polling snapshots by job ID, retains the command and latest output, and displays completion separately. Expanded details survive refreshes. Historical jobs without a completion record are labelled accordingly. Raw log records remain available; separate commands are not guessed to be duplicates. Existing command rows with attached tool results show command and result separately.

Background commands retain 30-second polling and now include a running output tail and a final exit-status message. A missing launch response never causes automatic command relaunch.

SDK installation failures previously bypassed runtime repair. Confirmed nonzero installation exits now feed diagnostics back into the probe to revise the environment recipe, with at most two repairs. Identical repeated failures stop; uncertain transport/process outcomes are not retried. The probe is instructed to inspect package requirements and available versions, reuse installed tools, and avoid modifying application source. A download failure alone does not establish a database or upstream-ticket failure.

Validation: background command, operation grouping, preflight and Git publication tests; TypeScript and JavaScript syntax checks. Live sandbox/provider behavior has not been verified by these checks.
