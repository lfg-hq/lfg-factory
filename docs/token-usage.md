# Token usage accounting

Token usage is recorded per provider request, with the acting user, project,
conversation, actual provider/model, operation, billing mode, and build attempt
where applicable. The acting user remains the person who initiated the work even
when the project shares an owner's API credentials.

Each ticket build/rebuild and ticket chat receives a new `token_usage_run` ID.
Delegation from Claude execution to Pi retains that attempt. SDK tool loops save
individual requests, not the final cumulative SDK total. Pi completed message
usage is accepted from authenticated callbacks and collected again from the full
VM output at completion; stable request IDs make those deliveries idempotent.
Claude's per-model result totals are collected from its output file, with deduplicated
assistant usage as a fallback when a run ends without a result. The collector runs
on failures and cancellation too. Only compact accounting fields are extracted
from the VM, rather than downloading the full transcript.

Document and ticket tools associate usage with the entities they create, read,
or edit. A single request can produce several documents/tickets. These are
**associations, not an estimated division of tokens**: entity rows are not additive.
The overall total always counts a request once. Build usage also links to the
ticket's source document when supplied. Codebase reads retain their configured
lite-model routing, record the actual model, and use operation `codebase_read`.

Input tokens include cached input; cache read/write counters are subsets, not
additional tokens to add to the total. Reasoning tokens, when provided by the
SDK, are a subset of output. API cost is saved only when the runner reports it.
Missing pricing and subscription costs remain null rather than being shown as
zero. This is token accounting, not a reconstruction of provider invoices.

## Installation

Normal app startup uses `drizzle-kit push` and includes the new SQLite/PostgreSQL
schema. For an existing database, the additive, repeatable migration is:

```sh
bun scripts/migrate-token-usage.ts
```

It uses the app's configured database, preserves existing usage rows, and creates
`token_usage_run`, `token_usage_document`, and `token_usage_ticket` alongside the
extended `token_usage` table. No historical usage is invented or backfilled.

## Reporting

Authenticated `GET /api/token-usage` defaults to the current user's last 30 days.

Supported query parameters:

| Parameter | Meaning |
| --- | --- |
| `groupBy` | `person`, `document`, `ticket`, `build`, or `model` (default) |
| `projectId` | Public project ID; owners/admins can see the project's actors, other members only themselves |
| `userId` | Filter an actor; inspecting another actor requires project administrative access |
| `documentId`, `ticketId`, `runId` | Filter an entity or specific attempt |
| `model`, `operation` | Filter the actual model ID or operation |
| `from`, `to` | ISO dates; inclusive start and exclusive end |

Every breakdown remains split by provider, model, and billing mode. `total`
contains unduplicated totals and `rows` the breakdown. `knownCost` is null when
no reported price exists, with `requestsWithoutCost` indicating incomplete cost
coverage. Build grouping includes model helper calls belonging to build runs,
while excluding ordinary chat and ticket-chat attempts.

Examples:

```text
/api/token-usage?projectId=PUBLIC_ID&groupBy=person
/api/token-usage?ticketId=TICKET_ID&groupBy=build
/api/token-usage?documentId=DOCUMENT_ID&groupBy=model
/api/token-usage?operation=codebase_read&groupBy=model
```

## Coverage and verification

Instrumented execution paths: main chat and its tools/helpers, subscription
SDK calls inside an attributed execution context, ticket builds and ticket chats
(Claude and Pi), and in-process codebase reads. Autonomous agent jobs using
`withUserSubscription` also inherit actor attribution. New independent entry
points must establish `withUsage` before invoking models; model factories alone
cannot infer the acting user.

If a provider supplies no usage before cancellation, its unknown tokens cannot
be reconstructed. A process crash before Claude's final file collection, or an
unreachable VM, can leave that build's usage incomplete; failures are logged.
The authenticated Pi callback can continue recording against its persisted run
after an app restart. There is no retroactive import or dashboard page in this
change; the protected reporting API exposes the stored data.

Checks:

```sh
bun test tests/token-usage.test.ts
bun test scripts/subscription-model.test.ts
bun run typecheck
```
