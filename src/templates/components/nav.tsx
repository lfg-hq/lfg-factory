import { html } from "hono/html";

type NavPage = "home" | "agent" | "self-host" | "case-studies" | "compare" | "services" | "blog";

interface NavOptions {
  activePage: NavPage;
  /** The single filled CTA. Defaults to self-serve signup. */
  ctaLabel?: string;
  ctaHref?: string;
}

export const Nav = ({
  activePage,
  ctaLabel = "Access Agent",
  ctaHref = "/auth/register",
}: NavOptions) => html`
<!-- FOUC prevention: runs before paint -->
<script>
  (function() {
    var s = localStorage.getItem('lfg-theme');
    var d = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (s === 'dark' || (!s && d)) document.documentElement.classList.add('dark');
  })();
</script>

<!-- Shared dark mode styles for all pages using Nav -->
<style>
  #navbar.nav-scrolled {
    background: rgba(255,255,255,0.93);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(0,0,0,0.06);
  }
  /* ── Dark mode ── */
  html.dark body {
    background: #0d1117 !important;
    color: #c9d1d9;
  }
  html.dark #navbar.nav-scrolled {
    background: rgba(13,17,23,0.97) !important;
    border-color: rgba(255,255,255,0.05) !important;
    box-shadow: none !important;
  }
  html.dark .blur-3xl { opacity: 0.08 !important; }
  html.dark [class*="bg-white"]  { background-color: #161b22 !important; }
  html.dark .bg-slate-50         { background-color: #0d1117 !important; }
  html.dark .bg-slate-100        { background-color: #161b22 !important; }
  html.dark .bg-slate-200        { background-color: #21262d !important; }
  html.dark .bg-indigo-50,
  html.dark .bg-brand-50         { background-color: #161b22 !important; }
  html.dark .bg-brand-100        { background-color: #1c2128 !important; }
  html.dark .text-slate-900      { color: #e6edf3 !important; }
  html.dark .text-slate-800      { color: #c9d1d9 !important; }
  html.dark .text-slate-700      { color: #b0bac6 !important; }
  html.dark .text-slate-600      { color: #8b949e !important; }
  html.dark .text-slate-500      { color: #6e7681 !important; }
  html.dark .text-slate-400      { color: #4d5562 !important; }
  html.dark .text-brand-900,
  html.dark .text-brand-800,
  html.dark .text-brand-700,
  html.dark .text-brand-600      { color: #818cf8 !important; }
  html.dark [class*="border-slate-2"],
  html.dark [class*="border-slate-1"] { border-color: rgba(255,255,255,0.06) !important; }
  html.dark [class*="border-brand-2"] { border-color: rgba(99,102,241,0.2) !important; }
  html.dark .border-dashed        { border-color: rgba(255,255,255,0.08) !important; }
  html.dark [class*="border-t"]   { border-color: rgba(255,255,255,0.05) !important; }
  html.dark *                     { box-shadow: none !important; }
  html.dark .glass {
    background: rgba(22,27,34,0.85) !important;
    border-color: rgba(255,255,255,0.07) !important;
  }
  html.dark .mesh {
    background-image:
      radial-gradient(circle at 10% 20%, rgba(99,102,241,0.12), transparent 40%),
      radial-gradient(circle at 80% 0%,  rgba(139,92,246,0.08),  transparent 35%) !important;
  }
  html.dark #mobile-menu {
    background-color: #161b22 !important;
    border-color: rgba(255,255,255,0.06) !important;
  }
  html.dark input:not([type=submit]):not([type=button]),
  html.dark textarea {
    background-color: #1c2128 !important;
    border-color: rgba(255,255,255,0.18) !important;
    color: #e6edf3 !important;
  }
  html.dark input::placeholder,
  html.dark textarea::placeholder { color: #6e7681 !important; }
</style>

<nav id="navbar" class="fixed top-0 left-0 right-0 z-50 transition-all duration-300 bg-transparent py-5">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center">
    <a href="/" class="flex items-center gap-2 group">
      <div class="bg-brand-600 text-white p-1.5 rounded-lg transform group-hover:rotate-12 transition-transform">
        <i data-lucide="rocket" class="w-5 h-5"></i>
      </div>
      <span class="font-display font-bold text-xl tracking-tight text-slate-900">LFG</span>
    </a>
    <div class="hidden md:flex items-center gap-6">
      <a href="/" class="text-sm font-medium ${activePage === "home" ? "text-brand-600 font-semibold" : "text-slate-600 hover:text-brand-600"} transition-colors">Home</a>
      <a href="/agent/" class="text-sm font-medium ${activePage === "agent" ? "text-brand-600 font-semibold" : "text-slate-600 hover:text-brand-600"} transition-colors">Agent</a>
      <a href="/self-host/" class="text-sm font-medium ${activePage === "self-host" ? "text-brand-600 font-semibold" : "text-slate-600 hover:text-brand-600"} transition-colors">Self-host</a>
      <a href="/case-studies/" class="text-sm font-medium ${activePage === "case-studies" ? "text-brand-600 font-semibold" : "text-slate-600 hover:text-brand-600"} transition-colors">Case studies</a>
      <a href="/blog/" class="text-sm font-medium ${activePage === "blog" ? "text-brand-600 font-semibold" : "text-slate-600 hover:text-brand-600"} transition-colors">Blog</a>
      <!-- Services is a secondary path: last in the order and visually lighter -->
      <a href="/services/" class="text-sm font-normal ${activePage === "services" ? "text-brand-600 font-semibold" : "text-slate-400 hover:text-brand-600"} transition-colors">Services</a>
      <div class="flex items-center gap-4 ml-2">
        <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="text-slate-500 hover:text-slate-900 transition-colors">
<svg viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg>
        </a>
        <button id="theme-toggle" onclick="window.toggleTheme && window.toggleTheme()" class="text-slate-500 hover:text-slate-900 transition-colors" title="Toggle dark mode" aria-label="Toggle dark mode">
          <i data-lucide="moon" class="w-5 h-5"></i>
        </button>
        <a href="${ctaHref}" class="bg-slate-900 hover:bg-brand-700 text-white px-5 py-2 rounded-full text-sm font-semibold transition-all shadow-lg whitespace-nowrap">
          ${ctaLabel}
        </a>
      </div>
    </div>
    <div class="md:hidden flex items-center gap-3">
      <button id="theme-toggle-mobile" onclick="window.toggleTheme && window.toggleTheme()" class="text-slate-500 hover:text-slate-900 transition-colors" aria-label="Toggle dark mode">
        <i data-lucide="moon" class="w-5 h-5"></i>
      </button>
      <button id="mobile-menu-btn" class="text-slate-600"><i data-lucide="menu" class="w-6 h-6"></i></button>
    </div>
  </div>
  <div id="mobile-menu" class="hidden md:hidden absolute top-full left-0 w-full bg-white border-b border-slate-200 p-4 flex-col gap-3 shadow-xl">
    <a href="/" class="text-base font-medium ${activePage === "home" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Home</a>
    <a href="/agent/" class="text-base font-medium ${activePage === "agent" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Agent</a>
    <a href="/self-host/" class="text-base font-medium ${activePage === "self-host" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Self-host</a>
    <a href="/case-studies/" class="text-base font-medium ${activePage === "case-studies" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Case studies</a>
    <a href="/blog/" class="text-base font-medium ${activePage === "blog" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Blog</a>
    <a href="/services/" class="text-base font-normal ${activePage === "services" ? "text-brand-600 font-semibold" : "text-slate-400"} py-2 mobile-link">Services</a>
    <a href="${ctaHref}" class="bg-brand-600 text-white w-full py-3 rounded-lg font-semibold text-center block mobile-link">${ctaLabel}</a>
  </div>
</nav>
<script>
  (function() {
    // Scroll: use CSS class so dark mode can override
    var navbar = document.getElementById('navbar');
    window.addEventListener('scroll', function() {
      if (window.scrollY > 20) {
        navbar.classList.add('nav-scrolled', 'py-3');
        navbar.classList.remove('bg-transparent', 'py-5');
      } else {
        navbar.classList.remove('nav-scrolled', 'py-3');
        navbar.classList.add('bg-transparent', 'py-5');
      }
    });

    // Mobile menu
    var btn = document.getElementById('mobile-menu-btn');
    var menu = document.getElementById('mobile-menu');
    btn.addEventListener('click', function() { menu.classList.toggle('hidden'); });
    menu.querySelectorAll('.mobile-link').forEach(function(l) {
      l.addEventListener('click', function() { menu.classList.add('hidden'); });
    });

    // Theme toggle
    function updateIcons(isDark) {
      ['theme-toggle','theme-toggle-mobile'].forEach(function(id) {
        var el = document.getElementById(id);
        if (!el) return;
        var icon = el.querySelector('[data-lucide]');
        if (icon) {
          icon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
          if (window.lucide) lucide.createIcons({ nodes: [icon] });
        }
      });
    }

    window.toggleTheme = function() {
      var isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('lfg-theme', isDark ? 'dark' : 'light');
      updateIcons(isDark);
    };

    // Sync icon on load (after lucide renders)
    setTimeout(function() {
      updateIcons(document.documentElement.classList.contains('dark'));
    }, 100);

    // Follow OS changes when no manual preference
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
      if (!localStorage.getItem('lfg-theme')) {
        document.documentElement.classList.toggle('dark', e.matches);
        updateIcons(e.matches);
      }
    });
  })();
</script>
`;

