import { html } from "hono/html";

// Variant A, "Stuck at 80%" problem/solution hook
// Long-form, narrative-led. Pairs with the carousel ad's pain-point frames.
export const ShipLandingPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LFG Labs, We ship the last 20% your AI app can't</title>
  <meta name="description" content="Replit, Lovable, Bolt got you 80% of the way. LFG Labs ships the last 20%, production-ready apps from $999, in 1 week, flat rate.">
  <meta property="og:title" content="LFG Labs, We ship the last 20%">
  <meta property="og:description" content="Production-ready apps from $999. 1 week. Ships on time or you don't pay.">
  <meta name="robots" content="noindex">
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
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
            'fade-in':'fadeIn 0.6s ease-out both',
            'drift':'drift 9s ease-in-out infinite',
            'pulse-slow':'pulse 3s ease-in-out infinite',
          },
          keyframes: {
            fadeUp:{'0%':{opacity:'0',transform:'translateY(22px)'},'100%':{opacity:'1',transform:'translateY(0)'}},
            fadeIn:{'0%':{opacity:'0'},'100%':{opacity:'1'}},
            drift:{'0%,100%':{transform:'translateY(0px)'},'50%':{transform:'translateY(-12px)'}},
          }
        }
      }
    }
  </script>
  <script src="https://unpkg.com/lucide@latest"></script>

  <!-- FOUC-safe theme bootstrap -->
  <script>
    (function() {
      var s = localStorage.getItem('lfg-theme');
      var d = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (s === 'dark' || (!s && d)) document.documentElement.classList.add('dark');
    })();
  </script>

  <style>
    body { background: radial-gradient(circle at 20% 0%, #eef2ff 0%, #f8fafc 38%, #ffffff 100%); overflow-x: hidden; }
    .mesh { background-image: radial-gradient(circle at 10% 20%, rgba(99,102,241,0.16), transparent 42%), radial-gradient(circle at 80% 0%, rgba(236,72,153,0.10), transparent 35%); }
    .glass { background: rgba(255,255,255,0.92); border: 1px solid rgba(148,163,184,0.2); backdrop-filter: blur(10px); }
    .grid-pattern {
      background-image: linear-gradient(rgba(99,102,241,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.06) 1px, transparent 1px);
      background-size: 48px 48px;
    }
    .price-card-pop { transform: scale(1.02); }
    .price-card-pop:hover { transform: scale(1.04); }
    /* ── Dark mode ── */
    html.dark body { background: radial-gradient(circle at 15% 0%, #1a1040 0%, #0d1117 45%, #0d1117 100%) !important; color: #c9d1d9; }
    html.dark .mesh { background-image: radial-gradient(circle at 10% 20%, rgba(99,102,241,0.18), transparent 45%), radial-gradient(circle at 80% 0%, rgba(139,92,246,0.14), transparent 40%) !important; }
    html.dark .glass { background: rgba(22,27,34,0.85) !important; border-color: rgba(99,102,241,0.18) !important; }
    html.dark .blur-3xl { opacity: 0.18 !important; }
    html.dark [class*="bg-white"] { background-color: #161b22 !important; }
    html.dark .bg-slate-50 { background-color: #0d1117 !important; }
    html.dark .bg-slate-100 { background-color: #161b22 !important; }
    html.dark .bg-brand-50 { background-color: #1c2128 !important; }
    html.dark .text-slate-900 { color: #e6edf3 !important; }
    html.dark .text-slate-800 { color: #c9d1d9 !important; }
    html.dark .text-slate-700 { color: #b0bac6 !important; }
    html.dark .text-slate-600 { color: #8b949e !important; }
    html.dark .text-slate-500 { color: #6e7681 !important; }
    html.dark .text-brand-700, html.dark .text-brand-600 { color: #818cf8 !important; }
    html.dark [class*="border-slate-2"], html.dark [class*="border-slate-1"] { border-color: rgba(255,255,255,0.07) !important; }
    html.dark [class*="border-brand-2"] { border-color: rgba(99,102,241,0.25) !important; }
    html.dark [class*="border-t"] { border-color: rgba(255,255,255,0.06) !important; }
    html.dark * { box-shadow: none !important; }
    html.dark input:not([type=submit]):not([type=button]), html.dark textarea {
      background-color: #1c2128 !important;
      border-color: rgba(255,255,255,0.18) !important;
      color: #e6edf3 !important;
    }
    html.dark input::placeholder, html.dark textarea::placeholder { color: #6e7681 !important; }
    html.dark .grid-pattern { background-image: linear-gradient(rgba(99,102,241,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.08) 1px, transparent 1px) !important; }
  </style>
</head>
<body class="text-slate-900 font-sans selection:bg-indigo-600 selection:text-white">

  <!-- Logo-only header (no nav per PRD) -->
  <header class="absolute top-0 left-0 right-0 z-50 px-4 sm:px-6 lg:px-8 py-5">
    <div class="max-w-6xl mx-auto flex items-center justify-between">
      <a href="/ship" class="flex items-center gap-2 group">
        <div class="bg-brand-600 text-white p-1.5 rounded-lg">
          <i data-lucide="rocket" class="w-5 h-5"></i>
        </div>
        <span class="font-display font-bold text-xl tracking-tight">LFG Labs</span>
      </a>
      <button id="theme-toggle" onclick="window.toggleTheme && window.toggleTheme()" class="text-slate-500 hover:text-slate-900 transition-colors p-2" aria-label="Toggle dark mode">
        <i data-lucide="moon" class="w-5 h-5"></i>
      </button>
    </div>
  </header>

  <main>

    <!-- ABOVE THE FOLD, split layout: copy + form -->
    <section class="relative pt-28 sm:pt-32 pb-16 overflow-hidden mesh">
      <div class="absolute inset-0 grid-pattern opacity-50 pointer-events-none"></div>
      <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
      <div class="absolute top-20 left-[5%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>

      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div class="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center">

          <!-- Left: copy -->
          <div class="text-center lg:text-left">
            <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass shadow-sm mb-6 animate-fade-up">
              <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse-slow"></span>
              <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">LFG Labs · Now booking</span>
            </div>

            <h1 class="animate-fade-up font-display font-bold text-4xl sm:text-5xl lg:text-[3.5rem] leading-[1.05] tracking-tight text-slate-900 mb-5" style="animation-delay:0.08s">
              Your AI app is 80% done.<br>
              <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 via-violet-500 to-pink-500">We ship the last 20%.</span>
            </h1>

            <p class="animate-fade-up text-lg text-slate-600 leading-relaxed mb-6 max-w-lg mx-auto lg:mx-0" style="animation-delay:0.15s">
              Production-ready web apps from <span class="font-semibold text-slate-900">$999</span>. One week. We take responsibility for shipping, auth, database, deploy, the works.
            </p>

            <!-- Trust strip -->
            <div class="animate-fade-up flex flex-wrap gap-3 mb-6 justify-center lg:justify-start" style="animation-delay:0.2s">
              <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm">
                <i data-lucide="clock" class="w-3.5 h-3.5 text-emerald-600"></i> 1 week to ship
              </span>
              <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm">
                <i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-600"></i> On-time or free
              </span>
              <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm">
                <i data-lucide="undo-2" class="w-3.5 h-3.5 text-emerald-600"></i> 7-day refund
              </span>
            </div>

            <p class="animate-fade-up text-sm text-slate-500 hidden lg:block" style="animation-delay:0.28s">
              <a href="#pricing" class="hover:text-brand-700 transition-colors inline-flex items-center gap-1 font-semibold">
                <i data-lucide="arrow-down" class="w-3.5 h-3.5"></i> See pricing & how it works
              </a>
            </p>
          </div>

          <!-- Right: form -->
          <div id="brief-form" class="animate-fade-up glass rounded-2xl shadow-2xl p-6 sm:p-7 border border-slate-200/70" style="animation-delay:0.18s">
            <div class="mb-5">
              <h2 class="font-display font-bold text-2xl text-slate-900">Tell us what to build</h2>
              <p class="text-sm text-slate-500 mt-1">3 fields · plan in your inbox in 24h.</p>
            </div>
            <form class="lfg-inquiry-form space-y-3.5">
              <input type="hidden" name="tier" class="tier-input" value="">
              <input type="hidden" name="variant" value="ship-a">
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
                <textarea name="requirements" required rows="3" placeholder="A CRM for my sales team / I started in Lovable but the auth keeps breaking..." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
              </div>
              <button type="submit" class="w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-all shadow-lg shadow-brand-600/25">
                <i data-lucide="send" class="w-4 h-4"></i>
                <span class="btn-text">Send my plan</span>
              </button>
              <p class="text-[11px] text-slate-500 text-center pt-1">We reply within 24 hours · No spam, no pitch decks</p>
              <div class="form-success hidden text-center py-3 px-4 rounded-lg bg-emerald-50 border border-emerald-200 text-sm font-semibold text-emerald-700">
                <i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i>Got it. We'll send your plan within 24 hours.
              </div>
              <div class="form-error hidden text-center py-3 px-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-600"></div>
            </form>
          </div>

        </div>
      </div>
    </section>

    <!-- THE PROBLEM -->
    <section class="py-20 bg-white border-t border-slate-100">
      <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-12">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">The wall</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 leading-tight">
            Replit got you a demo.<br class="hidden sm:block">
            Lovable got you a screenshot. Bolt got you stuck.
          </h2>
        </div>
        <div class="grid sm:grid-cols-2 gap-4 mb-10">
          <div class="rounded-xl border border-slate-200 bg-slate-50 p-5 flex items-start gap-3">
            <i data-lucide="x-circle" class="w-5 h-5 text-red-500 shrink-0 mt-0.5"></i>
            <div>
              <h3 class="font-semibold text-slate-900 text-sm mb-1">Auth that breaks</h3>
              <p class="text-sm text-slate-600">Login works in dev, fails the moment you ship to a real user.</p>
            </div>
          </div>
          <div class="rounded-xl border border-slate-200 bg-slate-50 p-5 flex items-start gap-3">
            <i data-lucide="database" class="w-5 h-5 text-red-500 shrink-0 mt-0.5"></i>
            <div>
              <h3 class="font-semibold text-slate-900 text-sm mb-1">A "database" that's localStorage</h3>
              <p class="text-sm text-slate-600">Refresh the page and your data is gone. Not a product, a toy.</p>
            </div>
          </div>
          <div class="rounded-xl border border-slate-200 bg-slate-50 p-5 flex items-start gap-3">
            <i data-lucide="alert-triangle" class="w-5 h-5 text-red-500 shrink-0 mt-0.5"></i>
            <div>
              <h3 class="font-semibold text-slate-900 text-sm mb-1">Deploys that 404</h3>
              <p class="text-sm text-slate-600">Build succeeds, deploy "works", page shows nothing. No idea why.</p>
            </div>
          </div>
          <div class="rounded-xl border border-slate-200 bg-slate-50 p-5 flex items-start gap-3">
            <i data-lucide="bug" class="w-5 h-5 text-red-500 shrink-0 mt-0.5"></i>
            <div>
              <h3 class="font-semibold text-slate-900 text-sm mb-1">No error handling, no path to prod</h3>
              <p class="text-sm text-slate-600">First real user breaks something invisible. You can't ship it.</p>
            </div>
          </div>
        </div>
        <p class="text-center text-lg text-slate-700 max-w-2xl mx-auto">
          <span class="font-display font-bold text-slate-900">You don't need another AI tool.</span><br>
          You need someone to ship the damn thing.
        </p>
      </div>
    </section>

    <!-- PRICING / OFFER -->
    <section id="pricing" class="py-20 bg-slate-50 border-t border-slate-100">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-12">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">The offer</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Flat rate. Hard scope. Real product.</h2>
          <p class="text-slate-500 text-lg mt-3 max-w-2xl mx-auto">Pick a tier. We send you a plan within 24 hours. 50% upfront, 50% on delivery.</p>
        </div>

        <div class="grid md:grid-cols-3 gap-6">
          <!-- Starter -->
          <div class="rounded-2xl border border-slate-200 bg-white p-7">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Starter</p>
            <div class="flex items-end gap-2 mb-2">
              <span class="font-display font-bold text-4xl text-slate-900">$999</span>
              <span class="text-slate-500 text-sm mb-1">flat</span>
            </div>
            <p class="text-xs text-slate-500 mb-5">Ships in 1 week</p>
            <ul class="space-y-2.5 mb-7 text-sm">
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Up to 5 features</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Real auth + Postgres</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Deployed to your domain</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Full source code + docs</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Senior engineer review</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> 30 days post-launch support</li>
            </ul>
            <a href="#brief-form-bottom" data-tier="starter" class="tier-cta w-full inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-all">
              Start at $999 <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
          </div>

          <!-- Pro (popular) -->
          <div class="rounded-2xl border-2 border-brand-500 bg-brand-50 p-7 relative shadow-xl price-card-pop transition-transform">
            <div class="absolute -top-3 left-1/2 -translate-x-1/2">
              <span class="text-xs font-bold px-3 py-1 rounded-full bg-brand-600 text-white shadow-lg uppercase tracking-wider">Most popular</span>
            </div>
            <p class="text-xs font-bold text-brand-700 uppercase tracking-wider mb-3">Pro</p>
            <div class="flex items-end gap-2 mb-2">
              <span class="font-display font-bold text-4xl text-slate-900">$1,999</span>
              <span class="text-slate-500 text-sm mb-1">flat</span>
            </div>
            <p class="text-xs text-slate-500 mb-5">Ships in 2 weeks</p>
            <ul class="space-y-2.5 mb-7 text-sm">
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Up to 10 features</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Stripe / payment integration</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> 1 third-party API connection</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Everything in Starter</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> 30 days post-launch support</li>
            </ul>
            <a href="#brief-form-bottom" data-tier="pro" class="tier-cta w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-all">
              Start at $1,999 <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
          </div>

          <!-- Custom -->
          <div class="rounded-2xl border border-slate-200 bg-white p-7">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Custom</p>
            <div class="flex items-end gap-2 mb-2">
              <span class="font-display font-bold text-4xl text-slate-900">From $5k</span>
            </div>
            <p class="text-xs text-slate-500 mb-5">Scoped together</p>
            <ul class="space-y-2.5 mb-7 text-sm">
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Full product scope</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Ongoing builds or sprints</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Dedicated team</li>
              <li class="flex items-start gap-2.5 text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0 mt-0.5"></i> Weekly demos</li>
            </ul>
            <a href="#brief-form-bottom" data-tier="custom" class="tier-cta w-full inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-all">
              Talk to us <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
          </div>
        </div>

        <p class="text-center text-sm text-slate-500 mt-8">
          <i data-lucide="users" class="w-4 h-4 inline align-text-bottom"></i> Maximum 4 builds per week, we don't overcommit.
        </p>
      </div>
    </section>

    <!-- HOW IT WORKS -->
    <section class="py-20 bg-white border-t border-slate-100">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-14">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">How it works</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">From brief to deployed in 4 steps</h2>
        </div>
        <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div class="bg-slate-50 rounded-2xl border border-slate-200 p-6">
            <div class="w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mb-4">
              <i data-lucide="message-square-text" class="w-5 h-5"></i>
            </div>
            <span class="text-xs font-bold text-brand-600 uppercase tracking-wider">01: You</span>
            <h3 class="font-display font-bold text-lg mt-2 mb-2">Brief us</h3>
            <p class="text-sm text-slate-600">Describe what you need. Goals, scope, constraints. We ask the right follow-ups, no bloated discovery calls.</p>
          </div>
          <div class="bg-slate-50 rounded-2xl border border-slate-200 p-6">
            <div class="w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mb-4">
              <i data-lucide="file-text" class="w-5 h-5"></i>
            </div>
            <span class="text-xs font-bold text-brand-600 uppercase tracking-wider">02: Us</span>
            <h3 class="font-display font-bold text-lg mt-2 mb-2">Plan + PRD</h3>
            <p class="text-sm text-slate-600">Within 24 hours, you get a full plan: scope, architecture, delivery timeline, payment link.</p>
          </div>
          <div class="bg-slate-50 rounded-2xl border border-slate-200 p-6">
            <div class="w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mb-4">
              <i data-lucide="terminal" class="w-5 h-5"></i>
            </div>
            <span class="text-xs font-bold text-brand-600 uppercase tracking-wider">03: Us</span>
            <h3 class="font-display font-bold text-lg mt-2 mb-2">Build + test</h3>
            <p class="text-sm text-slate-600">Agents execute in sandboxed environments. Senior engineers review every diff. You see daily progress.</p>
          </div>
          <div class="bg-slate-50 rounded-2xl border border-slate-200 p-6">
            <div class="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center mb-4">
              <i data-lucide="check-circle-2" class="w-5 h-5"></i>
            </div>
            <span class="text-xs font-bold text-emerald-600 uppercase tracking-wider">04: You</span>
            <h3 class="font-display font-bold text-lg mt-2 mb-2">Review + ship</h3>
            <p class="text-sm text-slate-600">Approve, we deploy. Source code + docs handed over. 7-day refund if you don't love it.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- PROOF, real portfolio items -->
    <section class="py-20 bg-slate-50 border-t border-slate-100">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-12">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">Built with the same pipeline</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Real products. In production. Right now.</h2>
          <p class="text-slate-500 text-lg mt-3 max-w-2xl mx-auto">These run on the same agent pipeline that'll build your app.</p>
        </div>

        <div class="grid md:grid-cols-3 gap-6">

          <!-- mags.run -->
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
              <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-1">Cloud platform</p>
              <h3 class="font-display font-bold text-base text-slate-900 mb-1.5">mags.run</h3>
              <p class="text-sm text-slate-500 leading-snug">On-demand cloud VMs for AI agents and developers. Spin up workspaces in seconds.</p>
            </div>
          </a>

          <!-- kitereach.com -->
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
              <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-1">SaaS product</p>
              <h3 class="font-display font-bold text-base text-slate-900 mb-1.5">kitereach.com</h3>
              <p class="text-sm text-slate-500 leading-snug">AI-powered outreach. Multi-channel sequencing, lead discovery, smart follow-ups.</p>
            </div>
          </a>

          <!-- easylogs.co -->
          <a href="https://easylogs.co" target="_blank" rel="noopener noreferrer" class="group rounded-2xl border border-slate-200 bg-white overflow-hidden hover:border-brand-300 hover:shadow-xl transition-all">
            <div class="bg-slate-100 border-b border-slate-200 flex items-center gap-1.5 px-3 py-2">
              <span class="w-2 h-2 rounded-full bg-red-400"></span>
              <span class="w-2 h-2 rounded-full bg-amber-400"></span>
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span class="ml-2 text-[11px] text-slate-500 font-mono">easylogs.co</span>
              <i data-lucide="external-link" class="w-3 h-3 text-slate-400 ml-auto group-hover:text-brand-600"></i>
            </div>
            <div class="aspect-[16/10] overflow-hidden bg-slate-50">
              <img src="/public/images/screenshots/easylogs.png" alt="easylogs.co, Logging for developers" class="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500" loading="lazy" />
            </div>
            <div class="p-5">
              <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-1">Dev tool</p>
              <h3 class="font-display font-bold text-base text-slate-900 mb-1.5">easylogs.co</h3>
              <p class="text-sm text-slate-500 leading-snug">Real-time log streaming, alerts, and search. One-line SDK to integrate.</p>
            </div>
          </a>

        </div>

        <div class="text-center mt-10">
          <a href="/case-studies/" class="inline-flex items-center gap-2 text-sm font-semibold text-brand-600 hover:text-brand-700">
            See full portfolio <i data-lucide="arrow-right" class="w-4 h-4"></i>
          </a>
        </div>
      </div>
    </section>

    <!-- GUARANTEES -->
    <section class="py-24 bg-white border-t border-slate-100 relative overflow-hidden">
      <div class="absolute -top-32 -right-32 w-[500px] h-[500px] rounded-full bg-emerald-100/40 blur-3xl pointer-events-none"></div>
      <div class="absolute -bottom-32 -left-32 w-[500px] h-[500px] rounded-full bg-brand-100/30 blur-3xl pointer-events-none"></div>

      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div class="text-center mb-14">
          <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 mb-4">
            <i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-600"></i>
            <span class="text-xs font-bold text-emerald-700 uppercase tracking-wider">Why this is safe to try</span>
          </span>
          <h2 class="font-display font-bold text-4xl md:text-5xl text-slate-900 leading-tight">
            Five guarantees.<br>
            <span class="text-transparent bg-clip-text bg-gradient-to-r from-emerald-600 to-brand-600">In writing.</span>
          </h2>
        </div>

        <div class="grid md:grid-cols-2 gap-5">
          <div class="guarantee-card group relative rounded-2xl p-6 bg-white border border-slate-200 hover:border-emerald-400 transition-all">
            <div class="flex items-start gap-4">
              <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shrink-0 shadow-lg shadow-emerald-500/30">
                <i data-lucide="clock" class="w-6 h-6 text-white"></i>
              </div>
              <div class="flex-1">
                <h3 class="font-display font-bold text-lg text-slate-900 mb-1.5">Ships on time, or it's free</h3>
                <p class="text-sm text-slate-600 leading-relaxed">Miss the deadline, the deposit comes back. No questions, no negotiation.</p>
              </div>
            </div>
          </div>

          <div class="guarantee-card group relative rounded-2xl p-6 bg-white border border-slate-200 hover:border-emerald-400 transition-all">
            <div class="flex items-start gap-4">
              <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center shrink-0 shadow-lg shadow-brand-500/30">
                <i data-lucide="undo-2" class="w-6 h-6 text-white"></i>
              </div>
              <div class="flex-1">
                <h3 class="font-display font-bold text-lg text-slate-900 mb-1.5">7-day refund window</h3>
                <p class="text-sm text-slate-600 leading-relaxed">Don't love it after delivery? Refund the final 50% within 7 days.</p>
              </div>
            </div>
          </div>

          <div class="guarantee-card group relative rounded-2xl p-6 bg-white border border-slate-200 hover:border-emerald-400 transition-all">
            <div class="flex items-start gap-4">
              <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center shrink-0 shadow-lg shadow-violet-500/30">
                <i data-lucide="key-round" class="w-6 h-6 text-white"></i>
              </div>
              <div class="flex-1">
                <h3 class="font-display font-bold text-lg text-slate-900 mb-1.5">You own everything</h3>
                <p class="text-sm text-slate-600 leading-relaxed">Your repo, your domain, your DB. We don't host or lock anything in.</p>
              </div>
            </div>
          </div>

          <div class="guarantee-card group relative rounded-2xl p-6 bg-white border border-slate-200 hover:border-emerald-400 transition-all">
            <div class="flex items-start gap-4">
              <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-pink-400 to-pink-600 flex items-center justify-center shrink-0 shadow-lg shadow-pink-500/30">
                <i data-lucide="user-check" class="w-6 h-6 text-white"></i>
              </div>
              <div class="flex-1">
                <h3 class="font-display font-bold text-lg text-slate-900 mb-1.5">Senior engineer review</h3>
                <p class="text-sm text-slate-600 leading-relaxed">A human reviews every diff before it ships. No raw AI slop in your codebase.</p>
              </div>
            </div>
          </div>

          <div class="guarantee-card group relative rounded-2xl p-6 bg-gradient-to-br from-slate-900 to-slate-800 text-white md:col-span-2 hover:from-slate-800 hover:to-slate-700 transition-all">
            <div class="flex items-start gap-4">
              <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shrink-0 shadow-lg shadow-amber-500/40">
                <i data-lucide="users" class="w-6 h-6 text-white"></i>
              </div>
              <div class="flex-1">
                <h3 class="font-display font-bold text-lg text-white mb-1.5">Maximum 4 builds per week</h3>
                <p class="text-sm text-slate-300 leading-relaxed">We cap intake to keep the quality bar high. First week typically books out, submit early or wait for the next slot.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- FAQ -->
    <section class="py-20 bg-slate-50 border-t border-slate-100">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-10">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">FAQ</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Common questions</h2>
        </div>
        <div class="space-y-3">
          <details class="group rounded-xl border border-slate-200 bg-white p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>What if I don't like it?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">You get 7 days from delivery to ask for a refund of the final 50% payment. No questions, no hoops. We've already deposited the work into your repo by then so you keep everything.</p>
          </details>
          <details class="group rounded-xl border border-slate-200 bg-white p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>Who owns the code?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">You do. 100%. We push to your GitHub repo and deploy to your domain on your hosting account. We retain no rights and no copies after handover.</p>
          </details>
          <details class="group rounded-xl border border-slate-200 bg-white p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>What's NOT included?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">Native iOS/Android (web-only at these tiers), pixel-perfect Figma builds (we use Tailwind defaults that look great), and ongoing maintenance beyond the included support window. Any of those = Custom tier.</p>
          </details>
          <details class="group rounded-xl border border-slate-200 bg-white p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>How is this different from Replit / Lovable / Bolt?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">Those tools give you a working demo and leave you to figure out the production parts, auth, deploy, error handling, edge cases. We finish the job. Senior engineers review the AI's output before anything ships.</p>
          </details>
          <details class="group rounded-xl border border-slate-200 bg-white p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>What if I need more features later?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">Every build includes 30 days of post-launch support for tweaks and fixes. After that, we offer add-on builds at the same flat-rate model, or a Custom retainer for ongoing work.</p>
          </details>
          <details class="group rounded-xl border border-slate-200 bg-white p-5">
            <summary class="flex items-center justify-between cursor-pointer text-slate-900 font-semibold list-none">
              <span>How does payment work?</span>
              <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 group-open:rotate-180 transition-transform"></i>
            </summary>
            <p class="mt-3 text-sm text-slate-600 leading-relaxed">50% deposit via Stripe to lock your slot ($500 / $1,000), 50% on delivery after you've reviewed and approved. Refund window applies to the delivery payment.</p>
          </details>
        </div>
      </div>
    </section>

    <!-- FORM (bottom, second chance for users who scrolled past hero form) -->
    <section id="brief-form-bottom" class="py-20 bg-white border-t border-slate-100">
      <div class="max-w-xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-8">
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-3">Ready when you are.</h2>
          <p class="text-slate-600">Three fields. Plan in your inbox within 24 hours.</p>
        </div>

        <div class="glass rounded-2xl shadow-2xl p-6 sm:p-8 border border-slate-200/70">
          <form class="lfg-inquiry-form space-y-4">
            <input type="hidden" name="tier" class="tier-input" value="">
            <input type="hidden" name="variant" value="ship-a">
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
              <textarea name="requirements" required rows="5" placeholder="e.g. A CRM where my sales team can log leads, see a kanban pipeline, and get reminders on stale deals. Or: I started this on Lovable but the auth keeps breaking, I need it shipped properly." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
            </div>
            <button type="submit" class="w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3.5 rounded-lg font-semibold text-base transition-all shadow-lg shadow-brand-600/20">
              <i data-lucide="send" class="w-4 h-4"></i>
              <span class="btn-text">Send my plan</span>
            </button>
            <p class="text-xs text-slate-500 text-center">Ships on time or you don't pay · 7-day refund · Your code, your domain</p>
            <div class="form-success hidden text-center py-3 px-4 rounded-lg bg-emerald-50 border border-emerald-200 text-sm font-semibold text-emerald-700">
              <i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i>Got it. We'll send your plan within 24 hours.
            </div>
            <div class="form-error hidden text-center py-3 px-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-600"></div>
          </form>
        </div>
      </div>
    </section>

  </main>

  <!-- Mobile sticky CTA bar (shows on scroll, hides when a form is in view) -->
  <div id="mobile-cta-bar" class="lg:hidden fixed bottom-0 left-0 right-0 z-40 px-3 pb-3 pt-2 transform translate-y-full transition-transform duration-300 pointer-events-none">
    <div class="max-w-md mx-auto bg-white border border-slate-200 rounded-2xl shadow-2xl p-2.5 flex items-center gap-2 pointer-events-auto" style="backdrop-filter: blur(10px);">
      <div class="flex-1 pl-2">
        <p class="text-[11px] text-slate-500 leading-tight">From $999 · Ships in 1 week</p>
        <p class="text-sm font-semibold text-slate-900 leading-tight">Get your build plan</p>
      </div>
      <a href="#brief-form" class="shrink-0 inline-flex items-center justify-center gap-1.5 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2.5 rounded-xl font-semibold text-sm transition-colors">
        Send my plan <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
      </a>
    </div>
  </div>

  <!-- Minimal footer (no nav exits per PRD) -->
  <footer class="py-8 pb-24 lg:pb-8 border-t border-slate-100 bg-slate-50">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <p class="text-xs text-slate-500">&copy; ${new Date().getFullYear()} LFG Inc. · <a href="mailto:hello@lfg.run" class="hover:text-brand-600">hello@lfg.run</a></p>
    </div>
  </footer>

  <script>
    lucide.createIcons();

    // Theme toggle
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

    // Tier CTAs prefill the hidden tier field on ALL forms
    document.querySelectorAll('.tier-cta').forEach(function(a) {
      a.addEventListener('click', function() {
        var t = a.getAttribute('data-tier') || '';
        document.querySelectorAll('.tier-input').forEach(function(input) { input.value = t; });
      });
    });

    // Form submission, handles both hero and bottom forms
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
            if (typeof fbq === 'function') { fbq('track', 'Lead', { content_name: 'ship-a' }); }
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

    // Mobile sticky CTA bar, show after scrolling past hero, hide when any form is visible
    (function() {
      var bar = document.getElementById('mobile-cta-bar');
      if (!bar) return;
      var heroForm = document.getElementById('brief-form');
      var bottomForm = document.getElementById('brief-form-bottom');
      var formInView = false;

      if ('IntersectionObserver' in window) {
        var obs = new IntersectionObserver(function(entries) {
          formInView = entries.some(function(e) { return e.isIntersecting; });
          updateBar();
        }, { threshold: 0.2 });
        if (heroForm) obs.observe(heroForm);
        if (bottomForm) obs.observe(bottomForm);
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

  <!--
    Meta Pixel placeholder, drop your <script>fbq init</script> block here once the pixel ID is confirmed.
    Then the Lead event above will fire on form success.
  -->

</body>
</html>
`;
