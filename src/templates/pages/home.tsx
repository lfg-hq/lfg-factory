import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import { ModelStrip } from "../components/model-strip.tsx";
import { LifecycleRail, PHASES } from "../components/lifecycle.tsx";
import { PreviewMock } from "../components/preview-mock.tsx";
import type { BlogPost } from "../../utils/blog.ts";

/**
 * Homepage.
 *
 * Built around the two problems LFG exists to solve now that coding agents
 * write most of the code: deciding what to build, and verifying what got
 * built. Implementation sits between them, run by the coding agents people
 * already trust. Every section is one of those three, or the practical answer
 * to "will this fit how we work".
 *
 * Positioning rules: LFG amplifies teams, it does not replace them; no
 * invented delivery metrics; no fear-led framing.
 */

/** "Decide" slideshow: one shot per planning artifact. [src, caption, alt, chrome label] */
const SHOTS: Array<[src: string, caption: string, alt: string, label: string]> = [
  ["/public/images/screenshots/agent-prd-chat.png", "Scope and plan",
   "A request being turned into a PRD and technical plan in LFG", "your-project/plan"],
  ["/public/images/screenshots/agent-ticket-board.png", "Tickets",
   "An LFG project board: every ticket, its state and its dependencies", "your-project/tickets"],
];

const DECIDE = PHASES.find((p) => p.key === "decide")!.stages;

const VERIFY: Array<[icon: string, title: string, body: string]> = [
  ["monitor-play", "Every change, running in LFG",
   "LFG works out how your app runs, provisions its databases, applies migrations and seed data, starts it, and opens it in a browser inside LFG. Click through the change before you read a line of the diff."],
  ["flask-conical", "Tests that prove something",
   "The QA agent writes tests from the acceptance criteria, then runs them against the code before and after the change. Tests that pass both times prove nothing, so they are thrown away. Only tests that catch the change are kept."],
  ["video", "Evidence attached to the ticket",
   "Frontend tickets get a recorded walkthrough in a real browser. API tickets get the requests and responses. Your reviewer starts from proof that it works, not from a pile of diffs."],
];

const ENGINES: Array<[name: string, note: string]> = [
  ["Claude Code", "Anthropic models"],
  ["Codex", "OpenAI models"],
  ["Pi", "Gemini, DeepSeek, Kimi, GLM and more"],
];

const FIT: Array<[icon: string, title: string, body: string]> = [
  ["cpu", "Any model",
   "Claude, GPT, Gemini, Grok, DeepSeek, Kimi or GLM. Choose per project, per task or per client policy."],
  ["key-round", "Your existing subscriptions",
   "Run on the Claude and ChatGPT plans your team already pays for, or on API keys. No new model contract required."],
  ["folder-git-2", "Your repositories",
   "GitHub or GitLab. Work lands on branches and pull requests under your own protection rules."],
  ["plug", "Your tools",
   "Tickets sync to Jira or Linear. MCP servers and app connectors bring in the docs and systems your team already works in."],
  ["sliders-horizontal", "Customised to your business",
   "Your process, definition of done, review rules, templates and stack conventions, configured per team."],
  ["server", "Self-hosted if you need it",
   "Run the whole factory inside your own infrastructure, or let us host a dedicated instance. The core is MIT."],
];

