import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";

/**
 * /services/ — for buyers who need software built.
 *
 * A different reader from the services-firm page and deliberately written that
 * way. An SMB buyer does not care about agency margin structure; they care
 * about whether you understood them, whether the thing works, who owns the
 * code, and what happens when they change their mind. So this page leads with
 * clarity, ownership, visibility and accountability, and keeps the agent
 * mechanics to a single section near the bottom.
 */

const USE_CASES: Array<[string, string, string, string[]]> = [
  ["rocket", "Build a new product",
   "A product with real users, not a prototype you throw away in three months.",
   ["Customer-facing applications", "SaaS products", "Authentication, payments, integrations", "Infrastructure and deployment"]],
  ["list-checks", "Clear a backlog",
   "The work your team keeps meaning to get to and never does.",
   ["Features that keep slipping", "Long-standing bugs", "Integrations with other systems", "Overdue upgrades"]],
  ["layout-dashboard", "Build internal software",
   "The operational tooling that runs on spreadsheets today.",
   ["Dashboards and reporting", "Approval and workflow tools", "Admin and back-office apps", "Data entry and operations"]],
  ["refresh-cw", "Modernize existing systems",
   "Work inside the stack you already have rather than starting again.",
   ["Refactoring and migrations", "New functionality in an old codebase", "Third-party integrations", "Performance and reliability"]],
];

const ANSWERS: Array<[string, string]> = [
  ["Will you actually understand what I need?",
   "That is the first thing we produce, and you see it before anything is built. Your requirement comes back as a written specification with acceptance criteria — what will exist, how we will know it works, and what is deliberately out of scope. If we misunderstood you, you find out on day one when it costs a conversation, not at delivery when it costs the project."],
  ["Will the thing actually work?",
   "Every change is tested and checked against the acceptance criteria it came from before a person reviews it, and a named engineer approves it before it ships. You also get a working preview as it is built, so \"working\" is something you click on rather than something we assert."],
  ["Am I going to spend six months managing developers?",
   "No. There is no standup for you to attend and no team for you to run. You review the specification at the start, look at previews as things land, and approve the finished work. Between those points the pipeline carries the project."],
  ["Who owns the code?",
   "You do, unambiguously, and it lives in your repository from the first commit. Not a portal we control, not an account you lose access to if you stop working with us. You can hire an engineer tomorrow and hand it over."],
  ["What happens when the requirements change?",
   "They will, and that is normal. Because the specification, the plan and the tickets are all written down and linked, a change is a scoping conversation with a visible cost rather than an argument about what was agreed six weeks ago."],
  ["Can you work inside our existing system?",
   "Usually yes. The factory reads an existing codebase as context before it plans anything, which is what makes modernization and backlog work tractable rather than a rewrite in disguise."],
  ["What happens after launch?",
   "The project record — requirements, decisions, tickets, tests, documentation — stays with the code. Whether we keep going, your own team takes over, or you bring in someone else, none of it depends on us still being in the room."],
  ["Will someone disappear halfway through?",
   "You can see the state of the work at any moment without asking us: what is done, what is running, what failed, what is waiting on you. Projects go wrong quietly when nobody can see them. This one is hard to hide."],
];

export const DevelopmentServicesPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "Custom Software Development Services | AI Software Factory | LFG",
  description: "Get software built without assembling a large development team. LFG delivers custom software, internal tools, product builds and modernization through an AI software factory with engineering oversight.",
  path: "/services/",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "services" })}

