import { html } from "hono/html";
import { Nav, Footer } from "../components/nav.tsx";

export const ServicesPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LFG | Done-for-you delivery on the factory</title>
  <meta name="description" content="Some teams license the LFG factory and run it themselves. Others want us to run it. Same pipeline either way — planned, built, and senior-reviewed, with the code handed over.">
  <meta property="og:title" content="LFG | Done-for-you delivery on the factory">
  <meta property="og:description" content="Some teams license the factory. Others want us to run it. Same pipeline either way.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://lfg.run/services/">
  <meta property="og:image" content="https://lfg.run/public/images/screenshots/agent-ticket-board.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="LFG | Done-for-you delivery on the factory">
  <meta name="twitter:description" content="Some teams license the factory. Others want us to run it. Same pipeline either way.">
  <meta name="twitter:image" content="https://lfg.run/public/images/screenshots/agent-ticket-board.png">
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
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
          animation: {
            'fade-up':'fadeUp 0.6s ease-out both',
            'drift':'drift 8s ease-in-out infinite',
          },
          keyframes: {
            fadeUp:{'0%':{opacity:'0',transform:'translateY(20px)'},'100%':{opacity:'1',transform:'translateY(0)'}},
            drift:{'0%,100%':{transform:'translateY(0px)'},'50%':{transform:'translateY(-10px)'}},
          }
        }
      }
    }
  </script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    body { background: radial-gradient(circle at 20% 0%, #eef2ff 0%, #f8fafc 38%, #ffffff 100%); overflow-x: hidden; }
    .mesh { background-image: radial-gradient(circle at 10% 20%, rgba(99,102,241,0.14), transparent 40%), radial-gradient(circle at 80% 0%, rgba(236,72,153,0.12), transparent 35%); }
    .glass { background: rgba(255,255,255,0.9); border: 1px solid rgba(148,163,184,0.2); backdrop-filter: blur(10px); }
    .step-line { position: relative; }
    .step-line::after { content: ''; position: absolute; top: 20px; left: calc(50% + 20px); width: calc(100% - 40px); height: 1px; background: linear-gradient(90deg, #c7d2fe, transparent); }
    .step-line:last-child::after { display: none; }
    /* Dark mode overrides for this page */
    html.dark body { background: radial-gradient(circle at 15% 0%, #1a1040 0%, #0d1117 45%, #0d1117 100%) !important; }
    html.dark .mesh { background-image: radial-gradient(circle at 10% 20%, rgba(99,102,241,0.18), transparent 45%), radial-gradient(circle at 80% 0%, rgba(139,92,246,0.14), transparent 40%) !important; }
    html.dark .glass { background: rgba(22,27,34,0.85) !important; border-color: rgba(99,102,241,0.15) !important; }
    html.dark .blur-3xl { opacity: 0.15 !important; }
  </style>
</head>
<body class="text-slate-900 font-sans selection:bg-indigo-600 selection:text-white">

  ${ Nav({ activePage: "services" }) }

  <main>

    <!-- HERO -->
    <section class="relative pt-28 sm:pt-36 pb-16 overflow-hidden mesh">
      <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
      <div class="absolute top-20 left-[5%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div class="grid lg:grid-cols-2 gap-14 items-start">

          <!-- Left: pitch -->
          <div class="animate-fade-up">
            <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass shadow-sm mb-7">
              <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
              <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">A service tier of the product</span>
            </div>
            <h1 class="font-display font-bold text-4xl sm:text-5xl leading-[1.1] tracking-tight text-slate-900 mb-5">
              Done-for-you delivery.<br>
              <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">We run the factory for you.</span>
            </h1>
            <p class="text-lg text-slate-600 leading-relaxed mb-6">
              Some teams license the factory and run it inside their own org. Others want us to run it. Same pipeline either way: PRD, dependency-aware ticket graph, sandboxed agent execution, senior review on every diff, and the source handed over at the end.
            </p>
            <p class="text-base text-slate-600 leading-relaxed mb-8">
              Would rather run it yourself? <a href="/" class="font-semibold text-brand-600 hover:text-brand-700 transition-colors">See the factory</a>.
            </p>

            <!-- Process pills -->
            <div class="flex flex-col sm:flex-row gap-4 mb-8">
              <div class="flex items-center gap-3 bg-white rounded-xl border border-slate-200 px-4 py-3 shadow-sm">
                <div class="w-8 h-8 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center shrink-0">
                  <i data-lucide="file-text" class="w-4 h-4"></i>
                </div>
                <div>
                  <p class="text-xs font-bold text-slate-900">Plan</p>
                  <p class="text-xs text-slate-500">PRD + architecture</p>
                </div>
              </div>
              <div class="flex items-center gap-3 bg-white rounded-xl border border-slate-200 px-4 py-3 shadow-sm">
                <div class="w-8 h-8 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center shrink-0">
                  <i data-lucide="terminal" class="w-4 h-4"></i>
                </div>
                <div>
                  <p class="text-xs font-bold text-slate-900">Build</p>
                  <p class="text-xs text-slate-500">Agents + engineers</p>
                </div>
              </div>
              <div class="flex items-center gap-3 bg-white rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 shadow-sm">
                <div class="w-8 h-8 rounded-lg bg-brand-600 text-white flex items-center justify-center shrink-0">
                  <i data-lucide="rocket" class="w-4 h-4"></i>
                </div>
                <div>
                  <p class="text-xs font-bold text-brand-900">Ship</p>
                  <p class="text-xs text-brand-600">Deployed + handed over</p>
                </div>
              </div>
            </div>

            <div class="flex flex-wrap gap-2 mb-8">
              <span class="text-xs font-semibold px-3 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600">Web apps</span>
              <span class="text-xs font-semibold px-3 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600">Mobile apps</span>
              <span class="text-xs font-semibold px-3 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600">Cloud + infra</span>
              <span class="text-xs font-semibold px-3 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600">AI features</span>
              <span class="text-xs font-semibold px-3 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600">CI/CD + docs</span>
            </div>

            <div class="flex items-center gap-4">
              <a href="#services-form" class="px-6 py-3 rounded-full bg-slate-900 text-white font-semibold hover:bg-brand-700 transition-colors inline-flex items-center gap-2">
                Tell us what to build <i data-lucide="arrow-right" class="w-4 h-4"></i>
              </a>
              <p class="text-sm text-slate-500">We reply within 24 hours.</p>
            </div>
          </div>

          <!-- Right: form -->
          <div id="services-form" class="glass rounded-2xl shadow-2xl p-6 border border-slate-200/70 animate-fade-up" style="animation-delay:0.15s">
            <div class="mb-5">
              <h2 class="font-display font-bold text-xl text-slate-900">Tell us what to build</h2>
              <p class="text-sm text-slate-500 mt-1">Fill this out and we'll send you a plan within 24 hours.</p>
            </div>
            <form id="inquiry-form" class="space-y-4">
              <div class="grid sm:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs font-semibold text-slate-600 mb-1 block">Name *</label>
                  <input name="name" required placeholder="Your name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                </div>
                <div>
                  <label class="text-xs font-semibold text-slate-600 mb-1 block">Email *</label>
                  <input name="email" type="email" required placeholder="you@company.com" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                </div>
              </div>
              <div class="grid sm:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs font-semibold text-slate-600 mb-1 block">Company</label>
                  <input name="company" placeholder="Acme Corp" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                </div>
                <div>
                  <label class="text-xs font-semibold text-slate-600 mb-1 block">Role</label>
                  <input name="role" placeholder="Founder, CTO, PM..." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                </div>
              </div>
              <div class="grid sm:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs font-semibold text-slate-600 mb-1 block">Timeline</label>
                  <input name="timeline" placeholder="e.g. 2–4 weeks" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                </div>
                <div>
                  <label class="text-xs font-semibold text-slate-600 mb-1 block">Budget</label>
                  <input name="budget" placeholder="e.g. $999 or custom" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                </div>
              </div>
              <div>
                <label class="text-xs font-semibold text-slate-600 mb-1 block">What do you need built? *</label>
                <textarea name="requirements" required rows="4" placeholder="Describe the product, key features, and what success looks like." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
              </div>
              <button type="submit" class="w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-all shadow-lg shadow-brand-600/20">
                <i data-lucide="send" class="w-4 h-4"></i>
                <span class="btn-text">Submit request</span>
              </button>
              <div id="form-success" class="hidden text-center py-2 text-sm font-semibold text-emerald-600">
                <i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i>Got it, we'll reply within 24 hours.
              </div>
              <div id="form-error" class="hidden text-center py-2 text-sm text-red-500"></div>
            </form>
          </div>

        </div>
      </div>
    </section>

    <!-- WORKING UNDER A PARTNER'S BRAND -->
    <section class="py-16 bg-white border-t border-slate-100">
      <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="rounded-2xl border-2 border-brand-200 bg-brand-50 p-8 sm:p-10">
          <div class="flex items-start gap-4">
            <div class="w-11 h-11 rounded-xl bg-brand-600 text-white flex items-center justify-center shrink-0">
              <i data-lucide="handshake" class="w-5 h-5"></i>
            </div>
            <div>
              <h2 class="font-display font-bold text-2xl text-slate-900 mb-3">If you are an agency, we work behind you</h2>
              <p class="text-slate-700 leading-relaxed mb-4">
                When we deliver under a services firm's brand, we work as a subcontractor. Your client relationship, your invoice, your name on the release. We do not approach your clients, and we do not put your logo in our marketing without asking.
              </p>
              <p class="text-slate-600 text-sm leading-relaxed">
                Plenty of firms start here for one project, then license the factory and bring it in-house once their own engineers have seen it run. That is the intended path, not a lost sale.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- WHAT WE BUILD -->
    <section class="py-20 bg-white border-t border-slate-100">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-12">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">What we build</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Full-stack delivery, any type of product</h2>
          <p class="text-slate-500 text-lg mt-3 max-w-2xl mx-auto">We handle the whole build, not just code. Design, architecture, deployment, docs, and CI/CD included.</p>
        </div>
        <div class="grid md:grid-cols-3 gap-6">
          <div class="rounded-2xl border border-slate-200 bg-slate-50 p-6 hover:border-brand-300 hover:shadow-lg transition-all">
            <div class="w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mb-4">
              <i data-lucide="layout" class="w-5 h-5"></i>
            </div>
            <h3 class="font-display font-bold text-lg mb-2">Web apps</h3>
            <p class="text-sm text-slate-600 leading-relaxed">Customer portals, admin dashboards, SaaS platforms, AI-powered tools. Production-ready, not prototypes.</p>
            <ul class="mt-4 space-y-1.5 text-xs text-slate-500">
              <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i> Multi-tenant architecture</li>
              <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i> Auth, billing, roles built in</li>
              <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i> Mobile-responsive by default</li>
            </ul>
          </div>
          <div class="rounded-2xl border border-slate-200 bg-slate-50 p-6 hover:border-brand-300 hover:shadow-lg transition-all">
            <div class="w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mb-4">
              <i data-lucide="smartphone" class="w-5 h-5"></i>
            </div>
            <h3 class="font-display font-bold text-lg mb-2">Mobile apps</h3>
            <p class="text-sm text-slate-600 leading-relaxed">iOS and Android builds with clean UX, offline-first architecture, push notifications, and analytics.</p>
            <ul class="mt-4 space-y-1.5 text-xs text-slate-500">
              <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i> React Native or native</li>
              <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i> App Store ready builds</li>
              <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i> Synced backend APIs</li>
            </ul>
          </div>
          <div class="rounded-2xl border border-slate-200 bg-slate-50 p-6 hover:border-brand-300 hover:shadow-lg transition-all">
            <div class="w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mb-4">
              <i data-lucide="cloud" class="w-5 h-5"></i>
            </div>
            <h3 class="font-display font-bold text-lg mb-2">Cloud + delivery</h3>
            <p class="text-sm text-slate-600 leading-relaxed">Infrastructure setup, CI/CD pipelines, containerisation, monitoring, and full handover documentation.</p>
            <ul class="mt-4 space-y-1.5 text-xs text-slate-500">
              <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i> AWS / GCP / Fly / Railway</li>
              <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i> GitHub Actions or similar</li>
              <li class="flex items-center gap-2"><i data-lucide="check" class="w-3.5 h-3.5 text-brand-500"></i> Source code + runbooks</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- HOW IT WORKS -->
    <section class="py-20 bg-slate-50 border-t border-slate-100">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-14">
          <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">How it works</p>
          <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">From brief to deployed in 4 steps</h2>
          <p class="text-slate-500 text-lg mt-3">You describe what you need. We plan, build, and ship. You review at each step.</p>
        </div>
        <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div class="bg-white rounded-2xl border border-slate-200 p-6 relative">
            <div class="w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mb-4">
              <i data-lucide="message-square-text" class="w-5 h-5"></i>
            </div>
            <span class="text-xs font-bold text-brand-600 uppercase tracking-wider">01: You</span>
            <h3 class="font-display font-bold text-lg mt-2 mb-2">Brief us</h3>
            <p class="text-sm text-slate-600">Tell us what you need. Goals, scope, constraints. We ask the right follow-up questions, no bloated discovery calls.</p>
          </div>
          <div class="bg-white rounded-2xl border border-brand-200 bg-brand-50/30 p-6 relative">
            <div class="w-10 h-10 rounded-xl bg-brand-200 text-brand-700 flex items-center justify-center mb-4">
              <i data-lucide="file-text" class="w-5 h-5"></i>
            </div>
            <span class="text-xs font-bold text-brand-600 uppercase tracking-wider">02: Us</span>
            <h3 class="font-display font-bold text-lg mt-2 mb-2">Plan + PRD</h3>
            <p class="text-sm text-slate-600">LFG Agent generates a full product requirements document, technical architecture, and delivery tickets. You approve before we write a line of code.</p>
          </div>
          <div class="bg-white rounded-2xl border border-brand-200 bg-brand-50/30 p-6 relative">
            <div class="w-10 h-10 rounded-xl bg-brand-200 text-brand-700 flex items-center justify-center mb-4">
              <i data-lucide="terminal" class="w-5 h-5"></i>
            </div>
            <span class="text-xs font-bold text-brand-600 uppercase tracking-wider">03: Us</span>
            <h3 class="font-display font-bold text-lg mt-2 mb-2">Build + test</h3>
            <p class="text-sm text-slate-600">Agents execute tickets in sandboxed environments. Senior engineers review every diff. You see daily progress, real working software, not status updates.</p>
          </div>
          <div class="bg-white rounded-2xl border border-slate-200 p-6 relative">
            <div class="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center mb-4">
              <i data-lucide="check-circle-2" class="w-5 h-5"></i>
            </div>
            <span class="text-xs font-bold text-emerald-600 uppercase tracking-wider">04: You</span>
            <h3 class="font-display font-bold text-lg mt-2 mb-2">Review + ship</h3>
            <p class="text-sm text-slate-600">You review the working product. Approve and we deploy. Request changes and we iterate immediately. Full source code and docs handed over.</p>
          </div>
        </div>
        <div class="mt-8 text-center">
          <p class="text-sm text-slate-500"><span class="font-semibold text-brand-600">You touch steps 1 and 4.</span> The build pipeline runs autonomously in between.</p>
        </div>
      </div>
    </section>

    <!-- PRICING -->
    <section class="py-20 bg-white border-t border-slate-100">
      <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="grid md:grid-cols-2 gap-6">
          <!-- Intro plan -->
          <div class="rounded-2xl border-2 border-brand-200 bg-brand-50 p-8 relative overflow-hidden">
            <div class="absolute top-4 right-4">
              <span class="text-xs font-bold px-2.5 py-1 rounded-full bg-brand-600 text-white">Popular</span>
            </div>
            <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-3">Intro build</p>
            <div class="flex items-end gap-2 mb-4">
              <span class="font-display font-bold text-4xl text-slate-900">$999</span>
              <span class="text-slate-500 text-sm mb-1">one-time</span>
            </div>
            <p class="text-sm text-slate-600 mb-6">A focused build delivered in under a week. Scoped, planned, built, and deployed with full handover. Limited features, ideal for MVPs and proof-of-concepts.</p>
            <ul class="space-y-2.5 mb-8">
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> PRD + technical plan included</li>
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> Up to 5 core features</li>
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> Deployed to production</li>
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> Source code + docs handed over</li>
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> Senior engineer review</li>
            </ul>
            <a href="#services-form" class="w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-all">
              Start for $999 <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
          </div>
          <!-- Custom plan -->
          <div class="rounded-2xl border border-slate-200 bg-white p-8">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Custom build</p>
            <div class="flex items-end gap-2 mb-4">
              <span class="font-display font-bold text-4xl text-slate-900">Custom</span>
            </div>
            <p class="text-sm text-slate-600 mb-6">For full products, ongoing builds, or teams that need to scale fast. We scope together and agree on a delivery plan that fits your timeline and budget.</p>
            <ul class="space-y-2.5 mb-8">
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> Full product scope</li>
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> Ongoing sprints or fixed price</li>
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> Dedicated delivery team</li>
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> Weekly demos + review calls</li>
              <li class="flex items-center gap-2.5 text-sm text-slate-700"><i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i> Optional maintenance retainer</li>
            </ul>
            <a href="#services-form" class="w-full inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-all">
              Talk to us <i data-lucide="arrow-right" class="w-4 h-4"></i>
            </a>
          </div>
        </div>
      </div>
    </section>

    <!-- CLOSING CTA -->
    <section class="py-16 bg-slate-900 border-t border-slate-800">
      <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 class="font-display font-bold text-3xl md:text-4xl text-white mb-4">Ready to start building?</h2>
        <p class="text-slate-400 mb-8">Fill out the form above and we'll come back with a plan within 24 hours. No commitment until you're happy with the scope.</p>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <a href="#services-form" class="inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 text-white px-8 py-3.5 rounded-lg font-semibold transition-all">
            <i data-lucide="send" class="w-4 h-4"></i> Submit your project
          </a>
          <a href="/agent/" class="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 text-white px-8 py-3.5 rounded-lg font-semibold transition-all border border-white/20">
            See how LFG Agent works
          </a>
        </div>
      </div>
    </section>

  </main>

  ${ Footer() }

  <script>
    lucide.createIcons();

    const form = document.getElementById('inquiry-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      const btnText = form.querySelector('.btn-text');
      const success = document.getElementById('form-success');
      const error = document.getElementById('form-error');
      success.classList.add('hidden');
      error.classList.add('hidden');
      btn.disabled = true;
      btnText.textContent = 'Submitting...';

      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const res = await fetch('/api/services/inquiry', {
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
        btnText.textContent = 'Submit request';
      }
    });
  </script>

</body>
</html>
`;
