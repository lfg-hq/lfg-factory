# Epic builds

Enable **Project → Settings → Models & AI → Build features as epics** as the project owner. The setting defaults to off. Reload open chat pages after changing it. Disabling it restores the Tickets panel and normal ticket tools; runs already started continue.

With the setting enabled, project chat discusses scope and technical choices, then creates the PRD and technical analysis. After explicit build approval, `buildEpic` creates **one build ticket for the entire feature**. Its description contains every milestone, acceptance criterion, and linked document reference. Milestones seed the existing ticket Tasks checklist; Pi records task state in a sandbox progress file read by the existing completion poll, while API builders use the existing task tools. Unknown task IDs and invalid states are ignored. Milestones do not create separate tickets, branches, or builds.

The normal durable build queue runs that one ticket through the existing builder, validation, and preview flow. A stable ticket identity and existing run checks prevent duplicate tickets on repeated requests. Retries reuse the approved ticket and its saved sandbox work; supplying a new plan on retry does not overwrite it. Scope changes require discussing and explicitly updating the existing ticket.

Chat and the Epic panel show the feature status, its single build item, implementation tasks, documents and recent activity. Clicking the build item opens the existing ticket panel inside chat. Progress returns when revisiting the conversation. Passing verification makes the feature **Ready for review**; it does not approve or merge it.

Existing epics with multiple tickets continue their original workflow. No tickets, code, or history are silently combined or deleted. To use the new model for an old epic, discuss the retained work and approve a new epic with the remaining complete scope; old active work must first be stopped through the existing controls. No automatic migration is performed.

The queue pauses on failure. Asking to resume reuses the same ticket. The existing workspace recovery and controller safeguards retain saved source and prevent overlapping agent requests. A missing unrecoverable sandbox is reported rather than implying its uncommitted work was recovered.

This change uses existing ticket metadata and task tables; it adds no new database migration. The flag migration below is needed only when initially enabling Epic builds.

## Database rollout

Apply the additive migration for your database before starting the updated application:

- PostgreSQL: `drizzle/manual/20260924-epic-builds-postgres.sql` (idempotent).
- SQLite: `drizzle/manual/20260924-epic-builds-sqlite.sql` (run once).

Alternatively, use the repository's schema-push workflow. Both schemas define `epic_builds_enabled` with a false default. Existing projects retain their original workflow. No database or production deployment was performed while implementing this branch.

## Validation

- `bun test tests/epic-builds.test.ts`
- `bun test tests/build-reporting.test.ts` (run separately: these files mock different database modules)
- `bun run scripts/test-epic-build-ui.ts`
- `bun run typecheck`, `bun run check:pages`, `bun run check:scripts`

The browser fixture does not call a paid coding model or start a real sandbox. A deployed smoke test should approve a small feature, observe progress, exercise a failed-step retry, and open the completed preview. The existing single-server dispatcher is reused; multi-server distributed dispatch is not introduced by this feature.

## Chat navigation and requirements review

Chat generation now outlives its browser socket. Returning to the conversation
restores saved history plus the active turn's buffered events, then subscribes to
live output. Stop still cancels the original turn. This registry is process-local:
it survives browser navigation/disconnects, not a server restart or routing to a
different server process. Existing transcript checkpoints remain persisted.

The collapsed activity header shows the latest action with animated dots (static
under reduced-motion preferences). Epic cards use Review requirements, Review
build issue, or Review results. These ask the agent for context and a plan; they do
not approve a build. Explicit approval in chat remains required.

Regression checks: `bun test tests/background-turns.test.ts` and
`bun test tests/chat-background-lifecycle.test.ts` (run independently because the
latter mocks the model and database), plus `node scripts/test-agent-trail.mjs` and
`bun run scripts/test-epic-build-ui.ts`.
