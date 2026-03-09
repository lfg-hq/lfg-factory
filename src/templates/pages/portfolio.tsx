import { html } from "hono/html";
import { Nav, Footer } from "../components/nav.tsx";

export const PortfolioPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Portfolio | Built with LFG Agent</title>
    <meta name="description" content="Real products shipped using LFG Agent — from idea to working software in days. See what AI-first engineering looks like in production.">

    <meta property="og:title" content="Portfolio | Built with LFG Agent">
    <meta property="og:description" content="Real products shipped using LFG Agent — from idea to working software in days.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://lfg.run/portfolio/">
    <meta property="og:image" content="https://lfg.run/static/images/logo_lfg.png">

    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="Portfolio | Built with LFG Agent">
    <meta name="twitter:description" content="Real products shipped using LFG Agent — from idea to working software in days.">
    <meta name="twitter:image" content="https://lfg.run/static/images/logo_lfg.png">

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
              ink: { 900:'#0f172a' },
              accent: { 500:'#ec4899',600:'#db2777' }
            },
            animation: {
              'fade-in':'fadeIn 0.5s ease-out',
              'fade-up':'fadeUp 0.6s ease-out both',
              'drift':'drift 8s ease-in-out infinite',
            },
            keyframes: {
              fadeIn:{'0%':{opacity:'0'},'100%':{opacity:'1'}},
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
      .glass { background: rgba(255,255,255,0.85); border: 1px solid rgba(148,163,184,0.24); backdrop-filter: blur(10px); }
      .glow-brand { box-shadow: 0 0 30px rgba(99,102,241,0.15), 0 0 60px rgba(99,102,241,0.05); }
      .project-card { transition: all 0.3s ease; }
      .project-card:hover { transform: translateY(-4px); box-shadow: 0 20px 60px rgba(99,102,241,0.12); }
      .screenshot-frame { transition: all 0.3s ease; }
      .project-card:hover .screenshot-frame { border-color: #6366f1; }
      @keyframes fadeIn { 0% { opacity:0; } 100% { opacity:1; } }
      @keyframes fadeUp { 0% { opacity:0; transform:translateY(20px); } 100% { opacity:1; transform:translateY(0); } }
      @keyframes drift { 0%,100% { transform:translateY(0px); } 50% { transform:translateY(-10px); } }
    </style>
</head>
<body class="text-slate-900 font-sans selection:bg-indigo-600 selection:text-white">

    ${ Nav({ activePage: "portfolio" }) }

    <main>

      <!-- HERO -->
      <section class="relative pt-28 sm:pt-40 pb-16 sm:pb-20 overflow-hidden mesh">
        <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
        <div class="absolute top-20 left-[5%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div class="text-center max-w-3xl mx-auto">
            <div class="inline-flex items-center gap-2 px-4 py-2 rounded-full glass shadow-sm mb-8 animate-fade-up">
              <i data-lucide="layers" class="w-3.5 h-3.5 text-brand-600"></i>
              <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">Products we built</span>
            </div>
            <h1 class="font-display font-semibold text-3xl sm:text-4xl md:text-5xl lg:text-6xl leading-[1.1] tracking-tight text-slate-900 animate-fade-up" style="animation-delay:0.1s">
              We build real products.<br><span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">Here's the proof.</span>
            </h1>
            <p class="text-lg sm:text-xl text-slate-600 mt-7 max-w-2xl mx-auto leading-relaxed animate-fade-up" style="animation-delay:0.2s">
              Every product below is live, solves a real problem we had, and runs on the same LFG Agent pipeline we sell. Not demos. Not side projects. Tools we depend on every day — and we keep building more.
            </p>
            <div class="mt-8 flex flex-wrap items-center justify-center gap-4 animate-fade-up" style="animation-delay:0.3s">
              <a href="/agent/" class="px-7 py-3.5 rounded-full bg-brand-600 text-white font-semibold hover:bg-brand-700 transition-all inline-flex items-center gap-2 shadow-lg shadow-brand-600/25">
                See how LFG Agent builds <i data-lucide="arrow-right" class="w-4 h-4"></i>
              </a>
            </div>
          </div>

          <!-- Role cards -->
          <div class="mt-14 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto animate-fade-up" style="animation-delay:0.4s">
            <div class="glass rounded-xl p-5 text-center">
              <div class="w-9 h-9 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center mx-auto mb-3">
                <i data-lucide="server" class="w-4 h-4"></i>
              </div>
              <p class="font-display font-semibold text-sm text-slate-900">mags.run</p>
              <p class="text-xs text-slate-500 mt-1">Cloud VM platform</p>
            </div>
            <div class="glass rounded-xl p-5 text-center">
              <div class="w-9 h-9 rounded-lg bg-pink-100 text-pink-700 flex items-center justify-center mx-auto mb-3">
                <i data-lucide="send" class="w-4 h-4"></i>
              </div>
              <p class="font-display font-semibold text-sm text-slate-900">kitereach.com</p>
              <p class="text-xs text-slate-500 mt-1">AI outreach platform</p>
            </div>
            <div class="glass rounded-xl p-5 text-center">
              <div class="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-3">
                <i data-lucide="activity" class="w-4 h-4"></i>
              </div>
              <p class="font-display font-semibold text-sm text-slate-900">easylogs.co</p>
              <p class="text-xs text-slate-500 mt-1">Developer logging</p>
            </div>
            <div class="rounded-xl p-5 text-center border-2 border-dashed border-slate-200 bg-white/40">
              <div class="w-9 h-9 rounded-lg bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
                <i data-lucide="plus" class="w-4 h-4"></i>
              </div>
              <p class="font-display font-semibold text-sm text-slate-400">More coming</p>
              <p class="text-xs text-slate-400 mt-1">Always shipping</p>
            </div>
          </div>
        </div>
      </section>

      <!-- FLYWHEEL -->
      <section class="py-16 bg-slate-50 border-t border-slate-100">
        <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div class="text-center mb-12">
            <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">The flywheel</p>
            <h2 class="font-display font-bold text-2xl md:text-3xl text-slate-900">How they cross-feed each other</h2>
            <p class="text-slate-500 text-base mt-3 max-w-xl mx-auto">Each product feeds data, users, and learnings back into the others. The more we ship, the tighter the loop gets.</p>
          </div>
          <div class="relative">
            <!-- Connection lines (decorative, hidden on mobile) -->
            <div class="hidden lg:block absolute inset-0 pointer-events-none">
              <svg class="w-full h-full" viewBox="0 0 900 220" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
                <path d="M180 110 Q340 40 450 110 Q560 180 720 110" stroke="#c7d2fe" stroke-width="1.5" stroke-dasharray="6 4" fill="none"/>
                <path d="M180 110 Q340 180 450 110 Q560 40 720 110" stroke="#fbcfe8" stroke-width="1.5" stroke-dasharray="6 4" fill="none"/>
              </svg>
            </div>
            <div class="grid lg:grid-cols-4 gap-6 relative z-10">
              <!-- LFG Agent -->
              <div class="bg-white rounded-xl border-2 border-brand-200 p-5 shadow-sm">
                <div class="w-10 h-10 rounded-xl bg-brand-600 text-white flex items-center justify-center mb-3">
                  <i data-lucide="rocket" class="w-5 h-5"></i>
                </div>
                <h3 class="font-display font-bold text-base text-slate-900 mb-2">LFG Agent</h3>
                <p class="text-xs text-slate-500 leading-relaxed">Builds all three products. Every ticket executed, every feature shipped — done by the same agent we sell.</p>
                <div class="mt-3 pt-3 border-t border-slate-100">
                  <p class="text-xs font-semibold text-brand-600">Gives → all three</p>
                </div>
              </div>
              <!-- mags.run -->
              <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
                <div class="w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mb-3">
                  <i data-lucide="server" class="w-5 h-5"></i>
                </div>
                <h3 class="font-display font-bold text-base text-slate-900 mb-2">mags.run</h3>
                <p class="text-xs text-slate-500 leading-relaxed">Powers the sandboxed VM layer that LFG Agent runs Claude Code in. Every ticket execution happens on a Mags workspace.</p>
                <div class="mt-3 pt-3 border-t border-slate-100">
                  <p class="text-xs font-semibold text-indigo-600">Gives → LFG compute layer</p>
                </div>
              </div>
              <!-- kitereach.com -->
              <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
                <div class="w-10 h-10 rounded-xl bg-pink-100 text-pink-700 flex items-center justify-center mb-3">
                  <i data-lucide="send" class="w-5 h-5"></i>
                </div>
                <h3 class="font-display font-bold text-base text-slate-900 mb-2">kitereach.com</h3>
                <p class="text-xs text-slate-500 leading-relaxed">Runs LFG's outbound strategy. Finds founders, startups, and teams who need to ship fast and puts LFG in front of them.</p>
                <div class="mt-3 pt-3 border-t border-slate-100">
                  <p class="text-xs font-semibold text-pink-600">Gives → LFG pipeline &amp; users</p>
                </div>
              </div>
              <!-- easylogs.co -->
              <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
                <div class="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center mb-3">
                  <i data-lucide="activity" class="w-5 h-5"></i>
                </div>
                <h3 class="font-display font-bold text-base text-slate-900 mb-2">easylogs.co</h3>
                <p class="text-xs text-slate-500 leading-relaxed">Monitors all of it — LFG's infra, Mags workspaces, and Kitereach sequences. When something breaks, we know first.</p>
                <div class="mt-3 pt-3 border-t border-slate-100">
                  <p class="text-xs font-semibold text-emerald-600">Gives → full observability</p>
                </div>
              </div>
            </div>
          </div>
          <!-- Summary callout -->
          <div class="mt-10 bg-white rounded-xl border border-brand-200 p-6">
            <div class="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div class="shrink-0 w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center">
                <i data-lucide="refresh-cw" class="w-5 h-5"></i>
              </div>
              <p class="text-sm text-slate-600 leading-relaxed">
                LFG Agent builds products → <span class="font-semibold text-brand-600">Mags</span> runs the sandboxed execution that powers every agent session → <span class="font-semibold text-pink-600">Kitereach</span> finds the next wave of users for LFG and Mags → <span class="font-semibold text-emerald-600">Easylogs</span> keeps everything observable across all three. Each product stress-tests LFG Agent, making it sharper for the next ship.
              </p>
            </div>
          </div>
        </div>
      </section>

      <!-- PROJECTS -->
      <section class="py-16 sm:py-24 bg-white border-t border-slate-100">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

          <!-- mags.run -->
          <div class="project-card rounded-2xl border border-slate-200 bg-white overflow-hidden mb-10 shadow-sm">
            <div class="grid lg:grid-cols-5 gap-0">
              <!-- Screenshot -->
              <div class="lg:col-span-3 relative overflow-hidden bg-slate-50 border-b lg:border-b-0 lg:border-r border-slate-200">
                <div class="flex items-center gap-1.5 px-4 py-2.5 bg-slate-100 border-b border-slate-200">
                  <span class="w-2.5 h-2.5 rounded-full bg-red-400"></span>
                  <span class="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                  <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                  <span class="ml-2 text-xs text-slate-400 font-mono">mags.run</span>
                  <a href="https://mags.run" target="_blank" rel="noopener noreferrer" class="ml-auto text-slate-400 hover:text-brand-600 transition-colors">
                    <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                  </a>
                </div>
                <a href="https://mags.run" target="_blank" rel="noopener noreferrer" class="block">
                  <img
                    src="/public/images/screenshots/mags.png"
                    alt="mags.run — Cloud VM platform for AI workloads"
                    class="w-full object-cover object-top"
                    loading="lazy"
                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                  />
                  <div class="hidden w-full h-64 items-center justify-center bg-gradient-to-br from-indigo-50 to-slate-100">
                    <div class="text-center">
                      <i data-lucide="globe" class="w-10 h-10 text-brand-300 mx-auto mb-2"></i>
                      <p class="text-sm text-slate-400">mags.run</p>
                    </div>
                  </div>
                </a>
              </div>
              <!-- Details -->
              <div class="lg:col-span-2 p-8 flex flex-col justify-center">
                <div class="flex items-center gap-2 mb-4">
                  <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-50 border border-brand-200 text-xs font-bold text-brand-700 uppercase tracking-wider">
                    <i data-lucide="sparkles" class="w-3 h-3"></i> Built with LFG Agent
                  </span>
                </div>
                <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-3">
                  <a href="https://mags.run" target="_blank" rel="noopener noreferrer" class="hover:text-brand-600 transition-colors">mags.run</a>
                </h2>
                <p class="text-slate-600 leading-relaxed mb-6">
                  A cloud platform for spinning up developer VMs and AI workspaces on-demand. Designed for teams that need isolated, reproducible environments without the DevOps overhead. Provision a workspace in seconds, run your code, and tear it down when done.
                </p>
                <div class="space-y-2 mb-6">
                  <div class="flex items-center gap-2 text-sm text-slate-600">
                    <i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i>
                    On-demand cloud VMs for AI agents and developers
                  </div>
                  <div class="flex items-center gap-2 text-sm text-slate-600">
                    <i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i>
                    Persistent and ephemeral workspace modes
                  </div>
                  <div class="flex items-center gap-2 text-sm text-slate-600">
                    <i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i>
                    SDK + API for programmatic control
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <a href="https://mags.run" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-brand-600 text-white font-semibold text-sm hover:bg-brand-700 transition-all shadow shadow-brand-600/20">
                    Visit site <i data-lucide="arrow-up-right" class="w-3.5 h-3.5"></i>
                  </a>
                  <span class="flex items-center gap-1.5 text-xs text-slate-400">
                    <i data-lucide="zap" class="w-3.5 h-3.5 text-amber-500"></i>
                    Production
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- kitereach.com -->
          <div class="project-card rounded-2xl border border-slate-200 bg-white overflow-hidden mb-10 shadow-sm">
            <div class="grid lg:grid-cols-5 gap-0">
              <!-- Details first on lg -->
              <div class="lg:col-span-2 p-8 flex flex-col justify-center order-2 lg:order-1 border-t lg:border-t-0 lg:border-r border-slate-200">
                <div class="flex items-center gap-2 mb-4">
                  <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-50 border border-brand-200 text-xs font-bold text-brand-700 uppercase tracking-wider">
                    <i data-lucide="sparkles" class="w-3 h-3"></i> Built with LFG Agent
                  </span>
                </div>
                <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-3">
                  <a href="https://kitereach.com" target="_blank" rel="noopener noreferrer" class="hover:text-brand-600 transition-colors">kitereach.com</a>
                </h2>
                <p class="text-slate-600 leading-relaxed mb-6">
                  An AI-powered outreach platform built to help sales teams find, qualify, and engage leads at scale. Combines AI-written personalization with multi-channel sequencing — email, LinkedIn, and beyond — so your team spends time closing, not cold-messaging.
                </p>
                <div class="space-y-2 mb-6">
                  <div class="flex items-center gap-2 text-sm text-slate-600">
                    <i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i>
                    AI-personalized outreach at scale
                  </div>
                  <div class="flex items-center gap-2 text-sm text-slate-600">
                    <i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i>
                    Multi-channel sequences with smart follow-ups
                  </div>
                  <div class="flex items-center gap-2 text-sm text-slate-600">
                    <i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i>
                    Lead discovery and qualification built in
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <a href="https://kitereach.com" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-brand-600 text-white font-semibold text-sm hover:bg-brand-700 transition-all shadow shadow-brand-600/20">
                    Visit site <i data-lucide="arrow-up-right" class="w-3.5 h-3.5"></i>
                  </a>
                  <span class="flex items-center gap-1.5 text-xs text-slate-400">
                    <i data-lucide="zap" class="w-3.5 h-3.5 text-amber-500"></i>
                    Production
                  </span>
                </div>
              </div>
              <!-- Screenshot -->
              <div class="lg:col-span-3 relative overflow-hidden bg-slate-50 order-1 lg:order-2">
                <div class="flex items-center gap-1.5 px-4 py-2.5 bg-slate-100 border-b border-slate-200">
                  <span class="w-2.5 h-2.5 rounded-full bg-red-400"></span>
                  <span class="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                  <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                  <span class="ml-2 text-xs text-slate-400 font-mono">kitereach.com</span>
                  <a href="https://kitereach.com" target="_blank" rel="noopener noreferrer" class="ml-auto text-slate-400 hover:text-brand-600 transition-colors">
                    <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                  </a>
                </div>
                <a href="https://kitereach.com" target="_blank" rel="noopener noreferrer" class="block">
                  <img
                    src="/public/images/screenshots/kitereach.png"
                    alt="kitereach.com — AI outreach platform"
                    class="w-full object-cover object-top"
                    loading="lazy"
                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                  />
                  <div class="hidden w-full h-64 items-center justify-center bg-gradient-to-br from-indigo-50 to-slate-100">
                    <div class="text-center">
                      <i data-lucide="globe" class="w-10 h-10 text-brand-300 mx-auto mb-2"></i>
                      <p class="text-sm text-slate-400">kitereach.com</p>
                    </div>
                  </div>
                </a>
              </div>
            </div>
          </div>

          <!-- easylogs.co -->
          <div class="project-card rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
            <div class="grid lg:grid-cols-5 gap-0">
              <!-- Screenshot -->
              <div class="lg:col-span-3 relative overflow-hidden bg-slate-50 border-b lg:border-b-0 lg:border-r border-slate-200">
                <div class="flex items-center gap-1.5 px-4 py-2.5 bg-slate-100 border-b border-slate-200">
                  <span class="w-2.5 h-2.5 rounded-full bg-red-400"></span>
                  <span class="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                  <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                  <span class="ml-2 text-xs text-slate-400 font-mono">easylogs.co</span>
                  <a href="https://easylogs.co" target="_blank" rel="noopener noreferrer" class="ml-auto text-slate-400 hover:text-brand-600 transition-colors">
                    <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                  </a>
                </div>
                <a href="https://easylogs.co" target="_blank" rel="noopener noreferrer" class="block">
                  <img
                    src="/public/images/screenshots/easylogs.png"
                    alt="easylogs.co — Simple logging for developers"
                    class="w-full object-cover object-top"
                    loading="lazy"
                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                  />
                  <div class="hidden w-full h-64 items-center justify-center bg-gradient-to-br from-indigo-50 to-slate-100">
                    <div class="text-center">
                      <i data-lucide="globe" class="w-10 h-10 text-brand-300 mx-auto mb-2"></i>
                      <p class="text-sm text-slate-400">easylogs.co</p>
                    </div>
                  </div>
                </a>
              </div>
              <!-- Details -->
              <div class="lg:col-span-2 p-8 flex flex-col justify-center">
                <div class="flex items-center gap-2 mb-4">
                  <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-50 border border-brand-200 text-xs font-bold text-brand-700 uppercase tracking-wider">
                    <i data-lucide="sparkles" class="w-3 h-3"></i> Built with LFG Agent
                  </span>
                </div>
                <h2 class="font-display font-bold text-2xl sm:text-3xl text-slate-900 mb-3">
                  <a href="https://easylogs.co" target="_blank" rel="noopener noreferrer" class="hover:text-brand-600 transition-colors">easylogs.co</a>
                </h2>
                <p class="text-slate-600 leading-relaxed mb-6">
                  A lightweight logging platform for developers who want application visibility without the complexity. Drop in the SDK, stream your logs in real-time, set alerts, and search everything — no Elasticsearch clusters to manage, no per-seat pricing bloat.
                </p>
                <div class="space-y-2 mb-6">
                  <div class="flex items-center gap-2 text-sm text-slate-600">
                    <i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i>
                    Real-time log streaming with search and filters
                  </div>
                  <div class="flex items-center gap-2 text-sm text-slate-600">
                    <i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i>
                    Alerts and anomaly detection built in
                  </div>
                  <div class="flex items-center gap-2 text-sm text-slate-600">
                    <i data-lucide="check" class="w-4 h-4 text-brand-600 shrink-0"></i>
                    Simple SDK — one line to integrate
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <a href="https://easylogs.co" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-brand-600 text-white font-semibold text-sm hover:bg-brand-700 transition-all shadow shadow-brand-600/20">
                    Visit site <i data-lucide="arrow-up-right" class="w-3.5 h-3.5"></i>
                  </a>
                  <span class="flex items-center gap-1.5 text-xs text-slate-400">
                    <i data-lucide="zap" class="w-3.5 h-3.5 text-amber-500"></i>
                    Production
                  </span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </section>

      <!-- HOW WE BUILD -->
      <section class="py-20 bg-slate-50 border-t border-slate-100">
        <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div class="text-center mb-14">
            <p class="text-sm font-bold text-brand-600 uppercase tracking-wider mb-2">The process</p>
            <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">How each of these was built</h2>
            <p class="text-slate-600 text-lg mt-4 max-w-2xl mx-auto">Every product above followed the same AI-first pipeline — no months of planning, no large eng team.</p>
          </div>
          <div class="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div class="bg-white rounded-xl border border-slate-200 p-6 text-center">
              <div class="w-12 h-12 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mx-auto mb-4">
                <i data-lucide="message-square-text" class="w-6 h-6"></i>
              </div>
              <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">01</p>
              <h3 class="font-display font-semibold text-base text-slate-900 mb-2">Describe the idea</h3>
              <p class="text-sm text-slate-500">Plain-English brief to LFG Agent. What it does, who it's for, what success looks like.</p>
            </div>
            <div class="bg-white rounded-xl border border-slate-200 p-6 text-center">
              <div class="w-12 h-12 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mx-auto mb-4">
                <i data-lucide="file-text" class="w-6 h-6"></i>
              </div>
              <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">02</p>
              <h3 class="font-display font-semibold text-base text-slate-900 mb-2">PRD &amp; technical plan</h3>
              <p class="text-sm text-slate-500">Agent generates a full PRD and architecture. You review and approve in minutes.</p>
            </div>
            <div class="bg-white rounded-xl border border-slate-200 p-6 text-center">
              <div class="w-12 h-12 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mx-auto mb-4">
                <i data-lucide="list-checks" class="w-6 h-6"></i>
              </div>
              <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">03</p>
              <h3 class="font-display font-semibold text-base text-slate-900 mb-2">Tickets &amp; execution</h3>
              <p class="text-sm text-slate-500">Agent breaks the plan into tickets and runs Claude Code sessions for each one.</p>
            </div>
            <div class="bg-white rounded-xl border border-slate-200 p-6 text-center">
              <div class="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-4">
                <i data-lucide="rocket" class="w-6 h-6"></i>
              </div>
              <p class="text-xs font-bold text-emerald-600 uppercase tracking-wider mb-2">04</p>
              <h3 class="font-display font-semibold text-base text-slate-900 mb-2">Review &amp; ship</h3>
              <p class="text-sm text-slate-500">You review the working product, approve, and deploy. Done in days.</p>
            </div>
          </div>
        </div>
      </section>

      <!-- MORE COMING -->
      <section class="py-16 bg-white border-t border-slate-100">
        <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div class="grid md:grid-cols-2 gap-6 items-center">
            <div>
              <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-50 border border-brand-200 mb-5">
                <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
                <span class="text-xs font-bold text-brand-700 uppercase tracking-wider">Always shipping</span>
              </div>
              <h2 class="font-display font-bold text-2xl md:text-3xl text-slate-900 mb-4">This portfolio keeps growing</h2>
              <p class="text-slate-600 leading-relaxed mb-4">
                We're not a studio that ships on contract and moves on. Every product we build becomes part of the stack we run. We keep using, improving, and expanding each one — and LFG Agent keeps getting better with every project.
              </p>
              <p class="text-slate-600 leading-relaxed">
                More products are in the pipeline. Some solve problems in our own workflow. Some are standalone ideas. All of them are built with the same agent you can use today.
              </p>
            </div>
            <div class="bg-slate-50 rounded-2xl border border-slate-200 p-7">
              <div class="space-y-4">
                <div class="flex items-start gap-3">
                  <div class="w-8 h-8 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center shrink-0 mt-0.5">
                    <i data-lucide="check" class="w-4 h-4"></i>
                  </div>
                  <div>
                    <p class="font-semibold text-sm text-slate-900">Built with LFG Agent</p>
                    <p class="text-xs text-slate-500 mt-0.5">Every product starts as a brief. The agent ships it.</p>
                  </div>
                </div>
                <div class="flex items-start gap-3">
                  <div class="w-8 h-8 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center shrink-0 mt-0.5">
                    <i data-lucide="check" class="w-4 h-4"></i>
                  </div>
                  <div>
                    <p class="font-semibold text-sm text-slate-900">In production, not demos</p>
                    <p class="text-xs text-slate-500 mt-0.5">Real traffic, real users, real problems being solved.</p>
                  </div>
                </div>
                <div class="flex items-start gap-3">
                  <div class="w-8 h-8 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center shrink-0 mt-0.5">
                    <i data-lucide="check" class="w-4 h-4"></i>
                  </div>
                  <div>
                    <p class="font-semibold text-sm text-slate-900">Cross-feeding by design</p>
                    <p class="text-xs text-slate-500 mt-0.5">Every product makes the next one faster to build.</p>
                  </div>
                </div>
                <div class="flex items-start gap-3">
                  <div class="w-8 h-8 rounded-lg bg-pink-100 text-pink-700 flex items-center justify-center shrink-0 mt-0.5">
                    <i data-lucide="plus" class="w-4 h-4"></i>
                  </div>
                  <div>
                    <p class="font-semibold text-sm text-slate-900">More coming</p>
                    <p class="text-xs text-slate-500 mt-0.5">We ship, learn, and add. This page will keep updating.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- GET INVOLVED -->
      <section class="py-20 bg-slate-900 border-t border-slate-800">
        <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div class="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 mb-5">
                <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                <span class="text-xs font-bold text-slate-300 uppercase tracking-wider">Open to connect</span>
              </div>
              <h2 class="font-display font-bold text-2xl md:text-3xl text-white mb-4">Want to be part of what we're building?</h2>
              <p class="text-slate-400 leading-relaxed mb-6">
                Whether you want to use one of our products, collaborate on something new, invest, or just follow the journey — we'd love to hear from you. We're a small team building fast, and the right conversations open the right doors.
              </p>
              <div class="space-y-3">
                <div class="flex items-center gap-3 text-sm text-slate-400">
                  <i data-lucide="users" class="w-4 h-4 text-brand-400 shrink-0"></i>
                  Founders and teams wanting to build faster
                </div>
                <div class="flex items-center gap-3 text-sm text-slate-400">
                  <i data-lucide="handshake" class="w-4 h-4 text-brand-400 shrink-0"></i>
                  Partners interested in integrating our tools
                </div>
                <div class="flex items-center gap-3 text-sm text-slate-400">
                  <i data-lucide="lightbulb" class="w-4 h-4 text-brand-400 shrink-0"></i>
                  Investors who get the flywheel
                </div>
                <div class="flex items-center gap-3 text-sm text-slate-400">
                  <i data-lucide="code-2" class="w-4 h-4 text-brand-400 shrink-0"></i>
                  Builders who want to contribute
                </div>
              </div>
            </div>
            <div>
              <form id="connect-form" class="space-y-4">
                <div>
                  <input
                    type="text"
                    id="connect-name"
                    placeholder="Your name"
                    class="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-500 transition-colors"
                    required
                  />
                </div>
                <div>
                  <input
                    type="email"
                    id="connect-email"
                    placeholder="Your email"
                    class="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-500 transition-colors"
                    required
                  />
                </div>
                <div>
                  <textarea
                    id="connect-message"
                    placeholder="What are you thinking? (investing, partnering, building together, just curious...)"
                    rows="4"
                    class="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-brand-500 transition-colors resize-none"
                    required
                  ></textarea>
                </div>
                <button
                  type="submit"
                  id="connect-btn"
                  class="w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-500 text-white px-6 py-3.5 rounded-xl font-semibold text-sm transition-all"
                >
                  <i data-lucide="send" class="w-4 h-4"></i>
                  <span id="connect-btn-text">Send message</span>
                </button>
                <div id="connect-success" class="hidden text-center py-3 text-sm text-emerald-400 font-medium">
                  <i data-lucide="check-circle" class="w-4 h-4 inline mr-1.5"></i>Got it — we'll be in touch.
                </div>
                <div id="connect-error" class="hidden text-center py-3 text-sm text-red-400">
                  Something went wrong. Email us directly at <a href="mailto:hello@lfg.run" class="underline">hello@lfg.run</a>
                </div>
              </form>
            </div>
          </div>
        </div>
      </section>

    </main>

    ${ Footer() }

    <script>
      lucide.createIcons();

      // Connect form
      document.getElementById('connect-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('connect-btn');
        const btnText = document.getElementById('connect-btn-text');
        const success = document.getElementById('connect-success');
        const error = document.getElementById('connect-error');
        submitBtn.disabled = true;
        btnText.textContent = 'Sending...';
        success.classList.add('hidden');
        error.classList.add('hidden');
        try {
          const res = await fetch('/api/portfolio/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: document.getElementById('connect-name').value,
              email: document.getElementById('connect-email').value,
              message: document.getElementById('connect-message').value,
            }),
          });
          if (res.ok) {
            success.classList.remove('hidden');
            document.getElementById('connect-form').reset();
          } else {
            error.classList.remove('hidden');
          }
        } catch {
          error.classList.remove('hidden');
        } finally {
          submitBtn.disabled = false;
          btnText.textContent = 'Send message';
          lucide.createIcons();
        }
      });
    </script>

</body>
</html>
`;
