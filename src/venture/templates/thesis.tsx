import { html, raw } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../../templates/components/site.tsx";
import { TOKEN_POLICY } from "../services/assessment.ts";

// The pitch: LFG Ventures' thesis and operating model, in short sections.
// Static. Tranche guidance comes from the same policy the analyst is given.
const CHAT = "/venture/chat";

export const VentureThesisPage = () => html`<!doctype html>
<html lang="en"><head>${SiteHead({ title: "LFG Ventures: the thesis", description: "Venture building paid in tokens: how LFG's analyst funds ideas, how agents build and run them, and how each tranche is earned.", path: "/venture/thesis", noindex: true })}
<link rel="stylesheet" href="/public/venture/landing.css">
<link rel="stylesheet" href="/public/venture/thesis.css"></head>
<body class="text-slate-900 font-sans">${SiteNav({})}
<main class="vl vt">

<section class="vt-hero">
  <span class="vl-eyebrow"><span aria-hidden="true"></span>THE THESIS</span>
  <h1>Venture building,<br><span class="vl-grad">paid in tokens.</span></h1>
  <p class="vl-lead">LFG funds founders with AI agent work instead of cash, for equity or a revenue share. Tokens measure what we put in and what comes back.</p>
  <div class="vt-hero-stats">
    <div><b>Tokens</b><span>the unit of investment</span></div>
    <div><b>Tranches</b><span>released milestone by milestone</span></div>
    <div><b>One stack</b><span>shared by every venture</span></div>
  </div>
</section>

<section class="vl-section">
  <h2>Why now</h2>
  <div class="vt-why">
    <div><span>01</span><h3>Ideas are everywhere</h3><p>From a plumber's booking tool to an AI observability platform.</p></div>
    <div><span>02</span><h3>Agents can do the work</h3><p>Product, marketing, support and operations, end to end.</p></div>
    <div><span>03</span><h3>Founders bring what's scarce</h3><p>The insight, the network and the selling.</p></div>
    <div><span>04</span><h3>Tokens make it measurable</h3><p>Every tranche has a cost, a plan and a result.</p></div>
  </div>
</section>

<section class="vl-section">
  <h2>The loop</h2>
  <p class="vl-sub">One cycle per tranche. Results decide the next one.</p>
  <ol class="vt-loop">
    <li><span>${icon.search}</span><b>Assess</b><p>The analyst interviews the founder and checks public evidence.</p></li>
    <li><span>${icon.coins}</span><b>Fund</b><p>A tranche sized to the next milestone. Both sides sign.</p></li>
    <li><span>${icon.build}</span><b>Build and run</b><p>Agents ship and operate. The founder sells.</p></li>
    <li><span>${icon.chart}</span><b>Measure</b><p>Revenue, usage, spend and founder commitments.</p></li>
    <li><span>${icon.split}</span><b>Decide</b><p>Release more, hold and learn, or halt.</p></li>
  </ol>
  <p class="vt-repeat">${icon.repeat} Repeats at every milestone or weekly check-in</p>
</section>

<section class="vl-section">
  <h2>How the analyst sizes a tranche</h2>
  <p class="vl-sub">Fund the next milestone, not the whole company. Only as much as the expected return justifies.</p>
  <div class="vt-sizing">
    <div class="vt-inputs">
      <h3>What it weighs</h3>
      <ul>
        <li><b>Market</b><span>Bottom-up TAM, SAM, SOM in US dollars</span></li>
        <li><b>Founder fit</b><span>Experience, access, network, capacity</span></li>
        <li><b>Evidence</b><span>Sourced facts vs self-reported claims</span></li>
        <li><b>Next milestone</b><span>What must be built to learn the most</span></li>
      </ul>
    </div>
    <div class="vt-rule">
      <small>The rule</small>
      <p class="vt-formula">Tranche = cost of the next milestone</p>
      <p class="vt-formula sub">only if expected return ≫ tranche</p>
      <div class="vt-verdicts"><span class="vl-pill good">Fund</span><span class="vl-pill warn">Needs more info</span><span class="vl-pill bad">Decline</span><span class="vl-pill bad">Prohibited</span></div>
      <p class="vt-note">Every claim is labelled sourced, founder-reported or estimate. Unknowns stay unknown.</p>
    </div>
  </div>
  <div class="vt-tiers">
    ${TOKEN_POLICY.guide.map(line => { const [what, size] = line.split(': '); return html`<div><b>${size}</b><span>${what}</span></div>`; })}
  </div>
  <div class="vt-example">
    <div class="vt-example-head"><small>Worked example</small><strong>Booking app for independent plumbers</strong><span>Founder: a working plumber in 3 WhatsApp groups with ~400 peers</span></div>
    <div class="vt-example-lines">
      <div><span class="vl-type">MVP</span>WhatsApp booking + calendar<b>2.2M</b></div>
      <div><span class="vl-type">Landing page</span>Sign-up and pilot deposits<b>0.5M</b></div>
      <div><span class="vl-type">Support</span>FAQ bot for customers<b>0.5M</b></div>
      <div class="vt-total">First tranche<b>3.2M tokens</b></div>
    </div>
    <div class="vt-example-deal"><span>Deal</span><b>8% of revenue until 3× the tranche, or 36 months</b><span>Founder commitments</span><b>Interview 10 plumbers · 3 paid pilots · demo video in the groups</b></div>
  </div>
</section>

<section class="vl-section">
  <h2>Agents do the work, on one stack</h2>
  <p class="vl-sub">Each venture gets a team of agents and a production platform from day one.</p>
  <div class="vt-work">
    <div><h3>Build</h3><p>MVPs, features, landing pages, integrations</p></div>
    <div><h3>Grow</h3><p>Content, campaigns, outreach, sales support</p></div>
    <div><h3>Run</h3><p>Customer support, bookkeeping, analytics</p></div>
    <div><h3>Maintain</h3><p>Hosting, upgrades, security fixes, uptime</p></div>
  </div>
  <div class="vt-stack">
    <small>Shared core, built once</small>
    <div><span>Auth</span><span>Payments</span><span>Analytics</span><span>Email</span><span>Support</span><span>Hosting</span><span>Security</span></div>
    <p>Every new venture starts production-grade and needs fewer tokens to launch.</p>
  </div>
</section>

<section class="vl-section">
  <h2>Release, hold or halt</h2>
  <p class="vl-sub">At each check-in the analyst reads real signals and recommends; LFG decides.</p>
  <div class="vt-signals">
    <span>Revenue</span><span>Active users</span><span>Conversion</span><span>Tokens spent vs plan</span><span>Work shipped</span><span>Founder commitments</span>
  </div>
  <div class="vt-decide">
    <div class="go"><h3>Release</h3><p>Milestone hit, numbers moving.</p><ul><li>Next tranche, sized to the next milestone</li><li>Next terms reflect the traction</li></ul></div>
    <div class="hold"><h3>Hold and learn</h3><p>Mixed or missing signals.</p><ul><li>Small, targeted experiments</li><li>Founder gathers specific data</li><li>Reassess at the next check-in</li></ul></div>
    <div class="stop"><h3>Halt</h3><p>No traction after real tries, or risk.</p><ul><li>Spending stops</li><li>The founder keeps the venture and its customers</li><li>Learnings feed the next decision</li></ul></div>
  </div>
</section>

<section class="vl-section vt-model">
  <div>
    <h2>How LFG earns</h2>
    <ul class="vl-points">
      <li><b>Equity</b><span>For venture-scale companies that will raise capital.</span></li>
      <li><b>Revenue or profit share</b><span>For smaller businesses. Capped at a multiple of the tranche, with an end date.</span></li>
      <li><b>Return per token</b><span>Tokens in, revenue back. Comparable across every venture.</span></li>
    </ul>
  </div>
  <div>
    <h2>Why it compounds</h2>
    <ul class="vl-points">
      <li><b>Cheaper launches</b><span>Each shared service makes the next venture cost fewer tokens.</span></li>
      <li><b>Sharper decisions</b><span>Every decision and its outcome calibrate the analyst.</span></li>
      <li><b>More shots on goal</b><span>Small tranches let LFG back many founders and double down on winners.</span></li>
    </ul>
  </div>
</section>

<section class="vl-final">
  <h2>The analyst decides. Agents build. Results earn the next tranche.</h2>
  <p>See it from the founder's side.</p>
  <div class="vt-final-ctas"><a class="vl-btn primary light" href="${CHAT}">Talk to the analyst</a><a class="vl-btn ghost" href="/venture">For founders</a></div>
</section>

</main>${SiteFooter()}</body></html>`;

// Static, trusted icon paths only.
const svg = (d: string) => html`<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${raw(d)}</svg>`;
const icon = {
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  coins: svg('<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>'),
  build: svg('<path d="m15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9"/><path d="M17.64 15 22 10.64"/><path d="m20.91 11.7-1.25-1.25a1.5 1.5 0 0 1 0-2.12l.64-.64a4 4 0 0 0-5.66-5.66l-.64.64a1.5 1.5 0 0 1-2.12 0L10.64 1.42"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>'),
  split: svg('<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.17-2.83L3 3"/><path d="m15 9 6-6"/>'),
  repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
};
