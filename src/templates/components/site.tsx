import { html } from "hono/html";

/**
 * Shared chrome for the marketing site.
 *
 * Every marketing page renders SiteHead + SiteNav + SiteFooter so the header,
 * palette and type scale cannot drift page to page — which is exactly how the
 * old site ended up running two different navigations at once.
 *
 * Navigation follows the redesign brief: a buyer should find their own problem
 * in the menu, so Solutions is split by who you are rather than by feature.
 */

export type SitePage =
  | "home" | "how-it-works" | "agent" | "self-host"
  | "software-services" | "startups" | "services"
  | "case-studies" | "blog" | "none";

interface HeadOptions {
  title: string;
  description: string;
  path: string;
  /** og:image, defaults to the ticket board — real product, never stock AI art. */
  image?: string;
  noindex?: boolean;
}

export const SiteHead = ({ title, description, path, image = "/public/images/screenshots/agent-ticket-board.png", noindex = false }: HeadOptions) => html`
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}">
  ${noindex ? html`<meta name="robots" content="noindex">` : html`<link rel="canonical" href="https://lfg.run${path}">`}
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://lfg.run${path}">
  <meta property="og:image" content="https://lfg.run${image}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="https://lfg.run${image}">
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
  <script>
    // Light is the default. We deliberately do NOT follow prefers-color-scheme:
    // a first-time visitor on a dark-mode machine was landing on the dark
    // treatment, which is not how the site is meant to be introduced. Dark is
    // opt-in and only ever applied when the visitor has chosen it here before.
    (function() {
      if (localStorage.getItem('lfg-theme') === 'dark') document.documentElement.classList.add('dark');
    })();
  </script>
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
            accent: { 500:'#ec4899',600:'#db2777' },
          },
          animation: { 'fade-up':'fadeUp 0.6s ease-out both','drift':'drift 8s ease-in-out infinite' },
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
    .glass { background: rgba(255,255,255,0.85); border: 1px solid rgba(148,163,184,0.24); backdrop-filter: blur(10px); }

    /* Section rhythm: alternate plain / tinted so long pages stay readable */
    .band { background: #ffffff; border-top: 1px solid #eef1f5; }
    .band-tint { background: #f8fafc; border-top: 1px solid #eef1f5; }

    /* Flow-diagram primitives */
    .node { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:9px 14px; text-align:center; }
    .node-accent { background:#eef2ff; border-color:#c7d2fe; }
    .node-ok { background:#ecfdf5; border-color:#a7f3d0; }
    .link-v { width:1px; height:16px; background:#cbd5e1; margin:0 auto; }

    /* Comparison table */
    .cmp { width:100%; border-collapse:separate; border-spacing:0; min-width:600px; }
    .cmp th, .cmp td { text-align:left; padding:13px 18px; font-size:0.9rem; vertical-align:top; }
    .cmp thead th { font-size:0.72rem; letter-spacing:.09em; text-transform:uppercase; font-weight:700; }
    .cmp tbody tr { border-top:1px solid #eef1f5; }
    .cmp .col-lfg { background:#f8fafc; }

    /* Screenshot frame with browser chrome */
    .shot { background:#fff; border:1px solid #e2e8f0; border-radius:14px; overflow:hidden; box-shadow:0 30px 60px -30px rgba(15,23,42,0.28); }
    .shot-bar { display:flex; align-items:center; gap:6px; padding:9px 14px; border-bottom:1px solid #eef1f5; background:#f8fafc; }
    .shot-dot { width:9px; height:9px; border-radius:50%; }
    html.dark .shot { background:#0f141d !important; border-color:rgba(255,255,255,0.08) !important; }
    html.dark .shot-bar { background:rgba(255,255,255,0.03) !important; border-bottom-color:rgba(255,255,255,0.07) !important; }

    /* ── Dark mode ── */
    html.dark body { background:#0d1117; color:#c9d1d9; }
    html.dark .mesh { background-image: radial-gradient(circle at 10% 20%, rgba(99,102,241,0.12), transparent 40%), radial-gradient(circle at 80% 0%, rgba(139,92,246,0.08), transparent 35%); }
    html.dark .glass { background: rgba(22,27,34,0.85); border-color: rgba(255,255,255,0.07); }
    html.dark .blur-3xl { opacity:0.08 !important; }
    html.dark .band { background:#0d1117 !important; border-top-color:rgba(255,255,255,0.06) !important; }
    html.dark .band-tint { background:#12161d !important; border-top-color:rgba(255,255,255,0.06) !important; }
    html.dark .node { background:#161b22 !important; border-color:rgba(255,255,255,0.09) !important; }
    html.dark .node-accent { background:rgba(99,102,241,0.14) !important; border-color:rgba(129,140,248,0.45) !important; }
    html.dark .node-ok { background:rgba(16,185,129,0.10) !important; border-color:rgba(16,185,129,0.35) !important; }
    html.dark .link-v { background:rgba(255,255,255,0.14) !important; }
    html.dark .cmp tbody tr { border-top-color:rgba(255,255,255,0.06) !important; }
    html.dark .cmp .col-lfg { background:rgba(99,102,241,0.07) !important; }
    html.dark [class*="bg-white"] { background-color:#161b22 !important; }
    html.dark .bg-slate-50 { background-color:#0d1117 !important; }
    html.dark .bg-slate-100 { background-color:#161b22 !important; }
    html.dark .bg-brand-50, html.dark .bg-indigo-50 { background-color:#161b22 !important; }
    html.dark .text-slate-900 { color:#e6edf3 !important; }
    html.dark .text-slate-800 { color:#c9d1d9 !important; }
    html.dark .text-slate-700 { color:#b0bac6 !important; }
    html.dark .text-slate-600 { color:#8b949e !important; }
    html.dark .text-slate-500 { color:#6e7681 !important; }
    html.dark .text-brand-700, html.dark .text-brand-600 { color:#818cf8 !important; }
    html.dark [class*="border-slate-2"], html.dark [class*="border-slate-1"] { border-color:rgba(255,255,255,0.07) !important; }
    html.dark * { box-shadow:none !important; }
    html.dark input, html.dark textarea, html.dark select {
      background-color:#1c2128 !important; border-color:rgba(255,255,255,0.18) !important; color:#e6edf3 !important;
    }
    html.dark input::placeholder, html.dark textarea::placeholder { color:#6e7681 !important; }
    html.dark #navbar.scrolled { background:rgba(13,17,23,0.97) !important; border-color:rgba(255,255,255,0.05) !important; }
    html.dark .menu-card { background:#161b22 !important; border-color:rgba(255,255,255,0.08) !important; }
    html.dark .menu-card a:hover { background:rgba(255,255,255,0.04) !important; }
    html.dark #mobile-menu { background:#161b22 !important; border-color:rgba(255,255,255,0.06) !important; }

    #navbar.scrolled { background:rgba(255,255,255,0.94); backdrop-filter:blur(12px); border-bottom:1px solid rgba(0,0,0,0.06); }
    .menu-card { background:#fff; border:1px solid #e2e8f0; border-radius:14px; box-shadow:0 18px 40px -18px rgba(15,23,42,0.28); }
    .menu-wrap { opacity:0; visibility:hidden; transform:translateY(6px); transition:opacity .16s ease, transform .16s ease, visibility .16s; }
    .has-menu:hover .menu-wrap, .has-menu:focus-within .menu-wrap { opacity:1; visibility:visible; transform:translateY(0); }
  </style>
`;

