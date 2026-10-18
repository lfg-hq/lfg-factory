# Chat instructions and context management

The main Product Agent coordinates research and authorized work. Its base prompt contains conversational rules, source verification, artifact boundaries and skill routing. Shared engineering/runtime safeguards remain always loaded. Specialized workflows live in product-planning, document-authoring and ticket-delivery, alongside the existing design and diagram skills. Tool definitions are still available; this change does not implement dynamic tool discovery.

Ordinary answers remain in chat. Saved artifacts use the existing Docs/Tickets collections. No automatic right-panel opening or new inline document preview is introduced.

## Context versus spending

Existing usage-model instrumentation records provider token spending. New context diagnostics separately record provider input/output usage and estimated request size. They contain numeric metadata, never prompts or keys.

CHAT_CONTEXT_BUDGET_TOKENS defaults to 64000. It is a conservative application budget, not automatic discovery of a model's context window. Set it below the smallest deployed model limit, accounting for output and provider overhead. Before each model step, input above 75% of this budget is compacted. Estimates use UTF-8 bytes/3, not an exact tokenizer; multimodal/provider overhead can vary. Output is capped at 20% of the budget, at most 12000 tokens.

Compaction preserves the latest user request, system context and latest complete assistant/tool group. If those alone exceed the budget it stops with a clear error rather than silently removing them. Earlier evidence becomes a bounded handoff with goals, corrections, decisions, source IDs, results and outstanding work. Summarization uses the selected model, no tools, and the request cancellation signal. It adds cost and occasional latency; identical summary requests are reused within the turn. Common credentials are redacted and the summarizer is instructed to exclude secrets, but summaries should still be treated as private data.

## Conversation continuity

The private conversation_context table holds a rolling handoff and message checkpoint. More than 40 new conversation messages triggers summarization of older text, retaining the latest 20 exact messages. Recent full tool traces are loaded separately. Background operation notices do not consume those slots. Original chat messages are never deleted. Saved checkpoints are updated only after successful summarization; compare-and-swap prevents a stale concurrent summary from overwriting a newer checkpoint. A failed summary stops the request rather than silently dropping history. Long historical items are explicitly marked as shortened; summaries are lossy and important source facts must be re-read. This is not cross-chat project memory and never grants permission.

Schema deployment is required before this code serves chat: apply the appropriate 20261015-conversation-context SQL in drizzle/manual, or the normal reviewed Drizzle schema synchronization. Both SQLite and PostgreSQL schemas include the table. No production database migration is run by this change itself.

Long-term project memory should be a later, user-visible feature: editable decisions/preferences with provenance and access controls. Existing documents/tickets remain the authoritative project record. No hidden memory.md files are created.

## Validation

- bun test tests/context-compaction.test.ts tests/agent-engineering-contract.test.ts tests/chat-diagnostics.test.ts
- DATABASE_DRIVER=sqlite DATABASE_URL=:memory: bun scripts/test-conversation-handoff.ts
- bun scripts/test-skills.mjs
- bunx tsc --noEmit
- node scripts/check-schema-parity.mjs

These tests validate routing rules and context mechanics with deterministic summaries. They do not establish model answer quality; live representative conversations should be evaluated after deployment, including older constraints, corrections, document edits and long tool runs.
