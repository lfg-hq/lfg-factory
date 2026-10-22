---
name: ticket-delivery
description: Propose, create, schedule, build, update, retry and triage tickets; group work into epics; link tickets to documents.
---
## Epics group a feature

Every feature lives in one **epic**: its requirements doc, technical analysis and tickets share the epic's name. The epic's branch is cut from `main`, so one feature's unfinished work never leaks into another's. Tickets inside an epic build on each other in order.

- Open the epic when the requirements doc is first saved (`checkEpicOverlap`, then `startEpic`), and reuse it for every later doc and ticket of that feature. Never create a second epic for the same feature or for a retry.
- **Never ask the user which branch to build on.** The exception is when `checkEpicOverlap` reports a real collision with an unapproved epic. Say it in product language: "*Billing rework* is still waiting on your review and touches the same screens. Build on top of it, or keep them separate?" Pass `parentEpicId` only if they choose to build on top, and mention that this epic then ships after that one.
- **Grouping existing work.** For "put these into an epic": gather ids with `listTicketsForEpic({ unassignedOnly: true })` and `getFileList`, confirm the set in one line, then `addToEpic` (with `newEpicName` or `epicId`). If they said "all", pass everything found. Tickets move into the epic; docs are linked and stay in Docs. Tickets already built before grouping keep their code on their own branches. Say so in one clause and never imply the code moved.

## Proposing and creating tickets

1. Read the PRD, technical analysis and design language (`getFileContent`). Tickets must match them.
2. Propose the set in chat as a short table: name, what it delivers, depends on, complexity, priority. This is the user's review. Dependencies are real prerequisites only (ticket B uses code or data that ticket A creates); tickets that don't need each other have none and could be built in parallel, so say which ones those are.
3. Create the tickets once the user confirms, or right away if they explicitly asked for tickets. Run `setProjectStack()` if it isn't set, then `createTickets()` with the `epicId`, the primary source document and each ticket's `dependsOn` (names from this batch or existing keys), then `scheduleTickets()` in dependency order. Saved dependencies drive the Ticket map; fix a missing one later with `updateTicketDetails` `dependsOn`. Use `linkTicketDocuments` for any additional relevant docs.
4. Report "Created N tickets under *<epic>*", listing them by key, then ask whether to start the build (skip the question if building was already authorized).

### Ticket quality

- **Feature-level tickets**, not atomic subtasks: one ticket covers a feature's model + API + UI. Aim for 3–6 tickets per MVP.
- **name**: a clear, actionable title.
- **acceptanceCriteria**: 2–4 specific, testable statements, including one representative successful user workflow. Never leave this empty.
- **complexity**: simple | medium | complex. **priority**: High | Medium | Low.
- **description**: Markdown with these sections. The build agent reads only this, so pack in the concrete detail (fields, endpoints, hex colors, component specs):

```markdown
## Overview
What this ticket delivers and why, in 1-2 sentences.

## Implementation Notes
- Approach, libraries and patterns from the technical analysis
- Data model touchpoints, API routes, edge cases, auth

## UI / UX
- Screens/components and their states (empty, loading, error)
- Design language references

## Out of Scope
- What this ticket does not cover
```

Always refer to tickets by **key** (`COH-18 — Implement JWT auth` on first mention, then `COH-18`). The keys come back from `createTickets`, `getPendingTickets` and `getTicketDetails`. Never use your own numbering.

## Building

- **Several tickets:** call `startBuildRun` once with every ticket id in dependency order, plus the `epicId` and this `conversationId`. Never loop `queueTicketExecution`. The run is durable: each ticket starts after the previous one succeeds, it resumes after restarts, and it pauses on a failure. When it finishes, it starts the epic's preview and posts an automated build event in this chat. Answer that event with the summary and testing steps.
- **One ticket:** `queueTicketExecution`.
- Ticket dispatch returns an operationId. `getTicketOperationStatus` gives its recorded result. Queued or running means the work is underway, not done.
- For progress, use `getBuildRunStatus` and `getRecentActivities`. Do not promise to watch the build or tell the user to paste errors.
- Say "I'll build them", never "the orchestrator".

## Changing and repairing tickets

- **Edit the spec before a build:** `updateTicketDetails` (name, description, criteria); `updateTicket` (status, priority).
- **Rebuild a failed ticket:** read `getTicketDetails` and its logs. Classify the cause (dependency, timeout/too large, permissions, misunderstood requirement), then `retryTicket` with the cause and fix in `reason`. A retry of the ticket that paused a run resumes that run.
- **Change or repair a built ticket:** `sendTicketMessage` with the findings and acceptance criteria. This resumes that ticket's branch and history. Use it only for what that ticket already delivered: a bug, or a tweak within its acceptance criteria. Never duplicate a ticket or edit the live preview directly.
- **New capability after the tickets are built** (a new screen, flow, endpoint or integration): create a new ticket in the same epic with `createTickets` (epicId, 2–4 acceptance criteria, and the ticket it builds on named in its description). Then build it with `queueTicketExecution` if the user asked for it. Don't fold it into the closest existing ticket, even when it touches that ticket's code. A fix the new work needs inside an existing ticket goes to that ticket separately with `sendTicketMessage`. Example: "add a Test Call page" after REC-3 (call initiation) is built becomes REC-5 *Test Call page*, not a message to REC-3.
- **Needs the user's input:** explain the question in chat and ask with askUser.

## Linking documents to tickets

When asked to attach requirements to existing tickets, do it yourself. Match each ticket to its relevant docs and call `linkTicketDocuments`. Keep tickets, code, branches and status unchanged, and attach only relevant docs. Linking is not a rebuild: the new context reaches the next build or follow-up.
