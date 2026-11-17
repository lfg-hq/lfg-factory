import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import { PORTFOLIO, type PortfolioProject } from "../../data/portfolio.ts";

/**
 * /portfolio/ and /portfolio/:slug/.
 *
 * The consulting portfolio: products we have built for clients and for
 * ourselves. Its job is to win the next project, so every claim is concrete and
 * comes from the real build. Outcome numbers only appear once measured (see
 * src/data/portfolio.ts).
 */

/** Screenshot when we have one, otherwise a calm gradient panel with the project's icon. */
const visual = (p: PortfolioProject, size: "card" | "hero") => p.image
  ? html`<img src="${p.image}" alt="${p.name}" loading="lazy" class="w-full h-full object-cover object-top" />`
  : html`
    <div class="relative w-full h-full bg-gradient-to-br ${p.gradient} flex items-center justify-center overflow-hidden">
      <div class="absolute inset-0 opacity-20" style="background-image: radial-gradient(circle at 1px 1px, white 1px, transparent 0); background-size: 18px 18px;"></div>
      <div class="absolute -bottom-16 -right-16 w-56 h-56 rounded-full bg-white/10"></div>
      <div class="relative flex flex-col items-center text-center px-6">
        <div class="${size === "hero" ? "w-20 h-20 rounded-3xl" : "w-14 h-14 rounded-2xl"} bg-white/15 border border-white/30 backdrop-blur flex items-center justify-center mb-3">
          <i data-lucide="${p.icon}" class="${size === "hero" ? "w-10 h-10" : "w-7 h-7"} text-white"></i>
        </div>
        <span class="text-white/90 text-xs font-semibold uppercase tracking-wider">${p.client}</span>
      </div>
    </div>`;

const card = (p: PortfolioProject) => html`
  <a href="/portfolio/${p.slug}/" class="group flex flex-col rounded-2xl border border-slate-200 bg-white overflow-hidden hover:border-brand-300 hover:-translate-y-0.5 transition-all">
    <div class="h-52 border-b border-slate-100 bg-slate-50">${visual(p, "card")}</div>
    <div class="p-6 sm:p-7 flex flex-col flex-1">
      <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">${p.tagline}</p>
      <h2 class="font-display font-bold text-xl sm:text-2xl text-slate-900 group-hover:text-brand-700 transition-colors">${p.name}</h2>
      <p class="text-sm text-slate-500 mt-1 mb-3">${p.client}</p>
      <p class="text-slate-600 leading-relaxed mb-5">${p.summary}</p>
      <div class="flex flex-wrap gap-1.5 mb-6">
        ${p.stack.slice(0, 5).map((s) => html`<span class="text-xs font-medium px-2.5 py-1 rounded-md bg-slate-100 text-slate-600">${s}</span>`)}
      </div>
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

export const PortfolioIndexPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "Portfolio | Products LFG Has Built for Clients",
  description: "Case studies from LFG's consulting work: AI-assisted operations, voice agents, recruiting tools, developer platforms and go-to-market products, built and running in production.",
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
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">Portfolio</span>
      </div>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up max-w-3xl">
        Work we have
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">shipped.</span>
      </h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">
        Real products for real operations, from an accounts team buried in supplier invoices to a clinic that needed its phone answered. Each one was scoped with the people who use it, built on our software factory, and taken all the way to production. The factory itself is here too, and we can set it up for your team.
      </p>
      <div class="flex flex-wrap gap-2 mt-8">
        ${PORTFOLIO.map((p) => html`<a href="/portfolio/${p.slug}/" class="text-sm font-medium px-3.5 py-1.5 rounded-full bg-white border border-slate-200 text-slate-700 hover:border-brand-300 hover:text-brand-700 transition-colors">${p.name}</a>`)}
      </div>
    </div>
  </section>

  <section class="band-tint py-16">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 grid md:grid-cols-2 gap-6 lg:gap-8">
      ${PORTFOLIO.map(card)}
    </div>
  </section>

  <section class="band py-16">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-8 text-center">How every one of these was delivered</h2>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
        ${[
          ["users", "Built with the people who use it", "Real documents, calls and workflows from the client drive every iteration."],
          ["shield-check", "Rules where it matters", "AI does the reading and drafting; deterministic code makes the decisions that must be right."],
          ["file-check-2", "Tested, then shipped", "Edge cases become permanent tests, and every change is verified before it reaches production."],
          ["server", "Yours to run", "Deployed on your cloud or ours, with audit trails, access control and backups from day one."],
        ].map(([icon, title, text]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-6">
            <i data-lucide="${icon}" class="w-6 h-6 text-brand-600 mb-3"></i>
            <h3 class="font-semibold text-slate-900 mb-1.5">${title}</h3>
            <p class="text-sm text-slate-600 leading-relaxed">${text}</p>
          </div>`)}
      </div>
    </div>
  </section>

  ${cta("Your project could be next.", "Tell us about the process that is costing your team the most time. We will show you how we would scope it, build it and get it into production.")}
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
