import { html, raw } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../../templates/components/site.tsx";

// Marketing page for LFG Ventures: what founders get and how it works.
// Static; every call to action goes to the analyst's page, which handles sign-in.
const CHAT = "/venture-analyst/chat";

export const VentureAnalystPage = () => html`<!doctype html>
<html lang="en"><head>${SiteHead({ title: "LFG Ventures | Your idea, built with LFG's AI agents", description: "LFG's agents build and run your business in exchange for equity or a revenue share. No cash upfront. Start with a conversation.", path: "/venture-analyst" })}
<link rel="stylesheet" href="/public/venture/landing.css"></head>
<body class="text-slate-900 font-sans">${SiteNav({})}
<main class="vl">

<section class="vl-hero">
  <div class="vl-hero-copy">
    <span class="vl-eyebrow"><span aria-hidden="true"></span>LFG VENTURES</span>
    <h1>Bring the idea.<br><span class="vl-grad">We bring the team.</span></h1>
    <p class="vl-lead">LFG's AI agents build and run your business, in exchange for equity or a share of revenue. No cash upfront.</p>
    <div class="vl-ctas">
      <a class="vl-btn primary" href="${CHAT}">Talk to the analyst</a>
      <a class="vl-btn" href="#how">How it works</a>
    </div>
    <ul class="vl-trust">
      <li>${check}You keep ownership</li>
      <li>${check}Nothing starts until both sides sign</li>
      <li>${check}Progress you can see, every week</li>
    </ul>
  </div>

  <div class="vl-card" aria-label="Example venture">
    <div class="vl-card-top"><span class="vl-tag">Example venture</span><span class="vl-pill good">Active</span></div>
    <strong class="vl-card-title">Booking app for independent plumbers</strong>
    <div class="vl-card-grid">
      <div><small>Deal</small><b>8% revenue share</b></div>
      <div><small>Tranche</small><b>3M tokens</b></div>
      <div><small>Timeline</small><b>Week 4</b></div>
      <div><small>Revenue</small><b>$192 / mo</b></div>
    </div>
    <div class="vl-card-work">
      <div><span class="vl-type">MVP</span>WhatsApp booking + calendar<span class="vl-pill good">Shipped</span></div>
      <div><span class="vl-type">Landing page</span>Sign-up and pilot deposits<span class="vl-pill good">Shipped</span></div>
      <div><span class="vl-type">Support</span>FAQ bot for customers<span class="vl-pill info">Building</span></div>
    </div>
  </div>
</section>

<section class="vl-section">
  <h2>What you get</h2>
  <div class="vl-values">
    <div class="vl-value">${icon.coins}<h3>No cash upfront</h3><p>LFG invests agent work, measured in tokens.</p></div>
    <div class="vl-value">${icon.server}<h3>A real stack, day one</h3><p>Hosting, auth, payments, analytics and security. Shared, maintained.</p></div>
    <div class="vl-value">${icon.search}<h3>An honest first read</h3><p>Market size, your edge and a clear verdict, with sources.</p></div>
    <div class="vl-value">${icon.handshake}<h3>Upside only if it works</h3><p>Equity or a capped revenue share. Agreed and signed by both sides.</p></div>
  </div>
</section>

<section class="vl-section" id="how">
  <h2>How it works</h2>
  <ol class="vl-steps">
    <li><span>1</span><h3>Talk</h3><p>Chat with the analyst about the idea and what you bring.</p></li>
    <li><span>2</span><h3>Get a verdict</h3><p>Fund, not yet, or no. With a token budget and a proposed deal.</p></li>
    <li><span>3</span><h3>Sign</h3><p>Agree the terms. Ask to renegotiate if they don't fit.</p></li>
    <li><span>4</span><h3>Build and sell</h3><p>Agents build and run it. You talk to customers.</p></li>
    <li><span>5</span><h3>Check in</h3><p>Real results decide the next tranche.</p></li>
  </ol>
</section>

<section class="vl-section vl-notyet">
  <div>
    <h2>Not yet isn't no.</h2>
    <p class="vl-sub">Most ideas that aren't funded just need more data or more clarity. You get a plan, not a dead end.</p>
    <ul class="vl-points">
      <li><b>What's missing</b><span>Clear gaps, like who pays and how much.</span></li>
      <li><b>What to do next</b><span>Concrete steps, like 10 customer conversations.</span></li>
      <li><b>Pick up where you left off</b><span>Come back with answers. Your conversation is saved; ask for a fresh assessment.</span></li>
    </ul>
  </div>
  <div class="vl-card vl-feedback" aria-label="Example feedback">
    <div class="vl-card-top"><span class="vl-tag">Example feedback</span><span class="vl-pill warn">Needs more info</span></div>
    <strong class="vl-card-title">Email automation for newsletter creators</strong>
    <div class="vl-fb"><small>Missing</small><p>Which creators, and what they pay for tools today.</p></div>
    <div class="vl-fb"><small>Next steps</small><p>Pick one niche. Talk to 10 creators in it.</p></div>
    <div class="vl-fb"><small>Then</small><p>Bring the answers back. The analyst reassesses.</p></div>
  </div>
</section>

<section class="vl-section">
  <h2>Sized to the idea</h2>
  <p class="vl-sub">The first tranche covers the next milestone, not the whole company.</p>
  <div class="vl-sizes">
    <div class="vl-size"><small>Content-led product</small><b>~300K tokens</b><p>Landing page and a content plan on X.</p></div>
    <div class="vl-size"><small>Local service tool</small><b>~3M tokens</b><p>MVP plus a paid pilot with 10 customers.</p></div>
    <div class="vl-size"><small>Venture-scale platform</small><b>100M+ tokens</b><p>A staged build with design partners.</p></div>
  </div>
</section>

<section class="vl-section vl-split">
  <div><h3>You bring</h3><ul><li>The problem and the insight</li><li>Your network and first customers</li><li>Selling, feedback, follow-through</li></ul></div>
  <div><h3>LFG brings</h3><ul><li>Product, design and engineering</li><li>Marketing, support and operations</li><li>Infrastructure, security and upkeep</li></ul></div>
</section>

<section class="vl-final">
  <h2>Have an idea worth building?</h2>
  <p>Start with a conversation. It's private to you and LFG's venture team.</p>
  <a class="vl-btn primary light" href="${CHAT}">Talk to the analyst</a>
  <a class="vl-thesis" href="/venture-analyst/thesis">Read the thesis →</a>
</section>

</main>${SiteFooter()}</body></html>`;

const check = html`<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4 10-10"/></svg>`;
// Static, trusted icon paths only.
const svg = (d: string) => html`<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${raw(d)}</svg>`;
const icon = {
  coins: svg('<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>'),
  server: svg('<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  handshake: svg('<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>'),
};
