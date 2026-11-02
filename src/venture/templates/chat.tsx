import { html } from "hono/html";

// The analyst's own page: the same chat as the landing panel, full height,
// inside the venture app bar. public/venture/analyst.js runs in "page" mode here.
export const VentureChatPage = () => html`<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Venture Analyst | LFG</title><meta name="robots" content="noindex">
<link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
<script>if (localStorage.getItem('lfg-theme') === 'dark') document.documentElement.classList.add('dark');</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/public/venture/analyst.css">
<link rel="stylesheet" href="/public/venture/dashboard.css">
<script defer src="/public/js/marked.min.js"></script>
<script defer src="/public/venture/markdown.js"></script>
<script defer src="/public/venture/analyst.js"></script></head>
<body class="vd-body" data-venture-mode="page">
<header class="vd-bar">
<a class="vd-brand" href="/"><span class="vd-logo" aria-hidden="true">${rocket}</span>LFG</a>
<span class="vd-sep" aria-hidden="true">/</span><a class="vd-crumb" href="/venture-analyst/dashboard">Ventures</a>
<span class="vd-sep" aria-hidden="true">/</span><span class="vd-crumb">Analyst</span>
</header>
<main class="va-chatpage">
<section class="va-panel" id="va-panel" aria-label="Venture analyst chat" tabindex="-1">
<header class="va-head"><span class="va-avatar" aria-hidden="true">${bot}</span><div><strong id="va-heading">Venture Analyst</strong><small id="va-status">Loading…</small></div><a id="va-dashboard" class="va-dash" href="/venture-analyst/dashboard" hidden>Go to dashboard <span aria-hidden="true">→</span></a><button id="va-close" aria-label="Close" hidden></button></header>
<div id="va-stage" aria-live="polite"></div>
</section>
</main></body></html>`;

const rocket = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`;
const bot = html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="16" height="14" rx="4"/><path d="M12 3v4M9 12v2m6-2v2M9 17h6M1 12v4m22-4v4"/></svg>`;
