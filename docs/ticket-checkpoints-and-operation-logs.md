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

## Validation preparation jobs

Validation utility installation, Docker startup, and candidate/baseline checkout creation now use single-launch background jobs with 30-second polling, cancellation and a 15-minute maximum runtime. These potentially slow steps previously used blocking exec calls even though builds and service provisioning already used background jobs. Preparation failures include their step label. Progress retains the job identity without exposing the setup script or raw output. The reported Magpie deadline error alone does not identify which earlier blocking call failed; live reproduction is still needed to establish that particular incident's command.

## GitLab publication credentials

Ticket publication now carries the selected Git credential owner's ID independently of the LLM actor. Before remote operations the validated Git client reloads/refreshes that user's token and resets origin. An explicit HTTP Basic authentication rejection forces one refresh/retry; transport loss never triggers a blind push retry. Output is redacted against both old and refreshed credentials. Pipeline failures propagate, including failed ls-remote calls.

The token helper coalesces simultaneous refresh calls within one process, persists rotated refresh tokens and expiry, and refuses known-expired/rejected tokens when refresh configuration is unavailable. OAuth app configuration and the stored grant still need to be valid. This change does not verify production configuration or coordinate refreshes across separate server processes.

## Environment repair during validation

Toolchain and dependency-install step failures now retain a typed environment failure through evidence persistence. The publication loop routes these to an environment-specific agent prompt instead of the source/test repair prompt. It permits bounded installation diagnostics, checks installed tools and feed access, and requires an idempotent fix persisted in the validation recipe. Application builds/tests remain server-owned after the next commit checkpoint. The prompt preserves tests, mappings, schema steps, fixtures and routes.

Environment repair has a separate two-attempt budget from source repair. An unchanged commit producing the same environment error stops rather than looping; changed recipe commits can be tested again within the budget. Unsupported packages or unavailable feeds still block publication. This change does not establish the cause of the reported NuGet download failure, or guarantee that external feeds are reachable.
