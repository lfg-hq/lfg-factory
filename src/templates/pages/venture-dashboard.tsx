import { html } from "hono/html";

// A working app page, not marketing: its own slim top bar, no site nav/footer.
// Founders and LFG reviewers load data through /api/venture; the script renders
// either the venture list or one venture's full view into #vd.
export const VentureDashboardPage = () => html`<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ventures | LFG</title><meta name="robots" content="noindex">
<link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
<script>if (localStorage.getItem('lfg-theme') === 'dark') document.documentElement.classList.add('dark');</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/public/css/venture-analyst.css">
<link rel="stylesheet" href="/public/css/venture-dashboard.css">
<script defer src="/public/js/marked.min.js"></script>
<script defer src="/public/js/venture-markdown.js"></script>
<script defer src="/public/js/venture-dashboard.js"></script></head>
<body class="vd-body">
<header class="vd-bar">
<a class="vd-brand" href="/"><span class="vd-logo" aria-hidden="true">${rocket}</span>LFG</a>
<span class="vd-sep" aria-hidden="true">/</span><a class="vd-crumb" href="/venture-analyst/dashboard">Ventures</a>
<nav class="vd-bar-right" aria-label="Account"><a class="vd-ghost" href="/venture-analyst?chat=open">Analyst chat</a><span id="vd-user" class="vd-user" hidden></span><button id="vd-signout" class="vd-ghost" type="button" hidden>Sign out</button></nav>
</header>
<main class="vd" id="vd" aria-live="polite"></main>
</body></html>`;

const rocket = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`;
