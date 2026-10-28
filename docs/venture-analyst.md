# Venture landing and private persistence (LFG-1)

## Scope and persisted tasks
Sources read in full: PRD `93ac7f56`, technical analysis `b0493b9d`, approved design `4b948a09` and original design `951e8fcd`. Ticket scope takes precedence: inference, research, streaming and assessment generation belong to dependent tickets.

- [x] Public `/venture-analyst`, approved copy/labelled example, unchanged shared marketing navigation/homepage.
- [x] In-place desktop expansion, mobile dialog, focus trap/restoration, Escape/close, dark mode, abort/retry and cleared examples.
- [x] Fixed-return Google authorization-code sign-in / explicit authenticated linking through installed Better Auth APIs. Implicit same-email linking disabled; other login methods remain enabled. No Gmail scopes.
- [x] Canonical-session + server-owned Google account gate on every venture API route; same-origin writes; strict payloads; owner-only persistence/list/resume.
- [x] Parallel Drizzle schemas and additive journalled SQLite/PostgreSQL migrations for conversations/messages/sources/assessment versions.
- [x] Targeted access, migration, persistence, logging, OAuth-state and browser tests; typecheck and Bun bundle.
- [ ] Live Google OAuth success, Workspace login and real cancellation in the preview: missing external Google credentials and authorized preview callback. Fixture tests are not live-provider proof.

## Acceptance evidence
| Criterion | Implementation | Verification |
|---|---|---|
| 1: approved anonymous landing, Google gate, return/retry | `venture-analyst.tsx`, scoped CSS/JS, `/auth/venture/google`, `handleGoogleCallback` | Chromium checks labelled example, cleared sample, exact CTA, initial button label, honest correlated configuration error/retry, owned panel reload. OAuth fixture tests exercise real installed Better Auth state/callback/cancellation APIs. **Live success remains unverified.** |
| 2: private Google-connected owner access, Workspace, basic scopes | `venture-access.ts`, `api/venture.ts`, explicit linking config | Six API tests on **each** DB use real Better Auth sessions and labelled test identities: anonymous 401, password-only 403, foreign load/write 404, isolated lists, forged owner/project rejected, cross-origin/missing-origin denied. OAuth fixture tests assert basic scopes and code flow; Workspace-shaped test account is accepted, not proof of live Workspace OAuth. |
| 3: durable additive persistence, preserve existing data | paired schemas, `0014_venture.sql` / `pg/0001_venture.sql`, journal entries, DB URL parity fix | `test:venture` runs actual `db:migrate` before/after existing account/hash/session/project-chat/message fixtures, repeats migration and checks preservation; both DBs pass. Fresh child process reloads saved message. Both real `db:push` runners also succeeded. No homepage/chrome source changes. |
| 4: responsive/keyboard design and diagnostics | scoped UI, structured stdout adapter, Google callback handler | Real Chromium at 1440×1000 and 390×844: fullscreen geometry, focus trap/restoration, Escape, dark palette, session create/resume/reload; no page errors. API tests assert timestamp/level/service/event/requestId/outcome/duration/error code and redaction for successful and denied requests. OAuth fixture cancellation records `cancelled`. |

Screenshots from verification are sandbox artifacts `/data/venture-{desktop,mobile,dark-mobile}.png`, not source assets. Integration fixture identities/content/credentials exist only under `tests/` and temporary databases. There are no production/demo bypasses, fake AI replies or startup account operations.

## API and next-ticket seam
- `GET /api/venture/session`: ready only for a canonical session with a linked Google account. `streamingAvailable:false` honestly advertises this ticket's boundary.
- `GET/POST /api/venture/conversations`: owner derived server-side; POST accepts only optional `title` (1–160 characters), bounded JSON body. List is bounded to 100 recent records.
- `GET /api/venture/conversations/:id`: owner checked before loading messages. No share/public report or project context.
- `POST /auth/venture/google`: same-origin only, chooses real sign-in or explicit linking server-side, ignores client provider/scopes/return URLs. Better Auth manages state, cookies and code exchange at `/api/auth/callback/google`.
- Panel emits `venture:conversation` with the loaded conversation/messages for a future streaming composer. No message-generation endpoint is supplied here. All history renders with textContent; no untrusted HTML/Markdown rendering.

## Runtime / configuration
One required web process: working directory `/data/project`, command **`bun run start`**, `0.0.0.0:8080` by default, stdout/stderr collected and rotated by the platform. No additional venture worker; existing in-process project workers are unchanged and use the same resolved environment/database. Temporary test web processes on 8091 terminate in `finally`.

All commands use `.env` via Bun or inherit its resolved environment. Do not introduce environment-file variants. Required external settings: **GOOGLE_CLIENT_ID**, **GOOGLE_CLIENT_SECRET**; register `<public-origin>/api/auth/callback/google` in Google and put that public origin in `BETTER_AUTH_URL`. Only basic identity permissions are used. No AI/Exa credentials needed for this ticket.

Development has a localhost origin and port default; a missing auth secret is generated once in `data/.auth-secret` (0600). Existing configured secrets are never changed. Persist `data/` across rebuilds, including SQLite and this generated secret. Production retains the existing explicit-secret requirement. No manual feature flag. No account seed/reset required.

Repository startup continues using `db:push`. For databases already managed by the migration journal, `bun run db:migrate` applies the new additive migrations. Do **not** mix initial migration replay into an existing push-managed database without an established baseline. The old SQLite `0002_instant_app.sql` needed statement separators for the actual runner; only separators changed. Drizzle config now honors explicit PostgreSQL DATABASE_URL exactly as the runtime does.

## Setup and validation inventory
Verified: Bun 1.3.11, Node 22.22.2, Hono 4.12.1, Better Auth 1.4.18, Drizzle ORM 0.45.1 / Kit 0.31.9, TypeScript 5.9.3, better-sqlite3 12.6.2, PostgreSQL 17.11, Chromium 136, playwright-core 1.61.1. No framework/library upgrade or lockfile change.

Sandbox initially had no Bun/dependencies/database. Bun musl binary was installed under `/data/tools`. Bun package download stalled on DNS/IPv6; npm restored locked direct versions under `/data/deps`, with the ignored node_modules link pointing there. SQLite native binding was rebuilt with build-base/python3. Alpine packages installed with apk. An IPv4 hosts entry for the Alpine mirror resolved apk's download stall. New local SQLite/PG databases were provisioned; no prior records existed to restore or replace. PostgreSQL cluster: `/data/venture-pg`, local socket `/data/venture-pg-socket`, loopback 5432; credentials only in `.env`. No external database touched.

Run `bun run test:venture` (requires local PG connection and create-database permission for disposable test DBs), `bun run test:venture-browser`, `bun run typecheck`, `bun run check:schema`, and `bun build src/index.ts --target=bun --outdir=/data/venture-build`. Tests clean temporary databases/processes. Full prerequisite commands and latest outcomes: `docs/venture-runtime-report.json`.

Git baseline: feature branch `feature/lfg-1-build-venture-landing-google-access-and`, HEAD `b8dcf9efc1367bd00327d9685df77fccd09396db`. Source implementation is uncommitted; no push/merge performed. Runtime checks exercised this working tree, not a new commit. Live provider workflow remains unverified, not passed.