type NavItem = [href: string, icon: string, label: string, sub: string];

const NAV_PRODUCT: NavItem[] = [
  ["/how-it-works/", "workflow", "How LFG works", "Requirement to release, stage by stage"],
  ["/agent/", "bot", "LFG Agent", "The engine underneath the factory"],
  ["/self-host/", "server", "Self-hosted", "Run it on your own infrastructure"],
  // Signing up is the top of the funnel now — it is free, it starts a
  // relationship, and a call can follow. The consultative path sits beside it.
  ["/auth/register", "sparkles", "Try LFG free", "Sign up and run it on your own repo"],
];

const NAV_SOLUTIONS: NavItem[] = [
  ["/software-services/", "building-2", "For software services firms", "Deliver more client work per engineer"],
  ["/startups/", "rocket", "For startups and SMBs", "Ship a product without a full team"],
  ["/services/", "hammer", "Software development services", "Tell us what to build and we deliver it"],
];

const menuItem = ([href, icon, label, sub]: NavItem) => html`
  <a href="${href}" class="flex gap-3 px-3.5 py-3 rounded-lg hover:bg-slate-50 transition-colors">
    <i data-lucide="${icon}" class="w-4 h-4 text-brand-600 mt-0.5 shrink-0"></i>
    <span class="block">
      <span class="block text-sm font-semibold text-slate-900">${label}</span>
      <span class="block text-xs text-slate-500 mt-0.5 leading-snug">${sub}</span>
    </span>
  </a>`;

