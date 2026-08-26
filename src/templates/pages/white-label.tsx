import { html } from "hono/html";
import { Nav, Footer } from "../components/nav.tsx";
import { ModelStrip } from "../components/model-strip.tsx";

/**
 * White-label — a managed, branded LFG instance that we operate for a firm.
 *
 * Deliberately scoped to what actually ships: we run the deployment, so the
 * branding is something we configure per instance, not a settings toggle in
 * the product. There is no org-branding UI (the organizations schema is not
 * wired to any route yet) and no theme editor, so neither is claimed here.
 * Share links are real but cover files and tickets only — described as such.
 */
export const WhiteLabelPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LFG | White-label the factory. Deliver AI-built software under your own brand.</title>
    <meta name="description" content="A managed LFG instance we run for your firm, on your domain, with your models and your repositories. Your clients see your brand, not ours.">
    <link rel="canonical" href="https://lfg.run/white-label/">
    <meta property="og:title" content="White-label the factory | LFG">
    <meta property="og:description" content="A managed LFG instance we run for your firm, on your domain, with your models and your repositories. Your clients see your brand, not ours.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://lfg.run/white-label/">
    <meta property="og:image" content="https://lfg.run/public/images/screenshots/agent-ticket-board.png">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="White-label the factory | LFG">
    <meta name="twitter:description" content="A managed LFG instance we run for your firm, on your domain, with your models and your repositories.">
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
              ink: { 900:'#0f172a' },
              accent: { 500:'#ec4899',600:'#db2777' }
            },
            animation: {
              'fade-in':'fadeIn 0.5s ease-out','fade-up':'fadeUp 0.6s ease-out both','drift':'drift 8s ease-in-out infinite',
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
    </style>
</head>
<body class="text-slate-900 font-sans selection:bg-indigo-600 selection:text-white">

    ${ Nav({ activePage: "white-label" }) }

    <main>
        <!-- HERO -->
        <section class="relative pt-28 sm:pt-40 pb-20 sm:pb-24 overflow-hidden mesh">
            <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
            <div class="absolute top-20 left-[5%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>
            <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10 text-center">
                <div class="inline-flex items-center gap-2 px-4 py-2 rounded-full glass shadow-sm mb-8 animate-fade-up">
                    <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
                    <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">Managed white-label</span>
                </div>
                <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.1] tracking-tight text-slate-900 animate-fade-up">
                    Your factory.
                    <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">Your name on it.</span>
                </h1>
                <p class="text-lg text-slate-600 mt-6 max-w-2xl mx-auto leading-relaxed animate-fade-up">
                    Deliver AI-built software under your own brand. We stand up and operate a dedicated LFG instance for your firm &mdash; your domain, your models, your repositories. Your clients see your work, not our logo.
                </p>
                <div class="mt-8 flex flex-col sm:flex-row gap-3 justify-center animate-fade-up">
                    <a href="#inquiry" class="px-7 py-3 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
                        Talk to us about white-label <i data-lucide="arrow-right" class="w-4 h-4"></i>
                    </a>
                    <a href="/agent/" class="px-7 py-3 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
                        <i data-lucide="play" class="w-4 h-4"></i> See what it runs
                    </a>
                </div>
                <p class="mt-5 text-xs text-slate-500 animate-fade-up">Operated by us &middot; MIT-licensed core &middot; no lock-in</p>
            </div>
        </section>

        <!-- WHO IT IS FOR -->
        <section class="py-20 bg-white border-t border-slate-100">
            <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="text-center max-w-2xl mx-auto mb-12">
                    <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Who this is for</p>
                    <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Firms that sell delivery, not tooling</h2>
                    <p class="text-slate-600 text-lg mt-4">You already have the client relationships. What you need is capacity that does not come with a hiring cycle &mdash; and it has to carry your name.</p>
                </div>
                <div class="grid md:grid-cols-3 gap-6">
                    <div class="rounded-2xl border border-slate-200 bg-white p-7">
                        <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="building-2" class="w-5 h-5"></i></div>
                        <h3 class="font-display font-bold text-lg mb-2">Agencies and studios</h3>
                        <p class="text-sm text-slate-600 leading-relaxed">Take on more concurrent client work without the bench. Every artifact your client touches carries your brand.</p>
                    </div>
                    <div class="rounded-2xl border border-slate-200 bg-white p-7">
                        <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="briefcase" class="w-5 h-5"></i></div>
                        <h3 class="font-display font-bold text-lg mb-2">IT services firms</h3>
                        <p class="text-sm text-slate-600 leading-relaxed">Answer the "what is your AI story" question with a running pipeline rather than a slide, and keep fixed-price margins intact.</p>
                    </div>
                    <div class="rounded-2xl border border-slate-200 bg-white p-7">
                        <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="package" class="w-5 h-5"></i></div>
                        <h3 class="font-display font-bold text-lg mb-2">Product firms reselling build</h3>
                        <p class="text-sm text-slate-600 leading-relaxed">Offer implementation and customisation around your own product without standing up a second engineering org.</p>
                    </div>
                </div>
            </div>
        </section>

        <!-- WHAT STAYS YOURS -->
        <section class="py-20 bg-slate-50 border-t border-slate-100">
            <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="max-w-2xl mb-12">
                    <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">The split</p>
                    <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">We run the machine. You own the relationship.</h2>
                </div>
                <div class="grid lg:grid-cols-2 gap-6">
                    <div class="rounded-2xl border border-brand-200 bg-white p-8">
                        <div class="flex items-center gap-2 mb-5">
                            <i data-lucide="user-check" class="w-4 h-4 text-brand-600"></i>
                            <p class="text-xs font-bold text-brand-700 uppercase tracking-wider">Yours</p>
                        </div>
                        <ul class="space-y-3.5 text-sm text-slate-700">
                            <li class="flex gap-3"><i data-lucide="globe" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i><span><strong>Your domain.</strong> The instance runs where you point it, under a hostname you control.</span></li>
                            <li class="flex gap-3"><i data-lucide="git-branch" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i><span><strong>Your repositories.</strong> Branches, commits and pull requests land in your Git, on GitHub or GitLab.</span></li>
                            <li class="flex gap-3"><i data-lucide="key-round" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i><span><strong>Your model keys.</strong> Bring your own accounts; token spend is billed to you, not marked up by us.</span></li>
                            <li class="flex gap-3"><i data-lucide="database" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i><span><strong>Your data.</strong> Database and file storage live in your account when you want them there.</span></li>
                            <li class="flex gap-3"><i data-lucide="handshake" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i><span><strong>Your client relationship.</strong> We have no contract, contact or visibility with the people you serve.</span></li>
                        </ul>
                    </div>
                    <div class="rounded-2xl border border-slate-200 bg-white p-8">
                        <div class="flex items-center gap-2 mb-5">
                            <i data-lucide="settings" class="w-4 h-4 text-slate-500"></i>
                            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider">Ours to run</p>
                        </div>
                        <ul class="space-y-3.5 text-sm text-slate-700">
                            <li class="flex gap-3"><i data-lucide="rocket" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span><strong>Deployment.</strong> We stand the instance up and configure it as your build environment.</span></li>
                            <li class="flex gap-3"><i data-lucide="refresh-cw" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span><strong>Upgrades.</strong> New agent capabilities reach your instance without you scheduling a migration.</span></li>
                            <li class="flex gap-3"><i data-lucide="activity" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span><strong>Monitoring and patching.</strong> We watch the runtime and keep dependencies current.</span></li>
                            <li class="flex gap-3"><i data-lucide="life-buoy" class="w-4 h-4 text-slate-400 mt-0.5 shrink-0"></i><span><strong>A route to us.</strong> Your engineers get a direct line when the pipeline misbehaves.</span></li>
                        </ul>
                    </div>
                </div>
            </div>
        </section>

        <!-- MODELS -->
        <section class="py-16 bg-white border-t border-slate-100">
            <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="text-center max-w-2xl mx-auto mb-10">
                    <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Model policy is yours</p>
                    <h2 class="font-display font-bold text-3xl text-slate-900">Run whichever models your clients allow</h2>
                    <p class="text-slate-600 mt-4">Some clients will not let their code near a US frontier lab. Others want the strongest model regardless of cost. Set the policy per project.</p>
                </div>
                ${ ModelStrip() }
            </div>
        </section>

        <!-- HOW IT WORKS -->
        <section class="py-20 bg-slate-50 border-t border-slate-100">
            <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="text-center max-w-2xl mx-auto mb-12">
                    <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Getting started</p>
                    <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Four steps to your own instance</h2>
                </div>
                <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
                    <div class="rounded-2xl border border-slate-200 bg-white p-6">
                        <p class="text-xs font-bold text-brand-600 mb-3">01</p>
                        <h3 class="font-display font-bold text-base mb-2">Scope the fit</h3>
                        <p class="text-sm text-slate-600 leading-relaxed">A call about your delivery model, your stack and the clients this has to satisfy.</p>
                    </div>
                    <div class="rounded-2xl border border-slate-200 bg-white p-6">
                        <p class="text-xs font-bold text-brand-600 mb-3">02</p>
                        <h3 class="font-display font-bold text-base mb-2">We stand it up</h3>
                        <p class="text-sm text-slate-600 leading-relaxed">Your instance, on your hostname, wired to your Git and your model accounts.</p>
                    </div>
                    <div class="rounded-2xl border border-slate-200 bg-white p-6">
                        <p class="text-xs font-bold text-brand-600 mb-3">03</p>
                        <h3 class="font-display font-bold text-base mb-2">Run one real project</h3>
                        <p class="text-sm text-slate-600 leading-relaxed">Your engineers take a live brief through it end to end and judge the output themselves.</p>
                    </div>
                    <div class="rounded-2xl border border-brand-200 bg-white p-6">
                        <p class="text-xs font-bold text-brand-600 mb-3">04</p>
                        <h3 class="font-display font-bold text-base mb-2">Deliver under your brand</h3>
                        <p class="text-sm text-slate-600 leading-relaxed">Roll it across the portfolio at whatever pace your delivery leads are comfortable with.</p>
                    </div>
                </div>
            </div>
        </section>

        <!-- HONESTY BLOCK -->
        <section class="py-20 bg-white border-t border-slate-100">
            <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
                <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Straight answer</p>
                <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-6">What white-label means here, exactly</h2>
                <p class="text-slate-600 text-lg leading-relaxed mb-5">
                    This is an operated service, not a checkbox in a settings screen. There is no theme editor to log into and no self-serve branding panel &mdash; we configure a dedicated instance for your firm and run it. That is a deliberate choice: it means the arrangement is a conversation and a contract rather than a plan tier.
                </p>
                <p class="text-slate-600 text-lg leading-relaxed mb-8">
                    It also means we will tell you plainly what a given deployment can and cannot carry before you sign anything, rather than after.
                </p>
                <div class="rounded-2xl border-l-4 border-brand-500 bg-slate-50 p-6">
                    <p class="text-slate-700 leading-relaxed">
                        If you would rather not have us in the loop at all, you do not need us. The core is MIT-licensed &mdash; clone it, brand it, run it yourself, and never send us an email.
                        <a href="/self-host/" class="font-semibold text-brand-700 hover:text-brand-800 inline-flex items-center gap-1 whitespace-nowrap">See self-hosting <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i></a>
                    </p>
                </div>
            </div>
        </section>

        <!-- FAQ -->
        <section class="py-20 bg-slate-50 border-t border-slate-100">
            <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
                <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-10">Questions firms actually ask</h2>
                <div class="space-y-7">
                    <div>
                        <p class="font-display font-bold text-lg text-slate-900 mb-2">Will my client ever see the name LFG?</p>
                        <p class="text-slate-600 leading-relaxed">Not in anything you hand them. The code goes to your repositories and the deliverable is yours. Tell us during scoping which surfaces your clients will actually touch and we will walk through each one with you.</p>
                    </div>
                    <div>
                        <p class="font-display font-bold text-lg text-slate-900 mb-2">Who owns the code the agent writes?</p>
                        <p class="text-slate-600 leading-relaxed">You do, and so does your client under whatever terms you already have with them. It lands in your Git from the first commit. We claim nothing over it.</p>
                    </div>
                    <div>
                        <p class="font-display font-bold text-lg text-slate-900 mb-2">What happens if we stop working together?</p>
                        <p class="text-slate-600 leading-relaxed">The core is MIT-licensed, so you can keep running it yourself. Your repositories, your data and your model accounts were never ours to withhold.</p>
                    </div>
                    <div>
                        <p class="font-display font-bold text-lg text-slate-900 mb-2">Can we host it in our own cloud?</p>
                        <p class="text-slate-600 leading-relaxed">Yes. We can operate an instance inside your account, or run it in ours. Regulated clients usually push you toward the former, and that is fine.</p>
                    </div>
                    <div>
                        <p class="font-display font-bold text-lg text-slate-900 mb-2">How is it priced?</p>
                        <p class="text-slate-600 leading-relaxed">Per firm, and it depends on how many instances and how much of the operating load you want us carrying. Model tokens are billed to your own accounts, not resold through us. We will quote after the scoping call.</p>
                    </div>
                    <div>
                        <p class="font-display font-bold text-lg text-slate-900 mb-2">Do our engineers still review the work?</p>
                        <p class="text-slate-600 leading-relaxed">Yes, and that does not change. The pipeline plans, builds and tests; a human on your side approves before anything ships. Your name is on the delivery, so your people hold the gate.</p>
                    </div>
                </div>
            </div>
        </section>

        <!-- INQUIRY -->
        <section id="inquiry" class="py-20 bg-white border-t border-slate-100">
            <div class="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="text-center mb-8">
                    <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-3">Put your name on the factory</h2>
                    <p class="text-slate-600">Tell us about your firm and we will come back within a day with whether this is a fit and what it would cost.</p>
                </div>
                <div class="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-xl">
                    <form id="wl-form" class="space-y-4">
                        <div class="grid sm:grid-cols-2 gap-3">
                            <div>
                                <label class="text-xs font-semibold text-slate-600 mb-1 block">Name *</label>
                                <input name="name" required placeholder="Your name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                            </div>
                            <div>
                                <label class="text-xs font-semibold text-slate-600 mb-1 block">Work email *</label>
                                <input name="email" type="email" required placeholder="you@firm.com" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                            </div>
                        </div>
                        <div class="grid sm:grid-cols-2 gap-3">
                            <div>
                                <label class="text-xs font-semibold text-slate-600 mb-1 block">Firm *</label>
                                <input name="firm" required placeholder="Firm name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
                            </div>
                            <div>
                                <label class="text-xs font-semibold text-slate-600 mb-1 block">Delivery headcount</label>
                                <select name="headcount" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white text-slate-700">
                                    <option value="">Select range</option>
                                    <option value="1-10">1-10</option>
                                    <option value="10-50">10-50</option>
                                    <option value="50-200">50-200</option>
                                    <option value="200-1000">200-1000</option>
                                    <option value="1000+">1000+</option>
                                </select>
                            </div>
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-600 mb-1 block">Where should it run?</label>
                            <select name="hosting" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white text-slate-700">
                                <option value="">Not sure yet</option>
                                <option value="Our cloud account">Our own cloud account</option>
                                <option value="LFG operated">Operated by LFG</option>
                                <option value="On-premise">On-premise</option>
                            </select>
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-600 mb-1 block">What would you white-label it for? *</label>
                            <textarea name="context" required rows="4" placeholder="The kind of client work you deliver, and what your clients need to see." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
                        </div>
                        <button type="submit" class="w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-colors">
                            <i data-lucide="send" class="w-4 h-4"></i>
                            <span class="btn-text">Start the conversation</span>
                        </button>
                        <div id="wl-success" class="hidden text-center py-2 text-sm font-semibold text-emerald-600">
                            <i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i>Got it. We will reply within 24 hours.
                        </div>
                        <div id="wl-error" class="hidden text-center py-2 text-sm text-red-500"></div>
                    </form>
                </div>
            </div>
        </section>
    </main>

    ${ Footer() }

    <script>
      lucide.createIcons();

      var wlForm = document.getElementById('wl-form');
      wlForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var btn = wlForm.querySelector('button[type="submit"]');
        var btnText = wlForm.querySelector('.btn-text');
        var success = document.getElementById('wl-success');
        var error = document.getElementById('wl-error');
        success.classList.add('hidden');
        error.classList.add('hidden');
        btn.disabled = true;
        btnText.textContent = 'Sending...';

        var data = Object.fromEntries(new FormData(wlForm).entries());

        var FREE = ['gmail.com','googlemail.com','yahoo.com','yahoo.co.in','hotmail.com','outlook.com','live.com','aol.com','icloud.com','me.com','proton.me','protonmail.com','mail.com','gmx.com','yandex.com','rediffmail.com'];
        var domain = String(data.email || '').split('@')[1];
        domain = domain ? domain.toLowerCase().trim() : '';
        if (domain && FREE.indexOf(domain) !== -1) {
          error.textContent = 'Please use your work email address, not a personal one.';
          error.classList.remove('hidden');
          btn.disabled = false;
          btnText.textContent = 'Start the conversation';
          return;
        }

        try {
          var res = await fetch('/api/white-label/inquiry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          if (res.ok) {
            wlForm.reset();
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
          btnText.textContent = 'Start the conversation';
        }
      });
    </script>
</body>
</html>
`;
