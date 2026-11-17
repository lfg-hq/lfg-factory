# Chat instructions and context management

The main Product Agent coordinates research and authorized work. Its base prompt contains conversational rules, source verification, artifact boundaries and skill routing. Shared engineering/runtime safeguards remain always loaded. Specialized workflows live in product-planning, document-authoring and ticket-delivery, alongside the existing design and diagram skills. Tool definitions are always available; there is no dynamic tool discovery.

Ordinary answers remain in chat. Saved artifacts use the existing Docs/Tickets collections.

## Budget per model

`contextProfile(modelKey)` (src/ai/context-profile.ts) gives each model its own numbers:

- **window**: from the model catalog, or `context_window` in llm-models.json.
- **maxOutput**: the reply length requested. Up to 32,000 tokens for models the catalog knows, 12,000 otherwise. The ChatGPT subscription backend ignores an output cap, so on that route this is only a reservation.
- **budget**: the most input a step may send. The smallest of 93% of the window, the window less the reply (and, on a subscription, a further 5% for reasoning that cannot be capped), and a ceiling: 200,000 for API keys (`CHAT_CONTEXT_CEILING_API`), 400,000 for a subscription (`CHAT_CONTEXT_CEILING_SUBSCRIPTION`). `CHAT_CONTEXT_BUDGET_TOKENS` fixes the ceiling for every model.

Sizes are estimated as UTF-8 bytes/3 and calibrated per conversation against the provider's reported input tokens. Subscription turns send `reasoningEffort` (`CHAT_REASONING_EFFORT`, default `medium`).

## One compaction system

Before every model step, input above 75% of the budget is reduced, cheapest relief first (src/ai/context-compaction.ts):

1. Older tool output is shortened (the two latest results stay whole). Loaded skills are never shortened.
2. Older images are dropped.
3. Older history is replaced by a **handoff**: a structured summary (objective, user constraints, decisions, work done, findings, workflow state) whose length scales with the budget (`summaryLimit`: about 6% of the budget, 9,000 to 60,000 characters).

A handoff carries three things the summarizer cannot lose:

- **Actions ledger**: one line per state-changing tool call (what was called, what came back), recorded mechanically and carried through every later condense unchanged, newest 8,000 characters kept. IDs of epics, documents, tickets and builds stay addressable however long the chat runs.
- **Loaded skills**: the latest successful `loadSkill` results (up to three) are carried across as complete call/result pairs.
- **The plan**: the agent's working plan (below) is re-attached from the database after each condense. It is live state and is never summarized or saved in the handoff.

The handoff written mid-turn is saved to `conversation_context` as the conversation's checkpoint (`saveConversationCheckpoint`), so the next turn starts from it. After each turn a background refresh folds older messages into the same checkpoint (keeping the newest rows exact, within a quarter of the budget), now including a one-line digest of each turn's tool calls and the ledger. On a subscription both paths use the fast helper model first and the chat model as fallback; the refresh is bounded to six minutes. Original chat messages are never deleted or modified.

If no model summary can be produced, a mechanical excerpt of the earlier messages (the user's words and the agent's replies, cut to size) plus the ledger stands in, and the chat shows a warning line. History is never silently dropped. The turn fails only when the current request and its latest results alone exceed the budget.

If the provider still rejects a request as too long, the pass is retried once with the budget lowered to 60% and calibration ignored; steps that had finished are kept.

## What a turn loads

- The saved checkpoint, then the stored messages after it (up to 120 rows). If more than 80 messages are unsummarized (the background refresh kept failing), the turn condenses first, visibly, so nothing falls outside the loaded window.
- Prior turns are replayed as the structured tool calls and results the model saw. The newest turns are replayed in full (up to about 30% of the budget); older ones with results shortened to 4,000 characters. They are never flattened into prose. Stored steps keep up to 40,000 characters per result and 600,000 per turn.
- Everything the server adds for the turn (recent background operation results, @ticket context, the preview's branch, saved notes, the plan) is appended to the user's message as one `<turn-context>` block. The request always ends on the user's message and has a single system message. The block is not stored.

## Turn loop

A pass runs up to 80 steps. Beyond the existing rescue nudge (a reply that ends on an unkept promise or prose questions), a reply cut off at the output limit, or a pass that used every step while still calling tools, continues automatically, up to three times per turn.

## Working plan

`updatePlan` (src/ai/tools/plan-tools.ts, product chat only) stores the agent's plan per conversation in `conversation_plan`. It is shown to the agent at the start of each turn while any step is open, re-attached after every condense, and each update adds a progress line to the chat's activity trail. A plan is the agent's working state and never grants approval.

## Ticket outcomes

The agent takes an automatic turn in the originating conversation when a build run finishes or pauses, when a single ticket's build or retry completes or fails, and when a change request sent to a ticket completes or fails (src/services/build-summary-turn.ts). On success it is told to re-run the check that found the problem before calling a fix fixed; these turns may read and check but not start builds or change tickets. Events for a busy chat wait for it (up to 20 minutes) and run one at a time. Restart recovery and user stops do not trigger a turn. `CHAT_BUILD_EVENT_TURNS=0` disables the automatic turns; status messages remain.

## Schema

Apply `drizzle/manual/20261015-conversation-context-*.sql` and `drizzle/manual/20261113-conversation-plan-*.sql`, or the normal reviewed Drizzle schema synchronization, before this code serves chat.

## Limits

- Summaries are lossy; the prompt tells the agent to re-read sources for details. This is not cross-chat project memory (Notes and saved documents are) and never grants permission.
- Common credentials are redacted from summaries and the ledger, and the summarizer is told to exclude secrets, but handoffs should still be treated as private data.
- Full replay sends more input per turn than before; in exchange the prefix matches what the model saw last turn, which is what provider prompt caches key on.
- An automatic ticket-outcome turn is not registered as a live turn, so a user message sent while one runs is not queued behind it.

## Validation

- `bun run test:chat-context`: compaction, ledger, skills and plan across repeated condenses, checkpoint persistence, budgets, and `scripts/test-chat-turn.ts`, which drives the real turn loop against a throwaway SQLite database and a stubbed provider (user message last, structured replay, overflow retry, output-limit continuation, plan tool).
- `DATABASE_DRIVER=sqlite DATABASE_URL=:memory: bun scripts/test-conversation-handoff.ts`
- `bun test tests/agent-engineering-contract.test.ts tests/chat-diagnostics.test.ts tests/workflow-gaps.test.ts`
- `bunx tsc --noEmit`, `node scripts/check-schema-parity.mjs`

These validate mechanics with deterministic summaries and a scripted model. They do not establish answer quality with a real model; evaluate live representative conversations after deployment, including older constraints, document edits, long tool runs and a build that reports back.
