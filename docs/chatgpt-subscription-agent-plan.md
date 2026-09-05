# ChatGPT subscription agent integration

Created: 2026-09-06. Status: opt-in implementation complete; real-account rollout validation pending.

## Objective

Offer connected ChatGPT subscriptions alongside API keys for LFG agent reasoning,
without replacing the existing chat UI, Vercel AI SDK tool loop, document storage,
ticket tools, or sandbox execution. API customers retain their existing workflow.

## Architecture

The existing model resolver will select either the current API provider or a Pi
Codex model adapter. The adapter implements the AI SDK model contract and translates
messages, tool calls/results, text deltas, and partial JSON tool arguments. LFG
continues executing all tools with its existing authorization checks.

Ordinary chat inference runs in the application process. It requires neither a new
VM nor the Pi coding-agent CLI. Existing build and preview sandboxes remain separate.

## Authentication and billing invariants

- Resolve credentials using the authenticated user and existing project sharing
  grants, never a user ID supplied by a browser or model tool argument.
- Reuse the existing Codex credential broker. Refresh tokens remain encrypted in
  the existing store; only access tokens are passed to the model transport.
- Retrieve credentials for each generation, including subsequent tool-loop steps.
- Never use a process-global provider credential or log authorization material.
- Missing/revoked subscription, exhausted quota, unsupported features, and model
  access errors must fail explicitly. Never silently fall back to a paid API.
- A subscription is not a Platform API key, nor a promise of unlimited usage.

## User experience

Keep API models available. Add clearly labeled subscription model choices, enabled
only for connected eligible accounts. Persist the choice using the existing model
selection mechanism where practical. The selected route must remain visible when
resuming a conversation. Switching model does not delete history or documents.

## Workstreams and acceptance criteria

1. Inspect installed AI SDK/Pi interfaces and pin a compatible Pi library version.
2. Implement a separately testable AI SDK adapter: text, tool calls, tool results,
   interleaved streaming, usage, finish reasons, cancellation, and safe errors.
3. Add subscription model resolution and server-side credential ownership checks.
4. Wire main chat and background agents while preserving existing API behavior.
5. Preserve live document streaming through tool-input deltas. Execute mutations
   only after complete, schema-validated arguments; partial drafts are display-only.
6. Audit nested model calls: titles, summaries, codebase queries, preview reasoning,
   ticket evaluations, QA, and structured-output helpers. Propagate billing context
   where supported; explicitly document exclusions rather than claiming full parity.
7. Add selector affordances and connected-account validation.
8. Run deterministic tests, type checks, and an authenticated integration test when
   a suitable test account/environment is available. Never use production projects
   or create billable sandbox workloads merely to test the adapter.

## Test matrix

- API path unchanged; disconnected subscription cannot run.
- Two simultaneous users never share credentials or context.
- Text streams; tool IDs and partial arguments survive interleaving and history.
- A document streams live and is saved once; ticket tools retain authorization.
- A multi-step tool loop feeds tool results back to the subscription model.
- Cancellation stops upstream work; quota/auth failures do not invoke API fallback.
- Structured JSON output is validated, or fails explicitly if unsupported.
- Background work uses the authorized initiating/credential owner, not server keys.
- Model switching preserves replayable history.

## Risks and rollout

Pi's Codex transport is a third-party integration, not an official general-purpose
OpenAI Platform API entitlement. Verify deployment terms and account eligibility
before broad rollout. Pin dependencies and test updates. Native hosted search,
structured output, attachments, and reasoning-history compatibility need explicit
capability handling; do not silently drop unsupported input.

Start with opt-in subscription choices; keep API choices unchanged. Production
rollout requires a real-account smoke test covering streamed docs, ticket creation,
and completion evaluation. Rollback is selecting API explicitly, not automatically
charging an API key after a subscription failure.

## References

