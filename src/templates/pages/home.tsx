import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import type { BlogPost } from "../../utils/blog.ts";

/**
 * Homepage.
 *
 * Sells a delivery model, not an agent. Every section is filtered through one
 * question from the brief: does this help a buyer understand how LFG lets them
 * deliver more software with less engineering effort? Agent mechanics that only
 * answer "is the technology clever" live on /agent/ and /how-it-works/.
 *
 * Deliberately absent: invented delivery metrics. The case-study numbers render
 * as em dashes until real ones exist — a proposition this strong cannot afford
 * proof anyone could catch out.
 */

const PIPELINE = ["Requirements", "Architecture", "Tickets", "Build", "Test", "Review", "Ship"];

const COMPARISON: Array<[string, string]> = [
  ["Starts with a prompt", "Starts with a business requirement"],
  ["Works on a coding task", "Coordinates an entire project"],
  ["The developer supplies context", "Maintains project context"],
  ["Generates code", "Plans, builds, tests and documents"],
  ["Sessions are managed one at a time", "Work is broken into dependency-aware tickets"],
  ["The developer coordinates execution", "The factory coordinates execution"],
  ["Code is the artifact", "PRDs, architecture, tickets, code, tests, documentation"],
  ["QA happens separately", "Verification is part of the pipeline"],
  ["The developer owns the workflow", "People supervise outcomes and the decisions that matter"],
];

const STAGES: Array<[string, string, string, string, string[]]> = [
  ["01", "Understand", "scan-search",
   "LFG reads the requirement alongside your existing codebase, documentation and the business context around it.",
   ["PRD", "Acceptance criteria", "Technical analysis"]],
  ["02", "Plan", "map",
   "The factory settles the architecture and breaks the work into dependency-aware implementation tasks.",
   ["Architecture", "Tickets", "Execution plan"]],
  ["03", "Build", "terminal",
   "Tickets are executed inside isolated development environments, in parallel wherever the dependency graph allows.",
   ["Code", "Commits", "Working previews"]],
  ["04", "Verify", "flask-conical",
   "Tests, application behaviour and the original acceptance criteria are all checked before anything reaches a person.",
   ["Tests", "QA results", "Issue reports"]],
  ["05", "Review", "shield-check",
   "Your engineers review architecture, security-sensitive decisions and code quality — not every intermediate step.",
   ["Approved changes", "Review trail"]],
  ["06", "Ship", "git-merge",
   "Changes are prepared for merge and deployment with the documentation that explains them.",
   ["Pull request", "Documentation", "Release"]],
];

const TRUST: Array<[string, string, string]> = [
  ["folder-git-2", "Your repository", "LFG works inside your existing Git workflow and your own repositories. Nothing is held hostage."],
  ["user-check", "Human approval", "Agents do not decide on their own what enters production. A person signs off."],
  ["box", "Isolated execution", "Build jobs run inside isolated environments, not loose on your machines."],
  ["history", "Audit trail", "Requirements, tickets, code changes and reviews stay traceable after the fact."],
  ["cpu", "Model choice", "Use the model that suits the job — Claude, GPT, Gemini, or open models — rather than one vendor's."],
  ["server", "Self-hosting", "Stricter requirements can run the whole thing inside your own infrastructure. The core is MIT."],
];

const VISIBLE = ["Requirements", "Architecture", "Tickets", "Dependencies", "Agent execution",
                 "Commits", "Test results", "QA issues", "Reviews", "Release status"];

const CASE_STUDIES: Array<[string, string, string, string]> = [
  ["Mags", "mags", "/public/images/screenshots/mags.png", "Job-runner platform, built end to end on the factory."],
  ["Easylogs", "easylogs", "/public/images/screenshots/easylogs.png", "Developer observability platform, requirements through production."],
  ["Kitereach", "kitereach", "/public/images/screenshots/kitereach.png", "Go-to-market product stack, shipped and running live."],
];

export const HomePage = ({ posts = [] }: { posts?: BlogPost[]; turnstileSiteKey?: string }) => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "AI Software Development & Software Factory | LFG",
  description: "LFG is an AI software factory for businesses and software services companies. Plan, build, test and ship production software with AI agents and engineering oversight.",
  path: "/",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "home" })}

