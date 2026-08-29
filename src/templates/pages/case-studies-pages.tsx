import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import { CASE_STUDIES, hasMetrics, type CaseStudy } from "../../data/case-studies.ts";

/**
 * /case-studies/ and /case-studies/:slug/.
 *
 * The brief is right that proof has to be disproportionately strong here,
 * because the proposition sounds unbelievable. The structure it asks for —
 * challenge, scope, execution, human involvement, outcome, numbers — is all
 * present. The numbers are the one part we will not invent: unmeasured metrics
 * render as an em dash with a visible note, which is more persuasive than a
 * confident figure that turns out to be made up.
 */

const metricGrid = (c: CaseStudy) => html`
  <dl class="grid grid-cols-2 sm:grid-cols-3 gap-px bg-slate-200 rounded-2xl overflow-hidden border border-slate-200">
    ${c.metrics.map((m) => html`
      <div class="bg-white p-5">
        <dd class="font-display font-bold text-2xl text-slate-900">${m.value ?? html`<span class="text-slate-300">&mdash;</span>`}</dd>
        <dt class="text-xs text-slate-500 mt-1 leading-snug">${m.label}</dt>
      </div>`)}
  </dl>
  ${hasMetrics(c) ? "" : html`
  <p class="text-xs text-slate-500 mt-4">
    These figures are published only once they are measured from the project record. We would rather show an em dash than an estimate.
  </p>`}`;

export const CaseStudiesIndexPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "Case Studies | Software Built With the LFG Factory",
  description: "Production software built end to end on the LFG software factory — what was built, how the pipeline executed it, and where engineers were involved.",
  path: "/case-studies/",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "case-studies" })}

<main>
  <section class="relative pt-28 sm:pt-36 pb-14 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
        <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">Case studies</span>
      </div>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up max-w-3xl">
        Software built with
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">the factory.</span>
      </h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">
        We are the factory's first customer. These are production products taken from a requirement to a running system through the same pipeline we sell — including the parts where a person had to decide something.
      </p>
    </div>
  </section>

  <section class="band-tint py-16">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
      ${CASE_STUDIES.map((c) => html`
        <a href="/case-studies/${c.slug}/" class="group block rounded-2xl border border-slate-200 bg-white overflow-hidden hover:border-brand-300 transition-colors">
          <div class="grid md:grid-cols-2">
            <img src="${c.image}" alt="${c.name}" loading="lazy" class="w-full h-full max-h-72 object-cover object-top border-b md:border-b-0 md:border-r border-slate-100" />
            <div class="p-7 sm:p-9 flex flex-col">
              <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">${c.tagline}</p>
              <h2 class="font-display font-bold text-2xl text-slate-900 group-hover:text-brand-700 transition-colors mb-3">${c.name}</h2>
              <p class="text-slate-600 leading-relaxed mb-5">${c.summary}</p>
              <div class="flex flex-wrap gap-1.5 mb-6">
                ${c.stack.map((s) => html`<span class="text-xs font-medium px-2.5 py-1 rounded-md bg-slate-100 text-slate-600">${s}</span>`)}
              </div>
              <span class="mt-auto inline-flex items-center gap-2 font-semibold text-brand-700 group-hover:gap-3 transition-all">View case study <i data-lucide="arrow-right" class="w-4 h-4"></i></span>
            </div>
          </div>
        </a>`)}
    </div>
  </section>

  <section class="band py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-4">The most useful case study is your own.</h2>
      <p class="text-slate-600 text-lg leading-relaxed mb-8">
        Send us a real project or backlog item and we will show you how the factory would scope, plan and execute it.
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

export const CaseStudyPage = ({ study }: { study: CaseStudy }) => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: `${study.name} — ${study.tagline} | LFG Case Study`,
  description: study.summary,
  path: `/case-studies/${study.slug}/`,
  image: study.image,
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "case-studies" })}

<main>
  <section class="relative pt-28 sm:pt-36 pb-14 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <a href="/case-studies/" class="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-brand-600 transition-colors mb-6">
        <i data-lucide="arrow-left" class="w-3.5 h-3.5"></i> All case studies
      </a>
      <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-3">${study.tagline}</p>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up">${study.name}</h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">${study.summary}</p>
      <div class="flex flex-wrap gap-1.5 mt-6">
        ${study.stack.map((s) => html`<span class="text-xs font-medium px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-600">${s}</span>`)}
      </div>
      ${study.url ? html`
        <a href="${study.url}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 mt-6 font-semibold text-brand-700 hover:gap-3 transition-all">
          Visit the live product <i data-lucide="arrow-up-right" class="w-4 h-4"></i>
        </a>` : ""}
    </div>
  </section>

  <section class="band py-12">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="shot">
        <div class="shot-bar">
          <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
          <span class="ml-2 text-xs font-mono text-slate-400">${study.name.toLowerCase()}</span>
        </div>
        <img src="${study.image}" alt="${study.name}" class="w-full block" />
      </div>
    </div>
  </section>

  <section class="band py-16">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
      <div>
        <h2 class="font-display font-bold text-2xl text-slate-900 mb-3">The challenge</h2>
        <p class="text-slate-600 text-lg leading-relaxed">${study.challenge}</p>
      </div>
      <div>
        <h2 class="font-display font-bold text-2xl text-slate-900 mb-3">Scope</h2>
        <p class="text-slate-600 text-lg leading-relaxed">${study.scope}</p>
      </div>
      <div>
        <h2 class="font-display font-bold text-2xl text-slate-900 mb-4">What the factory did</h2>
        <ul class="space-y-3">
          ${study.execution.map((e) => html`
            <li class="flex gap-3 text-slate-600"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-1.5 shrink-0"></i><span class="text-lg leading-relaxed">${e}</span></li>`)}
        </ul>
      </div>
      <div>
        <h2 class="font-display font-bold text-2xl text-slate-900 mb-4">Where the engineers were involved</h2>
        <ul class="space-y-3">
          ${study.human.map((h) => html`
            <li class="flex gap-3 text-slate-600"><i data-lucide="user-check" class="w-4 h-4 text-brand-600 mt-1.5 shrink-0"></i><span class="text-lg leading-relaxed">${h}</span></li>`)}
        </ul>
      </div>
      <div>
        <h2 class="font-display font-bold text-2xl text-slate-900 mb-3">Outcome</h2>
        <p class="text-slate-600 text-lg leading-relaxed">${study.outcome}</p>
      </div>
      <div>
        <h2 class="font-display font-bold text-2xl text-slate-900 mb-4">The numbers</h2>
        ${metricGrid(study)}
      </div>
    </div>
  </section>

  <section class="band-tint py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <h2 class="font-display font-bold text-3xl text-slate-900 mb-4">Run your own project through it.</h2>
      <p class="text-slate-600 text-lg leading-relaxed mb-8">Send a real piece of work and see how the factory would scope, plan and execute it.</p>
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