- OpenAI authentication: https://developers.openai.com/codex/auth
- Official alternative (Codex app-server): https://developers.openai.com/codex/app-server
- Pi model library: https://github.com/earendil-works/pi/tree/main/packages/ai
- LFG model factory: `src/ai/provider.ts`
- Main agent streaming: `src/ai/stream-handler.ts`
- Background agents: `src/services/agent-runner.ts`
- Credential broker: `src/services/openai-codex-auth.ts`

## Implementation log

- 2026-09-06: Reference plan created before implementation. Repository initially clean.
- Pinned `@earendil-works/pi-ai` to 0.85.1; synchronized npm and Bun lockfiles.
- Added `src/ai/pi-subscription-model.ts` (AI SDK v3 adapter) and isolated async
  execution context. Every generation obtains a fresh access-token lookup from the
  existing broker. API execution clears inherited subscription context.
- Persisted subscription choices as `chatgpt/<native-model-id>` in the existing
  `modelSelections.selectedModel` field. No database migration. Chat catalogs are
  separate from builder catalogs; choices are the intersection of configured OpenAI
  models and the pinned Pi Codex catalog. A catalog entry is not proof of account entitlement.
- Added connected-account checks, subscription menu labels, selector error handling,
  updated settings guidance, and project subscription-sharing grant resolution.
- Wrapped main chat, custom agent runs, and agent reflections. Calls to the shared
  model factory within those async turns (including title/vision helpers) remain on
  the chosen subscription model even if a helper requests a cheaper API model.
- Added standalone resolution to preview driver, app-profile detection, codebase
  queries, ticket QA, ticket demos, and Instant test explanations. Existing sandbox
  build execution and its separate credential choice remain in place; subscription
  model IDs translate back to native IDs for Pi builds.
- Structured results use a synthetic required function tool, exposed as JSON text
  for AI SDK schema validation. This is not native constrained JSON generation.
  No database mutation executes from partial or unvalidated tool arguments.
- Tests cover text, live document arguments and exactly-once mocked tool execution,
  multi-step results, structured output validation, input capability errors, account
  isolation, cancellation, API preservation, selector rendering, and actual Pi SSE
  parsing with a simulated HTTP response (no paid inference).

## Current limitations and release checklist

- [x] Deterministic adapter/integration tests: 16 tests pass.
- [x] Existing document-preview and navigation checks pass.
- [x] TypeScript typecheck and whitespace/diff checks pass.
- [ ] Real-account end-to-end smoke test: connect a test user, choose a subscription
  model in chat, stream and save a document, create a test ticket, evaluate it, then
  switch back to API. This has not run; mocked tools do not prove database writes,
  authorization integration, browser behavior, or hosted account eligibility.
- [ ] Confirm commercial hosted usage/account policy before broad production rollout.
- [ ] Browser verification in both themes with connected/disconnected/shared users.
- Unsupported provider-hosted tool history requires a new conversation. LFG web
  research tools are used in place of native hosted search. Their service costs,
  sandbox compute, and other non-LLM charges are unaffected by this billing choice.
- Only text and inline images are accepted; unsupported files/models fail explicitly.
- Codex does not honor the API's `maxOutputTokens` field in this transport. The adapter
  reports unsupported settings; cancellation and existing agent step limits remain.
- Background runs select the user's setting when the run starts. Async context is
  not a durable job payload: future independent workers must explicitly resolve the
  model/credential owner as the standalone helpers do. This is not a guarantee that
  arbitrary newly added worker code automatically inherits chat billing.
- Instant's separate page still presents its existing API model menu; project and
  custom-agent chats expose the new subscription section. Existing sandbox builder
  subscription selection is unchanged.
- Dependency installation reported audit warnings; no unrelated automatic audit
  fixes or production deployment were performed.

## Developer verification

```sh
bun test scripts/subscription-model.test.ts
bun run typecheck
node scripts/test-doc-preview-view.mjs
bun run scripts/test-nav-layout.ts
git diff --check
```
