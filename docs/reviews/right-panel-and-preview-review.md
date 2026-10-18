# Right panel and preview review

Reviewed on 4 October 2026. This document explains the current right panel, identifies the causes of client confusion, and proposes a simpler experience and execution model.

**Assessment:** the panel has useful capabilities, but it is not yet a clear client-facing interface for a software factory. It asks clients to understand operational details before they can review the software being built. The main problem is the relationship between actions, versions and outcomes; changing icons and spacing alone will not solve it.

## Scope and evidence

This review covers the supplied screenshots and the current local source for Docs, Tickets or Epics, Preview, environment settings, preview execution and document selection. It includes the locally implemented quick restart change. It is not a claim that these changes are deployed on lfg.run.

Live browser inspection could not run because the browser-control tool failed to initialize. Visual findings therefore use the supplied screenshots and rendered structures in source. Backend findings come from the code. Proposed behavior below is explicitly a recommendation, not an implemented feature. No application code was changed during this review.

## What restart currently means

The assumption that everything is quick unless the user chooses Rebuild VM is **not yet true**.

| Current action | Actual local behavior | What the client needs to know |
| --- | --- | --- |
| Reload page | Reloads the embedded browser page. | Does not restart the app or update its code. |
| Restart app | Uses the active prepared checkout and saved start command. Restarts the primary app and enabled companion apps. Applies changed saved runtime variables to the existing environment, preserving unchanged repairs and database connections. Reuses dependencies and build unless a build-time variable changed or an app rebuild was requested. | This is the new quick path. It does not fetch code, provision databases or deliberately run the setup or repair pipeline. A saved start command can still perform work of its own. |
| Start preview after Stop | Calls the branch preparation action through `doRunBranch` and `doRestart(true)`. | Can still fetch, install, build, run schema steps and recover failures, even for the same branch. This contradicts the expectation of a simple resume. |
| Choose another branch | Runs the full branch preparation path. While work is in progress, changing the selection also cancels the current operation. | A selector is carrying out an expensive state change immediately. |
| Update & rebuild | Fetches and synchronizes the selected branch, resolves its runtime recipe, prepares databases and environment, installs/builds, applies schema steps and checks the app. | This is still a potentially long operation. The new local change retains saved recipe corrections when source inputs are unchanged. |
| Set up preview or Re-setup | Runs the setup pipeline. The existing UI invokes it without a selected ticket or epic branch. | This is not simply a stronger restart of whatever the client was viewing. |
| Rebuild sandbox | Attempts infrastructure replacement, then calls full preparation without preserving the selected branch in that call. | In the current cloud backend, replacement is blocked by the disk-ownership guard. The local Docker backend supports replacement. The visible button and confirmation do not explain that distinction. |
| Enable an additional app | Tries to start that companion alone; the fallback calls full preparation without a selected branch. | A small toggle can cause a much larger operation and lose the selected branch context. |
| Reset DB | Explicitly resets preview data and starts preparation again. | This is a data operation, not an app restart. It belongs in advanced settings. |
| Save an environment variable | Updates stored settings. The save handlers do not apply them to the running checkout. | The Env panel now shows Changes pending with Apply & restart app. Recognized public build-time variables trigger a build; custom build-time variables have an Also rebuild app option. Database connection edits use Update & rebuild. |

A quick restart has a 60-second readiness loop per service, with early failure when the launch command exits or the app returns a server error. This is not a measured promise that every whole operation completes in 60 seconds: VM wake, remote execution, URL binding and multiple services add time. No live restart benchmark was taken for this review.

## How the preview system works today

A project owns a preview workspace. The default checkout and branch worktrees share that workspace. Each selected branch can have a saved runtime profile: start/build commands, required databases, environment requirements, patches and recovery instructions. The selected checkout is exposed through a stable preview URL.

Full preparation synchronizes code, chooses or probes the runtime profile, brings up databases, writes environment settings and executes an ordered runbook. The runbook covers toolchain, configuration, dependency installation, build, schema, launch and verification. Failure can invoke an AI repair. A successful repair is checked in a separate checkout and the recipe can run again against the selected checkout. The current code has a bounded recovery budget of three; an older repository document still describes one attempt.

That explains the supplied restart log: Node installation took 4 minutes 8 seconds, dependency installation about 37 seconds, and the actual Next.js build about 16 seconds. Bootstrap failure led to repair and another setup replay. The label “Restart” hid all of this work.

