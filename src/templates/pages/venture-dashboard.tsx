import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";

// Shell only; founders and LFG reviewers load data through /api/venture.
export const VentureDashboardPage = () => html`<!doctype html>
<html lang="en"><head>${SiteHead({ title: "Venture Dashboard | LFG", description: "Your venture verdict, market opportunity, token tranche and next steps.", path: "/venture-analyst/dashboard", noindex: true })}
<link rel="stylesheet" href="/public/css/venture-analyst.css">
<script defer src="/public/js/marked.min.js"></script>
<script defer src="/public/js/venture-markdown.js"></script>
<script defer src="/public/js/venture-dashboard.js"></script></head>
<body class="text-slate-900 font-sans">${SiteNav({})}
<main class="venture vd" id="vd">
<header class="vd-top">
<div><div class="va-eyebrow"><span aria-hidden="true"></span> VENTURE DASHBOARD</div><h1 id="vd-title">Your ventures</h1></div>
<div class="vd-actions"><div id="vd-scope" class="vd-tabs" hidden></div><a class="va-pill" href="/venture-analyst?chat=open">Open analyst chat</a></div>
</header>
<div class="vd-grid"><aside id="vd-list" aria-label="Ventures"></aside><section id="vd-detail" aria-live="polite"></section></div>
</main>${SiteFooter()}</body></html>`;
