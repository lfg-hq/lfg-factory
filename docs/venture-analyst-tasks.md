# Venture analyst ticket — persisted task/evidence record

## Prerequisite inventory (2026-10-28)
- Bun 1.4.4 installed at `/data/tooling/bin/bun` (missing initially); Bun SQLite exercised through migrations, application queries and tests.
- Node 22.22.2; locked dependencies restored with `bun install --frozen-lockfile`. AI SDK 6.0.97, Hono 4.12.1, Drizzle 0.45.1, Better Auth 1.4.18, TypeScript 5.9.3.
- Selected local database: SQLite `data/lfg.db`. PostgreSQL is an existing optional deployment choice, not a required local service. Both schema definitions and additive index migrations supplied; schema parity passes. PostgreSQL runtime was not exercised.
- Chromium 136.0.7103.113 installed using `apk add chromium`; real Playwright launch/browser workflow passed.
- External credentials unavailable: `OPENAI_API_KEY` for the existing configured `gpt-5.6-luna` model, `EXA_API_KEY`, and existing Google OAuth client settings. No keys invented; no secret files inspected.

## Tasks / acceptance mapping
- [x] AC1 implementation: isolated provider-backed adaptive interview prompt/service; platform-only `getModel(DEFAULT_MODEL_KEY, undefined, {allowEnvFallback:true})`; HTTP NDJSON stream, durable user/assistant messages and source ledger, genuine empty-conversation greeting, saved-history reload, explicit retry, stop, visible research progress and dated source links.
- [x] AC1 fixture verification: streaming text chunks through installed AI SDK test model; actual fixture tool-result ledger persistence and valid/invalid citation checks (`tests/venture-analyst.test.ts`). Real browser creates/reloads a conversation and preserves a failed turn (`tests/venture-browser.ts`). All fixtures are test-only and labelled.
- [ ] AC1 live verification: real Google-linked founder -> adaptive provider interview -> confirmed-profile research -> sourced reload. Missing third-party credentials; NOT complete and NOT established by fixtures. `scripts/verify-venture-provider.ts` is an explicit real-provider/research smoke, not a full founder workflow; attempted here and failed readiness without making a billable request.
- [x] AC2 implementation: existing canonical Google/session/owner/same-origin guards on stream and stop; strict payload rejects owner/project IDs. Only `webSearch` and `readUrl` from the approved factory are registered. No broad project context, mutation tools or general chat handler changes. Prompt treats messages/pages as untrusted, asks profile confirmation before attribution, classifies claims, forbids sensitive/personality inference.
- [x] AC2 verification: anonymous/password-only/cross-owner/cross-origin endpoint denials; exact two-tool registry and no project secret in model context; private/numeric/IPv6/link-local URL rejection; pinned DNS and public-to-metadata redirect/rebinding tests. These prove capability isolation, not live-model obedience to every adversarial prompt.
- [x] AC3 implementation/verification: no fake fallback; missing provider, provider failure, missing search, search failure, cancelled/timeout terminal states, partial checkpoints, stale crash recovery, saved history without provider configuration. SDK default raw-error logging suppressed. Cancellation/timeout branches tested with fixture aborts; no 120-second wall-clock timeout test.
- [x] AC4 implementation/verification: 4,000 characters, bounded body, 30 turns/user/hour, 8 external research calls/turn, 120s timer, 2,400 tokens/step, 32k text ceiling, 9 steps, no retries, one active turn/conversation, unique request/role keys and durable partial unique lock. Per-user admission serialization assumes the selected single Bun web process, not horizontal multi-process deployment.
- [x] Redacted correlation/model/provider/request-ID logs: start/completion/failure/cancellation and research transitions asserted in tests. `venture.stream.accept` describes HTTP acceptance only; `venture.turn.*` records actual execution. Stdout/stderr collected/rotated by platform, no application log files.
- [x] Validation: `bun run typecheck`; Bun server bundle; `bun run test:venture-analyst` (21 tests); `bun run test:venture-browser`; `node scripts/check-schema-parity.mjs`; `git diff --check`. Live smoke failure is NOT a passed check.

## Runtime / local repair
- Working directory `/data/project`; web: `bun start` (inherits resolved `.env`); bind `0.0.0.0:8080`; stdout/stderr. Venture needs no additional worker; existing application in-process jobs unchanged. Temporary web/browser processes stopped.
- No prior database existed. Initial migration-created SQLite DB exposed existing migration/schema drift (`project_ticket.ticket_key` absent; `db:push` rename prompt). It contained zero users, passed integrity check and was preserved at `data/recovery-20261028/migrated-empty-lfg.db`. Initialized a new empty local database with current `bun run db:push`; this was NOT a restoration of prior records. Auth-secret file retained; no account/password/session resets.
- Repaired runtime: ordinary `bun start` schema push completes without prompts; startup clean; `/health` 200, `/venture-analyst` 200, private conversations 401. Authenticated database workflow separately exercised by real browser against its isolated test DB.
- Existing manual migration/snapshot drift is outside this feature; production/shared database migration reconciliation needs its own ticket. Do not run destructive push against existing data.

## Delivery facts
- Base/running source revision: `2c036f945a467626fc356cb2b8a799815d9e7d82` plus uncommitted ticket changes. No commits/pushes/merges performed. No retained running process claimed as workflow proof.
- Structured assessment persistence remains the next ticket, intentionally not implemented here.
- Runtime prerequisites, exact check commands and remaining live gaps: `venture-analyst-runtime.json` alongside this file.
