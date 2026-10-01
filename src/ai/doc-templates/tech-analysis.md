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

## Technical decisions agreed with the user
Before authoring this document, discuss material alternatives in chat and obtain a
choice or explicit delegation. Record the decision, tradeoffs, user confirmation,
and remaining assumptions. A recommendation is not an approved choice. Do not label
alternatives rejected without evidence. A library and Docker are not necessarily
alternatives: a library can still depend on a binary running inside a container.

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
