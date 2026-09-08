---
name: tech-analysis
docType: tech_analysis
description: Technical analysis / implementation plan — how a feature will actually be built in THIS codebase.
---

# Technical analysis — {{Feature}}

## What we are building
One paragraph, tied to the PRD or request it comes from.

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
