import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import { ModelStrip } from "../components/model-strip.tsx";
import { LifecycleRail, PHASES } from "../components/lifecycle.tsx";

/**
 * /how-it-works/ — the detailed factory explanation.
 *
 * Mechanism lives here. The stage names, numbers and phases come from the
 * shared lifecycle definition so this page cannot drift from the homepage;
 * this file only adds the depth for each stage — what happens, what it
 * produces, and where a person is still responsible.
 */

interface StageDetail {
  lede: string;
  detail: string[];
  outputs: string[];
  human: string;
  /** A real screenshot of this stage's output. [src, chrome label, alt] */
  shot?: [string, string, string];
}

const S = "/public/images/screenshots";

const DETAIL: Record<string, StageDetail> = {
  Scope: {
    lede: "Before anything is built, the request has to be understood in the context of the system it lands in.",
    detail: [
      "Reads the request alongside your codebase, existing documentation and the tools you connect: trackers, docs, MCP servers.",
      "Asks the questions a good engineer would ask before starting, rather than guessing and building the wrong thing.",
      "Separates what is being asked for from what is merely nice to have, so the plan is sized to the real goal.",
    ],
    outputs: ["Scope", "Open questions", "Technical analysis"],
    human: "You correct the understanding before a line of code exists. That is the cheapest place to catch a misread requirement.",
  },
  Plan: {
    lede: "The architecture decisions get made before anyone writes code, not discovered in a pull request.",
    detail: [
      "For every epic, LFG writes a technical analysis: what is being built, and how, in plain language.",
      "Key flows are drawn as sequence diagrams, failure paths included, so the design can be checked before it is built.",
      "It is honest about status: a design is labelled a proposal, a diagram is labelled intended behaviour, until the code proves otherwise.",
    ],
    outputs: ["Technical analysis", "Sequence diagrams", "Architecture decisions"],
    human: "Your architect reviews the decisions in one sitting. Changing them here costs a conversation, not a rewrite.",
    shot: [`${S}/lfg-analysis.webp`, "technical analysis", "An LFG technical analysis: what we are building and how, in plain language"],
  },
  Document: {
    lede: "Everything a good team writes before it builds, written and kept current.",
    detail: [
      "A PRD with features, priorities and acceptance criteria. That last part is what the verification stages check against later.",
      "Technical documentation for the decisions made in planning.",
      "Every document is versioned, so scope can change without the record of why getting lost.",
    ],
    outputs: ["PRD", "Acceptance criteria", "Technical docs"],
    human: "Agree what done means now, so passing at the end is a fact rather than an opinion.",
    shot: [`${S}/lfg-prd.webp`, "pilot requirements", "A requirements document in LFG: problem, goal and what will be built"],
  },
  Ticket: {
    lede: "The plan becomes a graph of work small enough to build and check on its own.",
    detail: [
      "Breaks the plan into tickets with their dependencies made explicit.",
      "Each ticket carries its own acceptance criteria and links back to the requirement that caused it.",
      "Tickets live in LFG's board, and sync to Jira or Linear if that is where your team already works.",
    ],
    outputs: ["Tickets", "Dependency graph", "Board"],
    human: "Reprioritise, split or cut tickets. The plan is yours to shape.",
    shot: [`${S}/lfg-ticket-board.webp`, "tickets", "LFG tickets grouped by epic, each epic on its own branch"],
  },
  Implement: {
    lede: "Coding agents execute the tickets, many at once, each in its own sandbox.",
    detail: [
      "Claude Code, Codex or Pi sessions run in isolated sandboxes, each on its own branch, never against a main line.",
      "Independent tickets run in parallel wherever the dependency graph allows, which is how the factory operates at scale.",
      "Context from earlier tickets travels forward, so ticket forty knows what ticket three decided.",
    ],
    outputs: ["Code", "Commits", "Live session logs"],
    human: "Nothing needs supervising step by step. Watch any session live, steer it or restart it if you want to.",
  },
  Test: {
    lede: "The agent that wrote the code is not the one that decides whether it works.",
    detail: [
      "The QA agent writes tests from the ticket's acceptance criteria.",
      "Each test runs against the code before the change and after it. Fail then pass is kept; pass both times is discarded as proving nothing; fail both times is reported.",
      "Kept tests land as their own commit on the ticket's branch, so the suite grows with the product.",
    ],
    outputs: ["Proven tests", "Test results", "Issue reports"],
    human: "You see the failures too. A pipeline that hides its own errors is not worth trusting.",
  },
  QA: {
    lede: "Every change runs, in front of you, inside LFG.",
    detail: [
      "LFG works out how the app runs, provisions its databases, applies migrations and seed data, starts it and opens it in an in-app browser.",
      "Frontend changes are exercised in a real browser and recorded as a walkthrough. API changes are called and their responses captured.",
      "Run a fresh sandbox per ticket, or a shared always-on preview of the whole project.",
    ],
    outputs: ["In-app preview", "Walkthrough recording", "QA verdict"],
    human: "Click through the change yourself before you read the diff.",
    shot: [`${S}/lfg-preview-tab.webp`, "preview", "An app built by LFG running in the Preview tab at its own URL"],
  },
};

const STAGES = PHASES.flatMap((p) => p.stages.map((s) => ({ ...s, phase: p, ...DETAIL[s.name] })));

export const HowItWorksPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "How LFG Works | Scope, Plan, Document, Ticket, Implement, Test, QA",
  description: "How LFG runs the software lifecycle in seven stages: deciding what to build, implementing it with Claude Code, Codex and Pi in parallel sandboxes, and verifying it with proven tests and an in-app preview.",
  path: "/how-it-works/",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "how-it-works" })}

