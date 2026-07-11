import { html } from "hono/html";
import { Nav, Footer } from "../components/nav.tsx";

export const FactoryPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LFG Factory | Agentic delivery pipeline for IT services firms</title>
  <meta name="description" content="Self-hosted agentic software delivery for IT services firms. AI builds, your engineers verify, your margins survive the AI pricing transition.">
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
  <meta property="og:title" content="LFG Factory | Agentic delivery pipeline for IT services firms">
  <meta property="og:description" content="Self-hosted agentic software delivery for IT services firms. AI builds, your engineers verify, your margins survive the AI pricing transition.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://lfg.run/factory/">
  <meta property="og:image" content="https://lfg.run/public/images/logo_lfg.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="LFG Factory | Agentic delivery pipeline for IT services firms">
  <meta name="twitter:description" content="Self-hosted agentic software delivery for IT services firms. AI builds, your engineers verify, your margins survive.">
  <meta name="twitter:image" content="https://lfg.run/public/images/logo_lfg.png">
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
    /* ===== Factory page design layer (enterprise tone, with depth) ===== */
    :root { --fx-accent:#6366f1; }
    body { background:#ffffff; overflow-x:hidden; }

    /* Surfaces: explicit so dark mode keeps real section rhythm
       (selectors are intentionally specific to beat the global nav dark rules) */
    .fx-base   { background:#ffffff; }
    .fx-raised { background:#f7f8fb; }
    html.dark body .fx-base   { background:#0a0d12 !important; }
    html.dark body .fx-raised { background:#0e131b !important; }

    /* Section hairline divider with a faint brand tint */
    .fx-section { border-bottom:1px solid #eef1f5; }
    html.dark body .fx-section { border-bottom-color:rgba(255,255,255,0.06) !important; }

    /* Hero: grid texture + soft radial glow */
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

    /* Cards with elevation + accent top line + hover lift */
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

    /* Icon tiles */
    .fx-tile { background:#eef2ff; color:#4338ca; }
    html.dark body .fx-tile { background:rgba(99,102,241,0.14) !important; color:#a5b4fc !important; }

    /* Buttons (defined under html.dark too so the global box-shadow reset can't flatten them) */
    .fx-btn-primary { background:var(--fx-accent); color:#fff; box-shadow:0 10px 30px -10px rgba(99,102,241,0.55); }
    .fx-btn-primary:hover { background:#4338ca; }
    html.dark body .fx-btn-primary { background:#6366f1 !important; box-shadow:0 12px 34px -10px rgba(99,102,241,0.7) !important; }
    html.dark body .fx-btn-primary:hover { background:#4f46e5 !important; }
    .fx-btn-ghost { border:1px solid #cbd5e1; color:#334155; }
    .fx-btn-ghost:hover { border-color:var(--fx-accent); color:var(--fx-accent); }
    html.dark body .fx-btn-ghost { border-color:rgba(255,255,255,0.16) !important; color:#c9d1d9 !important; }
    html.dark body .fx-btn-ghost:hover { border-color:rgba(129,140,248,0.7) !important; color:#a5b4fc !important; }

    /* Hero pipeline panel */
    .fx-panel { position:relative; background:#ffffff; border:1px solid #e7ebf1; border-radius:18px; box-shadow:0 30px 60px -30px rgba(15,23,42,0.25); }
    html.dark body .fx-panel { background:#0f141d !important; border-color:rgba(255,255,255,0.08) !important; box-shadow:0 30px 70px -30px rgba(0,0,0,0.8) !important; }
    .fx-stage { background:#f7f8fb; border:1px solid #eceff4; border-radius:12px; }
    html.dark body .fx-stage { background:rgba(255,255,255,0.03) !important; border-color:rgba(255,255,255,0.07) !important; }
    .fx-connector { background:linear-gradient(180deg, var(--fx-accent), transparent); }

    /* Economics small-print panel with accent bar */
    .fx-note { background:#f7f8fb; border:1px solid #eceff4; border-left:3px solid var(--fx-accent); }
    html.dark body .fx-note { background:rgba(99,102,241,0.06) !important; border-color:rgba(255,255,255,0.07) !important; border-left-color:#6366f1 !important; }

    /* Form panel */
    .fx-form { background:#ffffff; }
    html.dark body .fx-form { background:#0f141d !important; }
    html.dark body .fx-form input, html.dark body .fx-form select, html.dark body .fx-form textarea { background:#0a0d12 !important; }
  </style>
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

  ${ Nav({ activePage: "factory", ctaLabel: "Book a pilot", ctaHref: "#pilot-form" }) }

  <main>

    <!-- HERO -->
    <section class="fx-hero fx-base fx-section pt-28 sm:pt-36 pb-20 overflow-hidden">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div class="grid lg:grid-cols-12 gap-12 items-center">

          <!-- Left: pitch -->
          <div class="lg:col-span-7 animate-fade-up">
            <p class="text-xs font-bold text-brand-500 uppercase tracking-[0.18em] mb-4">For IT services firms</p>
            <h1 class="font-display font-bold text-4xl sm:text-5xl leading-[1.08] tracking-tight text-slate-900 mb-6">
              The software factory<br>for services firms.
            </h1>
            <p class="text-lg text-slate-600 leading-relaxed max-w-xl mb-8">
              Your clients are demanding AI pricing. Your delivery model is built on headcount. LFG is the agentic delivery pipeline that closes the gap: AI plans, builds, and tests. Your senior engineers verify. Your margins survive the transition.
            </p>
            <div class="flex flex-wrap items-center gap-3">
              <a href="#pilot-form" class="fx-btn-primary inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-colors">
                Book a pilot project <i data-lucide="arrow-right" class="w-4 h-4"></i>
              </a>
              <a href="/agent/" class="fx-btn-ghost inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-colors">
                See the pipeline
              </a>
            </div>
          </div>

          <!-- Right: live build board screenshot (show the machine, not just claims) -->
          <div class="lg:col-span-5 animate-fade-up" style="animation-delay:.12s">
            <div class="fx-panel overflow-hidden">
              <div class="flex items-center justify-between px-4 py-2.5 border-b border-slate-200/70">
                <div class="flex items-center gap-2 text-xs font-mono text-slate-400">
                  <span class="w-2.5 h-2.5 rounded-full bg-red-400/70"></span>
                  <span class="w-2.5 h-2.5 rounded-full bg-amber-400/70"></span>
                  <span class="w-2.5 h-2.5 rounded-full bg-emerald-400/70"></span>
                  <span class="ml-1">app.lfg.run/build</span>
                </div>
                <span class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-500">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse-soft"></span> live
                </span>
              </div>
              <img src="/public/images/screenshots/agent-ticket-board.png" alt="The LFG build board: every ticket, diff, and review in one place" class="w-full block" loading="lazy" />
            </div>
            <p class="text-xs text-slate-500 mt-3 text-center">Live build board: every ticket, diff, and senior review in one place.</p>
          </div>

        </div>
      </div>
    </section>

    <!-- PIPELINE DIAGRAM -->
    <section class="fx-raised fx-section py-10">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex flex-wrap items-center justify-center gap-x-2 gap-y-3">
          <div class="fx-stage inline-flex items-center gap-2 px-3.5 py-2"><i data-lucide="file-input" class="w-4 h-4 text-slate-400"></i><span class="text-sm font-semibold text-slate-700">Brief</span></div>
          <i data-lucide="arrow-right" class="w-4 h-4 text-slate-300 shrink-0"></i>
          <div class="fx-stage inline-flex items-center gap-2 px-3.5 py-2"><i data-lucide="file-text" class="w-4 h-4 text-slate-400"></i><span class="text-sm font-semibold text-slate-700">PRD</span></div>
          <i data-lucide="arrow-right" class="w-4 h-4 text-slate-300 shrink-0"></i>
          <div class="fx-stage inline-flex items-center gap-2 px-3.5 py-2"><i data-lucide="list-checks" class="w-4 h-4 text-slate-400"></i><span class="text-sm font-semibold text-slate-700">Tickets</span></div>
          <i data-lucide="arrow-right" class="w-4 h-4 text-slate-300 shrink-0"></i>
          <div class="fx-stage inline-flex items-center gap-2 px-3.5 py-2"><i data-lucide="terminal" class="w-4 h-4 text-slate-400"></i><span class="text-sm font-semibold text-slate-700">Sandboxed build</span></div>
          <i data-lucide="arrow-right" class="w-4 h-4 text-slate-300 shrink-0"></i>
          <div class="fx-stage inline-flex items-center gap-2 px-3.5 py-2 ring-1 ring-brand-300"><i data-lucide="shield-check" class="w-4 h-4 text-brand-500"></i><span class="text-sm font-bold text-brand-600">Senior review</span></div>
          <i data-lucide="arrow-right" class="w-4 h-4 text-slate-300 shrink-0"></i>
          <div class="fx-stage inline-flex items-center gap-2 px-3.5 py-2"><i data-lucide="rocket" class="w-4 h-4 text-slate-400"></i><span class="text-sm font-semibold text-slate-700">Ship</span></div>
        </div>
        <p class="text-center text-xs text-slate-500 mt-5">Every client brief moves through the same path. The highlighted gate is human, on every release.</p>
      </div>
    </section>

    <!-- THE PROBLEM -->
    <section class="fx-base fx-section py-20">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 class="font-display font-bold text-3xl text-slate-900 mb-5">The headcount model is breaking</h2>
        <p class="text-slate-600 text-lg leading-relaxed">
          Fixed-price deals are getting harder to win. Clients ask what AI discount you are passing through. Coding copilots make individual developers faster, which compresses billable hours without changing your cost structure. The firms that win the next decade will not bill for effort. They will price outcomes, and deliver them with a fraction of the bench.
        </p>
      </div>
    </section>

    <!-- WHAT LFG IS -->
    <section class="fx-raised fx-section py-20">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl mb-12">
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-5">A delivery pipeline you run inside your firm</h2>
          <p class="text-slate-600 text-lg leading-relaxed">
            LFG takes a client brief and produces a PRD, technical architecture, and a dependency-aware ticket graph. Each ticket executes in an isolated workspace via Claude Code. Your engineers review every diff before it ships. You keep the client relationship, the domain knowledge, and the accountability. The factory handles the volume.
          </p>
        </div>
        <div class="grid md:grid-cols-3 gap-6">
          <div class="fx-card p-7">
            <div class="flex items-center gap-3 mb-4">
              <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center"><i data-lucide="file-text" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">01 Plan</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">Brief to PRD and ticket graph in 24 hours. Versioned, client-reviewable, mapped to acceptance criteria.</p>
          </div>
          <div class="fx-card p-7">
            <div class="flex items-center gap-3 mb-4">
              <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center"><i data-lucide="terminal" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">02 Build</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">Parallel agent execution in sandboxed VMs. Full logs, diffs, and live previews for every ticket.</p>
          </div>
          <div class="fx-card p-7">
            <div class="flex items-center gap-3 mb-4">
              <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center"><i data-lucide="shield-check" class="w-5 h-5"></i></div>
              <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">03 Verify</span>
            </div>
            <p class="text-sm text-slate-600 leading-relaxed">Your senior engineers gate every release. Your QA standards. Your sign-off. Your name on the delivery.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ECONOMICS -->
    <section class="fx-base fx-section py-20">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 class="font-display font-bold text-3xl text-slate-900 mb-5">What it does to your margins</h2>
        <p class="text-slate-600 text-lg leading-relaxed mb-6">
          A typical $150K fixed-price web application: five engineers, fourteen weeks, 35% gross margin if nothing slips. The same project through the factory: one senior reviewer plus agent execution, three to four weeks, and a cost structure that lets you bid 30% under competitors while doubling margin. You stop selling hours. You start selling delivery.
        </p>

        <!-- Scannable comparison (the screenshot people share internally) -->
        <div class="grid sm:grid-cols-2 gap-4 mb-6">
          <div class="fx-card p-6">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">Traditional delivery</p>
            <dl class="space-y-3">
              <div class="flex items-center justify-between gap-3"><dt class="text-sm text-slate-500">Team</dt><dd class="text-sm font-semibold text-slate-900">5 engineers</dd></div>
              <div class="flex items-center justify-between gap-3"><dt class="text-sm text-slate-500">Timeline</dt><dd class="text-sm font-semibold text-slate-900">14 weeks</dd></div>
              <div class="flex items-center justify-between gap-3"><dt class="text-sm text-slate-500">Gross margin</dt><dd class="text-sm font-semibold text-slate-900">35% if nothing slips</dd></div>
              <div class="flex items-center justify-between gap-3"><dt class="text-sm text-slate-500">You sell</dt><dd class="text-sm font-semibold text-slate-900">Hours</dd></div>
            </dl>
          </div>
          <div class="fx-card p-6 ring-1 ring-brand-300">
            <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-4">Through the factory</p>
            <dl class="space-y-3">
              <div class="flex items-center justify-between gap-3"><dt class="text-sm text-slate-500">Team</dt><dd class="text-sm font-semibold text-slate-900">1 senior reviewer + agents</dd></div>
              <div class="flex items-center justify-between gap-3"><dt class="text-sm text-slate-500">Timeline</dt><dd class="text-sm font-semibold text-slate-900">3 to 4 weeks</dd></div>
              <div class="flex items-center justify-between gap-3"><dt class="text-sm text-slate-500">Margin</dt><dd class="text-sm font-semibold text-brand-600">Bid 30% lower, double the margin</dd></div>
              <div class="flex items-center justify-between gap-3"><dt class="text-sm text-slate-500">You sell</dt><dd class="text-sm font-semibold text-slate-900">Delivery</dd></div>
            </dl>
          </div>
        </div>

        <div class="fx-note rounded-lg p-4">
          <p class="text-xs text-slate-500 leading-relaxed">
            Modeled on LFG internal delivery data. Pilot projects produce your own baseline comparison.
          </p>
        </div>
      </div>
    </section>

    <!-- BUILT FOR INDIAN DELIVERY REALITIES -->
    <section class="fx-raised fx-section py-20">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 class="font-display font-bold text-3xl text-slate-900 mb-10">Built for Indian delivery realities</h2>
        <div class="grid sm:grid-cols-2 gap-5">
          <div class="fx-card p-7">
            <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center mb-4"><i data-lucide="server" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-lg text-slate-900 mb-2">Self-hosted</h3>
            <p class="text-sm text-slate-600 leading-relaxed">Open source core under Apache 2.0. Runs on your infrastructure or ours. Client code never leaves your control.</p>
          </div>
          <div class="fx-card p-7">
            <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center mb-4"><i data-lucide="shield-check" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-lg text-slate-900 mb-2">Data residency</h3>
            <p class="text-sm text-slate-600 leading-relaxed">Deployable in-region. Aligned with DPDP obligations and the data clauses in your client MSAs.</p>
          </div>
          <div class="fx-card p-7">
            <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center mb-4"><i data-lucide="layers" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-lg text-slate-900 mb-2">Works with your pyramid</h3>
            <p class="text-sm text-slate-600 leading-relaxed">Agents absorb the work you staffed juniors on. Your senior layer becomes the product.</p>
          </div>
          <div class="fx-card p-7">
            <div class="fx-tile w-10 h-10 rounded-lg flex items-center justify-center mb-4"><i data-lucide="file-search" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-lg text-slate-900 mb-2">Audit trail by default</h3>
            <p class="text-sm text-slate-600 leading-relaxed">Every requirement, ticket, commit, and review is logged and linkable to acceptance criteria. Built for clients who audit.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- PROOF -->
    <section class="fx-base fx-section py-20">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl mb-10">
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-5">We run the factory we sell</h2>
          <p class="text-slate-600 text-lg leading-relaxed">
            Mags, Easylogs, and Kitereach are production products built end to end on this pipeline by a team you can count on one hand. The pipeline you license is the pipeline we bet our own company on.
          </p>
        </div>
        <div class="grid md:grid-cols-3 gap-5">
          <a href="https://mags.run" target="_blank" rel="noopener noreferrer" class="fx-card group block overflow-hidden">
            <div class="aspect-[16/10] overflow-hidden border-b border-slate-200/70 bg-gradient-to-br from-brand-50 to-slate-100">
              <img src="/public/images/screenshots/mags.png" alt="mags.run product screenshot" class="w-full h-full object-cover object-top group-hover:scale-[1.03] transition-transform duration-300" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
              <div class="hidden w-full h-full items-center justify-center"><span class="font-display font-bold text-xl text-brand-700">mags.run</span></div>
            </div>
            <div class="p-6">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2.5">
                  <div class="fx-tile w-8 h-8 rounded-lg flex items-center justify-center"><i data-lucide="server" class="w-4 h-4"></i></div>
                  <h3 class="font-display font-bold text-lg text-slate-900">mags.run</h3>
                </div>
                <i data-lucide="arrow-up-right" class="w-4 h-4 text-slate-400 group-hover:text-brand-500"></i>
              </div>
              <p class="text-sm text-slate-600 leading-relaxed">Sandboxed cloud VMs for AI agent execution, built on Firecracker microVMs.</p>
            </div>
          </a>
          <a href="https://easylogs.co" target="_blank" rel="noopener noreferrer" class="fx-card group block overflow-hidden">
            <div class="aspect-[16/10] overflow-hidden border-b border-slate-200/70 bg-gradient-to-br from-brand-50 to-slate-100">
              <img src="/public/images/screenshots/easylogs.png" alt="easylogs.co product screenshot" class="w-full h-full object-cover object-top group-hover:scale-[1.03] transition-transform duration-300" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
              <div class="hidden w-full h-full items-center justify-center"><span class="font-display font-bold text-xl text-brand-700">easylogs.co</span></div>
            </div>
            <div class="p-6">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2.5">
                  <div class="fx-tile w-8 h-8 rounded-lg flex items-center justify-center"><i data-lucide="activity" class="w-4 h-4"></i></div>
                  <h3 class="font-display font-bold text-lg text-slate-900">easylogs.co</h3>
                </div>
                <i data-lucide="arrow-up-right" class="w-4 h-4 text-slate-400 group-hover:text-brand-500"></i>
              </div>
              <p class="text-sm text-slate-600 leading-relaxed">Developer logging and observability without the operational overhead.</p>
            </div>
          </a>
          <a href="https://kitereach.com" target="_blank" rel="noopener noreferrer" class="fx-card group block overflow-hidden">
            <div class="aspect-[16/10] overflow-hidden border-b border-slate-200/70 bg-gradient-to-br from-brand-50 to-slate-100">
              <img src="/public/images/screenshots/kitereach.png" alt="kitereach.com product screenshot" class="w-full h-full object-cover object-top group-hover:scale-[1.03] transition-transform duration-300" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
              <div class="hidden w-full h-full items-center justify-center"><span class="font-display font-bold text-xl text-brand-700">kitereach.com</span></div>
            </div>
            <div class="p-6">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2.5">
                  <div class="fx-tile w-8 h-8 rounded-lg flex items-center justify-center"><i data-lucide="send" class="w-4 h-4"></i></div>
                  <h3 class="font-display font-bold text-lg text-slate-900">kitereach.com</h3>
                </div>
                <i data-lucide="arrow-up-right" class="w-4 h-4 text-slate-400 group-hover:text-brand-500"></i>
              </div>
              <p class="text-sm text-slate-600 leading-relaxed">AI outreach platform for targeted, high-signal campaigns.</p>
            </div>
          </a>
        </div>
      </div>
    </section>

    <!-- PILOT -->
    <section class="fx-raised fx-section py-20">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl mb-10">
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-5">How a pilot works</h2>
          <p class="text-slate-600 text-lg leading-relaxed">
            Pick one real project, ideally one already scoped and priced the traditional way. We run it through the factory alongside or instead of your standard delivery. You compare time, cost, and quality against your own baseline. Two weeks. Fixed fee. No platform commitment.
          </p>
        </div>
        <div class="grid sm:grid-cols-3 gap-5">
          <div class="fx-card p-6">
            <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">Step 1</span>
            <h3 class="font-display font-bold text-base text-slate-900 mt-2 mb-2">Pick a scoped project</h3>
            <p class="text-sm text-slate-600 leading-relaxed">Ideally one already scoped and priced the traditional way, so the comparison is apples to apples.</p>
          </div>
          <div class="fx-card p-6">
            <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">Step 2</span>
            <h3 class="font-display font-bold text-base text-slate-900 mt-2 mb-2">Factory delivers in two weeks</h3>
            <p class="text-sm text-slate-600 leading-relaxed">PRD, ticket graph, sandboxed build, and senior review, delivered on a fixed fee with no platform commitment.</p>
          </div>
          <div class="fx-card p-6">
            <span class="text-xs font-bold text-brand-500 uppercase tracking-wider">Step 3</span>
            <h3 class="font-display font-bold text-base text-slate-900 mt-2 mb-2">Compare against your baseline</h3>
            <p class="text-sm text-slate-600 leading-relaxed">Measure time, cost, and quality against your own internal numbers, then decide if it scales.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA + FORM -->
    <section id="pilot-form" class="fx-raised py-20">
      <div class="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-8">
          <h2 class="font-display font-bold text-3xl text-slate-900 mb-3">Book a pilot</h2>
          <p class="text-slate-600">Your competitors are either building this in-house or pretending the pricing pressure is temporary.</p>
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
                <label class="text-xs font-semibold text-slate-600 mb-1 block">Firm</label>
                <input name="firm" placeholder="Firm name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
              </div>
              <div>
                <label class="text-xs font-semibold text-slate-600 mb-1 block">Headcount</label>
                <select name="headcount" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white text-slate-700">
                  <option value="">Select range</option>
                  <option value="50-200">50-200</option>
                  <option value="200-1000">200-1000</option>
                  <option value="1000-5000">1000-5000</option>
                  <option value="5000+">5000+</option>
                </select>
              </div>
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Role</label>
              <input name="role" placeholder="Delivery head, CTO, practice lead..." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Describe one fixed-price project you would test with *</label>
              <textarea name="project" required rows="4" placeholder="One real project, ideally already scoped and priced the traditional way." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
            </div>
            <button type="submit" class="fx-btn-primary w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg font-semibold text-sm transition-all">
              <i data-lucide="send" class="w-4 h-4"></i>
              <span class="btn-text">Book a pilot</span>
            </button>
            <div id="pilot-success" class="hidden text-center py-2 text-sm font-semibold text-emerald-600">
              <i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i>Got it. We will reply within 24 hours.
            </div>
            <div id="pilot-error" class="hidden text-center py-2 text-sm text-red-500"></div>
          </form>
        </div>
      </div>
    </section>

  </main>

  ${ Footer() }

  <script>
    lucide.createIcons();

    const form = document.getElementById('pilot-form-el');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      const btnText = form.querySelector('.btn-text');
      const success = document.getElementById('pilot-success');
      const error = document.getElementById('pilot-error');
      success.classList.add('hidden');
      error.classList.add('hidden');
      btn.disabled = true;
      btnText.textContent = 'Sending...';

      const data = Object.fromEntries(new FormData(form).entries());

      // Keep the pilot pipeline clean: nudge toward business email
      const FREE = ['gmail.com','googlemail.com','yahoo.com','yahoo.co.in','hotmail.com','outlook.com','live.com','aol.com','icloud.com','me.com','proton.me','protonmail.com','mail.com','gmx.com','yandex.com','rediffmail.com'];
      const domain = String(data.email || '').split('@')[1]?.toLowerCase().trim();
      if (domain && FREE.includes(domain)) {
        error.textContent = 'Please use your work email address, not a personal one.';
        error.classList.remove('hidden');
        btn.disabled = false;
        btnText.textContent = 'Book a pilot';
        return;
      }

      try {
        const res = await fetch('/api/factory/pilot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (res.ok) {
          form.reset();
          success.classList.remove('hidden');
          lucide.createIcons();
        } else {
          const d = await res.json();
          error.textContent = d.error || 'Something went wrong. Please try again.';
          error.classList.remove('hidden');
        }
      } catch {
        error.textContent = 'Unable to submit. Email us at hello@lfg.run';
        error.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btnText.textContent = 'Book a pilot';
      }
    });
  </script>

</body>
</html>
`;
