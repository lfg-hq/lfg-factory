import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";

export const VentureAnalystPage = () => html`<!doctype html>
<html lang="en"><head>${SiteHead({ title: "AI Venture Analyst | LFG", description: "An honest conversation about your idea, your edge, and the market.", path: "/venture-analyst" })}
<link rel="stylesheet" href="/public/css/venture-analyst.css">
<script defer src="/public/js/venture-analyst.js"></script></head>
<body class="text-slate-900 font-sans">${SiteNav({})}
<main class="venture" id="venture">
<div class="va-grid" id="va-grid">
<section class="va-pitch">
<div class="va-eyebrow"><span aria-hidden="true"></span> YOUR AI VENTURE ANALYST</div>
<h1>Is this the right business?<br><span class="va-gradient">Are you the right founder?</span></h1>
<p class="va-lead">An honest conversation about your idea, your edge, and the market. Turn big assumptions into an evidence-backed plan.</p>
<button class="va-pill" id="va-cta" aria-expanded="false" aria-controls="va-panel">Chat with analyst agent</button>
<p class="va-muted">Sign in with Google to start your private assessment.</p>
<div class="va-benefits"><div>${check}Founder fit and what to change</div><div>${check}Market size, revenue potential and funding fit</div><div>${check}A practical GTM and path to first revenue</div></div>
</section>
<section class="va-panel" id="va-panel" aria-label="Venture analyst chat" tabindex="-1">
<header class="va-head"><span class="va-avatar" aria-hidden="true">${bot}</span><div><strong id="va-heading">Venture Analyst</strong><small id="va-status">Example conversation · not a live chat</small></div><button id="va-close" aria-label="Collapse chat" hidden><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
<div id="va-stage" aria-live="polite"></div>
</section></div>
<section class="va-rail"><div><b>01 · Understand you</b>Your experience, ambitions and constraints.</div><div><b>02 · Test the opportunity</b>Public evidence, not just optimistic assumptions.</div><div><b>03 · Plan the next move</b>Validate, launch, acquire users and earn revenue.</div></section>
</main>${SiteFooter()}</body></html>`;

const check = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4 10-10"/></svg>`;
const bot = html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="16" height="14" rx="4"/><path d="M12 3v4M9 12v2m6-2v2M9 17h6M1 12v4m22-4v4"/></svg>`;
