import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";
import { ModelStrip } from "../components/model-strip.tsx";

/**
 * /self-host/ — run the factory yourself, or have us set it up.
 *
 * Two readers: the engineer who wants to clone and run the MIT core, and the
 * company that wants a factory in its own environment without building one.
 * The second is the larger opportunity, so the setup offer sits right after
 * the hero rather than at the bottom.
 */

const SETUP: Array<[icon: string, title: string, body: string]> = [
  ["server", "Install", "In your cloud, your data centre, or a dedicated instance we host. Sandboxes run on your own compute."],
  ["plug", "Connect", "Your GitHub or GitLab, Jira or Linear, MCP servers, and the models and subscriptions your company already pays for."],
  ["sliders-horizontal", "Customise", "Document templates, definition of done, review gates, stack conventions and model policy, configured to how you deliver."],
  ["users", "Hand over, or run it", "We train your engineers to hold the gates, or we keep running the factory and own the outcome."],
];

const GITHUB_SVG = html`<svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg>`;

export const SelfHostPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "Self-host LFG | Your infrastructure, your models, your data",
  description: "Run the LFG software factory on your own infrastructure, or have us install and customise it for your team. Open-source MIT core, any model, your existing subscriptions and tools.",
  path: "/self-host/",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "self-host" })}

<main>

  <!-- HERO -->
  <section class="relative pt-28 sm:pt-36 pb-16 overflow-hidden mesh">
    <div class="absolute -top-10 right-[10%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="absolute top-20 left-[5%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10 text-center">
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
        <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">Self-hosted &middot; open-source core</span>
      </div>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.1] tracking-tight text-slate-900 animate-fade-up">
        Your factory. Your infra.
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">Your data.</span>
      </h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl mx-auto leading-relaxed animate-fade-up">
        Run the whole LFG software factory inside your own environment, on your models and the subscriptions you already pay for. Clone the MIT core yourself, or have us set it up and customise it for your business.
      </p>
      <div class="mt-8 flex flex-col sm:flex-row gap-3 justify-center animate-fade-up">
        <a href="#setup" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
          Have us set it up <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
        <a href="#quickstart" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
          Run it yourself
        </a>
      </div>
    </div>
  </section>

  <!-- SETUP -->
  <section id="setup" class="band py-20">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Factory setup</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">We build the factory around your business.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          Every company delivers software differently. We install LFG where you need it, connect it to what you already run, and shape the pipeline to your process instead of asking your team to adopt ours.
        </p>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
        ${SETUP.map(([icon, title, body], i) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-7">
            <div class="flex items-center gap-3 mb-4">
              <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
              <span class="text-xs font-semibold text-slate-400 tabular-nums">${i + 1}</span>
            </div>
            <h3 class="font-display font-bold text-base mb-2">${title}</h3>
            <p class="text-sm text-slate-600 leading-relaxed">${body}</p>
          </div>`)}
      </div>
      <div class="flex flex-col sm:flex-row gap-3">
        <a href="/#start" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
          Talk to us about a setup <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
        <p class="text-sm text-slate-500 self-center sm:ml-3">Dedicated hosting, SSO, SLAs and volume pricing on request.</p>
      </div>
    </div>
  </section>

  <!-- QUICK START -->
  <section id="quickstart" class="band-tint py-20">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center max-w-2xl mx-auto mb-10">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Run it yourself</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Up and running in a few commands.</h2>
        <p class="text-slate-600 text-lg mt-4">The default setup uses SQLite and local file storage, so there is nothing external to provision for local development.</p>
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
  <section class="band py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="text-center max-w-2xl mx-auto mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Sandboxes</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Agent sessions and previews on your own compute.</h2>
        <p class="text-slate-600 text-lg mt-4">Every Claude Code, Codex or Pi session, and every in-app preview, runs in an isolated sandbox. You choose where that compute lives.</p>
      </div>
      <div class="grid md:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-brand-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="server" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-xl text-slate-900 mb-2">Docker (self-hosted)</h3>
          <p class="text-slate-600 leading-relaxed">Each sandbox is an isolated Docker container on your own server, from a prebuilt image with Node, Python and the coding agents baked in. No third-party compute; your code never leaves your box.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-7">
          <div class="w-11 h-11 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center mb-4"><i data-lucide="cloud" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-xl text-slate-900 mb-2">Managed VMs (hosted)</h3>
          <p class="text-slate-600 leading-relaxed">Prefer not to manage compute? Point LFG at hosted Firecracker micro-VMs and get public preview URLs out of the box. One env var switches backends.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- MODELS -->
  <section class="band-tint py-20">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Model-agnostic</p>
      <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Every major model, on the plans you already have.</h2>
      <p class="text-slate-600 text-lg mt-4 max-w-2xl mx-auto">Sign in with Claude or ChatGPT subscriptions, or use API keys. Switch per task, cost or capability, and set a model policy per project.</p>
      <div class="mt-8">${ModelStrip()}</div>
    </div>
  </section>

  <!-- OWN YOUR DATA -->
  <section class="band py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="grid md:grid-cols-3 gap-6">
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-lg bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="database" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg mb-2">Your database</h3>
          <p class="text-slate-600 text-sm leading-relaxed">SQLite out of the box, or point it at your own Postgres. Your data lives where you put it.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-lg bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="hard-drive" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg mb-2">Your files</h3>
          <p class="text-slate-600 text-sm leading-relaxed">Store uploads on local disk, or plug in S3. One env var switches between them.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-lg bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="lock" class="w-5 h-5"></i></div>
          <h3 class="font-display font-bold text-lg mb-2">Your keys</h3>
          <p class="text-slate-600 text-sm leading-relaxed">Secrets and subscription credentials are encrypted at rest and stay on your infrastructure. Nothing phones home.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section class="bg-slate-900 py-16">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
      <h2 class="font-display font-bold text-3xl md:text-4xl text-white">Own your software factory.</h2>
      <p class="text-slate-400 text-lg mt-4">Clone it and run it, or let us build it around your team.</p>
      <div class="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
        <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="px-7 py-3 rounded-full bg-white text-slate-900 font-semibold hover:bg-slate-100 transition-colors inline-flex items-center justify-center gap-2">
          ${GITHUB_SVG} Star on GitHub
        </a>
        <a href="/#start" class="px-7 py-3 rounded-full border border-slate-600 text-white font-semibold hover:border-brand-400 transition-colors inline-flex items-center justify-center gap-2">
          Talk to us <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
      </div>
    </div>
  </section>

</main>

${SiteFooter()}

<script>
  function copyCmd(btn) {
    var block = document.getElementById('sh-commands');
    if (!block) return;
    navigator.clipboard.writeText(block.innerText).then(function () {
      var t = btn.querySelector('.btn-text');
      if (t) { var old = t.textContent; t.textContent = 'Copied!'; setTimeout(function () { t.textContent = old; }, 1500); }
    });
  }
</script>

</body>
</html>
`;
