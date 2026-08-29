import { html } from "hono/html";
import { SiteNav, SiteFooter, type SitePage } from "./site.tsx";

/**
 * Backwards-compatible adapter.
 *
 * Pages written before the redesign (agent, self-host, white-label, blog,
 * vs-coding-agents…) import Nav/Footer from here and carry their own <head>.
 * Rather than touch each of them, this delegates the markup to the new shared
 * chrome so there is exactly one navigation on the site — while still emitting
 * the legacy dark-mode rules those older pages depend on, which now live in
 * SiteHead for pages that use it.
 *
 * New pages should import SiteHead/SiteNav/SiteFooter from ./site.tsx directly.
 */

type LegacyPage =
  | "home" | "agent" | "self-host" | "case-studies"
  | "compare" | "white-label" | "services" | "blog"
  | "how-it-works" | "software-services" | "startups";

const MAP: Record<LegacyPage, SitePage> = {
  home: "home",
  agent: "agent",
  "self-host": "self-host",
  "case-studies": "case-studies",
  services: "services",
  blog: "blog",
  "how-it-works": "how-it-works",
  "software-services": "software-services",
  startups: "startups",
  // No nav entry of their own — nothing should highlight.
  compare: "none",
  "white-label": "none",
};

interface NavOptions {
  activePage: LegacyPage;
  /** Accepted for compatibility; the shared nav has one fixed CTA. */
  ctaLabel?: string;
  ctaHref?: string;
}

/** Dark-mode rules the pre-redesign pages rely on (newer pages get these from SiteHead). */
const legacyDarkStyles = html`
<style>
  html.dark body { background:#0d1117 !important; color:#c9d1d9; }
  html.dark .blur-3xl { opacity:0.08 !important; }
  html.dark [class*="bg-white"] { background-color:#161b22 !important; }
  html.dark .bg-slate-50 { background-color:#0d1117 !important; }
  html.dark .bg-slate-100 { background-color:#161b22 !important; }
  html.dark .bg-slate-200 { background-color:#21262d !important; }
  html.dark .bg-indigo-50, html.dark .bg-brand-50 { background-color:#161b22 !important; }
  html.dark .bg-brand-100 { background-color:#1c2128 !important; }
  html.dark .text-slate-900 { color:#e6edf3 !important; }
  html.dark .text-slate-800 { color:#c9d1d9 !important; }
  html.dark .text-slate-700 { color:#b0bac6 !important; }
  html.dark .text-slate-600 { color:#8b949e !important; }
  html.dark .text-slate-500 { color:#6e7681 !important; }
  html.dark .text-slate-400 { color:#4d5562 !important; }
  html.dark .text-brand-900, html.dark .text-brand-800,
  html.dark .text-brand-700, html.dark .text-brand-600 { color:#818cf8 !important; }
  html.dark [class*="border-slate-2"], html.dark [class*="border-slate-1"] { border-color:rgba(255,255,255,0.06) !important; }
  html.dark [class*="border-brand-2"] { border-color:rgba(99,102,241,0.2) !important; }
  html.dark .border-dashed { border-color:rgba(255,255,255,0.08) !important; }
  html.dark [class*="border-t"] { border-color:rgba(255,255,255,0.05) !important; }
  html.dark * { box-shadow:none !important; }
  html.dark .glass { background:rgba(22,27,34,0.85) !important; border-color:rgba(255,255,255,0.07) !important; }
  html.dark .mesh {
    background-image:
      radial-gradient(circle at 10% 20%, rgba(99,102,241,0.12), transparent 40%),
      radial-gradient(circle at 80% 0%, rgba(139,92,246,0.08), transparent 35%) !important;
  }
  html.dark input:not([type=submit]):not([type=button]), html.dark textarea, html.dark select {
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
  .link-v { width:1px; height:16px; background:#cbd5e1; margin:0 auto; }
  html.dark .link-v { background:rgba(255,255,255,0.14) !important; }
</style>`;

export const Nav = ({ activePage }: NavOptions) => html`${legacyDarkStyles}${SiteNav({ active: MAP[activePage] ?? "none" })}`;

export const Footer = () => SiteFooter();
