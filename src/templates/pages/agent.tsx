import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import { ModelStrip } from "../components/model-strip.tsx";
import { LifecycleRail } from "../components/lifecycle.tsx";
import { PreviewMock } from "../components/preview-mock.tsx";

/**
 * /agent/ — the platform page.
 *
 * The homepage says what LFG does for a team; this page shows the machinery
 * that makes those claims true: the agent sessions it orchestrates, the
 * sandboxes they run in, the in-app preview, the QA agent, and how it plugs
 * into a company's models, subscriptions and tools. Every capability named
 * here exists in the product today.
 */

const PREVIEW_STEPS: Array<[string, string]> = [
  ["Detect", "Reads the codebase and works out how the app runs"],
  ["Provision", "Starts the services it needs: Postgres, MySQL, SQL Server, Redis"],
  ["Install", "Installs dependencies inside the sandbox"],
  ["Seed", "Applies migrations and seed data, and remembers verified test logins"],
  ["Start", "Boots the app and opens it in a browser inside LFG"],
];

const INTEGRATIONS: Array<[icon: string, title: string, body: string]> = [
  ["git-branch", "GitHub and GitLab", "Reads your repositories, works on branches and opens pull requests under your protection rules."],
  ["kanban", "Jira and Linear", "Link a project to your tracker and keep tickets and their status in sync."],
  ["blocks", "MCP servers", "Give the agent the same internal tools and data sources your engineers use."],
  ["plug", "App connectors", "Connect the docs, chat and business systems that hold the context behind a request."],
];

export const AgentPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "The LFG Platform | Agent orchestration, in-app preview and QA",
  description: "How LFG works under the hood: Claude Code, Codex and Pi sessions in parallel sandboxes, an in-app preview of every change, a QA agent that proves its tests, and any model on your existing subscriptions.",
  path: "/agent/",
  image: "/public/images/screenshots/agent-ticket-execution.png",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "agent" })}

