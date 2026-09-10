# Ticket Git and SDK preparation

Ticket builds must verify their repository and SDK before starting the coding agent. A successful agent response is insufficient evidence that an application builds or runs.

## Git setup

CLI builds, API/Pi builds, and newly created chat repositories use the same checked Git setup runner. It enables fail-fast shell execution, disables interactive Git credential prompts, captures stdout and stderr, and requires a zero exit code plus successful HEAD and expected-branch verification. Credential values are redacted before reporting errors. Empty output is an explicit missing-evidence failure, never success. Git setup is not blindly retried because a transport failure can leave an operation running remotely.

The COH-25 incident's original cause remains unknown: its deployed caller discarded stderr and reported only empty stdout. These changes make a subsequent failure diagnosable; they do not establish a historical authentication or network cause.

## Storage recovery update

The September 10 retry exposed the actual failure: Git exited 128 because fsync of `/data/project/.git/objects/pack/tmp_pack_*` returned an I/O error. API/Pi ticket Git setup now recognizes filesystem-specific failures and destroys the failing isolated sandbox, removes its database registration, creates a uniquely named no-sync VM, and reruns Git setup from the remote branch. Existing SDK preparation and runtime validation then run in the replacement. Unpushed files in a broken sandbox are discarded; the remote branch is authoritative.

There is one replacement per build attempt. If it also suffers a storage failure, it is removed and the ticket stops with a provider-storage blocker. A failed destruction prevents further allocation. Shared preview registrations and references belonging to other tickets block deletion. Authentication/network failures and generic Pi `EIO` without filesystem evidence do not trigger destructive recovery. This recovery handles Git setup; it does not yet restart arbitrary failures after the coding agent has started.

Five recovery tests cover the observed error classification, destruction-before-creation ordering, retry exhaustion, failed deletion, and non-storage failures. Actual VM replacement still needs verification after deployment.

## SDK preparation

Before CLI/API builds and ticket chat execution, a probe inspects the actual checkout and VM using saved ticket, anchor (when available), and default preview profiles as hints. Only stack, SDK version, toolchain commands, and directives are included. Preview secret overrides and source patches are not copied. Installation commands execute in order in the build VM, then a runtime check must succeed. .NET requires an installed SDK matching the detected major version, and `dotnet --version` also respects the checkout's global.json.

The probe must install executables on the standard PATH so subsequent agent processes can find them. Failed installation or verification stops the build with the failed step and exit code. It must not become a successful ticket merely because source edits completed.

This preflight prepares the SDK; the existing isolated runtime-validation pipeline remains responsible for fresh database/Redis allocation, migrations, application startup, route checks, regression tests, and publication of the validated revision. SDK readiness alone does not imply application readiness. The complete validation changes on this branch must be deployed together.

## Validation and rollout

Seven focused tests cover stderr-only Git failures, credential redaction, empty output, nonzero exit with a success marker, checkout verification, preview knowledge reuse, and failed SDK installation. Production VM installation and the original COH-25 Git failure still require a staging/production retry after deployment. Browser CDP certificate handling is outside this change.
