import { html } from "hono/html";

type NavPage = "home" | "agent" | "portfolio" | "services" | "blog";

interface NavOptions {
  activePage: NavPage;
  ctaLabel?: string;
  ctaHref?: string;
}

export const Nav = ({ activePage, ctaLabel = "Access Agent", ctaHref = "/auth/register" }: NavOptions) => html`
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
      <a href="/portfolio/" class="text-sm font-medium ${activePage === "portfolio" ? "text-brand-600 font-semibold" : "text-slate-600 hover:text-brand-600"} transition-colors">Portfolio</a>
      <a href="/services/" class="text-sm font-medium ${activePage === "services" ? "text-brand-600 font-semibold" : "text-slate-600 hover:text-brand-600"} transition-colors">Services</a>
      <a href="/blog/" class="text-sm font-medium ${activePage === "blog" ? "text-brand-600 font-semibold" : "text-slate-600 hover:text-brand-600"} transition-colors">Blog</a>
      <div class="flex items-center gap-4 ml-2">
        <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="text-slate-500 hover:text-slate-900 transition-colors">
          <i data-lucide="github" class="w-5 h-5"></i>
        </a>
        <a href="${ctaHref}" class="bg-slate-900 hover:bg-brand-700 text-white px-5 py-2 rounded-full text-sm font-semibold transition-all shadow-lg">
          ${ctaLabel}
        </a>
      </div>
    </div>
    <div class="md:hidden">
      <button id="mobile-menu-btn" class="text-slate-600"><i data-lucide="menu" class="w-6 h-6"></i></button>
    </div>
  </div>
  <div id="mobile-menu" class="hidden md:hidden absolute top-full left-0 w-full bg-white border-b border-slate-200 p-4 flex-col gap-3 shadow-xl">
    <a href="/" class="text-base font-medium ${activePage === "home" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Home</a>
    <a href="/agent/" class="text-base font-medium ${activePage === "agent" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Agent</a>
    <a href="/portfolio/" class="text-base font-medium ${activePage === "portfolio" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Portfolio</a>
    <a href="/services/" class="text-base font-medium ${activePage === "services" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Services</a>
    <a href="/blog/" class="text-base font-medium ${activePage === "blog" ? "text-brand-600 font-semibold" : "text-slate-700"} py-2 mobile-link">Blog</a>
    <a href="${ctaHref}" class="bg-brand-600 text-white w-full py-3 rounded-lg font-semibold text-center block mobile-link">${ctaLabel}</a>
  </div>
</nav>
<script>
  (function() {
    var navbar = document.getElementById('navbar');
    window.addEventListener('scroll', function() {
      if (window.scrollY > 20) {
        navbar.classList.add('bg-white/95', 'backdrop-blur-sm', 'shadow-sm', 'py-3');
        navbar.classList.remove('bg-transparent', 'py-5');
      } else {
        navbar.classList.remove('bg-white/95', 'backdrop-blur-sm', 'shadow-sm', 'py-3');
        navbar.classList.add('bg-transparent', 'py-5');
      }
    });
    var btn = document.getElementById('mobile-menu-btn');
    var menu = document.getElementById('mobile-menu');
    btn.addEventListener('click', function() { menu.classList.toggle('hidden'); });
    menu.querySelectorAll('.mobile-link').forEach(function(l) {
      l.addEventListener('click', function() { menu.classList.add('hidden'); });
    });
  })();
</script>
`;

export const Footer = () => html`
<footer class="bg-slate-900 text-slate-400 py-10">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="flex flex-col md:flex-row items-center justify-between gap-6">
      <div class="flex items-center gap-2">
        <div class="bg-brand-600 text-white p-1.5 rounded-lg">
          <i data-lucide="rocket" class="w-4 h-4"></i>
        </div>
        <span class="font-display font-bold text-white text-lg">LFG</span>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-6 text-sm">
        <a href="/" class="hover:text-white transition-colors">Home</a>
        <a href="/agent/" class="hover:text-white transition-colors">Agent</a>
        <a href="/portfolio/" class="hover:text-white transition-colors">Portfolio</a>
        <a href="/services/" class="hover:text-white transition-colors">Services</a>
        <a href="/blog/" class="hover:text-white transition-colors">Blog</a>
        <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">GitHub</a>
      </div>
      <p class="text-xs">&copy; ${new Date().getFullYear()} LFG. All rights reserved.</p>
    </div>
  </div>
</footer>
`;
