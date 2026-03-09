---
title: "Background Agents: The Infrastructure Layer Your AI Workflow Is Missing"
date: 2026-03-02
excerpt: "Most AI coding tools wait for you to prompt them. Background agents don't. They sit in your infrastructure, watch for triggers, and execute — while you're doing something else. Here's what that actually requires."
slug: background-agents-always-on-ai
---

# Background Agents: The Infrastructure Layer Your AI Workflow Is Missing

Most AI coding tools are reactive. You open a chat window, type a prompt, and wait for a response. The AI works when you ask it to, stops when you stop, and has no memory of what happened between sessions.

That model works for interactive, exploratory tasks. It breaks down for the category of engineering work that is recurring, well-defined, and genuinely better handled without constant human initiation.

Dependency updates. CVE patches. CI migration scripts. Lint and formatting enforcement. Test coverage gaps. Code review triage. These tasks share a profile: they're important, they're time-consuming, they follow a knowable pattern, and they're easy to deprioritize when something more urgent is on fire.

That's the job description for a background agent.

---

## What "Background" Actually Means

The word "background" here isn't about async streaming or non-blocking responses. It's about a fundamentally different operational model: an agent that receives a trigger, reasons about the problem, writes code, runs tests, and opens a pull request — without a human initiating any of it.

The trigger might be a new CVE entry matching your dependency tree. A nightly schedule. A PR landing in a specific repo. A failing test suite. The agent isn't waiting for a chat message. It's subscribed to events.

This distinction matters because it changes what the agent needs to be good at. An interactive agent has a human in the loop at every step, ready to correct course. A background agent doesn't. It needs to know when to proceed, when to stop, and how to bound its own blast radius.

---

## Not a Local Agent, Not a CI Pipeline

Two things get confused with background agents that are worth separating out.

**Running a local AI agent isn't background execution.** A process on your laptop tied to your machine's uptime, your VPN connection, and your development environment isn't infrastructure — it's a hack. True background execution requires isolated compute environments that spin up on demand, run to completion, and shut down cleanly. No lingering processes, no shared state, no "I forgot to turn it back on."

**Background agents aren't CI/CD pipelines.** CI pipelines execute predefined steps. They're deterministic. If you add a new lint rule, you update the pipeline. Background agents are different: they receive an open-ended trigger and reason about what to do. They can read a CVE advisory, identify affected packages, understand your project's specific dependency graph, write a targeted upgrade, run your test suite, and decide whether the result is safe to submit — without you encoding each of those steps in advance.

That's not a pipeline. That's an agent.

---

## The Three Infrastructure Requirements

You can't run real background agents on a prompt interface. You need three things:

**Isolated compute on demand.** Each agent execution needs its own environment — a clean sandbox it can write code in, run tests in, and break without consequences. On LFG, this means a Firecracker microVM per execution: fully isolated, spun up fresh, torn down when done. The agent never touches your production systems directly.

**An event routing layer.** Something has to connect the trigger (a new CVE, a scheduled job, a repository event) to the right agent with the right context. This isn't just a cron job. It's a system that knows which agent should handle which event, what context to pass it, and how to handle failures when the agent doesn't succeed on first attempt.

**A governance layer.** This is the part most teams underestimate. Background agents need guardrails that don't require human presence to enforce: bounded scope (an agent handling dependency updates should only touch dependency files), required review gates before code merges, audit trails of what ran and why, and escalation paths for when the agent hits something it can't resolve.

The governance layer is what separates background agents from background chaos.

---

## Use Cases Worth Running Autonomously

Not every engineering task belongs in a background agent. The sweet spot is work that is:

- Triggered by an external event, not a human decision
- Repetitive enough that a general pattern exists
- Safe to execute in a sandbox and submit via pull request
- Low enough stakes that human review of the PR is sufficient oversight

In practice, this covers more than most teams realize:

- **Dependency updates**: New minor/patch versions across multiple repositories, tested and submitted as PRs
- **CVE remediation**: Matching new vulnerability disclosures against your dependency graph and generating targeted upgrade PRs
- **CI pipeline migrations**: Updating configurations when a provider deprecates syntax or changes defaults
- **Lint and standards enforcement**: Applying new formatting rules or architectural constraints across a codebase after they're adopted
- **Test coverage expansion**: Identifying uncovered code paths and generating tests against acceptance criteria
- **Code review triage**: Summarizing large PRs, flagging potential issues, tagging reviewers based on ownership

The common thread: the agent works from a clear trigger, executes in a contained scope, and hands off to humans for final judgment.

---

## Safety Is an Infrastructure Property

A frequent objection to autonomous agents is: what if they do something wrong?

The right answer isn't "make the agent smarter." It's "design the infrastructure so that when the agent does something wrong, the damage is bounded and reversible."

Concretely:
- The agent runs in an isolated sandbox, not directly against your codebase
- Output is submitted as a pull request, not merged automatically
- Every execution has an audit trail: what triggered it, what the agent did, what it produced
- Scope is constrained by the task definition — an agent handling dependency updates can't touch authentication logic

The blast radius is an infrastructure decision, not an agent capability decision. You make the system safe by limiting what an agent can affect, not by hoping the agent is always correct.

LFG's sandboxed execution model was built around this principle. Every ticket runs in isolation. If the agent produces bad output, you reject the PR. Nothing in production changes until a human approves it.

---

## The Developer Role Shift

Here's the organizational implication that tends to take teams by surprise.

When background agents are handling dependency updates, CVE patches, and test coverage — and handling them reliably — the developer's relationship to that work changes. You stop writing those changes. You start reviewing them.

That's a different skill. It requires knowing what good output looks like, how to quickly spot when an agent went in the wrong direction, and how to calibrate the agent's behavior over time. It's less about executing and more about evaluating.

Some engineers find this uncomfortable. The work feels less tangible. But the practical effect is real: work that used to take half a day of focused effort — identifying the affected packages, testing the upgrade, updating configs, writing the PR — takes ten minutes of review. The compounding effect across a team over months is significant.

The engineers who adapt fastest to this model are the ones who've stopped thinking of code writing as the core job and started thinking of it as one tool among several.

---

## What This Means for LFG

Background agents aren't a separate product category from interactive AI development — they're the same infrastructure, operating in a different mode.

LFG already runs every ticket in an isolated sandbox with a full audit trail and human review gates. The same system that handles an interactive "build this feature" request can handle an event-triggered "patch this CVE" job. The agent topology is identical. What changes is the trigger: a human prompt versus an external event.

We're actively working on event-driven triggers and scheduled agent runs as first-class LFG features. The goal is a single platform where your interactive development work and your background maintenance work share the same execution infrastructure, the same visibility, and the same governance model.

Work shouldn't stop when your chat window closes. The engineering backlog doesn't pause. Neither should your agents.
