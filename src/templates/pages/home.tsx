import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import { ModelStrip } from "../components/model-strip.tsx";
import type { BlogPost } from "../../utils/blog.ts";

/**
 * Homepage.
 *
 * Told as a story in four chapters, because that is how a project actually
 * moves through LFG: decide what to build → settle the architecture → turn it
 * into tickets and agents → prove it works. The tension comes first (the model
 * writes the code; everything around it decides whether you ship), and every
 * chapter is backed by a real screenshot of the product doing that job.
 *
 * Positioning rules: LFG amplifies teams (5–10x capacity), it does not replace
 * them; no invented metrics or fake speed; no fear-led framing.
 */

const S = "/public/images/screenshots";

/** Hero product frame: one real screen per chapter. [src, tab label, alt] */
const HERO_SHOTS: Array<[src: string, label: string, alt: string]> = [
  [`${S}/lfg-prd.webp`, "PRD",
   "A requirements document written in LFG: problem, goal and what will be built, in plain language"],
  [`${S}/lfg-analysis.webp`, "Architecture",
   "A technical analysis written by LFG: what is being built and how, in plain language"],
  [`${S}/lfg-ticket-board.webp`, "Tickets",
   "LFG tickets grouped by epic, each epic on its own branch, with priorities"],
  [`${S}/lfg-preview-tab.webp`, "Live preview",
   "The app running inside LFG's Preview tab at its own preview URL"],
];

const BEFORE = ["Is this the right thing to build?", "Does it fit the architecture we have?", "What does done actually mean?"];
const AFTER = ["Does it run, or does it just compile?", "Do the tests test anything?", "Who signed off, and why?"];

const GOVERNANCE: Array<[icon: string, title: string, body: string]> = [
  ["git-pull-request-arrow", "Traceable from intent to merge",
   "Every commit links to a ticket, every ticket to a requirement, every requirement to the decision behind it."],
  ["user-check", "Human approval gates",
   "Agents propose. People approve the plan, the architecture and the final change before anything ships."],
  ["history", "A complete audit trail",
   "Agent sessions, diffs, test runs, recordings and approvals, kept on the record after the work ships."],
  ["shield-check", "Model and access policy",
   "Admins decide which models and subscriptions each team and project may use, and who can access what."],
  ["box", "Isolated execution",
   "Every agent session runs in its own sandbox, on its own branch. Never against main, never on a laptop."],
  ["server", "Your infrastructure, if you need it",
   "Self-host the whole factory, so code, data and keys never leave your environment."],
];

const CASE_STUDIES: Array<[string, string, string, string]> = [
  ["Mags", "mags", `${S}/mags.png`, "Job-runner platform, built end to end on the factory."],
  ["Easylogs", "easylogs", `${S}/easylogs.png`, "Developer observability platform, requirements through production."],
  ["Kitereach", "kitereach", `${S}/kitereach.png`, "Go-to-market product stack, shipped and running live."],
];

const chapter = (num: string, label: string) => html`
  <p class="flex items-center gap-3 mb-5">
    <span class="font-mono text-xs font-semibold text-brand-600">${num}</span>
    <span class="h-px w-8 bg-brand-200"></span>
    <span class="text-xs font-bold text-slate-500 uppercase tracking-wider">${label}</span>
  </p>`;

const frame = (src: string, alt: string, label: string) => html`
  <div class="shot">
    <div class="shot-bar">
      <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
      <span class="ml-2 text-xs font-mono text-slate-400 truncate">${label}</span>
    </div>
    <img src="${src}" alt="${alt}" loading="lazy" class="w-full block" />
  </div>`;

export const HomePage = ({ posts = [] }: { posts?: BlogPost[]; turnstileSiteKey?: string }) => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "LFG | The Software Factory Agent: decide what to build, prove what got built",
  description: "LFG scopes the work, makes the architecture decisions, turns them into tickets and runs Claude Code, Codex and Pi across them in parallel. Every change comes back running in a live preview, tested against what you asked for.",
  path: "/",
  image: `${S}/lfg-preview-tab.webp`,
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "home" })}

