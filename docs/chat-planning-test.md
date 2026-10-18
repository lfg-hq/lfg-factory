# Main chat planning test

This is a real browser-driven conversation, not a mocked model test. It opens Chrome, starts a new chat in the chosen project and runs the Recruiting scenario through requirements, technical analysis and draft ticket planning. It does not approve implementation. You can review the agent's actual responses and visible tool activity afterward; hidden model reasoning is not captured.

## Run

From the repository root:

```sh
node scripts/chat-planning-test.mjs --base-url http://localhost:3000
```

Choose the actual port of your local server. To intentionally test the deployed application instead:

```sh
node scripts/chat-planning-test.mjs --base-url https://lfg.run
```

Chrome uses a separate profile at `~/.lfg-planning-test-chrome`, so your usual browsing profile is not touched. Log in in that Chrome window, select the model you want to test, then press Enter in the terminal. The script navigates back to a fresh chat after login and uses the project's configured agent. The default project is Recruiting (`0df5e7e4-5cb5-4f0e-b284-ac1df5a7f04e`). To use another project, add `--project UUID`.

Run only one instance per Chrome profile. Install Chrome and the repository dependencies first. No API key or password is passed to the script; it uses the logged-in application session. The profile contains login credentials and should stay private.

## What it does

1. Records the existing documents, epics and tickets as a baseline.
2. Discusses the candidate self-upload recruiting app.
3. Settles English, Exotel, explicit candidate consent and recruiter-reviewed summaries.
4. Authorizes a separate test requirements document and technical analysis.
5. Requests draft, unscheduled tickets and dependencies, and stops before building.
6. Requests a final inventory of actual artifacts and unresolved decisions.

Every new test artifact is requested with a unique `planning-test-...` label. Existing assets must be preserved. These are real persistent writes and model calls can incur costs; use a test project if you do not want test artifacts in Recruiting. Nothing is automatically deleted afterward.

The no-build boundary is an explicit instruction to the agent, not a server-side execution sandbox. Use a non-production test project when testing agent compliance. Do not run other work in that project concurrently if you want clean before/after attribution.

Known clarification cards are answered from the scenario. Unknown questions stop the run for review rather than guessing. Generic confirmation buttons are never blindly accepted; the next message provides the scenario's specific authorization. A timeout or interrupted turn is reported as needing review, not retried automatically: server work may still be running. Inspect that chat and use its Stop control if needed before another run.

## Review output

Each run saves under `test-results/chat-planning/<run-id>/`:

- `report.md`: prompts, replies, outcome and a quality-review checklist.
- `report.json`: captured visible activity events, conversation ID, before/after artifact snapshots, and content of new or changed documents after each turn.
- `turn-N.png` and `final.png`: screenshots of the chat.

`completed-for-review` means the script finished; it is not a claim that the agent's output is correct. Check the requirements, technical analysis, saved tickets versus proposed tickets, repeated confirmations, skill names and whether the agent respected the build boundary. Snapshots are project-wide; changes are not conclusively attributable to this run if other work is happening concurrently.

Reports contain project content. Common OpenAI key and bearer-token strings are redacted from text exports, but this is not comprehensive secret detection and screenshots are unredacted. Keep these local and review them before sharing.

## Customize

Edit or copy `scripts/scenarios/recruiting-planning.json`. `turns` are successive user messages; `answers` maps question patterns to safe, predefined clarification responses. Unknown questions deliberately require review.

```sh
node scripts/chat-planning-test.mjs \
  --base-url http://localhost:3000 \
  --scenario scripts/scenarios/recruiting-planning.json \
  --timeout-seconds 600
```

Other options: `--profile DIR`, `--output DIR`, `--project UUID`. `--help` does not launch a browser or send messages. The default response deadline is ten minutes per turn; the clarification loop is limited to five rounds per scenario turn.
