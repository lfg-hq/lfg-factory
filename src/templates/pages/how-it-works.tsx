import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import { ModelStrip } from "../components/model-strip.tsx";

/**
 * /how-it-works/ — the detailed factory explanation.
 *
 * This is where mechanism belongs. The homepage says what the factory does for
 * a business; this page earns the claim by showing each stage, what it produces
 * and what a person is still responsible for. Screenshots are real product.
 */

const STAGES: Array<{
  num: string; name: string; icon: string; lede: string;
  detail: string[]; outputs: string[]; human: string;
}> = [
  {
    num: "01", name: "Understand", icon: "scan-search",
    lede: "Before anything is built, the requirement has to be understood in the context of the system it lands in.",
    detail: [
      "Reads the requirement alongside the existing codebase, documentation and prior decisions on the project.",
      "Asks the questions a good engineer would ask before starting, rather than guessing and building the wrong thing.",
      "Writes the requirement down as something reviewable, so disagreements surface now instead of at delivery.",
    ],
    outputs: ["PRD", "Acceptance criteria", "Technical analysis"],
    human: "You correct the understanding before a line of code exists — the cheapest place to catch a misread requirement.",
  },
  {
    num: "02", name: "Plan", icon: "map",
    lede: "Architecture and sequencing are decided once, deliberately, and recorded.",
    detail: [
      "Settles the implementation strategy and the architectural decisions the work depends on.",
      "Identifies which systems are affected and what has to happen before what.",
      "Breaks a large requirement into an executable graph of smaller tasks with their dependencies made explicit.",
    ],
    outputs: ["Architecture", "Tickets", "Execution plan"],
    human: "Your engineers review the plan and the ticket graph. Changing the approach here costs a conversation, not a rewrite.",
  },
  {
    num: "03", name: "Build", icon: "terminal",
    lede: "Tickets are executed by coding agents inside isolated environments.",
    detail: [
      "Each ticket runs in its own sandbox, on its own branch, never against a main line.",
      "Independent tickets run in parallel wherever the dependency graph allows it.",
      "Context from earlier tickets travels forward, so ticket forty knows what ticket three decided.",
    ],
    outputs: ["Code", "Commits", "Working previews"],
    human: "Nothing here needs supervising step by step. You can watch any ticket live if you want to.",
  },
  {
    num: "04", name: "Verify", icon: "flask-conical",
    lede: "The agent that wrote the code is not the only thing that checks it.",
    detail: [
      "Tests run, application behaviour is exercised, and the original acceptance criteria are checked against what was actually built.",
      "Failures go back for a fix and run the gauntlet again rather than landing on a person's desk.",
      "What reaches review has already survived the checks that would otherwise eat a reviewer's first pass.",
    ],
    outputs: ["Tests", "QA results", "Issue reports"],
    human: "You see the failures too. A pipeline that hides its own errors is not worth trusting.",
  },
  {
    num: "05", name: "Review", icon: "shield-check",
    lede: "A person approves, on the things that actually need judgment.",
    detail: [
      "Engineers review architecture, security-sensitive decisions and code quality.",
      "Review happens on a complete, verified change rather than on every intermediate agent step.",
      "The approval is recorded against the ticket and the requirement it came from.",
    ],
    outputs: ["Approved changes", "Review trail"],
    human: "This gate is always human. It is the part of the process we are least interested in automating away.",
  },
  {
    num: "06", name: "Ship", icon: "git-merge",
    lede: "The change is prepared for merge and deployment, with the documentation that explains it.",
    detail: [
      "A pull request against your repository, in your existing Git workflow.",
      "Documentation describing what changed and why, written from the decisions on record.",
      "The full trail from requirement through to release stays queryable afterwards.",
    ],
    outputs: ["Pull request", "Documentation", "Release"],
    human: "Merging is your call, in your repository, under your branch protection rules.",
  },
];

