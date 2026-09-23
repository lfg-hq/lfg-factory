# Epic builds

Enable **Project → Settings → Models & AI → Build features as epics** as the project owner. The setting defaults to off. Reload open chat pages after changing it. Disabling it restores the Tickets panel and normal ticket tools; runs already started continue.

With the setting enabled, project chat plans a feature as an epic and creates its PRD and supporting documents. The user approves building in chat or with **Build feature** in the Epics panel. The `buildEpic` tool creates an internal ordered plan, reuses existing work on retries, and dispatches the existing durable build queue. Internal tickets remain available on the full Tickets page. They are not streamed as cards into chat. Build reporting is recorded as epic-level reporting on the run and its execution origin, so restarts preserve that presentation.

The queue pauses on failure. Asking to resume (or clicking Resume build) retries the failed step and continues dependent work. It starts an epic-branch preview after completion and saves the returned URL on the epic. It does not approve or merge the epic automatically.

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
