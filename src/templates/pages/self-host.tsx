import { html } from "hono/html";
import { Nav, Footer } from "../components/nav.tsx";
import { ModelStrip } from "../components/model-strip.tsx";

export const SelfHostPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LFG | Self-host your AI agent. Your infra, your models, your data.</title>
    <meta name="description" content="LFG is open source and self-hostable. Run the whole AI product-development agent on your own server with Docker, bring your own model and API key, and keep your data.">
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

    ${ Nav({ activePage: "self-host" }) }

    <main>
        <!-- HERO -->
        <section class="relative pt-28 sm:pt-40 pb-20 sm:pb-24 overflow-hidden mesh">
            <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
            <div class="absolute top-20 left-[5%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>
            <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10 text-center">
                <div class="inline-flex items-center gap-2 px-4 py-2 rounded-full glass shadow-sm mb-8 animate-fade-up">
                    <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                    <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">Open source &middot; MIT</span>
                </div>
                <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.1] tracking-tight text-slate-900 animate-fade-up">
                    Your agent. Your infra.
                    <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">Your data.</span>
                </h1>
                <p class="text-lg text-slate-600 mt-6 max-w-2xl mx-auto leading-relaxed animate-fade-up">
                    LFG is fully open source. Run the entire AI product-development agent on your own server with Docker, bring your own model and API key, and keep every byte of your data in-house. No vendor lock-in.
                </p>
                <div class="mt-8 flex flex-col sm:flex-row gap-3 justify-center animate-fade-up">
                    <a href="#quickstart" class="px-7 py-3 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
                        Self-host in minutes <i data-lucide="arrow-right" class="w-4 h-4"></i>
                    </a>
                    <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="px-7 py-3 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
                        <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg> View on GitHub
                    </a>
                </div>
            </div>
        </section>

        <!-- QUICK START -->
        <section id="quickstart" class="py-20 bg-white border-t border-slate-100">
            <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="text-center max-w-2xl mx-auto mb-10">
                    <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Quick start</p>
                    <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Up and running in one command</h2>
                    <p class="text-slate-600 text-lg mt-4">The default setup uses SQLite and local file storage, so there's nothing external to provision for local dev.</p>
                </div>
                <div class="flex items-center justify-end mb-3">
                    <button onclick="copyCmd(this)" class="flex items-center gap-2 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 px-4 py-2 rounded-lg transition-colors">
                        <i data-lucide="copy" class="w-4 h-4"></i><span class="btn-text">Copy</span>
                    </button>
                </div>
                <div class="bg-[#0f172a] rounded-xl shadow-2xl overflow-hidden border border-slate-800 font-mono text-sm leading-relaxed">
                    <div class="flex items-center gap-2 px-4 py-3 bg-[#1e293b] border-b border-slate-700">
                        <div class="w-3 h-3 rounded-full bg-[#ff5f56]"></div>
                        <div class="w-3 h-3 rounded-full bg-[#ffbd2e]"></div>
                        <div class="w-3 h-3 rounded-full bg-[#27c93f]"></div>
                        <span class="ml-2 text-xs text-slate-400">bash</span>
                    </div>
                    <div class="p-6 text-slate-300 overflow-x-auto">
<pre id="sh-commands"># Clone and install (needs Bun)
git clone https://github.com/lfg-hq/lfg.git && cd lfg
bun install

# Configure: set BETTER_AUTH_SECRET + one AI provider key
cp example.env .env