const VISIBLE = ["Scope", "PRD", "Architecture", "Tickets", "Dependencies", "Live agent sessions",
                 "Diffs", "Previews", "Test results", "Walkthroughs", "Reviews"];

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
  title: "LFG | The Software Factory Agent: decide what to build, prove what got built",
  description: "LFG automates the software lifecycle: scoping, planning, documentation, ticketing, implementation, testing and QA. It runs Claude Code, Codex and Pi in parallel sandboxes and shows every change running before you review it.",
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

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-10 xl:gap-14 items-center">

        <div class="lg:col-span-6">
          <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
            <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
            <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">The software factory agent</span>
          </div>
          <h1 class="font-display font-semibold text-4xl sm:text-5xl xl:text-[3.35rem] leading-[1.08] tracking-tight text-slate-900 animate-fade-up">
            Decide what to build.<br>
            <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">Prove what got built.</span>
          </h1>
          <p class="text-lg text-slate-600 mt-6 leading-relaxed animate-fade-up">
            LFG automates the whole software lifecycle: scoping, planning, documentation, ticketing, implementation, testing and QA. It runs Claude Code, Codex and Pi sessions in parallel sandboxes. Every change is running in front of you before anyone reviews it.
          </p>

          <div class="mt-8 flex flex-col sm:flex-row gap-3 animate-fade-up">
            <a href="/auth/register" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
              Try LFG free <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
            <a href="#start" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
              Talk to us
            </a>
          </div>
          <p class="mt-4 text-sm text-slate-500 animate-fade-up">
            Any model &middot; your existing Claude or ChatGPT plan &middot; your repos and tools &middot; self-hostable
          </p>
        </div>

        <div class="min-w-0 lg:col-span-6 animate-fade-up" style="animation-delay:.12s">
          ${PreviewMock()}
        </div>
      </div>

      <div class="mt-14 animate-fade-up">
        ${LifecycleRail()}
        <p class="text-sm text-slate-500 mt-4">
          Your team shapes the plan at the start and signs off a verified change at the end. The pipeline carries the work in between.
        </p>
      </div>
    </div>
  </section>

  <!-- ═══════════ 2. WHY NOW ═══════════ -->
  <section class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-3">Why now</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Coding agents made code abundant. The leverage moved to both ends.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          When writing code is fast, two questions decide whether a team actually ships more. LFG is built around both of them, with the coding agents you already trust doing the work in between.
        </p>
      </div>

      <div class="grid md:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-slate-200 bg-white p-8">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="compass" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-2xl text-slate-900 mb-3">What should we build?</h3>
          <p class="text-slate-600 leading-relaxed">
            Agents will build whatever they are pointed at, so the plan matters more than ever. LFG turns a request into a scoped, documented, sequenced plan that your team can shape before any code exists.
          </p>
        </div>
        <div class="rounded-2xl border border-brand-200 bg-white p-8 ring-1 ring-brand-100">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="badge-check" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-2xl text-slate-900 mb-3">Does it actually work?</h3>
          <p class="text-slate-600 leading-relaxed">
            Agents produce more change than anyone can read line by line. LFG runs every change, tests it against what was asked for, and records the evidence, so review starts from proof.
          </p>
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ 3. DECIDE WHAT TO BUILD ═══════════ -->
  <section id="decide" class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Stages 1&ndash;4 &middot; Decide what to build</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-5">A plan your team can argue with.</h2>
          <p class="text-slate-600 text-lg leading-relaxed mb-8">
            LFG starts from your codebase and the context around it, not a blank prompt. It produces everything a good team writes before it builds, so a misread requirement is caught early, when fixing it takes a conversation instead of a rewrite.
          </p>
          <div class="space-y-5">
            ${DECIDE.map((s) => html`
              <div class="flex gap-4">
                <div class="w-10 h-10 rounded-xl bg-white border border-slate-200 text-brand-700 flex items-center justify-center shrink-0"><i data-lucide="${s.icon}" class="w-5 h-5"></i></div>
                <div>
                  <p class="font-display font-bold text-slate-900"><span class="text-slate-400 font-semibold tabular-nums mr-1.5">${s.num}</span>${s.name}</p>
                  <p class="text-sm text-slate-600 leading-relaxed mt-0.5">${s.short}</p>
                </div>
              </div>`)}
          </div>
        </div>

        <div class="shot" id="hero-shots">
          <div class="shot-bar">
            <span class="shot-dot bg-red-400/70"></span>
            <span class="shot-dot bg-amber-400/70"></span>
            <span class="shot-dot bg-emerald-400/70"></span>
            <span class="ml-2 text-xs font-mono text-slate-400" data-shot-label>your-project/plan</span>
          </div>
          <div class="relative aspect-[1354/848]">
            ${SHOTS.map(([src, , alt], i) => html`
              <img src="${src}" alt="${alt}" loading="lazy"
                   data-shot="${i}"
                   class="absolute inset-0 w-full h-full object-cover object-top transition-opacity duration-500 ${i === 0 ? "opacity-100" : "opacity-0"}" />`)}
          </div>
          <div class="flex items-center gap-3 px-4 py-3 border-t border-slate-100">
            ${SHOTS.map(([, caption], i) => html`
              <button type="button" data-shot-btn="${i}"
                      class="group flex-1 text-left transition-opacity ${i === 0 ? "" : "opacity-45 hover:opacity-80"}"
                      aria-label="Show ${caption}">
                <span class="block h-0.5 rounded-full mb-1.5 ${i === 0 ? "bg-brand-500" : "bg-slate-200"}" data-shot-bar></span>
                <span class="block text-[11px] font-semibold text-slate-600 leading-tight">${caption}</span>
              </button>`)}
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ 4. BUILD AT SCALE ═══════════
       The dark break sits on the stage the product deliberately does NOT
       claim to reinvent: implementation belongs to the coding agents. -->
  <section id="build" class="bg-slate-900 py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p class="text-xs font-bold text-brand-400 uppercase tracking-wider mb-2">Stage 5 &middot; Implement</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-white leading-tight mb-5">Many agents, one plan.</h2>
          <p class="text-lg text-slate-300 leading-relaxed mb-4">
            Claude Code, Codex and Pi are excellent engines, so LFG runs them rather than replacing them. Each ticket gets its own sandbox and branch. Independent tickets run at the same time, and context from earlier tickets carries forward, so ticket forty knows what ticket three decided.
          </p>
          <p class="text-lg text-slate-300 leading-relaxed">
            Watch any session live, steer it, or restart it. Better coding models make the factory better, not redundant.
          </p>
        </div>

        <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-4">Sandboxes &middot; this sprint</p>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            ${[["TKT-138", "Claude Code", "done"], ["TKT-139", "Pi", "done"], ["TKT-140", "Codex", "testing"],
               ["TKT-141", "Claude Code", "running"], ["TKT-142", "Claude Code", "verified"], ["TKT-143", "Pi", "queued"]]
              .map(([t, e, st]) => html`
              <div class="rounded-xl border border-white/10 bg-slate-800/60 p-3">
                <p class="text-xs font-mono text-slate-300">${t}</p>
                <p class="text-[11px] text-slate-500 mt-0.5">${e}</p>
                <p class="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold ${st === "queued" ? "text-slate-500" : st === "running" || st === "testing" ? "text-amber-300" : "text-emerald-400"}">
                  <span class="w-1.5 h-1.5 rounded-full ${st === "queued" ? "bg-slate-500" : st === "running" || st === "testing" ? "bg-amber-300 animate-pulse" : "bg-emerald-400"}"></span>${st}
                </p>
              </div>`)}
          </div>
          <div class="mt-5 pt-5 border-t border-white/10 grid grid-cols-3 gap-3">
            ${ENGINES.map(([name, note]) => html`
              <div>
                <p class="text-sm font-semibold text-white">${name}</p>
                <p class="text-[11px] text-slate-400 leading-snug mt-0.5">${note}</p>
              </div>`)}
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ 5. VERIFY WHAT GOT BUILT ═══════════ -->
  <section id="verify" class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Stages 6&ndash;7 &middot; Verify what got built</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">See it working before you review it.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          An agent that has read its own code will happily write tests that pass. LFG doesn't take its word for it. Every change is run, exercised and checked against the acceptance criteria written in stage 3.
        </p>
      </div>

      <div class="grid md:grid-cols-3 gap-6 mb-10">
        ${VERIFY.map(([icon, title, body]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-7">
            <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-lg text-slate-900 mb-2">${title}</h3>
            <p class="text-sm text-slate-600 leading-relaxed">${body}</p>
          </div>`)}
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white overflow-x-auto">
        <table class="cmp">
          <thead>
            <tr>
              <th class="text-slate-500">Test before the change</th>
              <th class="text-slate-500">Test after the change</th>
              <th class="col-lfg text-brand-600">What LFG does</th>
            </tr>
          </thead>
          <tbody>
            <tr><td class="text-slate-600">Fails</td><td class="text-slate-600">Passes</td><td class="col-lfg text-slate-800 font-medium">Keeps it. It really tests this change.</td></tr>
            <tr><td class="text-slate-600">Passes</td><td class="text-slate-600">Passes</td><td class="col-lfg text-slate-800 font-medium">Discards it. It proves nothing about the change.</td></tr>
            <tr><td class="text-slate-600">Fails</td><td class="text-slate-600">Fails</td><td class="col-lfg text-slate-800 font-medium">Reports it. Either the code or the test is wrong, and a person decides which.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- ═══════════ 6. FITS HOW YOU WORK ═══════════ -->
  <section id="fit" class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Fits how you already work</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Your models, your plans, your tools.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          LFG attaches to the stack, subscriptions and process you already have. We customise it to the business instead of asking the business to adapt.
        </p>
      </div>

      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
        ${FIT.map(([icon, title, body]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-7">
            <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-base mb-2">${title}</h3>
            <p class="text-sm text-slate-600 leading-relaxed">${body}</p>
          </div>`)}
      </div>

      ${ModelStrip()}
    </div>
  </section>

  <!-- ═══════════ 7. HOW TO WORK WITH US ═══════════ -->
  <section id="engage" class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-3">Working with us</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">We set up your factory, or we own the outcome.</h2>
      </div>

      <div class="grid lg:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-brand-200 bg-white p-8 flex flex-col ring-1 ring-brand-100">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="factory" class="w-5 h-5"></i></div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Set up the factory</p>
          <h3 class="font-display font-bold text-2xl text-slate-900 mb-3">Your team runs it. We build it around you.</h3>
          <p class="text-slate-600 leading-relaxed mb-6">
            We install LFG in your infrastructure or host a dedicated instance, connect your repositories, models and tools, and customise the pipeline to how you deliver. Then we help your engineers take the gates.
          </p>
          <ul class="space-y-2 text-sm text-slate-600 mb-7">
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Software services firms and agencies</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Product and platform engineering teams</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Teams with self-hosting or model-policy requirements</li>
          </ul>
          <div class="mt-auto flex flex-wrap gap-x-6 gap-y-2">
            <a href="/software-services/" class="inline-flex items-center gap-2 font-semibold text-brand-700 hover:gap-3 transition-all">For services firms <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
            <a href="/self-host/" class="inline-flex items-center gap-2 font-semibold text-brand-700 hover:gap-3 transition-all">Self-host and setup <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
          </div>
        </div>

        <div class="rounded-2xl border border-slate-200 bg-white p-8 flex flex-col">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="package-check" class="w-5 h-5"></i></div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Own the outcome</p>
          <h3 class="font-display font-bold text-2xl text-slate-900 mb-3">We run the factory for you.</h3>
          <p class="text-slate-600 leading-relaxed mb-6">
            Hand us a product, a feature or a backlog. You get verified, merge-ready pull requests in your own repository, measured against acceptance criteria agreed before we start, and you can watch every stage while it happens.
          </p>
          <ul class="space-y-2 text-sm text-slate-600 mb-7">
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Startups and growing businesses</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Backlogs and internal tools that keep slipping</li>
            <li class="flex gap-2.5"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>Modernisation inside an existing stack</li>
          </ul>
          <div class="mt-auto flex flex-wrap gap-x-6 gap-y-2">
            <a href="/services/" class="inline-flex items-center gap-2 font-semibold text-brand-700 hover:gap-3 transition-all">Have it delivered <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
            <a href="/startups/" class="inline-flex items-center gap-2 font-semibold text-brand-700 hover:gap-3 transition-all">For startups <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
          </div>
        </div>
      </div>

      <p class="text-sm text-slate-500 mt-6">
        Prefer to drive it yourself? <a href="/auth/register" class="font-semibold text-brand-700 hover:underline">Start free</a> on your own repository, or <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="font-semibold text-brand-700 hover:underline">clone the open-source core</a>.
      </p>
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
              <span class="mt-auto text-sm font-semibold text-brand-700 inline-flex items-center gap-1.5 group-hover:gap-2.5 transition-all">
                View case study <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
              </span>
            </div>
          </a>`)}
      </div>
    </div>
  </section>

  <!-- ═══════════ 9. VISIBILITY ═══════════ -->
  <section class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Visibility and control</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-5">The factory is the project record.</h2>
          <p class="text-slate-600 text-lg leading-relaxed mb-4">
            Every stage leaves something you can open, while the work is happening rather than in a report afterwards. Agents never decide on their own what enters production: a person signs off, and the trail from request to merge stays queryable.
          </p>
          <div class="flex flex-wrap gap-2 mb-7">
            ${VISIBLE.map((v) => html`<span class="text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600">${v}</span>`)}
          </div>
          <a href="/how-it-works/" class="inline-flex items-center gap-2 font-semibold text-brand-700 hover:gap-3 transition-all">See all seven stages <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
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

  ${posts.length === 0 ? "" : html`
  <!-- ═══════════ BUILD NOTES ═══════════ -->
  <section class="band-tint py-16">
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

  <!-- ═══════════ 10. FINAL CTA ═══════════ -->
  <section id="start" class="band py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center mb-10">
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-4">Give LFG one real piece of work.</h2>
        <p class="text-slate-600 text-lg leading-relaxed">
          Send us a product idea, a feature or a backlog item. We will show you how LFG scopes and plans it, and what it looks like built and verified. Judge it on that, not on a demo.
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
              <label class="text-xs font-semibold text-slate-600 mb-1 block">What are you after?</label>
              <select name="intent" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white text-slate-700">
                <option value="project">Have software built and verified</option>
                <option value="pilot">Set up a factory for my team</option>
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
              <i data-lucide="send" class="w-4 h-4"></i><span class="btn-text">Send project details</span>
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
  // ── Plan/tickets slideshow ────────────────────────────────────
  (function () {
    var root = document.getElementById('hero-shots');
    if (!root) return;
    var LABELS = ['your-project/plan', 'your-project/tickets'];
    var slides = root.querySelectorAll('[data-shot]');
    var buttons = root.querySelectorAll('[data-shot-btn]');
    var label = root.querySelector('[data-shot-label]');
    if (slides.length < 2) return;

    var current = 0;
    var timer = null;
    var DELAY = 5000;
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function show(next) {
      current = (next + slides.length) % slides.length;
      for (var i = 0; i < slides.length; i++) {
        slides[i].classList.toggle('opacity-100', i === current);
        slides[i].classList.toggle('opacity-0', i !== current);
      }
      for (var j = 0; j < buttons.length; j++) {
        var on = j === current;
        buttons[j].classList.toggle('opacity-45', !on);
        buttons[j].classList.toggle('hover:opacity-80', !on);
        var bar = buttons[j].querySelector('[data-shot-bar]');
        if (bar) {
          bar.classList.toggle('bg-brand-500', on);
          bar.classList.toggle('bg-slate-200', !on);
        }
      }
      if (label && LABELS[current]) label.textContent = LABELS[current];
    }

    function start() { if (!reduced && !timer) timer = setInterval(function () { show(current + 1); }, DELAY); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    for (var k = 0; k < buttons.length; k++) {
      (function (idx) {
        buttons[idx].addEventListener('click', function () { stop(); show(idx); start(); });
      })(k);
    }

    // Don't advance under the reader's cursor, or while the tab is hidden.
    root.addEventListener('mouseenter', stop);
    root.addEventListener('mouseleave', start);
    document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });

    start();
  })();

  // ── Project intake ────────────────────────────────────────────
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
        btnText.textContent = 'Send project details';
      }
    });
  })();
</script>

</body>
</html>
`;