<main>

  <!-- ═══════════ HERO ═══════════ -->
  <section class="relative pt-32 sm:pt-40 pb-20 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="absolute top-24 left-[4%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>

    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="max-w-5xl">
        <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-8 animate-fade-up">
          <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
          <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">The software factory agent</span>
        </div>
        <h1 class="font-display font-semibold text-4xl sm:text-5xl xl:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up">
          Decide what to build.<br>
          <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">Prove what got built.</span>
        </h1>
        <p class="text-lg sm:text-xl text-slate-600 mt-7 leading-relaxed max-w-3xl animate-fade-up">
          LFG automates the whole software lifecycle: scoping, planning, documentation, ticketing, implementation, testing and QA. It runs Claude Code, Codex and Pi sessions in parallel sandboxes. Every change is running in front of you before anyone reviews it.
        </p>
        <div class="mt-9 flex flex-col sm:flex-row gap-3 animate-fade-up">
          <a href="/auth/register" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
            Try LFG free <i data-lucide="arrow-right" class="w-4 h-4"></i>
          </a>
          <a href="#start" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
            Talk to us
          </a>
        </div>
        <p class="mt-4 text-sm text-slate-500 animate-fade-up">
          Runs on your Claude or ChatGPT plan &middot; any model &middot; your repos &middot; self-hostable
        </p>
      </div>

      <!-- The product itself, one real screen per chapter of the story -->
      <div class="mt-16 animate-fade-up" style="animation-delay:.12s">
        <div class="shot" id="hero-shots">
          <div class="shot-bar">
            <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
            <div class="ml-3 flex items-center gap-1 overflow-x-auto" role="tablist">
              ${HERO_SHOTS.map(([, label], i) => html`
                <button type="button" role="tab" data-shot-btn="${i}" aria-selected="${i === 0 ? "true" : "false"}"
                        class="px-3 py-1 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${i === 0 ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-800"}">
                  <span class="text-slate-400 mr-1">${i + 1}</span>${label}
                </button>`)}
            </div>
          </div>
          <div class="relative aspect-[3/2] bg-white">
            ${HERO_SHOTS.map(([src, , alt], i) => html`
              <img src="${src}" alt="${alt}" ${i === 0 ? "" : 'loading="lazy"'} data-shot="${i}"
                   class="absolute inset-0 w-full h-full object-cover object-top transition-opacity duration-500 ${i === 0 ? "opacity-100" : "opacity-0"}" />`)}
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ THE TENSION ═══════════ -->
  <section class="bg-slate-900 py-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <p class="text-xs font-bold text-brand-400 uppercase tracking-wider mb-4">The new bottleneck</p>
      <h2 class="font-display font-bold text-3xl md:text-5xl text-white leading-tight max-w-4xl">
        The model writes the code. Everything around it decides whether you ship.
      </h2>
      <p class="text-lg text-slate-400 mt-6 max-w-3xl leading-relaxed">
        Point a coding agent at a ticket and it will write the code. It won't stop to ask the questions that used to be answered in planning meetings, design reviews and QA cycles. Those questions didn't go away. They just stopped having an owner.
      </p>

      <div class="mt-14 grid md:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-white/10 p-8">
          <p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-5">Before the code</p>
          <ul class="space-y-4">
            ${BEFORE.map((q) => html`<li class="font-display text-xl text-white leading-snug">${q}</li>`)}
          </ul>
        </div>
        <div class="rounded-2xl border border-white/10 p-8">
          <p class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-5">After the code</p>
          <ul class="space-y-4">
            ${AFTER.map((q) => html`<li class="font-display text-xl text-white leading-snug">${q}</li>`)}
          </ul>
        </div>
      </div>

      <p class="mt-12 font-display text-2xl text-white max-w-3xl leading-snug">
        LFG owns those questions. Your agents do the typing. Your team makes the calls, and ships at <span class="text-brand-300">5&ndash;10x</span> its current capacity.
      </p>
    </div>
  </section>

  <!-- ═══════════ 01 · DECIDE WHAT TO BUILD ═══════════ -->
  <section id="decide" class="band py-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        <div class="lg:col-span-5">
          ${chapter("01", "Decide what to build")}
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 leading-tight mb-5">It starts with a conversation, not a prompt.</h2>
          <p class="text-slate-600 text-lg leading-relaxed mb-5">
            Tell LFG what you want the way you'd tell a senior engineer. It reads your codebase, your docs and the tools you connect, then asks the questions they would ask before writing anything.
          </p>
          <p class="text-slate-600 text-lg leading-relaxed">
            What comes out is a requirements document your team can argue with: scope, priorities and acceptance criteria. Done is defined before the work starts, so at the end passing is a fact, not an opinion.
          </p>
        </div>
        <div class="lg:col-span-7 min-w-0">
          ${frame(`${S}/lfg-prd.webp`, "A requirements document in LFG: problem, goal and what will be built, in plain language", "pilot requirements")}
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ 02 · ARCHITECTURE ═══════════ -->
  <section id="architecture" class="band-tint py-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-14">
        ${chapter("02", "Make the architecture decisions")}
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 leading-tight mb-5">Architecture gets decided before anyone writes code, not discovered in a pull request.</h2>
        <p class="text-slate-600 text-lg leading-relaxed">
          For every epic, LFG writes a technical analysis: what is being built, how it will be built in plain language, and the key flows drawn as sequence diagrams. Your architect reviews the decisions in one sitting, while changing them still costs a conversation instead of a rewrite.
        </p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div class="min-w-0">
          ${frame(`${S}/lfg-analysis.webp`, "An LFG technical analysis: what we are building and how we will build it, in plain language", "technical analysis")}
          <p class="text-sm text-slate-500 mt-3">The plan in plain language, linked to the requirements it implements.</p>
        </div>
        <div class="min-w-0 lg:mt-16">
          ${frame(`${S}/lfg-key-flows.webp`, "A sequence diagram of a key flow in an LFG technical analysis", "key flows")}
          <p class="text-sm text-slate-500 mt-3">Key flows as sequence diagrams, failure paths included.</p>
        </div>
      </div>

      <div class="mt-12 rounded-2xl border-l-4 border-brand-500 bg-white p-7 max-w-3xl">
        <p class="font-display font-bold text-lg text-slate-900">It's honest about what it hasn't proven yet.</p>
        <p class="text-slate-600 mt-2 leading-relaxed">
          A design is labelled a proposal. A diagram is labelled intended behaviour, not tested behaviour. Nothing is called verified until the code has run and the checks have passed.
        </p>
      </div>
    </div>
  </section>

  <!-- ═══════════ 03 · BUILD ═══════════ -->
  <section id="build" class="band py-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        <div class="lg:col-span-5">
          ${chapter("03", "Build it, in parallel")}
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 leading-tight mb-5">The plan becomes tickets. The tickets become agents.</h2>
          <p class="text-slate-600 text-lg leading-relaxed mb-5">
            Each epic gets its own branch. Each ticket carries its acceptance criteria and knows what it depends on. LFG hands them to Claude Code, Codex or Pi, each session in its own sandbox, as many at once as the dependency graph allows.
          </p>
          <p class="text-slate-600 text-lg leading-relaxed mb-7">
            No babysitting sessions, no copying context between them. Ticket forty knows what ticket three decided. Watch any session live, steer it, or let it run.
          </p>
          <div class="flex flex-wrap gap-2">
            ${["Claude Code", "Codex", "Pi", "Jira and Linear sync"].map((t) => html`<span class="text-sm font-medium px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700">${t}</span>`)}
          </div>
        </div>
        <div class="lg:col-span-7 min-w-0">
          ${frame(`${S}/lfg-ticket-board.webp`, "LFG tickets grouped by epic, each epic building on its own branch", "tickets")}
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ 04 · VERIFY ═══════════ -->
  <section id="verify" class="band-tint py-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        ${chapter("04", "Prove it works")}
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 leading-tight mb-5">&ldquo;All tests passed&rdquo; isn't proof. Seeing it run is.</h2>
        <p class="text-slate-600 text-lg leading-relaxed">
          An agent that has read its own diff will happily write tests that pass. So LFG doesn't take its word for it. Every change is stood up, exercised and checked against the acceptance criteria from chapter one, before a person spends a minute reviewing it.
        </p>
      </div>

      ${frame(`${S}/lfg-preview-tab.webp`, "An app built by LFG running inside the Preview tab, at its own preview URL", "live preview")}

      <div class="mt-10 grid md:grid-cols-3 gap-6">
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="monitor-play" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg text-slate-900 mb-2">A live preview of every change</h3>
          <p class="text-sm text-slate-600 leading-relaxed">LFG works out how your app runs, starts its databases, applies migrations and seed data, and opens it right inside LFG at its own URL. Desktop, tablet or phone. No pulling branches.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="flask-conical" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg text-slate-900 mb-2">Tests that have to earn their place</h3>
          <p class="text-sm text-slate-600 leading-relaxed">The QA agent writes tests from the acceptance criteria, then runs each one before and after the change. A test that passes both times proves nothing, so it's thrown out.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="video" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg text-slate-900 mb-2">Recorded proof on the ticket</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Frontend changes get a walkthrough recorded in a real browser. API changes get the actual requests and responses. Review starts from evidence.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ GOVERNANCE ═══════════ -->
  <section id="governance" class="band py-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
        <div class="lg:col-span-5 lg:sticky lg:top-28">
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-4">Governance</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 leading-tight mb-5">Governance built in, not bolted on.</h2>
          <p class="text-slate-600 text-lg leading-relaxed mb-5">
            More agents shouldn't mean less control. Every requirement, architecture decision, ticket, agent session, test and approval in LFG is linked to the next.
          </p>
          <p class="text-slate-600 text-lg leading-relaxed">
            Six months from now, when someone asks why it was built this way and who approved it, the answer is one click away.
          </p>
        </div>
        <div class="lg:col-span-7 grid sm:grid-cols-2 gap-5">
          ${GOVERNANCE.map(([icon, title, body]) => html`
            <div class="rounded-2xl border border-slate-200 bg-white p-6">
              <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
              <h3 class="font-display font-bold text-base text-slate-900 mb-2">${title}</h3>
              <p class="text-sm text-slate-600 leading-relaxed">${body}</p>
            </div>`)}
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════ YOUR STACK ═══════════ -->
  <section id="fit" class="bg-slate-900 py-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-14">
        <p class="text-xs font-bold text-brand-400 uppercase tracking-wider mb-4">Works with what you have</p>
        <h2 class="font-display font-bold text-3xl md:text-5xl text-white leading-tight">Runs on the plans you already pay for.</h2>
        <p class="text-lg text-slate-400 mt-6 leading-relaxed">
          No new model contract, no new tracker, no new way of working. LFG plugs into the subscriptions, repositories and tools your company already runs, and we shape it around how your business delivers software.
        </p>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
        ${[
          ["Your models", "Claude, GPT, Gemini, Grok, DeepSeek, Kimi, GLM. Pick per project, per task, or per client policy."],
          ["Your subscriptions", "Sign in with your team's Claude or ChatGPT plan, or bring API keys."],
          ["Your tools", "GitHub or GitLab, Jira or Linear, MCP servers and app connectors."],
          ["Your process", "Your templates, definition of done, review gates and stack conventions."],
        ].map(([t, b]) => html`
          <div class="border-t border-white/15 pt-5">
            <p class="font-display font-bold text-white mb-2">${t}</p>
            <p class="text-sm text-slate-400 leading-relaxed">${b}</p>
          </div>`)}
      </div>
      ${ModelStrip()}
    </div>
  </section>

  <!-- ═══════════ HOW WE WORK ═══════════ -->
  <section id="engage" class="band py-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-14">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-4">How we work</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 leading-tight">We build the factory around your team. Or we run it for you.</h2>
      </div>

      <div class="grid md:grid-cols-3 gap-8 mb-14">
        ${[
          ["01", "Bring us the real problem.", "A product, a backlog that keeps slipping, a system nobody wants to touch. You know the business; we bring the machine."],
          ["02", "We set up the factory with you.", "In your cloud or ours. Connected to your repos, models and tools, and shaped to how your team already ships."],
          ["03", "Your team runs it, or we own the outcome.", "Your engineers hold the gates and ship at 5–10x. Or hand us the whole thing and accept verified pull requests."],
        ].map(([n, t, b]) => html`
          <div>
            <p class="font-mono text-sm font-semibold text-brand-600 mb-4">${n}</p>
            <h3 class="font-display font-bold text-xl text-slate-900 mb-3 leading-snug">${t}</h3>
            <p class="text-slate-600 leading-relaxed">${b}</p>
          </div>`)}
      </div>

      <div class="grid lg:grid-cols-2 gap-6">
        <a href="/self-host/" class="group rounded-2xl border border-brand-200 bg-white p-8 ring-1 ring-brand-100 hover:border-brand-400 transition-colors">
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-3">Set up your factory</p>
          <p class="font-display font-bold text-2xl text-slate-900 mb-3">For services firms and product teams.</p>
          <p class="text-slate-600 leading-relaxed mb-6">Self-hosted or a dedicated instance, customised to your delivery process, with your engineers holding the gates.</p>
          <span class="inline-flex items-center gap-2 font-semibold text-brand-700 group-hover:gap-3 transition-all">Self-host and setup <i data-lucide="arrow-right" class="w-4 h-4"></i></span>
        </a>
        <a href="/services/" class="group rounded-2xl border border-slate-200 bg-white p-8 hover:border-brand-300 transition-colors">
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-3">We own the outcome</p>
          <p class="font-display font-bold text-2xl text-slate-900 mb-3">For businesses that need software built.</p>
          <p class="text-slate-600 leading-relaxed mb-6">Agree the acceptance criteria up front. Watch every stage happen. Accept verified pull requests in your own repository.</p>
          <span class="inline-flex items-center gap-2 font-semibold text-brand-700 group-hover:gap-3 transition-all">Have it delivered <i data-lucide="arrow-right" class="w-4 h-4"></i></span>
        </a>
      </div>
    </div>
  </section>

  <!-- ═══════════ PROOF ═══════════ -->
  <section class="band-tint py-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-10">
        <div class="max-w-2xl">
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-4">Built on LFG</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">We were our own first customer.</h2>
          <p class="text-slate-600 text-lg mt-4">These products went from idea to production on the factory, and they're still running.</p>
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
                Read the story <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
              </span>
            </div>
          </a>`)}
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

  <!-- ═══════════ CTA ═══════════ -->
  <section id="start" class="band-tint py-24">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center mb-10">
        <h2 class="font-display font-bold text-3xl md:text-5xl text-slate-900 mb-5 leading-tight">Don't test it on an easy ticket.</h2>
        <p class="text-slate-600 text-lg leading-relaxed">
          Send us something real: a product idea, a feature, the backlog item nobody wants. We'll come back with the scope, the architecture decisions and the plan, and show you what it looks like built and verified.
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
            <label class="text-xs font-semibold text-slate-600 mb-1 block">The work *</label>
            <textarea name="brief" required rows="5" placeholder="The harder the better. The more concrete it is, the more useful the plan we send back." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
          </div>
          <div class="flex flex-col sm:flex-row gap-3">
            <button type="submit" class="flex-1 inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-colors">
              <i data-lucide="send" class="w-4 h-4"></i><span class="btn-text">Send it over</span>
            </button>
            <a href="/auth/register" class="flex-1 inline-flex items-center justify-center gap-2 border border-slate-300 bg-white text-slate-800 py-3 rounded-lg font-semibold text-sm hover:border-brand-400 hover:text-brand-700 transition-colors">
              Or try it yourself, free
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
  // ── Hero product tabs ─────────────────────────────────────────
  (function () {
    var root = document.getElementById('hero-shots');
    if (!root) return;
    var slides = root.querySelectorAll('[data-shot]');
    var buttons = root.querySelectorAll('[data-shot-btn]');
    if (slides.length < 2) return;

    var current = 0;
    var timer = null;
    var DELAY = 5000;
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var ON = ['bg-white', 'text-brand-700', 'shadow-sm'];
    var OFF = ['text-slate-500', 'hover:text-slate-800'];

    function show(next) {
      current = (next + slides.length) % slides.length;
      for (var i = 0; i < slides.length; i++) {
        slides[i].classList.toggle('opacity-100', i === current);
        slides[i].classList.toggle('opacity-0', i !== current);
      }
      for (var j = 0; j < buttons.length; j++) {
        var on = j === current;
        buttons[j].setAttribute('aria-selected', on ? 'true' : 'false');
        ON.forEach(function (c) { buttons[j].classList.toggle(c, on); });
        OFF.forEach(function (c) { buttons[j].classList.toggle(c, !on); });
      }
    }

    function start() { if (!reduced && !timer) timer = setInterval(function () { show(current + 1); }, DELAY); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    // A click means the reader has taken over: stop rotating for good.
    for (var k = 0; k < buttons.length; k++) {
      (function (idx) {
        buttons[idx].addEventListener('click', function () { stop(); show(idx); });
      })(k);
    }

    root.addEventListener('mouseenter', stop);
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
        btnText.textContent = 'Send it over';
      }
    });
  })();
</script>

</body>
</html>
`;