export const HowItWorksPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "How the LFG Software Factory Works | Requirement to Release",
  description: "How LFG turns a requirement into shipped software: understanding, planning, building, verification, human review and release — and what a person is responsible for at each stage.",
  path: "/how-it-works/",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "how-it-works" })}

<main>

  <!-- HERO -->
  <section class="relative pt-28 sm:pt-36 pb-16 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
        <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">How it works</span>
      </div>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up max-w-3xl">
        From requirement to
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">release.</span>
      </h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">
        Software delivery is not just writing code. It is understanding what was asked for, deciding how to build it, sequencing the work, verifying it holds together, and being able to explain any of it afterwards. LFG runs that whole path as one pipeline.
      </p>
      <div class="mt-8 flex flex-wrap items-center gap-x-1.5 gap-y-2.5 animate-fade-up">
        ${STAGES.map((s, i) => html`
          ${i > 0 ? html`<i data-lucide="chevron-right" class="w-4 h-4 text-slate-300 shrink-0"></i>` : ""}
          <a href="#stage-${s.num}" class="node hover:border-brand-300 transition-colors"><span class="text-sm font-semibold text-slate-700">${s.name}</span></a>`)}
      </div>
    </div>
  </section>

  <!-- STAGES -->
  ${STAGES.map((s, i) => html`
  <section id="stage-${s.num}" class="${i % 2 === 0 ? "band" : "band-tint"} py-16 sm:py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid lg:grid-cols-12 gap-10">
        <div class="lg:col-span-7">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center"><i data-lucide="${s.icon}" class="w-5 h-5"></i></div>
            <span class="text-xs font-bold text-brand-600 uppercase tracking-wider">${s.num}</span>
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
    </div>
  </section>`)}

  <!-- SEE IT -->
  <section class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-10">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">The record</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Every stage leaves something you can look at.</h2>
        <p class="text-slate-600 text-lg mt-4">Requirements, tickets, execution logs, diffs, previews and review state — while the work is happening, not in a report afterwards.</p>
      </div>
      <div class="grid md:grid-cols-2 gap-6">
        <div class="shot">
          <div class="shot-bar">
            <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
            <span class="ml-2 text-xs font-mono text-slate-400">requirements and plan</span>
          </div>
          <img src="/public/images/screenshots/agent-prd-chat.png" alt="A PRD and technical plan being produced in LFG" loading="lazy" class="w-full block" />
        </div>
        <div class="shot">
          <div class="shot-bar">
            <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
            <span class="ml-2 text-xs font-mono text-slate-400">ticket board</span>
          </div>
          <img src="/public/images/screenshots/agent-ticket-board.png" alt="The LFG ticket board: every ticket, its state and its owner" loading="lazy" class="w-full block" />
        </div>
      </div>
    </div>
  </section>

  <!-- MODELS -->
  <section class="band-tint py-16">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center max-w-2xl mx-auto mb-10">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">The engines</p>
        <h2 class="font-display font-bold text-3xl text-slate-900">The factory is not tied to one vendor.</h2>
        <p class="text-slate-600 mt-4">Claude Code, Codex and other coding agents execute the tickets. Use the model that suits the job, the client, or the budget — and bring your own API key.</p>
      </div>
      ${ModelStrip()}
      <p class="text-center text-sm text-slate-500 mt-8">When coding models improve, the factory improves. <a href="/agent/" class="font-semibold text-brand-700 hover:underline">More about LFG Agent</a>.</p>
    </div>
  </section>

  <!-- CTA -->
  <section class="band py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-4">Watch it run on something of yours.</h2>
      <p class="text-slate-600 text-lg leading-relaxed mb-8">
        Send a real project, feature or backlog item. We will show you how the factory scopes it, plans it, and would execute it.
      </p>
      <div class="flex flex-col sm:flex-row gap-3 justify-center">
        <a href="/#start" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
          Submit a project <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
        <a href="/software-services/#pilot" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
          Book a factory pilot
        </a>
      </div>
    </div>
  </section>

</main>

${SiteFooter()}

</body>
</html>
`;
