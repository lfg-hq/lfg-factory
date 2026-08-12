import { html } from "hono/html";

// Variant B, "$999 flat-rate" price-led hook
// Scannable, scarcity-led, optimised for cold IG traffic that decides in 3 seconds.
export const ShipV2LandingPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>$999 to ship your app, LFG Labs</title>
  <meta name="description" content="Flat $999. One week. Production-ready web app, deployed to your domain. Ships on time or you don't pay.">
  <meta property="og:title" content="$999 to ship your app, LFG Labs">
  <meta property="og:description" content="Flat-rate. One week. Deployed. We ship the last 20% AI tools couldn't.">
  <meta name="robots" content="noindex">
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800;900&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
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
          animation: {
            'fade-up':'fadeUp 0.7s ease-out both',
            'pulse-slow':'pulse 3s ease-in-out infinite',
            'tick':'tick 1s ease-in-out infinite',
          },
          keyframes: {
            fadeUp:{'0%':{opacity:'0',transform:'translateY(20px)'},'100%':{opacity:'1',transform:'translateY(0)'}},
            tick:{'0%,100%':{opacity:'1'},'50%':{opacity:'0.4'}},
          }
        }
      }
    }
  </script>
  <script src="https://unpkg.com/lucide@latest"></script>

  <script>
    (function() {
      var s = localStorage.getItem('lfg-theme');
      var d = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (s === 'dark' || (!s && d)) document.documentElement.classList.add('dark');
    })();
  </script>

  <style>
    body { background: #ffffff; overflow-x: hidden; }
    .price-hero { background: linear-gradient(135deg, #312e81 0%, #4f46e5 50%, #7c3aed 100%); }
    .price-hero-pattern {
      background-image:
        linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px);
      background-size: 56px 56px;
    }
    .glass { background: rgba(255,255,255,0.92); border: 1px solid rgba(148,163,184,0.2); backdrop-filter: blur(10px); }
    .checkrow { display: flex; align-items: flex-start; gap: 0.75rem; }
    .scarcity-bar { background: linear-gradient(90deg, #fef3c7 0%, #fef9c3 50%, #fef3c7 100%); }

    /* ── Dark mode ── */
    html.dark body { background: #0d1117 !important; color: #c9d1d9; }
    html.dark .price-hero { background: linear-gradient(135deg, #1a1040 0%, #312e81 45%, #4f46e5 100%) !important; }
    html.dark .scarcity-bar { background: linear-gradient(90deg, #1c1917 0%, #292524 50%, #1c1917 100%) !important; color: #fbbf24 !important; }
    html.dark .glass { background: rgba(22,27,34,0.85) !important; border-color: rgba(99,102,241,0.18) !important; }
    html.dark [class*="bg-white"] { background-color: #161b22 !important; }
    html.dark .bg-slate-50 { background-color: #0d1117 !important; }
    html.dark .bg-slate-100 { background-color: #161b22 !important; }
    html.dark .bg-brand-50 { background-color: #1c2128 !important; }
    html.dark .bg-emerald-50, html.dark .bg-emerald-50\/50 { background-color: rgba(16,185,129,0.06) !important; }
    html.dark .text-slate-900 { color: #e6edf3 !important; }
    html.dark .text-slate-800 { color: #c9d1d9 !important; }
    html.dark .text-slate-700 { color: #b0bac6 !important; }
    html.dark .text-slate-600 { color: #8b949e !important; }
    html.dark .text-slate-500 { color: #6e7681 !important; }
    html.dark .text-brand-700, html.dark .text-brand-600 { color: #818cf8 !important; }
    html.dark [class*="border-slate-2"], html.dark [class*="border-slate-1"] { border-color: rgba(255,255,255,0.07) !important; }
    html.dark [class*="border-brand-2"] { border-color: rgba(99,102,241,0.25) !important; }
    html.dark [class*="border-emerald-2"] { border-color: rgba(16,185,129,0.2) !important; }
    html.dark [class*="border-t"] { border-color: rgba(255,255,255,0.06) !important; }
    html.dark * { box-shadow: none !important; }
    html.dark input:not([type=submit]):not([type=button]), html.dark textarea {
      background-color: #1c2128 !important;
      border-color: rgba(255,255,255,0.18) !important;
      color: #e6edf3 !important;
    }
    html.dark input::placeholder, html.dark textarea::placeholder { color: #6e7681 !important; }
  </style>
</head>
<body class="text-slate-900 font-sans selection:bg-indigo-600 selection:text-white">

  <!-- Scarcity bar -->
  <div class="scarcity-bar text-center py-2 px-4 text-xs sm:text-sm font-semibold text-amber-900 border-b border-amber-200 flex items-center justify-center gap-2">
    <span class="w-2 h-2 rounded-full bg-amber-500 animate-tick"></span>
    <span>Limited slots · <span class="font-bold">4 builds per week</span></span>
  </div>

  <!-- Logo-only header -->
  <header class="absolute top-9 left-0 right-0 z-50 px-4 sm:px-6 lg:px-8 py-4">
    <div class="max-w-6xl mx-auto flex items-center justify-between">
      <a href="/ship-v2" class="flex items-center gap-2 group">
        <div class="bg-white/15 backdrop-blur text-white p-1.5 rounded-lg border border-white/20">
          <i data-lucide="rocket" class="w-5 h-5"></i>
        </div>
        <span class="font-display font-bold text-xl tracking-tight text-white">LFG Labs</span>
      </a>
      <button id="theme-toggle" onclick="window.toggleTheme && window.toggleTheme()" class="text-white/70 hover:text-white transition-colors p-2" aria-label="Toggle dark mode">
        <i data-lucide="moon" class="w-5 h-5"></i>
      </button>
    </div>
  </header>

  <main>

    <!-- HERO, price-led, gradient, with embedded form -->
    <section class="relative price-hero text-white pt-24 sm:pt-28 pb-16 overflow-hidden">
      <div class="absolute inset-0 price-hero-pattern opacity-60"></div>
      <div class="absolute -top-20 right-[-5%] w-[400px] h-[400px] rounded-full bg-violet-400/20 blur-3xl"></div>
      <div class="absolute -bottom-20 left-[-5%] w-[400px] h-[400px] rounded-full bg-indigo-400/20 blur-3xl"></div>

      <div class="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="grid lg:grid-cols-5 gap-10 lg:gap-12 items-center">

          <!-- Left: copy (3/5 cols on lg) -->
          <div class="lg:col-span-3 text-center lg:text-left">
            <p class="animate-fade-up text-[11px] sm:text-xs font-bold uppercase tracking-[0.25em] text-brand-200 mb-4">Flat rate · Production-ready · 1 week</p>

            <h1 class="animate-fade-up font-display font-bold text-4xl sm:text-5xl lg:text-6xl tracking-tight leading-[1.05] mb-5" style="animation-delay:0.05s">
              <span class="text-white/85">We ship your app for</span>
              <span class="block font-extrabold text-7xl sm:text-8xl lg:text-[7.5rem] mt-2 bg-clip-text text-transparent bg-gradient-to-b from-white to-brand-200 leading-none">$999</span>
            </h1>

            <p class="animate-fade-up text-base sm:text-lg text-white/80 max-w-lg mx-auto lg:mx-0 mb-6 leading-relaxed" style="animation-delay:0.12s">
              One flat fee. One week. Real auth, real database, deployed to your domain. <span class="font-semibold text-white">Source code is yours.</span>
            </p>

            <!-- Trust pills -->
            <div class="animate-fade-up flex flex-wrap gap-2 mb-6 justify-center lg:justify-start" style="animation-delay:0.18s">
              <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-white/90 bg-white/10 backdrop-blur border border-white/15 px-3 py-1.5 rounded-full">
                <i data-lucide="clock" class="w-3.5 h-3.5 text-emerald-300"></i> On-time or free
              </span>
              <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-white/90 bg-white/10 backdrop-blur border border-white/15 px-3 py-1.5 rounded-full">
                <i data-lucide="undo-2" class="w-3.5 h-3.5 text-emerald-300"></i> 7-day refund
              </span>
              <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-white/90 bg-white/10 backdrop-blur border border-white/15 px-3 py-1.5 rounded-full">
                <i data-lucide="key-round" class="w-3.5 h-3.5 text-emerald-300"></i> You own the code
              </span>
            </div>

            <p class="animate-fade-up text-sm text-white/60 hidden lg:block" style="animation-delay:0.25s">
              <a href="#what-you-get" class="hover:text-white transition-colors inline-flex items-center gap-1 font-semibold">
                <i data-lucide="arrow-down" class="w-3.5 h-3.5"></i> What's included for $999
              </a>
            </p>
          </div>

          <!-- Right: form (2/5 cols on lg) -->
          <div id="brief-form" class="lg:col-span-2 animate-fade-up bg-white text-slate-900 rounded-2xl shadow-2xl p-6 border border-white/20" style="animation-delay:0.18s">
            <div class="mb-4">
              <h2 class="font-display font-bold text-xl text-slate-900">Send me a build plan</h2>
              <p class="text-sm text-slate-500 mt-0.5">3 fields · plan in 24 hours</p>
            </div>
            <form class="lfg-inquiry-form space-y-3">
              <input type="hidden" name="tier" class="tier-input" value="">
              <input type="hidden" name="variant" value="ship-b">
              <div>
                <label class="text-xs font-semibold text-slate-600 mb-1 block">Your name *</label>
                <input name="name" required placeholder="Jane Founder" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
              </div>
              <div>
                <label class="text-xs font-semibold text-slate-600 mb-1 block">Email *</label>
                <input name="email" type="email" required placeholder="you@company.com" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
              </div>
              <div>
                <label class="text-xs font-semibold text-slate-600 mb-1 block">What do you want to build? *</label>
                <textarea name="requirements" required rows="3" placeholder="A CRM for my sales team / I started in Lovable but auth keeps breaking..." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
              </div>
              <button type="submit" class="w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-bold text-sm transition-all shadow-lg shadow-brand-600/30">
                <i data-lucide="send" class="w-4 h-4"></i>
                <span class="btn-text">Send my plan</span>
              </button>
              <p class="text-[11px] text-slate-500 text-center pt-1">No spam, no pitch deck. Reply within 24h.</p>
              <div class="form-success hidden text-center py-3 px-4 rounded-lg bg-emerald-50 border border-emerald-200 text-sm font-semibold text-emerald-700">
                <i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i>Got it. Plan in your inbox within 24 hours.
              </div>
              <div class="form-error hidden text-center py-3 px-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-600"></div>
            </form>
          </div>

        </div>
      </div>
    </section>

    <!-- WHAT YOU GET, checklist, scannable -->
    <section id="what-you-get" class="py-20 bg-white">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-10">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">What $999 gets you</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">A real product. Not a demo.</h2>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
          <ul class="space-y-4">
            <li class="checkrow"><i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-500 shrink-0 mt-0.5"></i><div><span class="font-semibold text-slate-900">Up to 5 features</span><p class="text-sm text-slate-600 mt-0.5">Scoped together before kickoff. No surprise change orders.</p></div></li>
            <li class="checkrow"><i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-500 shrink-0 mt-0.5"></i><div><span class="font-semibold text-slate-900">Real auth, not localStorage</span><p class="text-sm text-slate-600 mt-0.5">Email/password, OAuth, sessions. Works for actual users.</p></div></li>
            <li class="checkrow"><i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-500 shrink-0 mt-0.5"></i><div><span class="font-semibold text-slate-900">Postgres database, properly modelled</span><p class="text-sm text-slate-600 mt-0.5">Migrations, indexes, backups. Survives growth past 10 users.</p></div></li>
            <li class="checkrow"><i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-500 shrink-0 mt-0.5"></i><div><span class="font-semibold text-slate-900">Deployed to your domain</span><p class="text-sm text-slate-600 mt-0.5">SSL, CDN, monitoring. We hand over keys, you own the infra.</p></div></li>
            <li class="checkrow"><i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-500 shrink-0 mt-0.5"></i><div><span class="font-semibold text-slate-900">Full source code + README</span><p class="text-sm text-slate-600 mt-0.5">Pushed to your GitHub. Anyone can run it locally in 5 minutes.</p></div></li>
            <li class="checkrow"><i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-500 shrink-0 mt-0.5"></i><div><span class="font-semibold text-slate-900">Senior engineer review</span><p class="text-sm text-slate-600 mt-0.5">Every line gets reviewed before it ships. No raw AI output.</p></div></li>
          </ul>

          <div class="mt-8 pt-6 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <p class="text-sm text-slate-500">Need more? Pro tier ($1,999) adds Stripe, 3rd-party APIs, and 10 features.</p>
            </div>
            <a href="#brief-form" class="shrink-0 px-6 py-3 rounded-full bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm transition-colors inline-flex items-center gap-2">
              Book my build <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
          </div>
        </div>
      </div>
    </section>

    <!-- COMPARISON / OFFER GRID -->
    <section class="py-20 bg-white border-t border-slate-100">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-12">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">Pick a tier</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Two flat prices. Hard scope.</h2>
          <p class="text-slate-500 text-lg mt-3">Most projects fit Starter. We'll tell you upfront if you need Pro.</p>
        </div>

        <div class="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
          <!-- Starter -->
          <div class="rounded-2xl border-2 border-slate-200 bg-white p-7">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Starter</p>
            <div class="flex items-end gap-2 mb-1">
              <span class="font-display font-extrabold text-5xl text-slate-900">$999</span>
            </div>
            <p class="text-xs text-slate-500 mb-6">flat · ships in 1 week</p>
            <ul class="space-y-2.5 mb-7 text-sm">
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">Up to 5 features</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">Auth + Postgres</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">Deployed + handed over</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">Senior engineer review</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">30 days post-launch support</span></li>
              <li class="flex items-start gap-2 opacity-40"><i data-lucide="x" class="w-4 h-4 shrink-0 mt-0.5"></i><span class="text-slate-700 line-through">Stripe / payments</span></li>
              <li class="flex items-start gap-2 opacity-40"><i data-lucide="x" class="w-4 h-4 shrink-0 mt-0.5"></i><span class="text-slate-700 line-through">3rd-party APIs</span></li>
            </ul>
            <a href="#brief-form" data-tier="starter" class="tier-cta w-full inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-all">
              Start at $999 <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
          </div>

          <!-- Pro -->
          <div class="rounded-2xl border-2 border-brand-500 bg-brand-50 p-7 relative">
            <div class="absolute -top-3 left-1/2 -translate-x-1/2">
              <span class="text-[10px] font-bold px-3 py-1 rounded-full bg-brand-600 text-white shadow-lg uppercase tracking-wider">Most popular</span>
            </div>
            <p class="text-xs font-bold text-brand-700 uppercase tracking-wider mb-3">Pro</p>
            <div class="flex items-end gap-2 mb-1">
              <span class="font-display font-extrabold text-5xl text-slate-900">$1,999</span>
            </div>
            <p class="text-xs text-slate-500 mb-6">flat · ships in 2 weeks</p>
            <ul class="space-y-2.5 mb-7 text-sm">
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">Up to 10 features</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">Auth + Postgres</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">Deployed + handed over</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">Senior engineer review</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="font-semibold text-slate-900">Stripe / payment integration</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="font-semibold text-slate-900">1 third-party API</span></li>
              <li class="flex items-start gap-2"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i><span class="text-slate-700">30 days post-launch support</span></li>
            </ul>
            <a href="#brief-form" data-tier="pro" class="tier-cta w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-all">
              Start at $1,999 <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
          </div>
        </div>

        <p class="text-center text-xs text-slate-500 mt-6">Bigger scope? <a href="#brief-form" data-tier="custom" class="tier-cta text-brand-600 font-semibold hover:underline">Custom tier from $5k</a></p>
      </div>
    </section>

    <!-- PROOF, real portfolio items -->
    <section class="py-20 bg-white border-t border-slate-100">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-10">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">Same pipeline, real products</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Live. In production.</h2>
        </div>
        <div class="grid md:grid-cols-3 gap-6">

          <a href="https://mags.run" target="_blank" rel="noopener noreferrer" class="group rounded-2xl border border-slate-200 bg-white overflow-hidden hover:border-brand-300 hover:shadow-xl transition-all">
            <div class="bg-slate-100 border-b border-slate-200 flex items-center gap-1.5 px-3 py-2">
              <span class="w-2 h-2 rounded-full bg-red-400"></span>
              <span class="w-2 h-2 rounded-full bg-amber-400"></span>
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span class="ml-2 text-[11px] text-slate-500 font-mono">mags.run</span>
              <i data-lucide="external-link" class="w-3 h-3 text-slate-400 ml-auto group-hover:text-brand-600"></i>
            </div>
            <div class="aspect-[16/10] overflow-hidden bg-slate-50">
              <img src="/public/images/screenshots/mags.png" alt="mags.run, Cloud VMs for AI workloads" class="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" loading="lazy" />
            </div>
            <div class="p-5">
              <p class="font-display font-bold text-base text-slate-900 mb-1">mags.run</p>
              <p class="text-sm text-slate-500">On-demand cloud VMs for AI agents and developers.</p>
            </div>
          </a>

          <a href="https://kitereach.com" target="_blank" rel="noopener noreferrer" class="group rounded-2xl border border-slate-200 bg-white overflow-hidden hover:border-brand-300 hover:shadow-xl transition-all">
            <div class="bg-slate-100 border-b border-slate-200 flex items-center gap-1.5 px-3 py-2">
              <span class="w-2 h-2 rounded-full bg-red-400"></span>
              <span class="w-2 h-2 rounded-full bg-amber-400"></span>
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span class="ml-2 text-[11px] text-slate-500 font-mono">kitereach.com</span>
              <i data-lucide="external-link" class="w-3 h-3 text-slate-400 ml-auto group-hover:text-brand-600"></i>
            </div>
            <div class="aspect-[16/10] overflow-hidden bg-slate-50">
              <img src="/public/images/screenshots/kitereach.png" alt="kitereach.com, AI outreach platform" class="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" loading="lazy" />
            </div>
            <div class="p-5">
              <p class="font-display font-bold text-base text-slate-900 mb-1">kitereach.com</p>
              <p class="text-sm text-slate-500">AI outreach platform. Multi-channel sequencing for sales teams.</p>
            </div>
          </a>

          <a href="https://easylogs.co" target="_blank" rel="noopener noreferrer" class="group rounded-2xl border border-slate-200 bg-white overflow-hidden hover:border-brand-300 hover:shadow-xl transition-all">
            <div class="bg-slate-100 border-b border-slate-200 flex items-center gap-1.5 px-3 py-2">
              <span class="w-2 h-2 rounded-full bg-red-400"></span>
              <span class="w-2 h-2 rounded-full bg-amber-400"></span>
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span class="ml-2 text-[11px] text-slate-500 font-mono">easylogs.co</span>
              <i data-lucide="external-link" class="w-3 h-3 text-slate-400 ml-auto group-hover:text-brand-600"></i>
            </div>
            <div class="aspect-[16/10] overflow-hidden bg-slate-50">
              <img src="/public/images/screenshots/easylogs.png" alt="easylogs.co, Logging platform" class="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" loading="lazy" />
            </div>
            <div class="p-5">
              <p class="font-display font-bold text-base text-slate-900 mb-1">easylogs.co</p>
              <p class="text-sm text-slate-500">Real-time log streaming, alerts, and search. One-line SDK.</p>
            </div>
          </a>

        </div>
        <div class="text-center mt-10">
          <a href="/portfolio/" class="inline-flex items-center gap-2 text-sm font-semibold text-brand-600 hover:text-brand-700">
            See full portfolio <i data-lucide="arrow-right" class="w-4 h-4"></i>
          </a>
        </div>
      </div>
    </section>

    <!-- GUARANTEES strip -->
    <section class="py-16 bg-emerald-50 border-t border-emerald-100">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="text-center"><i data-lucide="clock" class="w-6 h-6 text-emerald-600 mx-auto mb-2"></i><p class="text-sm font-semibold text-slate-900">Ships on time</p><p class="text-xs text-slate-600 mt-1">Or you don't pay</p></div>
          <div class="text-center"><i data-lucide="undo-2" class="w-6 h-6 text-emerald-600 mx-auto mb-2"></i><p class="text-sm font-semibold text-slate-900">7-day refund</p><p class="text-xs text-slate-600 mt-1">If you don't love it</p></div>
          <div class="text-center"><i data-lucide="key-round" class="w-6 h-6 text-emerald-600 mx-auto mb-2"></i><p class="text-sm font-semibold text-slate-900">You own the code</p><p class="text-xs text-slate-600 mt-1">Repo + domain + DB</p></div>
          <div class="text-center"><i data-lucide="user-check" class="w-6 h-6 text-emerald-600 mx-auto mb-2"></i><p class="text-sm font-semibold text-slate-900">Senior engineer review</p><p class="text-xs text-slate-600 mt-1">Every diff, every build</p></div>
        </div>
      </div>
    </section>

    <!-- FAQ -->
    <section class="py-20 bg-white border-t border-slate-100">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-10">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">FAQ</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Quick answers</h2>
        </div>
        <div class="space-y-3">
          <details class="group rounded-xl border border-slate-200 bg-slate-50 p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>How does payment work?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">50% deposit via Stripe to lock your slot ($500 for Starter, $1,000 for Pro). 50% on delivery after you've reviewed and approved the app. Refund window applies to the delivery payment.</p>
          </details>
          <details class="group rounded-xl border border-slate-200 bg-slate-50 p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>What if I don't like it?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">7 days to ask for a refund of the delivery payment. No hoops. The code is already in your repo so you keep everything.</p>
          </details>
          <details class="group rounded-xl border border-slate-200 bg-slate-50 p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>How is this different from Replit / Lovable / Bolt?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">They give you a working demo and leave you to figure out the production parts, auth that scales, deploy that doesn't 404, error handling, edge cases. We finish the job. Senior engineers review every diff.</p>
          </details>
          <details class="group rounded-xl border border-slate-200 bg-slate-50 p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>What's NOT included at $999?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">Native iOS/Android apps (web only at this tier), pixel-perfect Figma builds, payment integration, 3rd-party APIs, ongoing maintenance. Most of those = Pro tier ($1,999) or Custom.</p>
          </details>
          <details class="group rounded-xl border border-slate-200 bg-slate-50 p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>Who owns the code?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">You. We push to your GitHub and deploy to your domain on your hosting. We retain no rights, no copies, no lock-in.</p>
          </details>
        </div>
      </div>
    </section>

    <!-- FINAL CTA, bounces back up to hero form -->
    <section class="py-16 price-hero text-white relative overflow-hidden">
      <div class="absolute inset-0 price-hero-pattern opacity-50"></div>
      <div class="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 class="font-display font-bold text-3xl md:text-4xl mb-4">Ready to ship?</h2>
        <p class="text-white/80 text-lg mb-8 max-w-xl mx-auto">$999. One week. Production-ready. Tell us what to build and we'll send a plan within 24 hours.</p>
        <a href="#brief-form" class="inline-flex items-center justify-center gap-2 bg-white text-slate-900 px-8 py-4 rounded-full font-bold hover:bg-brand-100 transition-colors shadow-2xl">
          Send my plan <i data-lucide="arrow-up" class="w-4 h-4"></i>
        </a>
        <p class="text-xs text-white/60 mt-5">Ships on time or you don't pay · 7-day refund window</p>
      </div>
    </section>

  </main>

  <!-- Mobile sticky CTA bar (shows on scroll, hides when form is in view) -->
  <div id="mobile-cta-bar" class="lg:hidden fixed bottom-0 left-0 right-0 z-40 px-3 pb-3 pt-2 transform translate-y-full transition-transform duration-300 pointer-events-none">
    <div class="max-w-md mx-auto bg-white border border-slate-200 rounded-2xl shadow-2xl p-2.5 flex items-center gap-2 pointer-events-auto" style="backdrop-filter: blur(10px);">
      <div class="flex-1 pl-2">
        <p class="text-[11px] text-slate-500 leading-tight">$999 · ships in 1 week</p>
        <p class="text-sm font-semibold text-slate-900 leading-tight">Send my plan</p>
      </div>
      <a href="#brief-form" class="shrink-0 inline-flex items-center justify-center gap-1.5 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2.5 rounded-xl font-semibold text-sm transition-colors">
        Get started <i data-lucide="arrow-up" class="w-3.5 h-3.5"></i>
      </a>
    </div>
  </div>

  <footer class="py-8 pb-24 lg:pb-8 border-t border-slate-200 bg-white">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <p class="text-xs text-slate-500">&copy; ${new Date().getFullYear()} LFG · <a href="mailto:hello@lfg.run" class="hover:text-brand-600">hello@lfg.run</a></p>
    </div>
  </footer>

  <script>
    lucide.createIcons();

    function updateThemeIcon(isDark) {
      var btn = document.getElementById('theme-toggle');
      if (!btn) return;
      var icon = btn.querySelector('[data-lucide]');
      if (icon) { icon.setAttribute('data-lucide', isDark ? 'sun' : 'moon'); if (window.lucide) lucide.createIcons({ nodes: [icon] }); }
    }
    window.toggleTheme = function() {
      var isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('lfg-theme', isDark ? 'dark' : 'light');
      updateThemeIcon(isDark);
    };
    setTimeout(function(){ updateThemeIcon(document.documentElement.classList.contains('dark')); }, 100);

    // Tier CTAs prefill tier on ALL hidden inputs
    document.querySelectorAll('.tier-cta').forEach(function(a) {
      a.addEventListener('click', function() {
        var t = a.getAttribute('data-tier') || '';
        document.querySelectorAll('.tier-input').forEach(function(input) { input.value = t; });
      });
    });

    // Form submission, class-based so this works for any form on the page
    document.querySelectorAll('.lfg-inquiry-form').forEach(function(form) {
      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        var btn = form.querySelector('button[type="submit"]');
        var btnText = form.querySelector('.btn-text');
        var ok = form.querySelector('.form-success');
        var err = form.querySelector('.form-error');
        ok.classList.add('hidden'); err.classList.add('hidden');
        btn.disabled = true; btnText.textContent = 'Sending...';

        var data = Object.fromEntries(new FormData(form).entries());
        try {
          var res = await fetch('/api/labs/inquiry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          if (res.ok) {
            form.reset();
            ok.classList.remove('hidden');
            lucide.createIcons();
            if (typeof fbq === 'function') { fbq('track', 'Lead', { content_name: 'ship-b' }); }
          } else {
            var d = await res.json();
            err.textContent = d.error || 'Something went wrong. Please try again.';
            err.classList.remove('hidden');
          }
        } catch (_) {
          err.textContent = 'Unable to submit. Email us at hello@lfg.run';
          err.classList.remove('hidden');
        } finally {
          btn.disabled = false;
          btnText.textContent = 'Send my plan';
        }
      });
    });

    // Mobile sticky CTA bar
    (function() {
      var bar = document.getElementById('mobile-cta-bar');
      if (!bar) return;
      var heroForm = document.getElementById('brief-form');
      var formInView = false;

      if ('IntersectionObserver' in window && heroForm) {
        var obs = new IntersectionObserver(function(entries) {
          formInView = entries[0].isIntersecting;
          updateBar();
        }, { threshold: 0.2 });
        obs.observe(heroForm);
      }

      function updateBar() {
        var scrolled = window.scrollY > 600;
        var shouldShow = scrolled && !formInView;
        bar.style.transform = shouldShow ? 'translateY(0)' : 'translateY(120%)';
      }

      window.addEventListener('scroll', updateBar, { passive: true });
      updateBar();
    })();
  </script>

  <!-- Meta Pixel placeholder, drop fbq init here once pixel ID is confirmed. -->

</body>
</html>
`;
