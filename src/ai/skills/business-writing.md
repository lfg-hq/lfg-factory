---
name: business-writing
description: Writing for outside readers — case study, pitch, proposal, one-pager, collateral, post, client email. Brief (reader, purpose, evidence), when to ask, evidence rules, honest doc type, reader pass. NOT for PRDs, specs or tickets.
---

## Writing for readers outside the build

### 1. Product doc or business writing?
Decide this first. The two need opposite instincts.

| | Product doc | Business writing |
|---|---|---|
| Examples | PRD, technical analysis, spec, design doc, tickets, release notes for the team | case study, pitch, one-pager, proposal, sales or investor deck copy, blog or launch post, email to a client |
| Reader | the team building it | a buyer, partner, investor, candidate or the public |
| Job | say what to build and how | change what the reader believes or does |
| Source of truth | the code, the docs, the decisions | **evidence**: measured results, real customers, things a reader can check |
| Shape | the project's template | the reader and the purpose decide it |
| Empty section | write "open question" | **cut the section** |

Clues that it is business writing: an outside audience is named (clients, prospects, investors, "the website", LinkedIn, a market such as "for the UAE"). The words case study, pitch, proposal, one-pager, deck, post or announcement. Or the text has to persuade someone rather than instruct the team.

When a request is both (for example "a case study of the feature we built"), it is business writing **about** a product. The code tells you what the product does. It does not tell you what the reader cares about, or what has been proven.

### 2. Get the brief before you write
Four things must be clear before the first draft:

1. **Reader.** Who exactly: role, sector, market, how sceptical they are.
2. **Purpose.** What the reader should do or believe afterwards: agree to a pilot, book a call, invest, approve a budget.
3. **Evidence.** What has really been shown: measured numbers, customer quotes, completed pilots, working demos. Note who measured it, and for **which product**.
4. **Limits.** What must not be claimed, and what is confidential. Also the market facts that matter to the reader (language, dialect, regulation, buying habits).

**First look it up yourself.** Read the epic, its docs and tickets (getEpicStatus, getTicketDetails), Notes and the conversation. Find out what is built, what is verified and what is only planned. Then ask about the gaps.

**When to ask.** Call `askUser` **before drafting** if the reader or the purpose is not stated or obvious, or if what you found leaves no evidence for the kind of document they asked for. Use one call with up to 4 questions. Each question has suggested options built from what you found, and your recommendation first. Good questions sound like:
- "Who will read this?" → prospects in a named sector / an investor / the internal team / the website
- "What should it get them to do?" → agree to a pilot / book a demo / approve budget
- "No results have been measured for this feature yet (a full call in each language isn't verified). What should this be?" → a pilot proposal (recommended) / an internal brief / wait for a verified result and write the case study then

Do not ask when the user already gave the reader and the purpose, or when it is a short internal piece (a summary for the team, a status update). Then state your assumption in one line and write.

### 3. Evidence rules
- **Every claim traces to evidence.** Before the draft goes out, each number, result and "we proved" must point to something from step 2. If it doesn't, cut it or rewrite it as a goal ("the pilot will measure…").
- **Never borrow results from another product, feature or customer** to fill a results section. If a related product's number is truly relevant, use it at most once, labelled as that product's, and never as this product's proof.
- **Don't build multipliers from a throttle or a guess.** "5x more calls" needs both sides measured the same way. If the limit was a setting you chose, say what changed ("volume is no longer the constraint"), not a ratio.
- **No section without evidence.** A template slot (Results, Customers, Who it's for) with nothing true to put in it gets cut. Never fill it with guesses or placeholder lists marked "not validated".
- **Don't say "proven" for what isn't verified.** Built, in review, demoed internally, verified by a native speaker or user, and measured in a pilot are different states. Use the exact one.

### 4. Pick the honest document type
The type the user named is a request, not a rule. If the evidence does not support it, tell them so and recommend the type that fits (ask with `askUser` if they haven't chosen):

| What exists | Write |
|---|---|
| Measured results from real use | **Case study** |
| A working build or demo, no outside results | **Pilot proposal** or **solution brief**: the problem, the approach, what makes it different, what a pilot would measure |
| An idea or a plan | **Concept note** or **pitch** |
| Progress to report to the team | **Internal brief** (status, risks, next steps). No sales framing |

Never mix collateral and status in one document. "In review" and "being finalised" don't belong in something a prospect reads. Unvalidated market guesses don't belong in an internal brief.

### 5. Write for the reader
- Lead with the one thing a competitor can't easily say. Usually that is a hard-won detail, not the tech stack. Example: gendered grammar matched to the voice, with real examples in the script, is stronger than "built on a managed voice service".
- Hide internals the reader doesn't need: frameworks, database, auth details. Don't describe the work as configuring a vendor unless that is the point.
- Respect the reader's market. If a language, dialect, regulation or local norm makes the current product wrong for them, say so in the body, not only in a roadmap.
- Keep it short. One page beats five for a first touch.

### 6. Reader pass before you hand it over
Reread the draft as the named reader and check:
1. Do any two sections contradict each other (for example, a claim of proof and a "not yet verified" list)?
2. Does every claim and number trace to evidence from step 2, for this product?
3. Is there a section with nothing true in it? Cut it.
4. Is anything only the team would care about (status, tooling, stack) left in collateral?
5. Would this reader's market find anything wrong (language, regulation, positioning)?

Fix what you find before saving. In chat, give one line on what you left out and why (for example "No results section: nothing is measured yet, so it's written as a pilot proposal").