<main>

  <!-- HERO -->
  <section class="relative pt-28 sm:pt-36 pb-16 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-10 xl:gap-14 items-center">
        <div class="lg:col-span-6">
          <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
            <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
            <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">The platform</span>
          </div>
          <h1 class="font-display font-semibold text-4xl sm:text-5xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up">
            One agent that runs the
            <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">whole lifecycle.</span>
          </h1>
          <p class="text-lg text-slate-600 mt-6 leading-relaxed animate-fade-up">
            LFG is the factory around the coding agents. It plans the work, orchestrates Claude Code, Codex and Pi sessions in parallel sandboxes, runs every change in an in-app preview, and checks it against what was asked for, on the models and tools your team already uses.
          </p>
          <div class="mt-8 flex flex-col sm:flex-row gap-3 animate-fade-up">
            <a href="/auth/register" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
              Try LFG free <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
            <a href="/how-it-works/" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
              The seven stages
            </a>
          </div>
        </div>
        <div class="min-w-0 lg:col-span-6 animate-fade-up" style="animation-delay:.12s">
          ${PreviewMock()}
        </div>
      </div>
      <div class="mt-14 animate-fade-up">${LifecycleRail()}</div>
    </div>
  </section>

  <!-- ORCHESTRATION -->
  <section id="orchestration" class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Orchestration</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-5">Coding agents, run at scale.</h2>
          <p class="text-slate-600 text-lg leading-relaxed mb-6">
            A single agent session is limited by one context window and one person watching it. LFG runs many sessions, each with only the context its ticket needs, and coordinates them through the plan.
          </p>
          <ul class="space-y-3">
            ${[
              "Each ticket gets its own sandbox and its own branch. Nothing runs loose on your machines.",
              "Independent tickets run in parallel; dependent ones wait for what they need.",
              "Context from finished tickets travels forward to the ones that build on them.",
              "Live logs and diffs for every session. Continue, steer or restart at any point.",
              "Fresh sandbox per ticket, or lanes inside a shared always-on preview of the project.",
            ].map((d) => html`<li class="flex gap-3 text-slate-600"><i data-lucide="check" class="w-4 h-4 text-brand-600 mt-1 shrink-0"></i><span class="leading-relaxed">${d}</span></li>`)}
          </ul>
        </div>
        <div class="shot">
          <div class="shot-bar">
            <span class="shot-dot bg-red-400/70"></span><span class="shot-dot bg-amber-400/70"></span><span class="shot-dot bg-emerald-400/70"></span>
            <span class="ml-2 text-xs font-mono text-slate-400">ticket execution</span>
          </div>
          <img src="/public/images/screenshots/agent-ticket-execution.png" alt="A ticket executing in LFG: live logs, diff and review state" loading="lazy" class="w-full block" />
        </div>
      </div>
    </div>
  </section>

  <!-- PREVIEW -->
  <section id="preview" class="band-tint py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">In-app preview</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Every change, running inside LFG.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          No pulling branches, no local setup, no "works on my machine". LFG stands the app up in its sandbox and opens it in a browser right next to the ticket, with its logs, its databases and its setup steps a click away.
        </p>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
        ${PREVIEW_STEPS.map(([name, body], i) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-5">
            <p class="text-xs font-semibold text-slate-400 tabular-nums mb-2">${i + 1}</p>
            <p class="font-display font-bold text-slate-900 mb-1.5">${name}</p>
            <p class="text-sm text-slate-600 leading-relaxed">${body}</p>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- QA -->
  <section id="qa" class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Verification</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">A QA agent that doesn't take the code's word for it.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          A model that has read the diff will write tests that check what the code does, not what the ticket asked for. Those pass every time and tell you nothing. LFG checks them mechanically.
        </p>
      </div>
      <div class="grid md:grid-cols-3 gap-6">
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-red-50 text-red-600 flex items-center justify-center mb-5"><i data-lucide="circle-x" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg mb-2">Red: before the change</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Each new test runs against the code as it was before the ticket. It should fail, because the feature is not there yet.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center mb-5"><i data-lucide="circle-check" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg mb-2">Green: after the change</h3>
          <p class="text-sm text-slate-600 leading-relaxed">The same test runs against the new code. It should pass. Only tests that flip are kept, committed to the ticket's branch.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-5"><i data-lucide="video" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg mb-2">Recorded evidence</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Frontend tickets get a walkthrough recorded in a real browser; API tickets get the calls and responses. Both sit on the ticket's Preview tab.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- MODELS -->
  <section id="models" class="band-tint py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center max-w-2xl mx-auto mb-10">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Model-agnostic</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Any model, on the plans you already pay for.</h2>
        <p class="text-slate-600 text-lg mt-4">
          Sign in with your team's Claude or ChatGPT subscription, or use API keys. Switch per project, task, cost or client policy. Admins decide which models and subscriptions each team may use.
        </p>
      </div>
      ${ModelStrip()}
      <div class="mt-10 grid sm:grid-cols-3 gap-4 text-center">
        ${[["Claude Code", "Anthropic models, on a Claude plan or API key"],
           ["Codex", "OpenAI models, on a ChatGPT plan or API key"],
           ["Pi", "Gemini, DeepSeek, Kimi, GLM and other providers"]].map(([n, b]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-5">
            <p class="font-display font-bold text-slate-900">${n}</p>
            <p class="text-sm text-slate-600 mt-1">${b}</p>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- INTEGRATIONS -->
  <section id="integrations" class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Your tooling</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Works with what your company already runs.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          The factory fits into your existing workflow rather than replacing it, and we customise the pipeline (templates, definition of done, review rules, stack conventions) to how your business delivers.
        </p>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
        ${INTEGRATIONS.map(([icon, title, body]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-7">
            <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-base mb-2">${title}</h3>
            <p class="text-sm text-slate-600 leading-relaxed">${body}</p>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- DEPLOY -->
  <section class="bg-slate-900 py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid md:grid-cols-2 gap-10 items-center">
        <div>
          <p class="text-xs font-bold text-brand-400 uppercase tracking-wider mb-3">Run it your way</p>
          <h2 class="font-display font-bold text-3xl text-white leading-tight mb-4">Hosted, self-hosted, or set up for you.</h2>
          <p class="text-slate-300 leading-relaxed">
            Use LFG in the cloud, run the open-source core on your own infrastructure, or have us install, configure and customise a factory for your team. We can also run it for you and own the outcome.
          </p>
        </div>
        <div class="flex flex-col gap-3">
          <a href="/auth/register" class="px-6 py-3.5 rounded-xl bg-white text-slate-900 font-semibold hover:bg-slate-100 transition-colors inline-flex items-center justify-between gap-2">Start free in the cloud <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
          <a href="/self-host/" class="px-6 py-3.5 rounded-xl border border-white/20 text-white font-semibold hover:border-white/40 transition-colors inline-flex items-center justify-between gap-2">Self-host and managed setup <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
          <a href="/services/" class="px-6 py-3.5 rounded-xl border border-white/20 text-white font-semibold hover:border-white/40 transition-colors inline-flex items-center justify-between gap-2">Have us deliver it <i data-lucide="arrow-right" class="w-4 h-4"></i></a>
        </div>
      </div>
    </div>
  </section>

</main>

${SiteFooter()}

</body>
</html>
`;
