# Ticket execution in the prepared sandbox

Ticket runs use the saved checkout and its existing services. New Magpie ticket sandboxes must come from the prepared preview; failed/unconfirmed clone requests are retained and reported rather than replaced by an empty VM. Cloning preserves the prepared project directory for branch setup.

The coding agent checks database connectivity, starts the existing container if needed, restores dependencies using installed tooling and caches, runs the application, and repairs actual errors across any relevant layer. It describes the current repair to the user. It does not create validation databases or compare baseline recipes. Diagnostic commands should be bounded to 30 seconds; restore/build commands to five minutes. Runtime-agent invocations are capped at five minutes.

The agent leaves a report outside the repository containing its result, local application URL and repeatable feature assertions. The server checks the local HTTP endpoint and reruns those assertions with one-minute command limits. Failed assertions return to the agent in the same sandbox; successful setup is not rebuilt by the server. There are at most three agent invocations per run, and user cancellation remains available.

No implementation or repair checkpoint is committed before checks pass. Existing uncommitted repairs are accepted by Retry validation. After checks succeed, LFG verifies that HEAD/branch and the staged source have not changed, commits accumulated changes once, and records existing-sandbox runtime evidence. It does not claim fresh-install or upgrade coverage. Retry does not push or merge. The normal Build publication flow retains its remote-head checks; integration checks the merged working tree before committing it.

The old fresh-database/baseline-upgrade gate, generated validation-recipe probe, and parallel SDK worker have been removed from this execution path. Earlier entries in ticket-sandbox-cloning.md describe historical behavior.

Local verification covers commit timing, preserved pending changes, failed-check repair, cancellation, premature commits, publication failures, merge timing, clone preservation, HTTP checks and stop behavior. Remote CoHire runtime success must be established by a deployed run; these local checks do not establish that outcome.