# Start (runs migrations, serves on :3000)
bun run dev</pre>
                    </div>
                </div>
            </div>
        </section>

        <!-- SANDBOX BACKENDS -->
        <section class="py-20 bg-slate-50 border-t border-slate-100">
            <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="text-center max-w-2xl mx-auto mb-12">
                    <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Sandboxes</p>
                    <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Run builds on your own machines</h2>
                    <p class="text-slate-600 text-lg mt-4">Every app the agent builds runs in an isolated sandbox. Choose where that compute lives.</p>
                </div>
                <div class="grid md:grid-cols-2 gap-6">
                    <div class="rounded-2xl border border-brand-200 bg-white p-7">
                        <div class="w-11 h-11 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center mb-4">
                            <i data-lucide="server" class="w-5 h-5"></i>
                        </div>
                        <h3 class="font-display font-bold text-xl text-slate-900 mb-2">Docker (self-hosted)</h3>
                        <p class="text-slate-600 leading-relaxed">Each sandbox is an isolated Docker container on your own server, from a prebuilt image with Node, Python, and the coding agents baked in. No third-party compute, your code never leaves your box.</p>
                    </div>
                    <div class="rounded-2xl border border-slate-200 bg-white p-7">
                        <div class="w-11 h-11 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center mb-4">
                            <i data-lucide="cloud" class="w-5 h-5"></i>
                        </div>
                        <h3 class="font-display font-bold text-xl text-slate-900 mb-2">Managed VMs (hosted)</h3>
                        <p class="text-slate-600 leading-relaxed">Prefer not to manage compute? Point LFG at hosted Firecracker micro-VMs and get public preview URLs out of the box. Flip a single env var to switch backends.</p>
                    </div>
                </div>
            </div>
        </section>

        <!-- MODELS -->
        <section class="py-20 bg-white border-t border-slate-100">
            <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
                <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Bring your own model</p>
                <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Works with every major model</h2>
                <p class="text-slate-600 text-lg mt-4 max-w-2xl mx-auto">Use your own API keys. Switch models per task, cost, or capability, no provider lock-in.</p>
                <div class="mt-8">
                    ${ ModelStrip() }
                </div>
                <p class="text-slate-500 text-sm mt-6">Anthropic &middot; OpenAI &middot; Google &middot; xAI &middot; DeepSeek &middot; Moonshot &middot; Z.ai</p>
            </div>
        </section>

        <!-- OWN YOUR DATA -->
        <section class="py-20 bg-slate-50 border-t border-slate-100">
            <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="grid md:grid-cols-3 gap-6">
                    <div class="rounded-2xl border border-slate-200 bg-white p-6">
                        <div class="w-10 h-10 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="database" class="w-5 h-5"></i></div>
                        <h3 class="font-display font-bold text-lg mb-2">Your database</h3>
                        <p class="text-slate-600 text-sm leading-relaxed">SQLite out of the box, or point it at your own Postgres. Your data lives where you put it.</p>
                    </div>
                    <div class="rounded-2xl border border-slate-200 bg-white p-6">
                        <div class="w-10 h-10 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="hard-drive" class="w-5 h-5"></i></div>
                        <h3 class="font-display font-bold text-lg mb-2">Your files</h3>
                        <p class="text-slate-600 text-sm leading-relaxed">Store uploads on the local disk, or plug in S3. One env var flips between them.</p>
                    </div>
                    <div class="rounded-2xl border border-slate-200 bg-white p-6">
                        <div class="w-10 h-10 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="lock" class="w-5 h-5"></i></div>
                        <h3 class="font-display font-bold text-lg mb-2">Your keys</h3>
                        <p class="text-slate-600 text-sm leading-relaxed">Secrets are encrypted at rest and stay on your infrastructure. Nothing phones home.</p>
                    </div>
                </div>
            </div>
        </section>

        <!-- MANAGED -->
        <section class="py-20 bg-white border-t border-slate-100">
            <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="rounded-3xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-8 sm:p-12 text-center">
                    <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-brand-200 shadow-sm mb-6">
                        <span class="w-2 h-2 rounded-full bg-brand-500"></span>
                        <span class="text-xs font-bold text-brand-700 uppercase tracking-wider">Managed hosting</span>
                    </div>
                    <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Prefer we run it for you?</h2>
                    <p class="text-slate-600 text-lg mt-4 max-w-2xl mx-auto">Don't want to manage the infrastructure? We offer fully managed, dedicated LFG instances, hosted, scaled, and maintained by us, with your models and isolated data. Tell us what you need and we'll set you up.</p>
                    <div class="mt-8">
                        <a href="mailto:hello@lfg.run?subject=Managed%20LFG%20instance" class="px-7 py-3 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
                            <i data-lucide="mail" class="w-4 h-4"></i> Talk to us
                        </a>
                    </div>
                    <p class="text-slate-400 text-xs mt-4">Custom deployments, SSO, SLAs, and volume pricing available on request.</p>
                </div>
            </div>
        </section>

        <!-- CTA -->
        <section class="py-16 bg-slate-900">
            <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
                <h2 class="font-display font-bold text-3xl md:text-4xl text-white">Own your AI development stack</h2>
                <p class="text-slate-400 text-lg mt-4">Clone it, run it, own it. MIT licensed.</p>
                <div class="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
                    <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="px-7 py-3 rounded-full bg-white text-slate-900 font-semibold hover:bg-slate-100 transition-colors inline-flex items-center justify-center gap-2">
                        <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg> Star on GitHub
                    </a>
                    <a href="/agent/" class="px-7 py-3 rounded-full border border-slate-600 text-white font-semibold hover:border-brand-400 transition-colors inline-flex items-center justify-center gap-2">
                        See the agent <i data-lucide="arrow-right" class="w-4 h-4"></i>
                    </a>
                </div>
            </div>
        </section>
    </main>

    ${ Footer() }

    <script>
      function copyCmd(btn) {
        var block = document.getElementById('sh-commands');
        if (!block) return;
        navigator.clipboard.writeText(block.innerText).then(function () {
          var t = btn.querySelector('.btn-text');
          if (t) { var old = t.textContent; t.textContent = 'Copied!'; setTimeout(function () { t.textContent = old; }, 1500); }
        });
      }
      window.addEventListener('DOMContentLoaded', function () { if (window.lucide) lucide.createIcons(); });
    </script>
</body>
</html>
`;