export const SiteNav = ({ active = "none" }: { active?: SitePage }) => {
  const cls = (on: boolean) => on ? "text-brand-600 font-semibold" : "text-slate-600 hover:text-brand-600";
  const isProduct = active === "how-it-works" || active === "agent" || active === "self-host";
  const isSolutions = active === "software-services" || active === "startups" || active === "services";

  return html`
<nav id="navbar" class="fixed top-0 left-0 right-0 z-50 transition-all duration-300 bg-transparent py-4">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center">
    <a href="/" class="flex items-center gap-2 group shrink-0">
      <div class="bg-brand-600 text-white p-1.5 rounded-lg transform group-hover:rotate-12 transition-transform">
        <i data-lucide="rocket" class="w-5 h-5"></i>
      </div>
      <span class="font-display font-bold text-xl tracking-tight text-slate-900">LFG</span>
    </a>

    <div class="hidden lg:flex items-center gap-7">
      <div class="has-menu relative">
        <button class="text-sm font-medium ${cls(isProduct)} transition-colors inline-flex items-center gap-1">
          Product <i data-lucide="chevron-down" class="w-3.5 h-3.5"></i>
        </button>
        <div class="menu-wrap absolute left-1/2 -translate-x-1/2 top-full pt-3 w-[330px]">
          <div class="menu-card p-2">${NAV_PRODUCT.map(menuItem)}</div>
        </div>
      </div>

      <div class="has-menu relative">
        <button class="text-sm font-medium ${cls(isSolutions)} transition-colors inline-flex items-center gap-1">
          Solutions <i data-lucide="chevron-down" class="w-3.5 h-3.5"></i>
        </button>
        <div class="menu-wrap absolute left-1/2 -translate-x-1/2 top-full pt-3 w-[350px]">
          <div class="menu-card p-2">${NAV_SOLUTIONS.map(menuItem)}</div>
        </div>
      </div>

      <a href="/case-studies/" class="text-sm font-medium ${cls(active === "case-studies")} transition-colors">Case studies</a>
      <a href="/blog/" class="text-sm font-medium ${cls(active === "blog")} transition-colors">Blog</a>

      <div class="flex items-center gap-4 ml-1">
        <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="text-slate-500 hover:text-slate-900 transition-colors" aria-label="GitHub">
          <svg viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg>
        </a>
        <button id="theme-toggle" onclick="window.toggleTheme && window.toggleTheme()" class="text-slate-500 hover:text-slate-900 transition-colors" aria-label="Toggle dark mode">
          <i data-lucide="moon" class="w-5 h-5"></i>
        </button>
        <a href="/auth/login" class="text-sm font-semibold text-slate-600 hover:text-brand-600 transition-colors whitespace-nowrap">Sign in</a>
        <a href="/auth/register" class="bg-slate-900 hover:bg-brand-700 text-white px-5 py-2 rounded-full text-sm font-semibold transition-all whitespace-nowrap">Try LFG free</a>
      </div>
    </div>

    <div class="lg:hidden flex items-center gap-3">
      <button id="theme-toggle-mobile" onclick="window.toggleTheme && window.toggleTheme()" class="text-slate-500 hover:text-slate-900 transition-colors" aria-label="Toggle dark mode">
        <i data-lucide="moon" class="w-5 h-5"></i>
      </button>
      <button id="menu-btn" class="text-slate-600" aria-label="Open menu"><i data-lucide="menu" class="w-6 h-6"></i></button>
    </div>
  </div>

  <div id="mobile-menu" class="hidden lg:hidden absolute top-full left-0 w-full bg-white border-b border-slate-200 px-5 py-4 shadow-xl max-h-[80vh] overflow-y-auto">
    <p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">Product</p>
    ${NAV_PRODUCT.map(([href, , label]) => html`<a href="${href}" class="block py-2 text-base font-medium text-slate-700 m-link">${label}</a>`)}
    <p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mt-4 mb-1">Solutions</p>
    ${NAV_SOLUTIONS.map(([href, , label]) => html`<a href="${href}" class="block py-2 text-base font-medium text-slate-700 m-link">${label}</a>`)}
    <p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mt-4 mb-1">Resources</p>
    <a href="/case-studies/" class="block py-2 text-base font-medium text-slate-700 m-link">Case studies</a>
    <a href="/blog/" class="block py-2 text-base font-medium text-slate-700 m-link">Blog</a>
    <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="block py-2 text-base font-medium text-slate-700 m-link">GitHub</a>
    <div class="mt-4 pt-4 border-t border-slate-100 flex flex-col gap-2">
      <a href="/#start" class="block py-2 text-base font-medium text-slate-700 m-link">Talk to us about a project</a>
      <a href="/auth/login" class="block py-2 text-base font-semibold text-slate-700 m-link">Sign in</a>
      <a href="/auth/register" class="bg-brand-600 text-white w-full py-3 rounded-lg font-semibold text-center block m-link">Try LFG free</a>
    </div>
  </div>
</nav>
<script>
  (function() {
    // Older pages carry their own <head> and so never ran SiteHead's theme
    // init. Apply the stored choice here too so a visitor who picked dark
    // keeps it everywhere. Light remains the default; OS preference is not
    // consulted anywhere.
    if (localStorage.getItem('lfg-theme') === 'dark') document.documentElement.classList.add('dark');

    var navbar = document.getElementById('navbar');
    window.addEventListener('scroll', function() {
      if (window.scrollY > 20) { navbar.classList.add('scrolled','py-3'); navbar.classList.remove('bg-transparent','py-4'); }
      else { navbar.classList.remove('scrolled','py-3'); navbar.classList.add('bg-transparent','py-4'); }
    });
    var btn = document.getElementById('menu-btn');
    var menu = document.getElementById('mobile-menu');
    if (btn && menu) {
      btn.addEventListener('click', function() { menu.classList.toggle('hidden'); });
      menu.querySelectorAll('.m-link').forEach(function(l) { l.addEventListener('click', function() { menu.classList.add('hidden'); }); });
    }
    function updateIcons(isDark) {
      ['theme-toggle','theme-toggle-mobile'].forEach(function(id) {
        var el = document.getElementById(id); if (!el) return;
        var icon = el.querySelector('[data-lucide]');
        if (icon) { icon.setAttribute('data-lucide', isDark ? 'sun' : 'moon'); if (window.lucide) lucide.createIcons({ nodes: [icon] }); }
      });
    }
    window.toggleTheme = function() {
      var isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('lfg-theme', isDark ? 'dark' : 'light');
      updateIcons(isDark);
    };
    setTimeout(function() { updateIcons(document.documentElement.classList.contains('dark')); }, 100);
  })();
</script>`;
};