Status and execution steps are stored on the project environment and broadcast to the panel. The UI also polls. The panel displays a simulated browser with its own tabs, address field, history, reload control, device controls, proxy toggle and external-browser action. Diagnostics include setup logs, steps, app logs, database logs and a shell. A separate profile view exposes the recipe and editable JSON.

The quick restart now bypasses that full runbook. It resolves the active checkout from Git's registered worktrees, starts the saved commands, checks their response and preserves the stable address. Missing preparation is surfaced as an error; it does not silently enter a full rebuild or select another branch.

## Review of the entire right panel

### What should stay

The side-by-side chat and work surface is a useful foundation: users can discuss a requirement while reading its specification or testing the result. Resizing, opening the app externally, saved documents, design grouping, progress details and access to technical diagnostics are valuable. They need clearer organization and more predictable behavior.

### Where clients lose their bearings

| Area | Observed issue | Recommended change |
| --- | --- | --- |
| Top navigation | Docs, Tickets or Epics, Preview and Env mix documents, delivery work, app execution and configuration at the same level. The work tab's name changes with a project setting. | Use stable tabs: **App, Work, Docs**, with **Settings** behind a labeled gear. Keep epics and tickets as levels inside Work. |
| Context | The user can discuss one ticket, select another branch and open the project preview. The relationships are not persistently explained. | Show the feature and exact version being viewed. Keep “selected for review,” “currently serving” and “building” distinct when they differ. |
| Epic preview link | `chat-epics.js` checks whether an epic has a preview URL, but its Open preview handler only opens the project Preview tab. It does not pass the epic ID, branch or URL to select. | Opening a feature must target that feature's build. If it is not prepared, say so and prepare that target explicitly. |
| Completion | The epic percentage is based on tickets built and labeled “ready for review.” App availability, implementation completion and functional verification are different facts. | Show **Implementation complete**, **App available** and **Checks passed / failed / not run** separately. |
| Work detail | Ticket details, actions, tasks, Git and nested build phases are useful to engineers but spread a client's review across multiple layers. | Put scope, acceptance criteria, included documents, test results and **Test feature** on one feature summary. Collapse implementation tasks and Git details. |
| Preview toolbar | Branch selection, app switching, chat, screenshot, logs, overflow and a second browser toolbar compete for a narrow strip. Several actions are icon-only. | Keep version, availability, Refresh page, Open in new tab and Report issue visible. Put developer controls in a drawer. |
| Browser inside browser | Nested browser tabs and URL/history controls consume space without helping most clients approve a feature. Desktop content is scaled to fit, which can make it tiny. | Use one app viewport, an expand action and an external-browser link. Put responsive sizes behind one labeled control. |
| Failures | Failure states primarily expose logs and choices such as Re-setup or Run default branch. Clients have to choose an infrastructure remedy. | Explain what failed, whether the previous version still works, and provide one relevant recovery action. Keep logs expandable. |
| Docs | Uploads and Design Previews are folders, while ordinary documents are grouped directly by epic. The mixed hierarchy makes counts and nesting harder to scan. | Give Docs a consistent hierarchy: Requirements, Design Previews, Uploads. Group by feature within a category. Use an epic symbol for features and a folder icon only for actual categories. |
| Document trust | The user cannot easily tell which documents and versions a builder received. Current selection includes explicit links, epic context and eligible project-level specifications. | Add **Used in this build** with exact document revisions and requirement coverage. Keep the client-facing specification separate from agent execution notes. |
| Settings | Env exposes raw keys but not clearly whether a value is missing, saved, or applied to the current preview. Runtime profile settings live elsewhere. | Consolidate under Settings with Connections, Preview configuration and Advanced. Show pending configuration changes and a single Apply changes action. |
| Recovery controls | Rebuild sandbox is visible even where the backend blocks it. Failure is logged by the backend wrapper, while the endpoint immediately returns “starting.” | Drive available actions from backend capabilities and actual operation results. Do not present an unavailable action as a normal recovery route. |