export const Footer = () => html`
<footer class="bg-slate-900 text-slate-400 py-12">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="flex flex-col md:flex-row md:items-start justify-between gap-8">
      <div class="max-w-sm">
        <div class="flex items-center gap-2 mb-3">
          <div class="bg-brand-600 text-white p-1.5 rounded-lg">
            <i data-lucide="rocket" class="w-4 h-4"></i>
          </div>
          <span class="font-display font-bold text-white text-lg">LFG</span>
        </div>
        <p class="text-sm leading-relaxed">The self-hosted agentic software factory. We run our own company on it.</p>
      </div>
      <div class="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm md:justify-end md:max-w-lg">
        <a href="/" class="hover:text-white transition-colors">Home</a>
        <a href="/agent/" class="hover:text-white transition-colors">Agent</a>
        <a href="/self-host/" class="hover:text-white transition-colors">Self-host</a>
        <a href="/case-studies/" class="hover:text-white transition-colors">Case studies</a>
        <a href="/vs-coding-agents/" class="hover:text-white transition-colors">Vs. coding agents</a>
        <a href="/blog/" class="hover:text-white transition-colors">Blog</a>
        <a href="/services/" class="hover:text-white transition-colors">Services</a>
        <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">GitHub</a>
      </div>
    </div>
    <div class="border-t border-slate-800 mt-8 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
      <p>&copy; ${new Date().getFullYear()} LFG Inc. Open source core under MIT.</p>
      <div class="flex items-center gap-5">
        <a href="/privacy/" class="hover:text-white transition-colors">Privacy</a>
        <a href="/terms/" class="hover:text-white transition-colors">Terms</a>
      </div>
    </div>
  </div>
</footer>
`;
