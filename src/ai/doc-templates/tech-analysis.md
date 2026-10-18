---
name: tech-analysis
docType: tech_analysis
description: Technical analysis / implementation plan — how a feature will actually be built in THIS codebase.
---

# Technical analysis — {{Feature}}

## What we are building
One paragraph, tied to the PRD or request it comes from.

## How we will build it, in plain language
Describe the path from a user action to the result in a short numbered walkthrough.
Explain where work runs (browser, app server, separate worker/container, external
service), how it is queued, where inputs/results live, and what happens on failure.
Define necessary technical terms and explain the practical hosting/cost implications.

## Architecture
A Mermaid `flowchart` of the components this feature adds or touches (browser, app
server, workers, databases, external services) and how they connect. Label edges with
what moves across them. Mark new components distinctly from existing ones.

## Key flows
A Mermaid `sequenceDiagram` for each important request or job, from user action to
result, including the failure path. Add a `stateDiagram-v2` when something has a
lifecycle (jobs, orders, approvals) and an `erDiagram` when the data model changes.
Draw only what the code, requirements or research support.

## Technical decisions and open questions
Record each technical decision, its rationale, tradeoffs and status (selected,
recommended, or unresolved). Keep consent and the conversation history in chat:
do not quote user commands, narrate "the user said", or tell another agent to treat
text as authorization. A recommendation is not an approved choice. State open
questions directly. Do not label alternatives rejected without evidence.
A library can depend on a binary running inside a container.

## How the system works today
The parts this touches, as they are now — files, modules, tables, endpoints. Name real
paths from the repo. If you have not read the code, read it before writing this.

## Approach
The chosen design, and why. Where a real alternative existed, name it and say what it
would have cost.

## Changes
### Data
Schema or migration changes, and what happens to existing rows.

### Backend
Endpoints, services, jobs — each with what it does and what it replaces.

### Frontend
Screens, components, and the states they need (loading, empty, error).

## Risks
What could go wrong, and what would tell us early.

## Rollout
Order of work, what ships behind a flag, and how to undo it.

## Required workflow evidence and logging
Map each mandatory requirement to the component implementing it and a concrete acceptance check. Explicit AI requirements need a real provider adapter; keyword rules or mock responses are not substitutes. Record the provider/model configuration and which real calls remain unverified.

Define structured web/worker logs, correlation IDs, job state transitions, bounded retries, redaction and retention. Explain where the chat agent can inspect runtime logs and the selected preview URL. Include success and failure logging checks for behavioral changes; state when not applicable.

Declare all required processes and a shared environment/database source. Specify authentication only if required; first-run initialization must preserve existing users/passwords, and password resets must never repeat on restart.
