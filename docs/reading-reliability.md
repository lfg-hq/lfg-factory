# Document and repository reading

Implemented September 7, 2026. No database migration or API-key authentication changes.

## Workflow

- Saved report/audit/overview review requests are directed to document tools first. A per-turn guard prevents repository calls before a document is retrieved for these requests (explicit source-verification requests are exempt).
- Source investigation should target specific verification gaps, not be a prerequisite for document-based recommendations.
- Identical repository queries reuse their per-turn result. After two incomplete investigations, the agent must answer with available evidence rather than start another scan.
- Retrieved repository responses are cached within the turn, keyed by URL and credential identity. Failed requests are not cached. File reads/searches are also memoized within an investigation.

## Limits and recovery

- Each repository HTTP request, including body consumption: 30 seconds.
- Entire investigation, including setup: 10 minutes.
- Investigation inactivity: 2 minutes. Actual model output/tool activity and completed repository requests reset this timer. Connection heartbeats do not.
- Parent cancellation propagates into the model and repository requests. Stop/disconnect is not relabelled as a model timeout.
- A timed-out investigation returns partial text/findings and a warning to the parent chat agent. The final answer must distinguish verified findings from document-only recommendations.
- The existing outer chat inactivity watchdog remains a final safety net.

## Model routing

- Subscription repository investigation uses `gpt-5.6-luna` with low reasoning and the same subscription token resolver. The selected chat model is unchanged for final synthesis and saved-document interpretation.
- Other subscription helper workflows are unchanged unless they explicitly request an override.
- API repository investigation retains the existing same-provider lite-model choice and API keys.
- No fallback from a failed subscription request to API billing. If Luna is unavailable to the account, report incomplete inspection rather than bill an API key.
- The reasoning adapter forwards `reasoningEffort`; the installed Pi transport supports it. Background: [official reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning).

## Verification

Run `bun test scripts/reading-reliability.test.ts scripts/subscription-model.test.ts`, `node scripts/test-agent-trail.mjs`, `node scripts/test-codebase-progress.mjs`, and `bun run typecheck`.

These are offline regression checks, not evidence of live account/model availability. For manual testing, review a saved report, run a targeted source query, stop an active query, and repeat in API-key mode. Check that timeout warnings preserve findings and failed trails do not show a green check.