export const SiteFooter = () => html`
<footer class="bg-slate-900 text-slate-400 py-14">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="grid sm:grid-cols-2 md:grid-cols-4 gap-10">
      <div>
        <div class="flex items-center gap-2 mb-3">
          <div class="bg-brand-600 text-white p-1.5 rounded-lg"><i data-lucide="rocket" class="w-4 h-4"></i></div>
          <span class="font-display font-bold text-white text-lg">LFG</span>
        </div>
        <p class="text-sm leading-relaxed">An AI software factory. We build software with it, and software companies use it to deliver their own client work.</p>
      </div>
      <div>
        <h4 class="font-bold text-white mb-3 uppercase text-xs tracking-wider">Product</h4>
        <ul class="space-y-2.5 text-sm">
          <li><a href="/how-it-works/" class="hover:text-white transition-colors">How LFG works</a></li>
          <li><a href="/agent/" class="hover:text-white transition-colors">LFG Agent</a></li>
          <li><a href="/self-host/" class="hover:text-white transition-colors">Self-hosted</a></li>
          <li><a href="/auth/register" class="hover:text-white transition-colors">Try LFG free</a></li>
          <li><a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">GitHub</a></li>
        </ul>
      </div>
      <div>
        <h4 class="font-bold text-white mb-3 uppercase text-xs tracking-wider">Solutions</h4>
        <ul class="space-y-2.5 text-sm">
          <li><a href="/software-services/" class="hover:text-white transition-colors">For software services firms</a></li>
          <li><a href="/startups/" class="hover:text-white transition-colors">For startups and SMBs</a></li>
          <li><a href="/services/" class="hover:text-white transition-colors">Development services</a></li>
          <li><a href="/white-label/" class="hover:text-white transition-colors">White-label</a></li>
        </ul>
      </div>
      <div>
        <h4 class="font-bold text-white mb-3 uppercase text-xs tracking-wider">Company</h4>
        <ul class="space-y-2.5 text-sm">
          <li><a href="/case-studies/" class="hover:text-white transition-colors">Case studies</a></li>
          <li><a href="/blog/" class="hover:text-white transition-colors">Blog</a></li>
          <li><a href="/#start" class="hover:text-white transition-colors">Talk to us about a project</a></li>
          <li><a href="/software-services/#pilot" class="hover:text-white transition-colors">Book a pilot</a></li>
        </ul>
      </div>
    </div>
    <div class="border-t border-slate-800 mt-10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
      <p>&copy; ${new Date().getFullYear()} LFG Inc. Open source core under MIT.</p>
      <div class="flex items-center gap-5">
        <a href="/privacy/" class="hover:text-white transition-colors">Privacy</a>
        <a href="/terms/" class="hover:text-white transition-colors">Terms</a>
      </div>
    </div>
  </div>
</footer>
<script>lucide.createIcons();</script>`;
