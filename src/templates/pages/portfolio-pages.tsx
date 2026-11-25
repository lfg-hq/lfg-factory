import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import { PORTFOLIO, type PortfolioProject } from "../../data/portfolio.ts";

/**
 * /portfolio/ and /portfolio/:slug/.
 *
 * The portfolio leads with the Software Factory (the core product) and shows
 * every project as something the factory shipped, for clients and for our own
 * products. Every claim is concrete and comes from the real build. Outcome numbers only appear once measured (see
 * src/data/portfolio.ts).
 */

/** Screenshot when we have one, otherwise a calm gradient panel with the project's icon. */
const visual = (p: PortfolioProject, size: "card" | "hero") => p.image
  ? html`<img src="${p.image}" alt="${p.name}" loading="lazy" class="w-full h-full object-cover object-top" />`
  : html`
    <div class="relative w-full h-full bg-gradient-to-br ${p.gradient} flex items-center justify-center overflow-hidden">
      <div class="absolute inset-0 opacity-20" style="background-image: radial-gradient(circle at 1px 1px, white 1px, transparent 0); background-size: 18px 18px;"></div>
      <div class="absolute -bottom-16 -right-16 w-56 h-56 rounded-full bg-white/10"></div>
      <div class="relative ${size === "hero" ? "w-20 h-20 rounded-3xl" : "w-14 h-14 rounded-2xl"} bg-white/15 border border-white/30 backdrop-blur flex items-center justify-center">
        <i data-lucide="${p.icon}" class="${size === "hero" ? "w-10 h-10" : "w-7 h-7"} text-white"></i>
      </div>
    </div>`;

const FACTORY = PORTFOLIO.find((p) => p.slug === "software-factory");
const CLIENT_WORK = PORTFOLIO.filter((p) => p.group === "client");
const OWN_PRODUCTS = PORTFOLIO.filter((p) => p.group === "own");

/** One card per project: eyebrow (who it is for), name, what it does, how the factory delivered it. */
const card = (p: PortfolioProject) => html`
  <a href="/portfolio/${p.slug}/" class="group flex flex-col rounded-2xl border border-slate-200 bg-white overflow-hidden hover:border-brand-300 hover:-translate-y-0.5 transition-all">
    <div class="h-48 border-b border-slate-100 bg-slate-50">${visual(p, "card")}</div>
    <div class="p-6 flex flex-col flex-1">
      <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">${p.eyebrow ?? p.client}</p>
      <h3 class="font-display font-bold text-xl sm:text-2xl text-slate-900 group-hover:text-brand-700 transition-colors mb-2">${p.name}</h3>
      <p class="text-slate-600 leading-relaxed mb-5">${p.summary}</p>
      ${p.proof ? html`
      <div class="flex items-start gap-3 rounded-xl bg-brand-50 border border-brand-100 px-4 py-3 mb-5">
        <i data-lucide="factory" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>
        <p class="text-sm leading-snug"><span class="block text-[11px] font-bold uppercase tracking-wider text-brand-600 mb-0.5">Built on the factory</span><span class="font-semibold text-slate-800">${p.proof}</span></p>
      </div>` : ""}
      <p class="text-xs text-slate-400 mb-5">${p.stack.slice(0, 5).join(" · ")}</p>
      <span class="mt-auto inline-flex items-center gap-2 font-semibold text-brand-700 group-hover:gap-3 transition-all">Read the case study <i data-lucide="arrow-right" class="w-4 h-4"></i></span>
    </div>
  </a>`;

const cta = (heading: string, body: string) => html`
  <section class="band py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-4">${heading}</h2>
      <p class="text-slate-600 text-lg leading-relaxed mb-8">${body}</p>
      <div class="flex flex-col sm:flex-row gap-3 justify-center">
        <a href="/#start" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
          Talk to us about a project <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
        <a href="/services/" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
          How we work with clients
        </a>
      </div>
    </div>
  </section>`;