<main>

  <!-- ═══════════ 1. HERO ═══════════ -->
  <section class="relative pt-28 sm:pt-36 pb-16 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="absolute top-24 left-[4%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>

    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="max-w-3xl">
        <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
          <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
          <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">AI-native software development</span>
        </div>
        <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up">
          Ship more software<br>with
          <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">smaller teams.</span>
        </h1>
        <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">
          LFG is an AI software factory that turns requirements into production-ready software. It plans the work, builds the features, runs the tests, documents the changes and prepares the release, while engineers review the decisions that matter.
        </p>
        <p class="text-base text-slate-500 mt-3 max-w-2xl animate-fade-up">
          Built for software services companies, startups and growing businesses.
        </p>

        <div class="mt-8 flex flex-col sm:flex-row gap-3 animate-fade-up">
          <a href="#start" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
            Build a project with LFG <i data-lucide="arrow-right" class="w-4 h-4"></i>
          </a>
          <a href="/software-services/" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
            LFG for software companies
          </a>
        </div>
        <p class="mt-4 text-sm animate-fade-up">
          <a href="/agent/" class="text-slate-500 hover:text-brand-600 transition-colors inline-flex items-center gap-1.5">Explore the LFG Agent <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i></a>
        </p>
      </div>

      <!-- The product, in one line, before anyone scrolls -->
      <div class="mt-14 animate-fade-up">
        <div class="flex flex-wrap items-center gap-x-1.5 gap-y-2.5">
          ${PIPELINE.map((step, i) => html`
            ${i > 0 ? html`<i data-lucide="chevron-right" class="w-4 h-4 text-slate-300 shrink-0"></i>` : ""}
            <div class="node ${i === PIPELINE.length - 1 ? "node-accent" : ""}">
              <span class="text-sm font-semibold ${i === PIPELINE.length - 1 ? "text-brand-700" : "text-slate-700"}">${step}</span>
            </div>`)}
        </div>
        <p class="text-sm text-slate-500 mt-4">One pipeline, from the requirement to the release. Your engineers hold the review gate.</p>
      </div>
    </div>
  </section>

  <!-- ═══════════ 2. AUDIENCE SPLIT ═══════════ -->
  <section class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">One software factory. Two ways to use it.</h2>
        <p class="text-slate-600 text-lg mt-4">An AI software factory for modern software development — whether you need software built, or you build it for other people.</p>
      </div>

      <div class="grid lg:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-slate-200 bg-white p-8 flex flex-col">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="package" class="w-5 h-5"></i></div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">I need software built</p>
          <h3 class="font-display font-bold text-2xl text-slate-900 mb-3">Let LFG build it.</h3>
          <p class="text-slate-600 leading-relaxed mb-6">Give us a requirement, a backlog or a product idea. We run it through the LFG factory to plan, build, test and deliver it.</p>
          <ul class="space-y-2 text-sm text-slate-600 mb-7">
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Growing businesses and SMBs</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Startups and product teams</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Companies with a backlog that keeps slipping</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Internal software projects</li>
          </ul>
          <a href="/services/" class="mt-auto inline-flex items-center gap-2 font-semibold text-brand-700 hover:gap-3 transition-all">Build with LFG <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
        </div>

        <div class="rounded-2xl border border-brand-200 bg-white p-8 flex flex-col ring-1 ring-brand-100">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="building-2" class="w-5 h-5"></i></div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">I deliver software for clients</p>
          <h3 class="font-display font-bold text-2xl text-slate-900 mb-3">Put the factory inside your delivery organization.</h3>
          <p class="text-slate-600 leading-relaxed mb-6">Turn client requirements into scoped plans, tickets, tested code and release-ready work, while your senior engineers provide the oversight.</p>
          <ul class="space-y-2 text-sm text-slate-600 mb-7">
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Software services companies</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>IT consulting firms</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Digital and development agencies</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Implementation partners</li>
          </ul>
          <a href="/software-services/" class="mt-auto inline-flex items-center gap-2 font-semibold text-brand-700 hover:gap-3 transition-all">LFG for services firms <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ 3. THE PROBLEM ═══════════ -->
  <section class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Coding got cheaper. Software delivery didn't.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          A coding agent can write a feature. Someone still has to understand the requirement, find the right context, make the architectural decisions, coordinate the dependencies, verify that it all works together, and make sure the release actually meets the business objective it started from.
        </p>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          LFG turns those disconnected activities into one continuous delivery pipeline.
        </p>
      </div>

      <div class="grid md:grid-cols-2 gap-6 lg:gap-10 items-start">
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <p class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Traditional AI-assisted development</p>
          <p class="text-sm text-slate-500 mb-6">Eleven steps, and a person is the thread running through all of them.</p>
          ${["Requirement","Developer interprets it","Developer opens Claude or Codex","Developer manages context","Code generated","Developer tests","Developer fixes","Pull request","Senior review","QA","Rework"]
            .map((s, i) => html`${i > 0 ? html`<div class="link-v"></div>` : ""}<div class="node"><span class="text-sm text-slate-700">${s}</span></div>`)}
        </div>

        <div class="rounded-2xl border border-brand-200 bg-white p-7 ring-1 ring-brand-100">
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-1">LFG</p>
          <p class="text-sm text-slate-500 mb-6">Eight stages, and the pipeline carries the work between them.</p>
          ${["Requirement","Plan","Architecture","Tickets","Parallel execution","Tests","Verification"]
            .map((s, i) => html`${i > 0 ? html`<div class="link-v"></div>` : ""}<div class="node"><span class="text-sm text-slate-700">${s}</span></div>`)}
          <div class="link-v"></div>
          <div class="node node-ok"><span class="text-sm font-semibold text-emerald-700">Pull request / release</span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ 4. MORE THAN A CODING AGENT ═══════════ -->
  <section class="band-tint py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-10">
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">More than a coding agent.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          Claude Code, Codex and the other coding agents are excellent execution engines. We run them inside LFG. What LFG adds is the coordination around them.
        </p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white overflow-x-auto">
        <table class="cmp">
          <thead>
            <tr>
              <th class="text-slate-500">Coding agents</th>
              <th class="col-lfg text-brand-600">LFG software factory</th>
            </tr>
          </thead>
          <tbody>
            ${COMPARISON.map(([a, b]) => html`
              <tr>
                <td class="text-slate-600">${a}</td>
                <td class="col-lfg text-slate-800 font-medium">${b}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>

      <div class="mt-8 rounded-xl border-l-4 border-brand-500 bg-white p-6">
        <p class="text-lg font-semibold text-slate-900">They are the engines. LFG is the factory built around them.</p>
        <p class="text-slate-600 mt-2">Which is why better coding models make LFG better rather than redundant. <a href="/how-it-works/" class="font-semibold text-brand-700 hover:underline">See how the factory works</a>.</p>
      </div>
    </div>
  </section>

  <!-- ═══════════ 5. FROM REQUIREMENT TO RELEASE ═══════════ -->
  <section class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">The factory</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">From requirement to release.</h2>
        <p class="text-slate-600 text-lg mt-4">Six stages. Every one of them produces something you can inspect.</p>
      </div>

      <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        ${STAGES.map(([num, name, icon, body, outputs]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-7 flex flex-col">
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-600 uppercase tracking-wider">${num} ${name}</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed mb-5">${body}</p>
            <div class="mt-auto pt-4 border-t border-slate-100">
              <p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Output</p>
              <div class="flex flex-wrap gap-1.5">
                ${outputs.map((o) => html`<span class="text-xs font-medium px-2.5 py-1 rounded-md bg-slate-100 text-slate-600">${o}</span>`)}
              </div>
            </div>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- ═══════════ 6. AGENCY ECONOMICS ═══════════ -->
  <section class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">For software services firms</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Built for the new economics of software services.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          Your clients know AI can produce software faster. They will increasingly expect that efficiency to show up in your timelines and your pricing.
        </p>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          But handing every developer a coding agent does not change your delivery economics on its own. You still coordinate teams, requirements, QA, reviews and releases much the way you always did. LFG changes the unit of production: agents handle more of the execution, and senior engineers supervise architecture, quality and the client outcome.
        </p>
      </div>

      <div class="grid md:grid-cols-3 gap-6 mb-10">
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="trending-up" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg mb-2">Increase delivery capacity</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Run more client projects without expanding your bench in proportion.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="shield" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg mb-2">Protect margins</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Capture the AI efficiency instead of simply passing fewer billable hours to the customer.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="users" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg mb-2">Make senior engineers multiplicative</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Let experienced engineers supervise several streams of execution instead of writing every implementation themselves.</p>
        </div>
      </div>

      <a href="/software-services/" class="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors">
        See LFG for software services firms <i data-lucide="arrow-right" class="w-4 h-4"></i>
      </a>
    </div>
  </section>

  <!-- ═══════════ 7. FOR BUYERS WHO NEED SOFTWARE ═══════════ -->
  <section class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">For businesses and startups</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Need software built? Skip assembling another development team.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          A customer-facing application, an internal tool, a SaaS product or a stubborn backlog — LFG can take the project from requirements through implementation and verification. Instead of paying for a large team for months, you work with a small delivery layer backed by the factory.
        </p>
      </div>

      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-10">
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="rocket" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Build a new product</h3>
          <p class="text-sm text-slate-600 leading-relaxed">MVPs, SaaS applications and customer-facing products.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="list-checks" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Clear a backlog</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Features, bugs, integrations and modernization work your team keeps postponing.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="layout-dashboard" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Build internal software</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Operational tools, dashboards, workflows and business applications.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="refresh-cw" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Modernize existing systems</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Refactoring, migrations, integrations and new functionality inside an existing stack.</p>
        </div>
      </div>

      <a href="/services/" class="inline-flex items-center gap-2 font-semibold text-brand-700 hover:gap-3 transition-all">Tell us what you want built <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
    </div>
  </section>

  <!-- ═══════════ 8. PROOF ═══════════ -->
  <section class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-10">
        <div class="max-w-2xl">
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Proof</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Software built with LFG.</h2>
          <p class="text-slate-600 text-lg mt-4">Production products, built end to end on the factory. We are its first customer.</p>
        </div>
        <a href="/case-studies/" class="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold text-sm hover:border-brand-400 hover:text-brand-700 transition-colors shrink-0">
          All case studies <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
      </div>

      <div class="grid md:grid-cols-3 gap-6">
        ${CASE_STUDIES.map(([name, slug, img, blurb]) => html`
          <a href="/case-studies/${slug}/" class="group rounded-2xl border border-slate-200 bg-white overflow-hidden flex flex-col hover:border-brand-300 transition-colors">
            <img src="${img}" alt="${name}" loading="lazy" class="w-full aspect-[16/10] object-cover object-top border-b border-slate-100" />
            <div class="p-6 flex flex-col flex-1">
              <h3 class="font-display font-bold text-lg text-slate-900 group-hover:text-brand-700 transition-colors">${name}</h3>
              <p class="text-sm text-slate-600 leading-relaxed mt-2 mb-5">${blurb}</p>
              <dl class="mt-auto grid grid-cols-3 gap-2 pt-4 border-t border-slate-100">
                <div><dt class="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Tickets</dt><dd class="text-base font-bold text-slate-900">&mdash;</dd></div>
                <div><dt class="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Duration</dt><dd class="text-base font-bold text-slate-900">&mdash;</dd></div>
                <div><dt class="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Reviewers</dt><dd class="text-base font-bold text-slate-900">&mdash;</dd></div>
              </dl>
            </div>
          </a>`)}
      </div>
      <p class="text-xs text-slate-500 mt-5">Delivery figures are published only once they are measured. Placeholders show as an em dash rather than an estimate.</p>
    </div>
  </section>

  <!-- ═══════════ 9. VISIBILITY ═══════════ -->
  <section class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Visibility</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-5">No black-box outsourcing.</h2>
          <p class="text-slate-600 text-lg leading-relaxed mb-4">
            Traditional software outsourcing means weekly status meetings and waiting to find out whether a project is actually on track. With LFG the factory itself is the project record.
          </p>
          <div class="flex flex-wrap gap-2 mb-7">
            ${VISIBLE.map((v) => html`<span class="text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600">${v}</span>`)}
          </div>
          <p class="font-display font-bold text-xl text-slate-900 leading-snug">
            You should not need a status meeting to know whether your software is getting built.
          </p>
        </div>

        <div class="shot">
          <div class="shot-bar">
            <span class="shot-dot bg-red-400/70"></span>
            <span class="shot-dot bg-amber-400/70"></span>
            <span class="shot-dot bg-emerald-400/70"></span>
            <span class="ml-2 text-xs font-mono text-slate-400">ticket execution</span>
          </div>
          <img src="/public/images/screenshots/agent-ticket-execution.png" alt="A ticket executing in LFG: logs, diff and review state side by side" loading="lazy" class="w-full block" />
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ 10. TRUST ═══════════ -->
  <section class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Control</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Your code remains your code.</h2>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        ${TRUST.map(([icon, title, body]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-7">
            <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-base mb-2">${title}</h3>
            <p class="text-sm text-slate-600 leading-relaxed">${body}</p>
          </div>`)}
      </div>
    </div>
  </section>

  ${posts.length === 0 ? "" : html`
  <!-- ═══════════ BUILD NOTES ═══════════ -->
  <section class="band py-16">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-8">
        <h2 class="font-display font-bold text-2xl text-slate-900">Build notes</h2>
        <a href="/blog/" class="text-sm font-semibold text-brand-700 hover:gap-3 inline-flex items-center gap-2 transition-all">All posts <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
      </div>
      <div class="grid md:grid-cols-3 gap-5">
        ${posts.slice(0, 3).map((post) => html`
          <a href="/blog/${post.slug}/" class="group rounded-2xl border border-slate-200 bg-white p-6 hover:border-brand-300 transition-colors">
            <p class="text-xs text-slate-500 mb-2">${post.dateDisplay} &middot; ${post.readingMinutes} min read</p>
            <h3 class="font-display font-bold text-base text-slate-900 leading-snug group-hover:text-brand-700 transition-colors">${post.title}</h3>
            <p class="text-sm text-slate-600 leading-relaxed mt-2 line-clamp-3">${post.excerpt}</p>
          </a>`)}
      </div>
    </div>
  </section>`}

  <!-- ═══════════ 11. FINAL CTA ═══════════ -->
  <section id="start" class="band-tint py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center mb-10">
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-4">Give LFG one real piece of work.</h2>
        <p class="text-slate-600 text-lg leading-relaxed">
          Send us a project, a feature or a backlog item. We will show you how LFG scopes it, plans it, and would execute it through the factory. Judge it on that, not on a demo.
        </p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-xl">
        <form id="start-form" class="space-y-4">
          <div class="grid sm:grid-cols-2 gap-3">
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Name *</label>
              <input name="name" required placeholder="Your name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Email *</label>
              <input name="email" type="email" required placeholder="you@company.com" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
            </div>
          </div>
          <div class="grid sm:grid-cols-2 gap-3">
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Company</label>
              <input name="company" placeholder="Company name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Which describes you?</label>
              <select name="intent" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white text-slate-700">
                <option value="project">I need software built</option>
                <option value="pilot">I run a software services firm</option>
                <option value="other">Something else</option>
              </select>
            </div>
          </div>
          <div>
            <label class="text-xs font-semibold text-slate-600 mb-1 block">The project, feature or backlog item *</label>
            <textarea name="brief" required rows="5" placeholder="One real piece of work. The more concrete it is, the more useful the plan we send back." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
          </div>
          <div class="flex flex-col sm:flex-row gap-3">
            <button type="submit" class="flex-1 inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-colors">
              <i data-lucide="send" class="w-4 h-4"></i><span class="btn-text">Submit a project</span>
            </button>
            <a href="/software-services/#pilot" class="flex-1 inline-flex items-center justify-center gap-2 border border-slate-300 bg-white text-slate-800 py-3 rounded-lg font-semibold text-sm hover:border-brand-400 hover:text-brand-700 transition-colors">
              Book a factory pilot
            </a>
          </div>
          <div id="start-success" class="hidden text-center py-2 text-sm font-semibold text-emerald-600">
            <i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i>Got it. We will reply within one business day.
          </div>
          <div id="start-error" class="hidden text-center py-2 text-sm text-red-500"></div>
        </form>
      </div>
    </div>
  </section>

</main>

${SiteFooter()}

<script>
  (function () {
    var form = document.getElementById('start-form');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      var btnText = form.querySelector('.btn-text');
      var ok = document.getElementById('start-success');
      var err = document.getElementById('start-error');
      ok.classList.add('hidden');
      err.classList.add('hidden');
      btn.disabled = true;
      btnText.textContent = 'Sending...';
      try {
        var res = await fetch('/api/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
        });
        if (res.ok) {
          form.reset();
          ok.classList.remove('hidden');
          lucide.createIcons();
        } else {
          var d = await res.json();
          err.textContent = d.error || 'Something went wrong. Please try again.';
          err.classList.remove('hidden');
        }
      } catch (e2) {
        err.textContent = 'Unable to submit. Email us at hello@lfg.run';
        err.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btnText.textContent = 'Submit a project';
      }
    });
  })();
</script>

</body>
</html>
`;
