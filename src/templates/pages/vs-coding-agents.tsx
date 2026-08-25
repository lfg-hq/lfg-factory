import { html } from "hono/html";
import { Nav, Footer } from "../components/nav.tsx";
import { ModelStrip } from "../components/model-strip.tsx";

/**
 * Positioning page — answers one question, above the fold:
 * "Why do I need LFG if my team already uses Claude Code or Codex?"
 *
 * Deliberately not anti-Claude / anti-Codex: the argument is category, not
 * quality. Coding agents are the workers; LFG is the layer that plans,
 * assigns, verifies, and delivers. Shares the fx-* design layer with the
 * homepage and posts to the same /api/factory/pilot endpoint.
 */
export const VsCodingAgentsPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LFG vs. Claude Code and Codex — coding agents write code, LFG runs the factory</title>
  <meta name="description" content="Claude Code and Codex are excellent coding agents. LFG is the layer above them: planning, orchestration, context, independent verification, and delivery.">
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
  <link rel="canonical" href="https://lfg.run/vs-coding-agents/">
  <meta property="og:title" content="Coding agents write code. LFG runs the software factory.">
  <meta property="og:description" content="Claude Code and Codex are excellent coding agents. LFG is the layer above them: planning, orchestration, context, independent verification, and delivery.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://lfg.run/vs-coding-agents/">
  <meta property="og:image" content="https://lfg.run/public/images/screenshots/agent-ticket-board.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Coding agents write code. LFG runs the software factory.">
  <meta name="twitter:description" content="Claude Code and Codex are excellent coding agents. LFG is the layer above them: planning, orchestration, context, independent verification, and delivery.">
  <meta name="twitter:image" content="https://lfg.run/public/images/screenshots/agent-ticket-board.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Manrope', 'sans-serif'],
            display: ['Sora', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          },
          colors: {
            brand: { 50:'#eef2ff',100:'#e0e7ff',200:'#c7d2fe',300:'#a5b4fc',400:'#818cf8',500:'#6366f1',600:'#4f46e5',700:'#4338ca',800:'#3730a3',900:'#312e81' },
          },
          animation: { 'fade-up':'fadeUp 0.6s ease-out both', 'pulse-soft':'pulseSoft 2.4s ease-in-out infinite' },
          keyframes: {
            fadeUp:{'0%':{opacity:'0',transform:'translateY(16px)'},'100%':{opacity:'1',transform:'translateY(0)'}},
            pulseSoft:{'0%,100%':{opacity:'1'},'50%':{opacity:'.4'}},
          }
        }
      }
    }
  </script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    /* ===== Factory design layer (shared with the homepage) ===== */
    :root { --fx-accent:#6366f1; }
    body { background:#ffffff; overflow-x:hidden; }

    .fx-base   { background:#ffffff; }
    .fx-raised { background:#f7f8fb; }
    html.dark body .fx-base   { background:#0a0d12 !important; }
    html.dark body .fx-raised { background:#0e131b !important; }

    .fx-section { border-bottom:1px solid #eef1f5; }
    html.dark body .fx-section { border-bottom-color:rgba(255,255,255,0.06) !important; }

    .fx-hero { position:relative; }
    .fx-hero::before {
      content:''; position:absolute; inset:0; z-index:0; pointer-events:none;
      background-image:linear-gradient(rgba(15,23,42,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,0.05) 1px,transparent 1px);
      background-size:46px 46px;
      -webkit-mask-image:radial-gradient(ellipse 75% 70% at 25% 0%, #000 0%, transparent 72%);
      mask-image:radial-gradient(ellipse 75% 70% at 25% 0%, #000 0%, transparent 72%);
    }
    .fx-hero::after {
      content:''; position:absolute; inset:0; z-index:0; pointer-events:none;
      background:radial-gradient(620px 340px at 22% -8%, rgba(99,102,241,0.16), transparent 70%);
    }
    html.dark body .fx-hero::before {
      background-image:linear-gradient(rgba(255,255,255,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.05) 1px,transparent 1px) !important;
    }
    html.dark body .fx-hero::after {
      background:radial-gradient(640px 360px at 22% -10%, rgba(99,102,241,0.28), transparent 70%) !important;
    }

    .fx-card {
      position:relative; background:#ffffff; border:1px solid #e7ebf1; border-radius:14px;
      transition:transform .2s ease, border-color .2s ease, box-shadow .2s ease;
    }
    .fx-card::before {
      content:''; position:absolute; top:0; left:18px; right:18px; height:2px; border-radius:2px;
      background:linear-gradient(90deg,transparent,var(--fx-accent),transparent);
      opacity:0; transition:opacity .2s ease;
    }
    .fx-card:hover { transform:translateY(-3px); border-color:#c7d2fe; box-shadow:0 16px 40px -18px rgba(79,70,229,0.32); }
    .fx-card:hover::before { opacity:.85; }
    html.dark body .fx-card { background:#10151d !important; border-color:rgba(255,255,255,0.07) !important; }
    html.dark body .fx-card:hover { border-color:rgba(129,140,248,0.55) !important; box-shadow:0 18px 48px -18px rgba(99,102,241,0.5) !important; }

    /* Static card: no hover lift, used inside the flow diagram and the table */
    .fx-flat { position:relative; background:#ffffff; border:1px solid #e7ebf1; border-radius:14px; }
    html.dark body .fx-flat { background:#10151d !important; border-color:rgba(255,255,255,0.07) !important; }

    .fx-tile { background:#eef2ff; color:#4338ca; }
    html.dark body .fx-tile { background:rgba(99,102,241,0.14) !important; color:#a5b4fc !important; }

    .fx-btn-primary { background:var(--fx-accent); color:#fff; box-shadow:0 10px 30px -10px rgba(99,102,241,0.55); }
    .fx-btn-primary:hover { background:#4338ca; }
    html.dark body .fx-btn-primary { background:#6366f1 !important; box-shadow:0 12px 34px -10px rgba(99,102,241,0.7) !important; }
    html.dark body .fx-btn-primary:hover { background:#4f46e5 !important; }
    .fx-btn-ghost { border:1px solid #cbd5e1; color:#334155; }
    .fx-btn-ghost:hover { border-color:var(--fx-accent); color:var(--fx-accent); }
    html.dark body .fx-btn-ghost { border-color:rgba(255,255,255,0.16) !important; color:#c9d1d9 !important; }
    html.dark body .fx-btn-ghost:hover { border-color:rgba(129,140,248,0.7) !important; color:#a5b4fc !important; }

    .fx-stage { background:#f7f8fb; border:1px solid #eceff4; border-radius:12px; }
    html.dark body .fx-stage { background:rgba(255,255,255,0.03) !important; border-color:rgba(255,255,255,0.07) !important; }

    .fx-note { background:#f7f8fb; border:1px solid #eceff4; border-left:3px solid var(--fx-accent); }
    html.dark body .fx-note { background:rgba(99,102,241,0.06) !important; border-color:rgba(255,255,255,0.07) !important; border-left-color:#6366f1 !important; }

    .fx-form { background:#ffffff; }
    html.dark body .fx-form { background:#0f141d !important; }
    html.dark body .fx-form input, html.dark body .fx-form select, html.dark body .fx-form textarea { background:#0a0d12 !important; }

    /* ===== Page-specific: flow diagram + comparison table ===== */

    /* One node in a vertical flow */
    .fx-node {
      background:#ffffff; border:1px solid #e7ebf1; border-radius:10px;
      padding:10px 14px; text-align:center; width:100%;
    }
    html.dark body .fx-node { background:#141a24 !important; border-color:rgba(255,255,255,0.09) !important; }
    .fx-node-accent { border-color:#c7d2fe; background:#eef2ff; }
    html.dark body .fx-node-accent { background:rgba(99,102,241,0.14) !important; border-color:rgba(129,140,248,0.45) !important; }
    .fx-node-ok { border-color:#a7f3d0; background:#ecfdf5; }
    html.dark body .fx-node-ok { background:rgba(16,185,129,0.10) !important; border-color:rgba(16,185,129,0.4) !important; }
    .fx-node-fail { border-color:#fecdd3; background:#fff1f2; }
    html.dark body .fx-node-fail { background:rgba(244,63,94,0.10) !important; border-color:rgba(244,63,94,0.35) !important; }

    /* Vertical connector between nodes */
    .fx-link { width:1px; height:20px; background:#d8dee7; margin:0 auto; }
    html.dark body .fx-link { background:rgba(255,255,255,0.14) !important; }

    /* Comparison table */
    .fx-table { width:100%; border-collapse:separate; border-spacing:0; min-width:640px; }
    .fx-table th, .fx-table td { text-align:left; padding:14px 18px; vertical-align:top; font-size:0.875rem; }
    .fx-table thead th { font-size:0.75rem; letter-spacing:0.08em; text-transform:uppercase; font-weight:700; }
    .fx-table tbody tr { border-top:1px solid #eef1f5; }
    html.dark body .fx-table tbody tr { border-top-color:rgba(255,255,255,0.06) !important; }
    .fx-table td.fx-col-lfg, .fx-table th.fx-col-lfg { background:#f7f8fb; }
    html.dark body .fx-table td.fx-col-lfg, html.dark body .fx-table th.fx-col-lfg { background:rgba(99,102,241,0.07) !important; }
  </style>
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

  ${ Nav({ activePage: "compare", ctaLabel: "Run a project through LFG", ctaHref: "#pilot-form" }) }

  <main>

    <!-- ==================== 1. HERO ==================== -->
    <section class="fx-hero fx-base fx-section pt-28 sm:pt-36 pb-16 overflow-hidden">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div class="max-w-3xl animate-fade-up">
          <p class="text-xs font-bold text-brand-500 uppercase tracking-[0.18em] mb-4">LFG and coding agents</p>
          <h1 class="font-display font-bold text-4xl sm:text-5xl leading-[1.08] tracking-tight text-slate-900 mb-6">
            Coding agents write code.<br>LFG runs the software factory.
          </h1>
          <p class="text-lg text-slate-600 leading-relaxed mb-8">
            Claude Code and Codex are excellent coding agents. LFG gives your organization the layer above them: planning, orchestration, context, verification, and delivery.
          </p>
          <div class="flex flex-wrap items-center gap-3">
            <a href="#pilot-form" class="fx-btn-primary inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-colors">
              Run a project through LFG <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
            <a href="#how" class="fx-btn-ghost inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-colors">
              See how it works
            </a>
          </div>
        </div>
      </div>
    </section>

    <!-- ==================== 2. THE VISUAL ==================== -->
    <section class="fx-raised fx-section py-16 sm:py-20">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="grid md:grid-cols-2 gap-6 lg:gap-10 items-start">

          <!-- Coding agent path -->
          <div class="fx-flat p-6 sm:p-7">
            <div class="flex items-center gap-2 mb-1">
              <i data-lucide="bot" class="w-4 h-4 text-slate-400"></i>
              <p class="text-xs font-bold text-slate-500 uppercase tracking-[0.12em]">Claude Code / Codex</p>
            </div>
            <p class="text-sm text-slate-500 mb-6">One developer, one task.</p>

            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Ticket</span></div>
            <div class="fx-link"></div>
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Coding agent</span></div>
            <div class="fx-link"></div>
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Pull request</span></div>

            <p class="text-xs text-slate-500 mt-6 leading-relaxed">
              Fast, and genuinely good at what it does. Everything around it &mdash; context, sequencing, review, retries &mdash; stays with the developer.
            </p>
          </div>

          <!-- Factory path -->
          <div class="fx-flat p-6 sm:p-7 ring-1 ring-brand-300">
            <div class="flex items-center gap-2 mb-1">
              <i data-lucide="factory" class="w-4 h-4 text-brand-500"></i>
              <p class="text-xs font-bold text-brand-600 uppercase tracking-[0.12em]">LFG</p>
            </div>
            <p class="text-sm text-slate-500 mb-6">A delivery team, a whole project.</p>

            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Project / requirement</span></div>
            <div class="fx-link"></div>
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Understand context</span></div>
            <div class="fx-link"></div>
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Plan and decompose</span></div>
            <div class="fx-link"></div>
            <div class="fx-node fx-node-accent">
              <div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-sm font-semibold text-brand-700">
                <span>Claude</span><span class="text-brand-300">&middot;</span>
                <span>Codex</span><span class="text-brand-300">&middot;</span>
                <span>Gemini</span><span class="text-brand-300">&middot;</span>
                <span>Open models</span>
              </div>
              <p class="text-[11px] text-brand-600 mt-1">Executing in parallel, in sandboxes</p>
            </div>
            <div class="fx-link"></div>
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Review, test, verify</span></div>
            <div class="fx-link"></div>
            <div class="fx-node fx-node-fail"><span class="text-sm font-semibold text-rose-700">Failures loop back for a fix</span></div>
            <div class="fx-link"></div>
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Human approval</span></div>
            <div class="fx-link"></div>
            <div class="fx-node fx-node-ok"><span class="text-sm font-semibold text-emerald-700">Verified deliverable</span></div>
          </div>

        </div>
        <p class="text-center text-sm text-slate-500 mt-8">
          Same models. Different unit of work: a task versus a delivery.
        </p>
      </div>
    </section>

    <!-- ==================== 3. COMPARISON TABLE ==================== -->
    <section id="compare" class="fx-base fx-section py-20">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="max-w-2xl mb-10">
          <p class="text-xs font-bold text-brand-500 uppercase tracking-[0.18em] mb-3">Side by side</p>
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-4">Different jobs, not competing tools</h2>
          <p class="text-slate-600 text-lg leading-relaxed">
            A coding agent is scoped to a developer and a task. LFG is scoped to a delivery organization and a portfolio of work.
          </p>
        </div>

        <div class="fx-flat overflow-x-auto">
          <table class="fx-table">
            <thead>
              <tr>
                <th class="text-slate-500"></th>
                <th class="text-slate-500">Claude Code / Codex</th>
                <th class="fx-col-lfg text-brand-600">LFG</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="font-semibold text-slate-900">Designed for</td>
                <td class="text-slate-600">Individual developer, one task</td>
                <td class="fx-col-lfg text-slate-800 font-medium">Delivery team, whole organization</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">Input</td>
                <td class="text-slate-600">A prompt, an issue, a ticket</td>
                <td class="fx-col-lfg text-slate-800 font-medium">A requirement, a project, a backlog</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">Execution</td>
                <td class="text-slate-600">One coding agent at a time</td>
                <td class="fx-col-lfg text-slate-800 font-medium">Multiple specialized agents and workflows</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">Planning</td>
                <td class="text-slate-600">Agent-level planning within a session</td>
                <td class="fx-col-lfg text-slate-800 font-medium">Project-level planning and decomposition</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">Context</td>
                <td class="text-slate-600">Repository and session context</td>
                <td class="fx-col-lfg text-slate-800 font-medium">Project, architecture, and organizational context</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">Quality control</td>
                <td class="text-slate-600">The agent, its tests, and a human</td>
                <td class="fx-col-lfg text-slate-800 font-medium">Independent review, testing, and verification</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">Failures</td>
                <td class="text-slate-600">A developer notices and intervenes</td>
                <td class="fx-col-lfg text-slate-800 font-medium">The factory retries, reassigns, or escalates</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">Models</td>
                <td class="text-slate-600">The vendor's own model</td>
                <td class="fx-col-lfg text-slate-800 font-medium">Claude, Codex, Gemini, open models &mdash; per task</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">Output</td>
                <td class="text-slate-600">Code, a pull request</td>
                <td class="fx-col-lfg text-slate-800 font-medium">A verified deliverable</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">What you manage</td>
                <td class="text-slate-600">Agent sessions</td>
                <td class="fx-col-lfg text-slate-800 font-medium">Software delivery</td>
              </tr>
              <tr>
                <td class="font-semibold text-slate-900">What you measure</td>
                <td class="text-slate-600">Tasks and usage</td>
                <td class="fx-col-lfg text-slate-800 font-medium">Cost, throughput, quality, rework, delivery</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ==================== 4. THE PROVOCATION ==================== -->
    <section class="fx-raised fx-section py-20">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="grid lg:grid-cols-2 gap-12 items-start">
          <div>
            <h2 class="font-display font-bold text-3xl text-slate-900 mb-5">Your developers should not have to manage twenty agents</h2>
            <p class="text-slate-600 text-lg leading-relaxed mb-4">
              Developers increasingly spend their day starting agents, feeding them context, checking their output, retrying what failed, reviewing pull requests, and coordinating what depends on what.
            </p>
            <p class="text-slate-600 text-lg leading-relaxed mb-4">
              That is better than writing every line by hand. But it still makes the developer the orchestration layer.
            </p>
            <p class="text-slate-900 text-lg leading-relaxed font-semibold">
              LFG moves orchestration into the factory.
            </p>
          </div>
          <div class="fx-flat p-6 sm:p-7">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-[0.12em] mb-5">Where the day actually goes</p>
            <ul class="space-y-3 text-sm text-slate-600">
              <li class="flex gap-3"><i data-lucide="play" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span>Starting agents</span></li>
              <li class="flex gap-3"><i data-lucide="clipboard-list" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span>Giving them context</span></li>
              <li class="flex gap-3"><i data-lucide="search-check" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span>Checking their output</span></li>
              <li class="flex gap-3"><i data-lucide="rotate-ccw" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span>Retrying failed tasks</span></li>
              <li class="flex gap-3"><i data-lucide="git-pull-request" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span>Reviewing pull requests</span></li>
              <li class="flex gap-3"><i data-lucide="network" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span>Coordinating dependencies</span></li>
            </ul>
            <div class="fx-note rounded-lg p-4 mt-6">
              <p class="text-sm text-slate-700 leading-relaxed">
                Every one of these is coordination work. None of it is the engineering judgment you hired them for.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ==================== 5. HOW THE FACTORY WORKS ==================== -->
    <section id="how" class="fx-base fx-section py-20">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="max-w-2xl mb-12">
          <p class="text-xs font-bold text-brand-500 uppercase tracking-[0.18em] mb-3">The orchestration layer</p>
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-4">From requirement to verified software</h2>
          <p class="text-slate-600 text-lg leading-relaxed">
            Six stages. Coding agents do their best work inside stage four; the other five are the part nobody has been running for you.
          </p>
        </div>

        <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div class="fx-card p-7">
            <div class="flex items-center gap-3 mb-4">
              <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center"><i data-lucide="scan-search" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">01 Understand</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">LFG reads the requirement, the repository, the architecture, and the project context that already exists around them.</p>
          </div>
          <div class="fx-card p-7">
            <div class="flex items-center gap-3 mb-4">
              <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center"><i data-lucide="map" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">02 Plan</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">It settles the implementation strategy, the dependencies, and which systems the change is going to touch.</p>
          </div>
          <div class="fx-card p-7">
            <div class="flex items-center gap-3 mb-4">
              <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center"><i data-lucide="git-branch" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">03 Decompose</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">A large requirement becomes an executable graph of smaller tasks, each with acceptance criteria a reviewer can check.</p>
          </div>
          <div class="fx-card p-7">
            <div class="flex items-center gap-3 mb-4">
              <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center"><i data-lucide="terminal" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">04 Execute</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">Specialized coding agents pick up tasks and work them in isolated sandboxes, concurrently wherever the graph allows.</p>
          </div>
          <div class="fx-card p-7">
            <div class="flex items-center gap-3 mb-4">
              <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center"><i data-lucide="shield-check" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">05 Verify</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">Separate agents and deterministic tooling review the code, run the tests, and validate the behavior actually changed.</p>
          </div>
          <div class="fx-card p-7 ring-1 ring-brand-300">
            <div class="flex items-center gap-3 mb-4">
              <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center"><i data-lucide="check-check" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">06 Deliver</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">Your engineers review one complete, verified change instead of supervising every agent step that produced it.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ==================== 6. THE HEADLINE IDEA ==================== -->
    <section class="fx-raised fx-section py-20">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 class="font-display font-bold text-3xl sm:text-4xl leading-tight text-slate-900 mb-5">
          Move your engineers from supervising AI to reviewing outcomes.
        </h2>
        <p class="text-slate-600 text-lg leading-relaxed">
          Supervision scales with the number of agents. Review scales with the number of deliverables. Only one of those gets cheaper as the models get better.
        </p>
      </div>
    </section>

    <!-- ==================== 7. BRING YOUR OWN AGENTS ==================== -->
    <section class="fx-base fx-section py-20">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="max-w-2xl mb-10">
          <p class="text-xs font-bold text-brand-500 uppercase tracking-[0.18em] mb-3">Model-neutral by design</p>
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-4">Bring the best coding agents</h2>
          <p class="text-slate-600 text-lg leading-relaxed">
            LFG is not another model-locked coding agent. Use the right execution engine for each piece of work.
          </p>
        </div>

        <div class="grid sm:grid-cols-2 gap-5 mb-10">
          <div class="fx-flat p-6">
            <p class="text-sm font-semibold text-slate-900 mb-1">Claude</p>
            <p class="text-sm text-slate-600 leading-relaxed">For the work that needs complex reasoning across an unfamiliar codebase.</p>
          </div>
          <div class="fx-flat p-6">
            <p class="text-sm font-semibold text-slate-900 mb-1">Codex</p>
            <p class="text-sm text-slate-600 leading-relaxed">For implementation against a plan that is already clear.</p>
          </div>
          <div class="fx-flat p-6">
            <p class="text-sm font-semibold text-slate-900 mb-1">Gemini</p>
            <p class="text-sm text-slate-600 leading-relaxed">Wherever it wins on the task, the context window, or the price.</p>
          </div>
          <div class="fx-flat p-6">
            <p class="text-sm font-semibold text-slate-900 mb-1">Open models</p>
            <p class="text-sm text-slate-600 leading-relaxed">When unit economics or data control decide it for you. Self-hosted, your keys, your infrastructure.</p>
          </div>
        </div>

        ${ ModelStrip() }

        <div class="fx-note rounded-xl p-6 mt-10 max-w-2xl">
          <p class="text-lg font-semibold text-slate-900 leading-relaxed">
            When coding models improve, your factory improves.
          </p>
          <p class="text-sm text-slate-600 leading-relaxed mt-2">
            LFG is not a bet against the model vendors. It is a bet that capable workers keep arriving and someone has to organize them.
          </p>
        </div>
      </div>
    </section>

    <!-- ==================== 8. THE QUALITY LAYER ==================== -->
    <section class="fx-raised fx-section py-20">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p class="text-xs font-bold text-brand-500 uppercase tracking-[0.18em] mb-3">Verification</p>
            <h2 class="font-display font-bold text-3xl text-slate-900 mb-5">
              The agent that writes the code should not be the only agent checking it
            </h2>
            <p class="text-slate-600 text-lg leading-relaxed mb-4">
              Coding agents are probabilistic. LFG treats their output as work that has to be independently verified, not as truth.
            </p>
            <p class="text-slate-600 text-lg leading-relaxed">
              Every change runs the same gauntlet before a human ever looks at it. Anything that fails goes back for a fix and runs it again.
            </p>
          </div>

          <div class="fx-flat p-6 sm:p-8">
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Implementer</span></div>
            <div class="fx-link"></div>
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Independent code reviewer</span></div>
            <div class="fx-link"></div>
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Tests, browser checks, CI</span></div>
            <div class="fx-link"></div>
            <div class="fx-node"><span class="text-sm font-semibold text-slate-700">Architecture and security checks</span></div>
            <div class="fx-link"></div>
            <div class="grid grid-cols-1 gap-2.5">
              <div class="fx-node fx-node-fail">
                <span class="text-sm font-semibold text-rose-700">Failed &rarr; back to implementation</span>
              </div>
              <div class="fx-node fx-node-ok">
                <span class="text-sm font-semibold text-emerald-700">Passed &rarr; human reviewer</span>
              </div>
            </div>
            <p class="text-xs text-slate-500 mt-5 text-center">Your engineers are the last gate, not the first one.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ==================== 9. THE ORGANIZATION LAYER ==================== -->
    <section class="fx-base fx-section py-20">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="max-w-2xl mb-10">
          <p class="text-xs font-bold text-brand-500 uppercase tracking-[0.18em] mb-3">Organizational context</p>
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-4">Build the way your company builds</h2>
          <p class="text-slate-600 text-lg leading-relaxed">
            A coding agent starts every session roughly where the last one ended: with a repository and a prompt. A factory accumulates.
          </p>
        </div>

        <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-10">
          <div class="fx-stage px-4 py-3 flex items-center gap-2.5"><i data-lucide="folder-git-2" class="w-4 h-4 text-slate-400 shrink-0"></i><span class="text-sm font-medium text-slate-700">Your repositories</span></div>
          <div class="fx-stage px-4 py-3 flex items-center gap-2.5"><i data-lucide="layout-grid" class="w-4 h-4 text-slate-400 shrink-0"></i><span class="text-sm font-medium text-slate-700">Architecture decisions</span></div>
          <div class="fx-stage px-4 py-3 flex items-center gap-2.5"><i data-lucide="code-2" class="w-4 h-4 text-slate-400 shrink-0"></i><span class="text-sm font-medium text-slate-700">Coding standards</span></div>
          <div class="fx-stage px-4 py-3 flex items-center gap-2.5"><i data-lucide="check-square" class="w-4 h-4 text-slate-400 shrink-0"></i><span class="text-sm font-medium text-slate-700">Definition of done</span></div>
          <div class="fx-stage px-4 py-3 flex items-center gap-2.5"><i data-lucide="flask-conical" class="w-4 h-4 text-slate-400 shrink-0"></i><span class="text-sm font-medium text-slate-700">Testing requirements</span></div>
          <div class="fx-stage px-4 py-3 flex items-center gap-2.5"><i data-lucide="gavel" class="w-4 h-4 text-slate-400 shrink-0"></i><span class="text-sm font-medium text-slate-700">Review rules</span></div>
          <div class="fx-stage px-4 py-3 flex items-center gap-2.5"><i data-lucide="cpu" class="w-4 h-4 text-slate-400 shrink-0"></i><span class="text-sm font-medium text-slate-700">Model policies</span></div>
          <div class="fx-stage px-4 py-3 flex items-center gap-2.5"><i data-lucide="lock" class="w-4 h-4 text-slate-400 shrink-0"></i><span class="text-sm font-medium text-slate-700">Security constraints</span></div>
          <div class="fx-stage px-4 py-3 flex items-center gap-2.5"><i data-lucide="history" class="w-4 h-4 text-slate-400 shrink-0"></i><span class="text-sm font-medium text-slate-700">Past failures and corrections</span></div>
        </div>

        <p class="font-display font-bold text-2xl text-slate-900">
          Every project becomes context for the next one.
        </p>
      </div>
    </section>

    <!-- ==================== 10. ECONOMICS / DASHBOARD ==================== -->
    <section class="fx-raised fx-section py-20">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="max-w-2xl mb-10">
          <p class="text-xs font-bold text-brand-500 uppercase tracking-[0.18em] mb-3">For whoever signs the invoice</p>
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-4">Manage delivery, not tokens</h2>
          <p class="text-slate-600 text-lg leading-relaxed">
            The question a CTO or agency owner has to answer is not how much Claude usage the team burned last month. It is what shipped, how good it was, what it cost, and where the factory is failing.
          </p>
        </div>

        <div class="fx-flat overflow-hidden">
          <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-200/70">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-[0.12em]">Delivery dashboard</p>
            <span class="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-md bg-amber-50 text-amber-700 border border-amber-200">
              <i data-lucide="info" class="w-3 h-3"></i> Illustrative figures
            </span>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3 p-5">
            <div class="fx-stage p-5">
              <p class="font-display font-bold text-2xl text-slate-900">36</p>
              <p class="text-xs text-slate-500 mt-1">Projects delivered</p>
            </div>
            <div class="fx-stage p-5">
              <p class="font-display font-bold text-2xl text-slate-900">147</p>
              <p class="text-xs text-slate-500 mt-1">Tickets completed</p>
            </div>
            <div class="fx-stage p-5">
              <p class="font-display font-bold text-2xl text-slate-900">82%</p>
              <p class="text-xs text-slate-500 mt-1">First-review acceptance</p>
            </div>
            <div class="fx-stage p-5">
              <p class="font-display font-bold text-2xl text-slate-900">11%</p>
              <p class="text-xs text-slate-500 mt-1">Rework rate</p>
            </div>
            <div class="fx-stage p-5">
              <p class="font-display font-bold text-2xl text-slate-900">214 hrs</p>
              <p class="text-xs text-slate-500 mt-1">Human review hours avoided</p>
            </div>
            <div class="fx-stage p-5">
              <p class="font-display font-bold text-2xl text-brand-600">Agent cost vs. traditional cost</p>
              <p class="text-xs text-slate-500 mt-1">Per project, side by side</p>
            </div>
          </div>
        </div>

        <div class="fx-note rounded-lg p-5 mt-6">
          <p class="text-sm text-slate-600 leading-relaxed">
            These numbers are a mock-up of the executive view, not a customer result. Your own numbers come out of a pilot &mdash; that is the point of running one.
          </p>
        </div>
      </div>
    </section>

    <!-- ==================== 11. THE OBJECTION ==================== -->
    <section class="fx-base fx-section py-20">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 class="font-display font-bold text-3xl text-slate-900 mb-8">Why can't I just @Claude or @Codex in Slack?</h2>

        <p class="text-slate-900 text-lg leading-relaxed font-semibold mb-4">You can.</p>
        <p class="text-slate-600 text-lg leading-relaxed mb-4">
          If you have an isolated ticket and you want an agent to implement it, that may be all you need. We are not going to pretend otherwise, and LFG is not worth setting up for a one-line fix.
        </p>
        <p class="text-slate-600 text-lg leading-relaxed mb-8">
          LFG earns its place when you are managing many requirements, repositories, agents, dependencies, quality gates, and engineers at the same time &mdash; and the coordination has quietly become the bottleneck.
        </p>

        <div class="fx-note rounded-xl p-6">
          <p class="text-lg font-semibold text-slate-900 leading-relaxed">Claude and Codex execute the work.</p>
          <p class="text-lg font-semibold text-slate-900 leading-relaxed">LFG manages the system that delivers it.</p>
        </div>

        <div class="mt-10 space-y-6">
          <div>
            <p class="font-semibold text-slate-900 mb-1.5">Do I have to give up the agents my team already likes?</p>
            <p class="text-slate-600 leading-relaxed">No. They run inside LFG. The models stay the same; what changes is who is doing the planning, sequencing, and verification around them.</p>
          </div>
          <div>
            <p class="font-semibold text-slate-900 mb-1.5">Does this take engineers out of the loop?</p>
            <p class="text-slate-600 leading-relaxed">The opposite of what people usually mean by that. Every release still passes a human gate. Engineers stop babysitting agent sessions and start reviewing finished, verified changes.</p>
          </div>
          <div>
            <p class="font-semibold text-slate-900 mb-1.5">Where does it run?</p>
            <p class="text-slate-600 leading-relaxed">On your infrastructure, with your keys, if you want it that way. The core is open source. <a href="/self-host/" class="text-brand-600 font-semibold hover:underline">See self-hosting</a>.</p>
          </div>
          <div>
            <p class="font-semibold text-slate-900 mb-1.5">What does it cost to find out?</p>
            <p class="text-slate-600 leading-relaxed">One project and two weeks. You end up with your own acceptance rate, rework rate, and cost per delivery instead of ours.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ==================== 12. CTA / PILOT FORM ==================== -->
    <section id="pilot-form" class="fx-raised py-20">
      <div class="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-8">
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-3">Don't compare the demos. Compare the output.</h2>
          <p class="text-slate-600">
            Give LFG one real project. Connect your GitHub repository and let the factory work through it. Your engineers judge the result.
          </p>
        </div>
        <div class="fx-form fx-card p-6 sm:p-8">
          <form id="pilot-form-el" class="space-y-4">
            <div class="grid sm:grid-cols-2 gap-3">
              <div>
                <label class="text-xs font-semibold text-slate-600 mb-1 block">Name *</label>
                <input name="name" required placeholder="Your name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
              </div>
              <div>
                <label class="text-xs font-semibold text-slate-600 mb-1 block">Work email *</label>
                <input name="email" type="email" required placeholder="you@firm.com" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                <p class="text-[11px] text-slate-400 mt-1">Use your work email so we can route this to your pilot pipeline.</p>
              </div>
            </div>
            <div class="grid sm:grid-cols-2 gap-3">
              <div>
                <label class="text-xs font-semibold text-slate-600 mb-1 block">Company</label>
                <input name="firm" placeholder="Company name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
              </div>
              <div>
                <label class="text-xs font-semibold text-slate-600 mb-1 block">Headcount</label>
                <select name="headcount" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white text-slate-700">
                  <option value="">Select range</option>
                  <option value="10-50">10-50</option>
                  <option value="50-200">50-200</option>
                  <option value="200-1000">200-1000</option>
                  <option value="1000-5000">1000-5000</option>
                  <option value="5000+">5000+</option>
                </select>
              </div>
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Role</label>
              <select name="role" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white text-slate-700">
                <option value="">Select role</option>
                <option value="CTO">CTO</option>
                <option value="VP Engineering">VP Engineering</option>
                <option value="Delivery Lead">Delivery Lead</option>
                <option value="Founder / CEO">Founder / CEO</option>
                <option value="Practice Lead">Practice Lead</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Describe the project you would run through it *</label>
              <textarea name="project" required rows="4" placeholder="One real project, ideally already scoped the traditional way, plus which agents your team uses today." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
            </div>
            <button type="submit" class="fx-btn-primary w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg font-semibold text-sm transition-all">
              <i data-lucide="send" class="w-4 h-4"></i>
              <span class="btn-text">Run a project through LFG</span>
            </button>
            <div id="pilot-success" class="hidden text-center py-2 text-sm font-semibold text-emerald-600">
              <i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i>Got it. We will reply within 24 hours.
            </div>
            <div id="pilot-error" class="hidden text-center py-2 text-sm text-red-500"></div>
          </form>
        </div>
        <p class="text-center text-sm text-slate-500 mt-6">
          Prefer to read first? <a href="/agent/" class="font-semibold text-brand-600 hover:underline">How it works</a> &middot; <a href="/self-host/" class="font-semibold text-brand-600 hover:underline">Self-host</a> &middot; <a href="/proof/" class="font-semibold text-brand-600 hover:underline">Proof</a>
        </p>
      </div>
    </section>

  </main>

  ${ Footer() }

  <script>
    lucide.createIcons();

    var pilotForm = document.getElementById('pilot-form-el');
    pilotForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = pilotForm.querySelector('button[type="submit"]');
      var btnText = pilotForm.querySelector('.btn-text');
      var success = document.getElementById('pilot-success');
      var error = document.getElementById('pilot-error');
      success.classList.add('hidden');
      error.classList.add('hidden');
      btn.disabled = true;
      btnText.textContent = 'Sending...';

      var data = Object.fromEntries(new FormData(pilotForm).entries());

      // Keep the pilot pipeline clean: nudge toward business email
      var FREE = ['gmail.com','googlemail.com','yahoo.com','yahoo.co.in','hotmail.com','outlook.com','live.com','aol.com','icloud.com','me.com','proton.me','protonmail.com','mail.com','gmx.com','yandex.com','rediffmail.com'];
      var domain = String(data.email || '').split('@')[1];
      domain = domain ? domain.toLowerCase().trim() : '';
      if (domain && FREE.indexOf(domain) !== -1) {
        error.textContent = 'Please use your work email address, not a personal one.';
        error.classList.remove('hidden');
        btn.disabled = false;
        btnText.textContent = 'Run a project through LFG';
        return;
      }

      try {
        var res = await fetch('/api/factory/pilot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (res.ok) {
          pilotForm.reset();
          success.classList.remove('hidden');
          lucide.createIcons();
        } else {
          var d = await res.json();
          error.textContent = d.error || 'Something went wrong. Please try again.';
          error.classList.remove('hidden');
        }
      } catch (err) {
        error.textContent = 'Unable to submit. Email us at hello@lfg.run';
        error.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btnText.textContent = 'Run a project through LFG';
      }
    });
  </script>

</body>
</html>
`;