/** What the factory adds for a team. Positive framing: more capacity for the people you have. */
const FACTORY_VALUE: [string, string, string][] = [
  ["gauge", "Higher productivity", "Scoping, implementation and QA run in parallel across isolated sandboxes, so the same team ships more every sprint."],
  ["coins", "More output, less spend", "Runs on the AI plans you already pay for, with a model policy per project that matches the right model to each task and keeps token spend predictable."],
  ["shield-check", "Fewer mistakes in production", "Nothing merges unchecked. Every change is built, tested and exercised in a live preview before a person reviews it."],
  ["workflow", "Guardrails by default", "Your architecture, definition of done and review gates are enforced at every stage. AI drafts; rules decide."],
  ["users", "Capacity without matching headcount", "Take on more work and more clients without growing the team at the same rate. Senior engineers supervise several streams instead of hand-writing each."],
  ["scroll-text", "A trail on every change", "Every merged change traces back to the requirement, ticket, tests and approval that produced it."],
];

const FACTORY_NEEDS: [string, string][] = [
  ["Your code on GitHub or GitLab", "We work on branches; nothing changes in how you merge."],
  ["An AI plan you already have", "Claude or ChatGPT team plans, or API keys."],
  ["Somewhere for sandboxes to run", "A server of yours with Docker, or our hosted microVMs."],
  ["One senior engineer to own the gates", "They approve verified changes and hold the architecture."],
  ["A first project or backlog", "Real work to pilot on, so the value shows from the start."],
];

const FACTORY_STEPS: [string, string][] = [
  ["Connect", "Link repositories, tracker, AI plans and sandboxes. Nothing to migrate."],
  ["Configure", "Set your templates, definition of done, review gates and stack conventions."],
  ["Pilot", "Run one real project through the pipeline alongside your team."],
  ["Scale", "We train your engineers to hold the gates, or keep running it and own the outcome."],
];

