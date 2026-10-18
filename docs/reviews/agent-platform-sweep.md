# Agent platform sweep — 6 October 2026

## Scope and release status

Local platform audit of planning, chat, API/CLI/Pi ticket execution and follow-ups, runtime validation, preview recovery and diagnostics. These changes have not been deployed in this pass. No live customer credentials, databases or preview profiles were modified.

## Findings and corrections

| Area | Failure mechanism | Local correction |
| --- | --- | --- |
| Requirements | Execution paths received different delivery instructions; compiling or mocking could substitute for required provider behavior. | Shared engineering contract in planning, API/CLI/Pi builds, follow-ups and runtime repairs. Mandatory provider requirements cannot be satisfied by keywords or fixtures. |
| Logging | Logging and worker evidence were not a consistent delivery requirement. | Require correlated lifecycle/error logs, safe provider identifiers, bounded output and targeted success/failure evidence. UI/static/documentation changes must explain non-applicability. |
| Diagnostics | Chat depended on indirect inspection to obtain app evidence. | Project-bound read-only diagnostic tool returns selected URL, branch, state and web/worker logs, with access checks and common credential redaction. Unavailable logs are explicit. |
| Preview source drift | Preview policy explicitly allowed source repairs and persistent patches, including SQL scripts, despite ticket-only source ownership. | Removed conflicting instructions; application patches fail before apply/save/replay. Supported runtime configuration overrides remain available. |
| Login | Feature-test instructions allowed injected sessions despite requiring real browser login. | Authentication evidence must exercise supported real login; unrelated feature tests may reuse a session from a verified login. |
| Admin lifecycle | One-time account operations could be mistaken for reusable startup requirements. | Shared rules forbid universal admins, hardcoded credentials and recurring password resets. Existing seed guards require repository evidence and an existence check. |
| Runtime topology | Web reachability could stand in for worker/job success. | Shared rules require declared processes, shared resolved database/environment, separate worker output and actual job evidence. Existing worker/environment regression checks included. |
| Git follow-ups | A resumed ticket could remain behind its remote branch/epic until final integration. | Existing local baseline-refresh and saved-commit merge-retry fixes retained and regression checked; preserve dirty work and separate pushed/merged/running states. |
| Task continuity | Follow-ups could reuse completed task lists and report dispatch as completion. | Existing local persisted follow-up task and completion-reporting fixes retained and regression checked. |

## Important limits

- Prompt requirements guide agents; they do not prove generated applications contain correct logging or call their provider. Runtime evidence remains necessary. There is no universal automated logging-coverage gate in this change.
- Preview shell control remains a workflow boundary, not a complete security sandbox against arbitrary source-writing commands. The explicit patch APIs and replay paths enforce the source-patch restriction.
- Old source patches are preserved but blocked from replay. Before rebuilding an affected deployed preview, inspect its saved patch list, move required source changes through tickets, and retire obsolete overlays. Do not discard them blindly.
- Existing project-specific runtime-check rules remain; they are not a universal acceptance-criteria verifier.
- Tests here validate platform behavior and prompt consistency, not a successful live Invoice Reader login or invoice analysis.

## Validation

30 targeted test files run independently to avoid shared module-mock interference. One database test exceeded the default five-second runner limit during the first sweep; the complete database test file passed when rerun with a twenty-second test limit. TypeScript checking, agent-instruction checks and diff whitespace checks passed. Final preview-policy tests were rerun after removing remaining SQL-patch instructions.

## Deployment verification

After an explicitly authorized deployment, inspect a representative project's selected revision, declared processes and resolved database identity. Verify a real login survives restart/rebuild; required first-run initialization skips existing accounts. Verify a job progresses from queued to started to a terminal result and emits correlated web/worker logs. Confirm real provider behavior with authorized credentials and a representative input. Review legacy preview patches before rebuilding affected profiles. Verify a resumed ticket starts from the latest branch/epic baseline and a failed merge retries the saved commit without rebuilding the implementation.
