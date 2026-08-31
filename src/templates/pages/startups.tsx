import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";

/**
 * /startups/ — startups and SMBs.
 *
 * Deliberately not an "MVP in 14 days" page. Competing with cheap MVP shops
 * undersells the factory and attracts the wrong work, so startups sit under
 * the broader software-development umbrella: a real product, a real
 * repository, and a handover when the company grows its own engineers.
 */

const DELIVERS: Array<[string, string]> = [
  ["file-text", "Requirements"],
  ["layout-grid", "Architecture"],
  ["app-window", "A working application"],
  ["key-round", "Authentication"],
  ["credit-card", "Payments"],
  ["plug", "Integrations"],
  ["server", "Infrastructure"],
  ["flask-conical", "Tests"],
  ["book-open", "Documentation"],
];

export const StartupsPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "Software Development for Startups and SMBs | LFG",
  description: "Turn an early concept into a working product with requirements, architecture, tests and infrastructure — without hiring an engineering team first. Your repository, your code, ready to hand over.",
  path: "/startups/",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "startups" })}

<main>

  <!-- HERO -->
  <section class="relative pt-28 sm:pt-36 pb-16 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="absolute top-24 left-[4%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
        <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">For startups and SMBs</span>
      </div>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up max-w-3xl">
        Your product team<br>
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">before you hire one.</span>
      </h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">
        Getting a product built usually means raising money to hire engineers, then spending months managing them before you learn whether anyone wants the thing. LFG takes an early concept to a working application first — and hands you a repository your own engineers can take over when you have them.
      </p>
      <div class="mt-8 flex flex-col sm:flex-row gap-3 animate-fade-up">
        <a href="/#start" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
          Talk to us about a project <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
        <a href="/case-studies/" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
          See what we have shipped
        </a>
      </div>
    </div>
  </section>

  <!-- WHAT YOU GET -->
  <section class="band-tint py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-10">
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">A product, not a prototype.</h2>
        <p class="text-slate-600 text-lg mt-4">
          The problem with most things built fast is what they leave out. No tests, no documentation, no infrastructure, and an architecture nobody can explain — so the first real engineer you hire wants to start again. LFG produces the unglamorous parts too, because those are what make it survivable.
        </p>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${DELIVERS.map(([icon, label]) => html`
          <div class="rounded-xl border border-slate-200 bg-white px-4 py-3.5 flex items-center gap-3">
            <i data-lucide="${icon}" class="w-4 h-4 text-brand-600 shrink-0"></i>
            <span class="text-sm font-semibold text-slate-700">${label}</span>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- THE HANDOVER -->
  <section class="band py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">The exit ramp</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-5">Built to be handed over.</h2>
          <p class="text-slate-600 text-lg leading-relaxed mb-4">
            The point is not that you depend on us forever. When the company grows and you hire your own engineers, they take the repository — with the requirements, the architecture decisions, the tickets, the tests and the documentation that explain how it got that way.
          </p>
          <p class="text-slate-600 text-lg leading-relaxed">
            A codebase nobody can explain is a liability at your next raise. This one comes with its own history.
          </p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-8">
          <p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-4">What transfers with the code</p>
          <ul class="space-y-3.5">
            ${[
              ["git-branch", "The repository", "Yours from the first commit, on your GitHub or GitLab account."],
              ["file-text", "The decisions", "Why the architecture is the way it is, written down at the time."],
              ["list-checks", "The tickets", "Every piece of work, linked to the requirement that caused it."],
              ["flask-conical", "The tests", "So the next engineer can change things without holding their breath."],
            ].map(([icon, t, b]) => html`
              <li class="flex gap-3">
                <i data-lucide="${icon}" class="w-4 h-4 text-brand-600 mt-1 shrink-0"></i>
                <span>
                  <span class="block text-sm font-semibold text-slate-900">${t}</span>
                  <span class="block text-sm text-slate-600 mt-0.5 leading-relaxed">${b}</span>
                </span>
              </li>`)}
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- NOT AN MVP SHOP -->
  <section class="band-tint py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-6">We are not the cheapest way to get an MVP.</h2>
      <p class="text-slate-600 text-lg leading-relaxed mb-4">
        There are agencies that will build you something in a fortnight for very little money, and for some ideas that is genuinely the right call. If all you need is a landing page and a waitlist to test whether anyone cares, do that instead — you do not need us.
      </p>
      <p class="text-slate-600 text-lg leading-relaxed mb-4">
        LFG makes sense when the thing you are building has to actually work: real users, real data, payments that must not break, an integration with a system you do not control, or a product you intend to still be running in two years.
      </p>
      <p class="text-slate-900 text-lg leading-relaxed font-semibold">
        Being clear about that up front saves us both a discovery call.
      </p>
    </div>
  </section>

  <!-- CTA -->
  <section class="band py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-4">Describe the product.</h2>
      <p class="text-slate-600 text-lg leading-relaxed mb-8">
        We will come back with a technical plan and a delivery proposal — what it takes to build, in what order, and what it would cost.
      </p>
      <div class="flex flex-col sm:flex-row gap-3 justify-center">
        <a href="/#start" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
          Talk to us about a project <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
        <a href="/services/" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
          All development services
        </a>
      </div>
    </div>
  </section>

</main>

${SiteFooter()}

</body>
</html>
`;