const factorySection = () => html`
  <section id="factory" class="band py-16 scroll-mt-24">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="rounded-3xl bg-slate-900 text-white overflow-hidden">
        <div class="grid lg:grid-cols-[1.1fr_1fr] gap-10 p-6 sm:p-10 lg:p-12">
          <div>
            <p class="text-xs font-bold uppercase tracking-wider text-brand-300 mb-3">The core product</p>
            <h2 class="font-display font-bold text-3xl sm:text-4xl leading-tight mb-4">Software Factory: do more with the team you have.</h2>
            <p class="text-slate-300 text-lg leading-relaxed mb-8">An agentic delivery pipeline that plugs into your repositories, trackers and cloud, and takes work from a scoped request to a verified pull request. Your engineers stay in charge; the factory multiplies what they can deliver. Every product on this page was built on it.</p>
            <div class="flex flex-col sm:flex-row sm:items-end gap-2 sm:gap-4 mb-8">
              <span class="whitespace-nowrap font-display font-bold text-6xl sm:text-7xl leading-none text-transparent bg-clip-text bg-gradient-to-r from-indigo-300 to-pink-400">5–10x</span>
              <span class="text-slate-300 leading-snug pb-1">delivery capacity from the<br class="hidden sm:block" /> team you already have</span>
            </div>
            <div class="flex flex-col sm:flex-row sm:flex-wrap gap-3">
              <a href="/#start" class="sm:whitespace-nowrap text-center px-6 py-3 rounded-full bg-white text-slate-900 font-semibold hover:bg-slate-100 transition-colors inline-flex items-center justify-center gap-2">
                Deploy the factory for your team <i data-lucide="arrow-right" class="w-4 h-4"></i>
              </a>
              <a href="/portfolio/software-factory/" class="sm:whitespace-nowrap text-center px-6 py-3 rounded-full border border-white/25 text-white font-semibold hover:border-white/60 transition-colors inline-flex items-center justify-center gap-2">
                Read the case study
              </a>
            </div>
          </div>
          <div class="flex flex-col gap-4">
            ${FACTORY?.image ? html`<div class="rounded-2xl overflow-hidden border border-white/10 bg-slate-800"><img src="${FACTORY.image}" alt="The Software Factory pipeline" loading="lazy" class="w-full h-auto" /></div>` : ""}
            <div class="rounded-2xl bg-brand-600 p-5">
              <div class="flex items-center gap-2 mb-1.5"><i data-lucide="wallet" class="w-5 h-5 shrink-0"></i><h3 class="font-semibold text-lg">Works with your existing subscription plans</h3></div>
              <p class="text-white/85 text-sm leading-relaxed">Agents run on the Claude and ChatGPT plans your team already pays for, or on API keys. No new model contract and no surprise bill.</p>
            </div>
            <div class="rounded-2xl bg-white/5 border border-white/10 p-5">
              <div class="flex items-center gap-2 mb-1.5"><i data-lucide="sliders-horizontal" class="w-5 h-5 text-brand-300 shrink-0"></i><h3 class="font-semibold text-lg">Customisations available</h3></div>
              <p class="text-slate-300 text-sm leading-relaxed">Document templates, definition of done, review gates, approval rules and stack conventions, set per team or per client. It can also run under your own brand and domain.</p>
            </div>
          </div>
        </div>

        <div class="border-y border-white/10 grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-white/10">
          ${FACTORY_VALUE.map(([icon, title, text]) => html`
            <div class="bg-slate-900 p-6 sm:p-7">
              <div class="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center mb-3"><i data-lucide="${icon}" class="w-5 h-5 text-brand-300"></i></div>
              <h3 class="font-semibold mb-1.5">${title}</h3>
              <p class="text-sm text-slate-400 leading-relaxed">${text}</p>
            </div>`)}
        </div>

        <div class="grid lg:grid-cols-2 gap-10 p-6 sm:p-10 lg:p-12">
          <div>
            <h3 class="text-xs font-bold uppercase tracking-wider text-brand-300 mb-5">What you need to start</h3>
            <ul class="space-y-4">
              ${FACTORY_NEEDS.map(([title, text]) => html`
                <li class="flex gap-3">
                  <span class="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0 mt-0.5"><i data-lucide="check" class="w-3.5 h-3.5 text-emerald-300"></i></span>
                  <span><span class="block font-semibold">${title}</span><span class="block text-sm text-slate-400">${text}</span></span>
                </li>`)}
              <li class="flex gap-3">
                <span class="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0 mt-0.5"><i data-lucide="plus" class="w-3.5 h-3.5 text-slate-300"></i></span>
                <span><span class="block font-semibold text-slate-300">Optional: Jira or Linear, and MCP tools</span><span class="block text-sm text-slate-400">Connect them if you use them; not needed to start.</span></span>
              </li>
            </ul>
          </div>
          <div>
            <h3 class="text-xs font-bold uppercase tracking-wider text-brand-300 mb-5">How we get you running</h3>
            <ol class="space-y-5">
              ${FACTORY_STEPS.map(([title, text], n) => html`
                <li class="flex gap-4">
                  <span class="w-9 h-9 rounded-full bg-brand-600 font-display font-bold flex items-center justify-center shrink-0">${n + 1}</span>
                  <span><span class="block font-semibold text-lg">${title}</span><span class="block text-sm text-slate-400 leading-relaxed">${text}</span></span>
                </li>`)}
            </ol>
            <p class="text-sm text-slate-400 mt-6">Runs hosted by us, self-hosted on your cloud or data centre, or set up and operated for you.</p>
          </div>
        </div>
      </div>
    </div>
  </section>`;

const group = (id: string, label: string, intro: string, list: PortfolioProject[], cols: string) => html`
  <div id="${id}" class="scroll-mt-24">
    <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-6">
      <h3 class="font-display font-bold text-2xl text-slate-900">${label}</h3>
      <p class="text-slate-500 sm:text-right sm:max-w-md">${intro}</p>
    </div>
    <div class="grid ${cols} gap-6">${list.map(card)}</div>
  </div>`;

const PILLARS: [string, string, string][] = [
  ["users", "Built with the people who use it", "Real documents, calls and workflows feed the factory's scope and document stages, so the spec reflects how the work is actually done."],
  ["shield-check", "Rules where it matters", "AI reads and drafts. Deterministic code and guardrails make the decisions that must be right, and agents cannot merge unverified work."],
  ["file-check-2", "Tested, then shipped", "Isolated sandboxes, live preview QA with recorded walkthroughs, and edge cases that become permanent automated tests."],
  ["server", "Yours to run", "Hosted or self-hosted, on the AI plans you already have, with full code ownership and audit trails from day one."],
];