<main>

  <!-- HERO -->
  <section class="relative pt-28 sm:pt-36 pb-16 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="absolute top-24 left-[4%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
        <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">Software development services</span>
      </div>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up max-w-3xl">
        Need software built?<br>
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">Skip assembling a team.</span>
      </h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">
        A customer-facing application, an internal tool, a SaaS product or a backlog you have been postponing. We take it from requirements through implementation and verification — and you work with a small delivery team backed by the LFG software factory instead of paying for a large one for months.
      </p>
      <div class="mt-8 flex flex-col sm:flex-row gap-3 animate-fade-up">
        <a href="/#start" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
          Talk to us about a project <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
        <a href="/case-studies/" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
          See what we have shipped
        </a>
      </div>
      <p class="mt-5 text-sm text-slate-500 animate-fade-up">Your repository &middot; your code &middot; a written spec before anything is built</p>
    </div>
  </section>

  <!-- WHAT WE BUILD -->
  <section class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-12">
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">What we build</h2>
        <p class="text-slate-600 text-lg mt-4">Four shapes of work, one delivery process.</p>
      </div>
      <div class="grid sm:grid-cols-2 gap-6">
        ${USE_CASES.map(([icon, title, blurb, items]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-7">
            <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-xl text-slate-900 mb-2">${title}</h3>
            <p class="text-slate-600 leading-relaxed mb-5">${blurb}</p>
            <ul class="space-y-2">
              ${items.map((it) => html`<li class="flex gap-2.5 text-sm text-slate-600"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>${it}</li>`)}
            </ul>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- HOW WORKING WITH US GOES -->
  <section class="band py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">What it is like</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Four things you do. That is the whole job.</h2>
        <p class="text-slate-600 text-lg mt-4">Everything else is ours to run.</p>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
        ${([
          ["01", "Tell us what you need", "In your own words. A document, a conversation, a list of frustrations — whatever you have."],
          ["02", "Approve the specification", "You get a written spec with acceptance criteria before anything is built. This is where you push back."],
          ["03", "Watch it get built", "Working previews as features land. No waiting until the end to find out what you are getting."],
          ["04", "Accept the delivery", "Reviewed, tested, documented and merged into a repository you own."],
        ] as Array<[string, string, string]>).map(([n, t, b], i) => html`
          <div class="rounded-2xl border ${i === 3 ? "border-brand-200 ring-1 ring-brand-100" : "border-slate-200"} bg-white p-6">
            <p class="text-xs font-bold text-brand-600 mb-3">${n}</p>
            <h3 class="font-display font-bold text-base mb-2">${t}</h3>
            <p class="text-sm text-slate-600 leading-relaxed">${b}</p>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- VISIBILITY -->
  <section class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Visibility</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-5">You should not need a status meeting to know whether your software is getting built.</h2>
          <p class="text-slate-600 text-lg leading-relaxed mb-6">
            The usual version of this is a weekly call where someone tells you it is going well, and you find out otherwise near the deadline. Here the project record is the actual work: requirements, tickets, what is running right now, what failed, what is waiting on you.
          </p>
          <div class="flex flex-wrap gap-2">
            ${["Requirements", "Tickets", "What is building now", "Test results", "Issues found", "Reviews", "Release status"]
              .map((v) => html`<span class="text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600">${v}</span>`)}
          </div>
        </div>
        <div class="shot">
          <div class="shot-bar">
            <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
            <span class="ml-2 text-xs font-mono text-slate-400">your project</span>
          </div>
          <img src="/public/images/screenshots/agent-ticket-board.png" alt="A live LFG project board showing every ticket and its state" loading="lazy" class="w-full block" />
        </div>
      </div>
    </div>
  </section>

  <!-- THE ANSWERS -->
  <section class="band py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Before you ask</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">The questions everyone has about outsourcing software.</h2>
        <p class="text-slate-600 text-lg mt-4">Most of them come from being burned before. They are fair.</p>
      </div>
      <div class="space-y-8">
        ${ANSWERS.map(([q, a]) => html`
          <div>
            <p class="font-display font-bold text-lg text-slate-900 mb-2.5">${q}</p>
            <p class="text-slate-600 leading-relaxed">${a}</p>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- ENGAGEMENT MODELS -->
  <section class="band-tint py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Working together</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Start small if you want to.</h2>
        <p class="text-slate-600 text-lg mt-4">Most people would rather test us on something contained before handing over a project. That is the sensible instinct and we would rather you followed it.</p>
      </div>
      <div class="grid md:grid-cols-3 gap-6">
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <h3 class="font-display font-bold text-xl mb-2">Pilot</h3>
          <p class="text-sm text-slate-600 leading-relaxed mb-4">One scoped feature or a contained piece of work. You judge the result before committing to anything larger.</p>
          <p class="text-xs text-slate-500">Best for testing whether this actually works on your codebase.</p>
        </div>
        <div class="rounded-2xl border border-brand-200 bg-white p-7 ring-1 ring-brand-100">
          <h3 class="font-display font-bold text-xl mb-2">Project</h3>
          <p class="text-sm text-slate-600 leading-relaxed mb-4">Fixed-scope delivery against an agreed specification, with acceptance criteria written down before we start.</p>
          <p class="text-xs text-slate-500">Best for a defined build with a defined end.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <h3 class="font-display font-bold text-xl mb-2">Ongoing delivery</h3>
          <p class="text-sm text-slate-600 leading-relaxed mb-4">A continuing stream of work — a backlog, a roadmap, or a product that keeps evolving after launch.</p>
          <p class="text-xs text-slate-500">Best for teams without their own engineering capacity.</p>
        </div>
      </div>
      <p class="text-sm text-slate-500 mt-6">Pricing depends on scope, so we quote after we understand the work. <a href="/#start" class="font-semibold text-brand-700 hover:underline">Send us the requirement</a> and you will get a plan and a number.</p>
    </div>
  </section>

  <!-- WHAT'S UNDERNEATH -->
  <section class="band py-16">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">If you want the mechanism</p>
      <h2 class="font-display font-bold text-2xl md:text-3xl text-slate-900 mb-4">What is doing the work</h2>
      <p class="text-slate-600 leading-relaxed mb-4">
        We deliver through the LFG software factory: a pipeline that turns a requirement into a specification, an architecture, a set of dependency-aware tickets, code built in isolated environments, tests, and a reviewed pull request. Coding agents do the implementation. Engineers hold the review gate.
      </p>
      <p class="text-slate-600 leading-relaxed mb-6">
        You do not need to care about any of that to work with us — but the reason a small team can deliver this much is not a secret, and you can go and read it.
      </p>
      <div class="flex flex-wrap gap-3">
        <a href="/how-it-works/" class="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold text-sm hover:border-brand-400 hover:text-brand-700 transition-colors">How the factory works <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
        <a href="/case-studies/" class="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold text-sm hover:border-brand-400 hover:text-brand-700 transition-colors">Case studies <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section class="band-tint py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-4">Give us a requirement.</h2>
      <p class="text-slate-600 text-lg leading-relaxed mb-8">
        We will turn it into a technical plan and a delivery proposal. If it is not a fit, we will say so and tell you what would be.
      </p>
      <a href="/#start" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
        Talk to us about a project <i data-lucide="arrow-right" class="w-4 h-4"></i>
      </a>
    </div>
  </section>

</main>

${SiteFooter()}

</body>
</html>
`;