<main>

  <!-- HERO -->
  <section class="relative pt-28 sm:pt-36 pb-16 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
        <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">How it works</span>
      </div>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up max-w-3xl">
        Seven stages, from idea to
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">verified change.</span>
      </h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">
        Software delivery is not just writing code. It is deciding what to build, sequencing the work, building it, and knowing it works. LFG runs that whole path as one pipeline, and every stage leaves something you can open and check.
      </p>
      <div class="mt-10 animate-fade-up">
        ${LifecycleRail()}
      </div>
    </div>
  </section>

  <!-- STAGES -->
  ${STAGES.map((s, i) => html`
  ${i === 0 || STAGES[i - 1].phase.key !== s.phase.key ? html`
  <div class="bg-slate-900 py-5">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 flex items-baseline gap-3">
      <span class="font-display font-bold text-white text-lg">${s.phase.label}</span>
      <span class="text-sm text-slate-400">${s.phase.who}</span>
    </div>
  </div>` : ""}
  <section id="stage-${s.num}" class="${i % 2 === 0 ? "band" : "band-tint"} py-16 sm:py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid lg:grid-cols-12 gap-10">
        <div class="lg:col-span-7">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center"><i data-lucide="${s.icon}" class="w-5 h-5"></i></div>
            <span class="text-xs font-bold text-brand-600 uppercase tracking-wider">Stage ${s.num}</span>
          </div>
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-4">${s.name}</h2>
          <p class="text-lg text-slate-600 leading-relaxed mb-6">${s.lede}</p>
          <ul class="space-y-3">
            ${s.detail.map((d) => html`<li class="flex gap-3 text-slate-600"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-1 shrink-0"></i><span class="leading-relaxed">${d}</span></li>`)}
          </ul>
        </div>
        <div class="lg:col-span-5">
          <div class="rounded-2xl border border-slate-200 bg-white p-6 mb-5">
            <p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">What it produces</p>
            <div class="flex flex-wrap gap-2">
              ${s.outputs.map((o) => html`<span class="text-sm font-medium px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700">${o}</span>`)}
            </div>
          </div>
          <div class="rounded-2xl border-l-4 border-brand-500 bg-white p-6">
            <p class="text-[11px] font-bold text-brand-600 uppercase tracking-wider mb-2">Where you come in</p>
            <p class="text-sm text-slate-600 leading-relaxed">${s.human}</p>
          </div>
        </div>
      </div>
      ${s.shot ? html`
      <div class="shot mt-10">
        <div class="shot-bar">
          <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
          <span class="ml-2 text-xs font-mono text-slate-400">${s.shot[1]}</span>
        </div>
        <img src="${s.shot[0]}" alt="${s.shot[2]}" loading="lazy" class="w-full block" />
      </div>` : ""}
    </div>
  </section>`)}

  <!-- SIGN-OFF -->
  <section class="bg-slate-900 py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
        <div class="lg:col-span-6">
          <p class="text-xs font-bold text-brand-400 uppercase tracking-wider mb-3">Then: your sign-off</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-white leading-tight mb-5">A person approves a verified change.</h2>
          <ul class="space-y-3 text-slate-300">
            <li class="flex gap-3"><i data-lucide="check" class="w-4 h-4 text-brand-400 mt-1 shrink-0"></i><span>Review happens on a complete, running, tested change, not on every intermediate agent step.</span></li>
            <li class="flex gap-3"><i data-lucide="check" class="w-4 h-4 text-brand-400 mt-1 shrink-0"></i><span>A pull request lands in your GitHub or GitLab repository, under your branch protection rules.</span></li>
            <li class="flex gap-3"><i data-lucide="check" class="w-4 h-4 text-brand-400 mt-1 shrink-0"></i><span>The trail from request to merge stays queryable afterwards: scope, plan, tickets, sessions, tests, recordings, approvals.</span></li>
          </ul>
          <p class="text-white font-semibold mt-6">This gate is always human. It is the part we are least interested in automating away.</p>
        </div>
        <div class="min-w-0 lg:col-span-6">
          <div class="shot">
            <div class="shot-bar">
              <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
              <span class="ml-2 text-xs font-mono text-slate-400">ticket review</span>
            </div>
            <img src="${S}/agent-ticket-execution.png" alt="A ticket in LFG with its execution log, diff and review state" loading="lazy" class="w-full block" />
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- MODELS -->
  <section class="band-tint py-16">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center max-w-2xl mx-auto mb-10">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">The engines</p>
        <h2 class="font-display font-bold text-3xl text-slate-900">Not tied to one vendor.</h2>
        <p class="text-slate-600 mt-4">Claude Code, Codex and Pi execute the tickets. Use the model that suits the job, the client or the budget, on the Claude and ChatGPT plans your team already has or on API keys.</p>
      </div>
      ${ModelStrip()}
      <p class="text-center text-sm text-slate-500 mt-8">When coding models improve, the factory improves. <a href="/agent/" class="font-semibold text-brand-700 hover:underline">More about the platform</a>.</p>
    </div>
  </section>

  <!-- CTA -->
  <section class="band py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-4">Watch it run on something of yours.</h2>
      <p class="text-slate-600 text-lg leading-relaxed mb-8">
        Send a real project, feature or backlog item. We will show you how LFG scopes it, plans it, builds it and proves it works.
      </p>
      <div class="flex flex-col sm:flex-row gap-3 justify-center">
        <a href="/#start" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
          Talk to us <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
        <a href="/auth/register" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
          Try LFG free
        </a>
      </div>
    </div>
  </section>

</main>

${SiteFooter()}

</body>
</html>
`;
