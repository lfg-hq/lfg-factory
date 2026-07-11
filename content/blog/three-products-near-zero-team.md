---
title: "Three production products, one near-zero team: the numbers behind the LFG factory"
date: 2026-06-10
excerpt: "Almost nobody publishes their numbers. We are, because our entire business is the factory. Here is what it actually took to build and run mags.run, easylogs.co, and kitereach.com."
slug: three-products-near-zero-team
---

# Three production products, one near-zero team: the numbers behind the LFG factory

The claim that AI collapses software build cost is everywhere. You read it in every keynote, every pitch deck, every thread. What you almost never see is the receipt.

Almost nobody publishes their numbers. We are doing it because our entire business is the factory, and the factory is only credible if the numbers are real. If we cannot show you what it took to build our own products, we have no business asking you to run your client work through it.

Below is what it actually took to build and run three production products: mags.run, easylogs.co, and kitereach.com. Time, ticket counts, agent hours against human hours, and the parts the agent could not do. The honest version, including where it fell short.

<!-- TODO: NEEDS_DATA: Before publishing, pull real figures from git history and project records for each product below. Every line marked NEEDS_DATA must be replaced with a real (even if rough) number. Delete this comment when done. -->

## mags.run

<!-- TODO: NEEDS_DATA: two-sentence description of what mags.run is and who it is for. -->
What it is: Sandboxed cloud VMs for AI agent execution, built on Firecracker microVMs. NEEDS_DATA: second sentence on the core use case.

| Metric | Value |
| --- | --- |
| Time from brief to first production deploy | NEEDS_DATA |
| Total tickets executed by agents | NEEDS_DATA |
| Agent execution hours vs human review hours | NEEDS_DATA |
| Stack | NEEDS_DATA (e.g. Firecracker, ublk, FastCDC, Rust, ...) |

**The hardest part the agent could not do:** NEEDS_DATA. <!-- Likely the Firecracker / ublk / FastCDC infrastructure work. Be specific and honest. -->

**One thing that surprised us:** NEEDS_DATA.

## easylogs.co

<!-- TODO: NEEDS_DATA: two-sentence description of what easylogs.co is and who it is for. -->
What it is: Developer logging and observability without the operational overhead. NEEDS_DATA: second sentence on the core use case.

| Metric | Value |
| --- | --- |
| Time from brief to first production deploy | NEEDS_DATA |
| Total tickets executed by agents | NEEDS_DATA |
| Agent execution hours vs human review hours | NEEDS_DATA |
| Stack | NEEDS_DATA |

**The hardest part the agent could not do:** NEEDS_DATA.

**One thing that surprised us:** NEEDS_DATA.

## kitereach.com

<!-- TODO: NEEDS_DATA: two-sentence description of what kitereach.com is and who it is for. -->
What it is: An AI outreach platform for targeted, high-signal campaigns. NEEDS_DATA: second sentence on the core use case.

| Metric | Value |
| --- | --- |
| Time from brief to first production deploy | NEEDS_DATA |
| Total tickets executed by agents | NEEDS_DATA |
| Agent execution hours vs human review hours | NEEDS_DATA |
| Stack | NEEDS_DATA |

**The hardest part the agent could not do:** NEEDS_DATA.

**One thing that surprised us:** NEEDS_DATA.

## What the pipeline actually looks like

Numbers are easy to wave at. Here is one concrete ticket, end to end, so you can see how a single unit of work moves through Define, Build, and Ship.

<!-- TODO: NEEDS_DATA: Pick one real ticket from one of the three products and fill in the specifics below. Pick something representative, not the easiest one. -->

**Define.** NEEDS_DATA: what the ticket was, and the context the agent received (the PRD section, the architecture notes, the acceptance criteria, the relevant files it was pointed at).

**Build.** NEEDS_DATA: the diff size (files touched, lines added and removed), how long the agent ran, and what it produced.

**Ship.** NEEDS_DATA: the review outcome. Did it pass on the first review? What did the senior engineer change or push back on before it shipped?

This is the loop, repeated across every ticket in the graph: the agent does the volume, a senior engineer does the judgment, and nothing reaches production without a human sign-off.

## What this means if you run a services firm

The interesting part is not that a tiny team shipped three products. It is what the same pipeline does to a cost structure built for headcount.

If a team you can count on one hand can ship three production products, a 500-person services firm running this pipeline is not looking at a productivity bump. It is looking at a different cost structure entirely. The work you staff juniors on gets absorbed by agents. Your senior layer stops being a review bottleneck and becomes the product you sell. You stop billing for effort and start pricing delivery.

We wrote up what that looks like for an IT services firm, with the margin math, on the [factory page](/factory/).

## Where humans still carry the load

We are not going to pretend the agent did all of this on its own. It did not.

Architecture judgment is still human. The agent is good at executing a plan and weak at deciding which plan is right when the tradeoffs are subtle. Security review is human: we do not ship auth, payments, or data-handling code on agent confidence alone. And the hardest infrastructure work, the kind that touches kernels, storage, and the edges of the platform, is still where an experienced engineer earns their keep. The agent accelerates all of it. It replaces none of it.

That is the honest shape of the factory. AI does the volume. Senior engineers do the judgment. The result is three products from a near-zero team, and a delivery model we are willing to put our own numbers behind.

If you want to run your own project through it, [book a pilot on the factory page](/factory/) or read the code on [GitHub](https://github.com/lfg-hq/lfg).