The distinction between normal work and advanced controls is consistent with [progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/). The findings about ambiguous labels, status and recovery also align with [Nielsen's usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/). These are supporting design principles; the specific findings above come from this application's source and supplied screenshots.

## Proposed client experience

The right panel should answer four questions: **What are we building? What can I try now? What has been checked? What needs my decision?**

Keep the existing split layout. Introduce one consistent header and three tabs. The following is a proposed wireframe, not a rendering of the current app. Version numbers are illustrative.

```text
Invoice Reader                                      Settings
Reviewing: Invoice processing · Version 7

App                 Work                 Docs
────────────────────────────────────────────────────────────
Available · Version 7              Expand   Open in new tab

                   The actual application

────────────────────────────────────────────────────────────
Checks: 4 passed · 1 not run          View checks
Refresh page                         Report issue
```

**App:** show the current usable application and its version. On first use, Open app prepares the required environment with visible progress. After Stop, Start app resumes the same prepared version. When a newer build exists, show “Version 8 is ready” with **Use latest build**. Selecting a version should not implicitly cancel a build. A reported problem carries the selected version, URL and diagnostics into the existing agent conversation.

**Work:** show client-sized features first. A feature contains its objective, acceptance criteria, linked source documents, current implementation, checks and a Test feature action. Implementation tickets expand below it. When checks are disabled, show “Checks not run” in the summary; do not imply verification merely because code was saved or an HTTP endpoint answered.

**Docs:** keep Requirements, Design Previews and Uploads easy to distinguish. Within Requirements and Design Previews, group by feature. Mark document status and revision. Design Previews are saved mockups; App is executable software. Label that difference explicitly. Show which documents were used for a build and which changed afterward. Do not copy chat permission language into product specifications.

**Settings:** keep connections and missing setup values understandable to clients. Place branches, run commands, profiles, service ports, shell access, database reset and infrastructure repair under Advanced. Moving a control does not change its existing authorization rules.

When the panel is narrow, collapse secondary controls and offer Expand. Preserve the selected feature and scroll position when switching tabs. Use labels on primary actions, keyboard-accessible menus, and status text that does not depend on color. Keep Stop or Cancel visible throughout the operation it controls.

## Proposed execution model

The UI simplification needs a matching backend contract. A single vague “restart” endpoint with many side effects will recreate the same confusion behind new labels.

| User intent | Proposed backend behavior |
| --- | --- |
| Open app | Serve the requested prepared version. Wake its existing environment if needed. Prepare it only when its artifacts are genuinely missing. |
| Start app | Start the same saved version with its current applied configuration. No Git synchronization. |
| Restart app | Restart app processes only. Preserve source, dependencies and database state. |
| Use latest build | Select a specific completed build, then serve its artifact. Show exactly which feature/version is changing. |
| Apply settings | Compare configuration revisions. Apply runtime-only changes and restart; rebuild when a changed value was embedded at build time. Explain which operation is needed. |
| Fix issue | Inspect the selected version and attempt a bounded repair with visible progress. Record changes and checks. A process restart alone must not silently authorize source edits or database resets. |
| Recreate environment | Operator-level recovery for a damaged or missing environment, only when provider capabilities support it. Explain data consequences before execution. |

### Prepare once and reuse the result

Have the builder produce a versioned preview artifact and a machine-readable run recipe. Record source commit, toolchain, dependency lockfile, build configuration, schema version and document revisions. The preview service should consume that output instead of repeatedly asking an agent how to run the same app.

Invalidate only the work affected by a change:

- Same artifact and settings: start the process.
- Source change: rebuild the affected app.
- Dependency or toolchain change: update that dependency layer, then rebuild.
- Runtime environment change: apply settings and restart.
- Build-time environment change: rebuild and restart.
- Schema change: apply the required versioned migration once. Bootstrap and seed operations need their own repeat-safe checks.

For Next.js, choose a declared mode: use the development server for a warm development workspace, or build once and serve the resulting production artifact for client review. Restarting either mode should not reinstall Node. Do not run both workflows through the same unqualified setup command. Measure cold preparation separately from warm startup.

### Preserve a usable version during updates

Where resources permit, prepare and check the candidate separately, then switch the preview address to it. Keep the last usable artifact available if the candidate fails. This is a proposed architecture change: today's single shared preview workspace does not automatically provide independent serving slots. Extra processes or environments have resource costs. Database changes require migration compatibility; switching an application artifact back does not automatically roll back data.

### Use structured operation state

Represent each operation with an ID, target version, action, current phase, start time, last heartbeat, cancellation state and final result. Render that state directly. Some ticket phase presentation currently derives progress from log wording; structured events would reduce fragile UI behavior.

Give users a short status such as “Starting your app” or “Installing changed dependencies,” with elapsed time and expandable details. Do not invent a percentage or ETA. After an interruption, reconnect to the same operation instead of starting duplicate work.

An available app is not proof its features work. Attach verification results to the exact artifact. If feature testing is off, honor that setting and show its absence. If a login flow is claimed to work, its evidence should include submitting the actual browser form and retaining the session, rather than only a successful backend request.

## Recommended delivery order

### First make existing controls truthful

1. Route Start after Stop to the quick path when the same prepared version exists.
2. Make Open preview select the exact epic or ticket build.
3. Surface saved-versus-applied settings and add Apply changes.
4. Hide unsupported VM replacement; return and display its real failure state.
5. Remove companion-toggle fallbacks that unexpectedly prepare the default branch.
6. Distinguish implementation, availability and checks in all completion summaries.

### Then simplify the panel

Introduce App, Work and Docs, move configuration to Settings, reduce the embedded browser controls, and add a persistent version/feature header. Keep existing documents and IDs intact. Adapt the shared panel used on chat and ticket pages together so clients do not learn two interaction models.

### Then improve preparation and reliability

Introduce reusable build artifacts, explicit input fingerprints, structured operation events and precise cache invalidation. Keep AI recovery separate from ordinary start/restart. Add last-usable-version switching when serving isolation and migration compatibility support it.

## Acceptance checks for the redesign

- Stop and Start on an unchanged prepared app perform no fetch, dependency installation, build, migration or bootstrap.
- Restart cannot change the source revision or database records through platform-injected steps.
- Opening feature A never silently displays feature B.
- A settings edit shows pending status until the intended version actually uses it.
- Build completion, app availability and tests never share a misleading single success state.
- A disabled check is shown as not run, not passed.
- Every active operation has a visible cancellation control and survives page refresh without duplicate work.
- A failed candidate leaves the previous version reachable when the serving architecture supports it.
- At narrow panel widths, primary actions remain readable without horizontal toolbar scrolling.
- Clients can find uploads, designs and specifications without understanding Git or sandbox terminology.
- Time from click to usable app is measured separately for warm start, warm restart, new build and cold environment. Set performance targets after measuring remote wake and routing overhead; do not promise local startup speed without evidence.

## Source map

| Source | Relevant behavior |
| --- | --- |
| `src/templates/pages/chat.tsx` | Right-panel tabs, preview header and environment layout |
| `public/js/artifacts.js` | Panel resizing, navigation and persisted UI state |
| `public/js/artifacts-loader.js` | Document categories, epic groups, filtering and document views |
| `public/js/chat-epics.js` | Epic summaries, completion percentage and Open preview behavior |
| `public/js/ticket-agent.js` and `public/js/ticket-action-phases.js` | Ticket context, actions, phases and optional checks |
| `public/js/preview-tab.js` | Preview states, browser controls, restart/update/start routing and profile UI |
| `public/js/env-tab.js` and `src/routes/api/preview.ts` | Environment edits and preview action endpoints |
| `src/services/dev-preview.ts` | Setup, branch preparation, quick restart, recovery and companions |
| `src/services/preview-restart.ts` | Active checkout selection, process launch and bounded readiness |
| `src/services/project-sandbox.ts` | VM reuse and currently blocked cloud replacement |
| `src/services/ticket-context-documents.ts` | Selection of saved documents supplied to builders |
| `docs/preview-reliable-replay.md` and `docs/preview-vm-lifecycle.md` | Existing runtime documentation; replay attempt count needs updating to match code |

## Environment application implemented locally (October 4, 2026)

Quick restart compares saved variables with a per-branch snapshot of the last successful application. It updates changed assignments in the active checkout, restarts the primary and enabled companion apps, and records the captured snapshot only after startup succeeds. Deletions remove the assignment and unset inherited values. Failed or cancelled attempts remain pending, including when settings are reverted before retrying. Edits saved during a run remain pending for the next run.

Changes to NEXT_PUBLIC_, VITE_, REACT_APP_, GATSBY_ and PUBLIC_ variables, and explicitly recorded buildEnvironmentKeys, run the saved build commands in the current checkout first. A custom build-time setting can use the Env panel's Also rebuild app option. This does not fetch code, reinstall dependencies, apply migrations or recreate the VM.

Database connection changes use the full preparation path so connection selection and branch isolation can be checked. Legacy previews without an application snapshot retain recorded runtime overrides and provisioned database connections on their first quick restart. The snapshot tracks saved inputs; preview-managed connection values can intentionally differ from project settings.

Verification: local shell tests cover multiline/quoted values, removals, unchanged repairs and database connections, atomic writes and restrictive file permissions. Restart orchestration tests cover build selection, failure, retries and snapshot timing. A live remote VM restart has not been exercised.