export const PortfolioIndexPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "Portfolio | Built on the LFG Software Factory",
  description: "The LFG Software Factory gives engineering teams 5–10x delivery capacity on the AI plans they already pay for. See the production systems it has shipped for clients and for our own products.",
  path: "/portfolio/",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "portfolio" })}

<main>
  <section class="relative pt-28 sm:pt-36 pb-14 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
        <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">Portfolio · Built on the Software Factory</span>
      </div>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up max-w-4xl">
        Proof the factory
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">ships production software.</span>
      </h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">
        Our core product is the Software Factory: an agentic delivery pipeline that gives your engineering team far more delivery capacity, on the AI plans you already pay for. Every product on this page was built on it, from an accounts team's invoice platform to the developer platforms we run ourselves.
      </p>
      <div class="flex flex-wrap gap-2 mt-8">
        ${[["#factory", "factory", "The Software Factory"], ["#clients", "briefcase", "Built for clients"], ["#own", "boxes", "Our own products"]].map(([href, icon, label]) => html`<a href="${href}" class="inline-flex items-center gap-1.5 text-sm font-medium px-3.5 py-1.5 rounded-full bg-white border border-slate-200 text-slate-700 hover:border-brand-300 hover:text-brand-700 transition-colors"><i data-lucide="${icon}" class="w-3.5 h-3.5"></i>${label}</a>`)}
      </div>
    </div>
  </section>

  ${factorySection()}

  <section class="band-tint py-16">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 space-y-14">
      <div class="max-w-3xl">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Built on the Software Factory</p>
        <h2 class="font-display font-bold text-3xl sm:text-4xl text-slate-900 mb-3">Seven production systems, one factory.</h2>
        <p class="text-slate-600 text-lg leading-relaxed">Every project below went through the same pipeline: scoped with the people who use it, built by agents in isolated sandboxes, verified before review and shipped to production.</p>
      </div>
      ${group("clients", "Built for clients", "Operations teams that needed a system in production, not a prototype.", CLIENT_WORK, "md:grid-cols-2 lg:grid-cols-3")}
      ${group("own", "Our own products", "We run our own developer platforms and SaaS products on the factory every day.", OWN_PRODUCTS, "md:grid-cols-2")}
    </div>
  </section>

  <section class="band py-16">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-2 text-center">How every one of these was delivered</h2>
      <p class="text-slate-600 text-center mb-8">Four principles, built into the factory.</p>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
        ${PILLARS.map(([icon, title, text]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-6">
            <i data-lucide="${icon}" class="w-6 h-6 text-brand-600 mb-3"></i>
            <h3 class="font-semibold text-slate-900 mb-1.5">${title}</h3>
            <p class="text-sm text-slate-600 leading-relaxed">${text}</p>
          </div>`)}
      </div>
    </div>
  </section>

  <section class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-10 text-center">Put the factory to work for your team.</h2>
      <div class="grid md:grid-cols-2 gap-6">
        <a href="/#start" class="group rounded-3xl bg-slate-900 text-white p-8 flex flex-col hover:-translate-y-0.5 transition-all">
          <div class="w-12 h-12 rounded-2xl bg-brand-600 flex items-center justify-center mb-5"><i data-lucide="factory" class="w-6 h-6"></i></div>
          <h3 class="font-display font-bold text-2xl mb-1">Deploy the factory for your team</h3>
          <p class="text-sm font-semibold text-brand-300 mb-3">For software services firms and engineering teams</p>
          <p class="text-slate-300 leading-relaxed mb-6">Works with your existing subscription plans and is customised to your process. Hosted, self-hosted or operated for you.</p>
          <span class="mt-auto inline-flex items-center gap-2 font-semibold group-hover:gap-3 transition-all">Talk to us <i data-lucide="arrow-right" class="w-4 h-4"></i></span>
        </a>
        <a href="/services/" class="group rounded-3xl border border-slate-200 bg-white p-8 flex flex-col hover:border-brand-300 hover:-translate-y-0.5 transition-all">
          <div class="w-12 h-12 rounded-2xl bg-brand-50 flex items-center justify-center mb-5"><i data-lucide="rocket" class="w-6 h-6 text-brand-600"></i></div>
          <h3 class="font-display font-bold text-2xl text-slate-900 mb-1">Have us ship your first system</h3>
          <p class="text-sm font-semibold text-brand-600 mb-3">For operations teams who want an outcome, not a tool</p>
          <p class="text-slate-600 leading-relaxed mb-6">We scope it with your people, build it on the factory and take it all the way to production.</p>
          <span class="mt-auto inline-flex items-center gap-2 font-semibold text-brand-700 group-hover:gap-3 transition-all">See how we work <i data-lucide="arrow-right" class="w-4 h-4"></i></span>
        </a>
      </div>
    </div>
  </section>
</main>

${SiteFooter()}

</body>
</html>
`;

export const PortfolioProjectPage = ({ project: p }: { project: PortfolioProject }) => {
  const i = PORTFOLIO.findIndex((x) => x.slug === p.slug);
  const next = PORTFOLIO[(i + 1) % PORTFOLIO.length];
  return html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: `${p.name}: ${p.tagline} | LFG Portfolio`,
  description: p.summary,
  path: `/portfolio/${p.slug}/`,
  ...(p.image ? { image: p.image } : {}),
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "portfolio" })}

<main>
  <section class="relative pt-28 sm:pt-36 pb-12 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <a href="/portfolio/" class="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-brand-600 transition-colors mb-6">
        <i data-lucide="arrow-left" class="w-3.5 h-3.5"></i> All work
      </a>
      ${p.group ? html`
      <a href="/portfolio/#factory" class="flex w-fit items-center gap-1.5 px-3 py-1 rounded-full bg-brand-50 border border-brand-100 text-xs font-bold uppercase tracking-wider text-brand-700 hover:border-brand-300 transition-colors mb-4">
        <i data-lucide="factory" class="w-3.5 h-3.5"></i> Built on the Software Factory
      </a>` : ""}
      <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-3">${p.tagline}</p>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up">${p.name}</h1>
      <p class="text-base font-medium text-slate-500 mt-3">${p.client}</p>
      <p class="text-lg text-slate-600 mt-6 leading-relaxed animate-fade-up">${p.overview}</p>
      ${p.url ? html`
        <a href="${p.url}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 mt-6 font-semibold text-brand-700 hover:gap-3 transition-all">
          Visit the live product <i data-lucide="arrow-up-right" class="w-4 h-4"></i>
        </a>` : ""}
    </div>
  </section>

  <section class="band py-12">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="shot">
        <div class="shot-bar">
          <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
          <span class="ml-2 text-xs font-mono text-slate-400">${p.slug}</span>
        </div>
        <div class="${p.image ? "" : "h-64 sm:h-80"}">${visual(p, "hero")}</div>
      </div>
    </div>
  </section>

  <section class="band-tint py-14">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <h2 class="font-display font-bold text-2xl text-slate-900 mb-5">At a glance</h2>
      <dl class="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
        ${p.glance.map((g) => html`
          <div class="grid sm:grid-cols-[180px_1fr] gap-1 sm:gap-6 px-5 sm:px-6 py-4">
            <dt class="text-xs font-bold uppercase tracking-wider text-slate-500 sm:pt-0.5">${g.label}</dt>
            <dd class="text-slate-800 leading-relaxed">${g.value}</dd>
          </div>`)}
        <div class="grid sm:grid-cols-[180px_1fr] gap-1 sm:gap-6 px-5 sm:px-6 py-4">
          <dt class="text-xs font-bold uppercase tracking-wider text-slate-500 sm:pt-0.5">Stack</dt>
          <dd class="flex flex-wrap gap-1.5">${p.stack.map((s) => html`<span class="text-xs font-medium px-2.5 py-1 rounded-md bg-slate-100 text-slate-600">${s}</span>`)}</dd>
        </div>
      </dl>
    </div>
  </section>

  <section class="band py-16">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 space-y-14">
      <div>
        <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-4">The challenge</h2>
        <p class="text-slate-600 text-lg leading-relaxed mb-6">${p.challengeIntro}</p>
        <div class="grid sm:grid-cols-2 gap-4">
          ${p.challenges.map((c) => html`
            <div class="rounded-xl border border-slate-200 bg-white p-5">
              <h3 class="font-semibold text-slate-900 mb-1.5">${c.title}</h3>
              <p class="text-sm text-slate-600 leading-relaxed">${c.text}</p>
            </div>`)}
        </div>
      </div>

      ${p.approach ? html`
      <div class="rounded-2xl bg-brand-50 border border-brand-100 p-6 sm:p-8">
        <h2 class="font-display font-bold text-2xl text-slate-900 mb-3">Our approach</h2>
        <p class="text-slate-700 text-lg leading-relaxed">${p.approach}</p>
      </div>` : ""}

      <div>
        <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-6">What we built</h2>
        <div class="space-y-5">
          ${p.built.map((b, n) => html`
            <div class="rounded-2xl border border-slate-200 bg-white p-6 sm:p-7">
              <div class="flex items-center gap-3 mb-4">
                <span class="w-8 h-8 rounded-lg bg-slate-900 text-white font-display font-bold text-sm flex items-center justify-center shrink-0">${n + 1}</span>
                <h3 class="font-display font-bold text-lg text-slate-900">${b.title}</h3>
              </div>
              <ul class="space-y-2.5">
                ${b.points.map((pt) => html`
                  <li class="flex gap-3 text-slate-600"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-1 shrink-0"></i><span class="leading-relaxed">${pt}</span></li>`)}
              </ul>
            </div>`)}
        </div>
      </div>

      ${p.security.length ? html`
      <div>
        <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-5">Security and operations</h2>
        <ul class="space-y-3">
          ${p.security.map((s) => html`
            <li class="flex gap-3 text-slate-600"><i data-lucide="shield-check" class="w-4 h-4 text-emerald-600 mt-1 shrink-0"></i><span class="leading-relaxed">${s}</span></li>`)}
        </ul>
      </div>` : ""}
    </div>
  </section>

  <section class="band-tint py-16">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 space-y-14">
      <div>
        <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-6">Results</h2>
        <div class="grid sm:grid-cols-2 gap-4">
          ${p.results.map((r) => html`
            <div class="rounded-xl border border-slate-200 bg-white p-5">
              <div class="flex items-center gap-2 mb-1.5">
                <i data-lucide="trending-up" class="w-4 h-4 text-brand-600 shrink-0"></i>
                <h3 class="font-semibold text-slate-900">${r.title}</h3>
              </div>
              <p class="text-sm text-slate-600 leading-relaxed">${r.text}</p>
            </div>`)}
        </div>
      </div>
      <div>
        <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-6">Key takeaways</h2>
        <ol class="space-y-4">
          ${p.takeaways.map((t, n) => html`
            <li class="flex gap-4">
              <span class="font-display font-bold text-2xl text-brand-300 leading-none w-7 shrink-0">${n + 1}</span>
              <p class="text-slate-600 leading-relaxed"><strong class="text-slate-900">${t.title}.</strong> ${t.text}</p>
            </li>`)}
        </ol>
      </div>
    </div>
  </section>

  ${next && next.slug !== p.slug ? html`
  <section class="band py-10">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <a href="/portfolio/${next.slug}/" class="group flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-6 hover:border-brand-300 transition-colors">
        <span>
          <span class="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Next project</span>
          <span class="block font-display font-bold text-xl text-slate-900 group-hover:text-brand-700 transition-colors">${next.name}</span>
          <span class="block text-sm text-slate-500 mt-0.5">${next.tagline}</span>
        </span>
        <i data-lucide="arrow-right" class="w-5 h-5 text-brand-600 shrink-0 group-hover:translate-x-1 transition-transform"></i>
      </a>
    </div>
  </section>` : ""}

  ${cta("Have a process like this?", "Tell us what is costing your team the most time. We will show you how we would scope it, build it and get it into production.")}
</main>

${SiteFooter()}

</body>
</html>
`;
};
