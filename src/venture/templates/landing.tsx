import { html, raw } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../../templates/components/site.tsx";

// Marketing page for LFG Ventures: what founders get and how it works.
// The idea forms are the call to action: public/venture/landing.js keeps the
// typed idea, signs the founder in with Google, and the analyst's page sends it
// as the first message. Without JavaScript the forms open the analyst's page.
const CHAT = "/venture-analyst/chat";

const ideaForm = (id: string) => html`<form class="vh-form" action="${CHAT}" method="get" data-idea-form>
  <label class="vh-sr" for="${id}">Tell the analyst about your idea</label>
  <input id="${id}" name="idea" type="text" maxlength="4000" autocomplete="off" placeholder="A booking app for plumbers in my city">
  <button class="vh-go" type="submit">Chat with the analyst ${arrow}</button>
</form>
<p class="vh-formnote" role="status">Next, sign in with Google and the analyst picks up your idea. By continuing you agree to the LFG Ventures <a href="/venture-analyst/terms">Terms</a>.</p>`;

export const VentureAnalystPage = () => html`<!doctype html>
<html lang="en"><head>${SiteHead({ title: "LFG Ventures | Your idea, built with LFG's AI agents", description: "LFG invests tokens and agent execution, not cash. Our agents build and run your business in exchange for equity or a revenue share. Start with a conversation.", path: "/venture-analyst" })}
<link rel="stylesheet" href="/public/venture/landing.css">
<script defer src="/public/venture/landing.js"></script></head>
<body class="vh-body text-slate-900 font-sans">${SiteNav({})}
<main class="vh">

<section class="vh-hero">
  <span class="vh-badge"><span class="vh-logo" aria-hidden="true">${rocket}</span>LFG Ventures · your AI venture partner</span>
  <h1>Bring the idea.<br><span class="vl-grad">We bring the team.</span></h1>
  <p class="vh-lede">LFG's AI agents build and run your business, in exchange for equity or a share of revenue. No cash upfront.</p>
  ${ideaForm("idea-top")}
  <ul class="vh-trust">
    <li>${check}You keep ownership</li>
    <li>${check}Nothing starts until both sides sign</li>
    <li>${check}Progress you can see, every week</li>
  </ul>
</section>

<div class="vh-wrap">
  <ul class="vh-agents" aria-label="LFG's agents">
    <li>Product</li><li>Design</li><li>Engineering</li><li>Marketing</li><li>Sales</li><li>Customer support</li><li>Bookkeeping</li><li>Hosting and security</li><li>Custom agents</li>
  </ul>

  <section class="vh-shot" aria-labelledby="shot-title">
    <div class="vh-head">
      <p class="vh-kicker">Your venture dashboard</p>
      <h2 class="vh-h2" id="shot-title">Every token, every milestone, in plain view.</h2>
      <p class="vh-lede">See what the agents are building, what each piece cost, how many tokens are left in the tranche and what your customers are doing.</p>
    </div>
    <div class="vh-frame">
      <div class="vh-frame-bar" aria-hidden="true"><i></i><i></i><i></i><span>lfg.run/venture-analyst/dashboard</span></div>
      <img src="/public/images/screenshots/venture-dashboard.png" width="2560" height="1720" loading="lazy" alt="The LFG venture dashboard for a plumbers' booking app in week 5: 2.2M of 3M approved tokens spent, 770K left, 2 of 5 work items shipped and $1,176 in monthly revenue.">
    </div>
    <div class="vh-callouts">
      <div><b>Tokens left</b><span>The budget still in your tranche, always current.</span></div>
      <div><b>Work shipped</b><span>Each item with its cost and ship date.</span></div>
      <div><b>Results</b><span>Revenue, customers and users, week by week.</span></div>
    </div>
  </section>
</div>

<section class="vh-band" aria-labelledby="invest-title"><div class="vh-wrap vh-sec">
  <div class="vh-head">
    <p class="vh-kicker">A new kind of investment</p>
    <h2 class="vh-h2" id="invest-title">We invest with execution, not cash.</h2>
    <p class="vh-lede">Other venture funds write a cheque and leave the building to you. LFG invests tokens, and our agents turn those tokens into execution: the product, the launch and the day-to-day running of the business.</p>
  </div>
  <div class="vh-pillars">
    <div><h3>Tokens</h3><p>Your venture gets its own token budget, released one tranche at a time. Every token powers an agent working on your business.</p></div>
    <div><h3>Execution</h3><p>Agents do the work: design, code, marketing, sales and support. You see every item, what it cost and when it shipped.</p></div>
    <div><h3>A real stack, day one</h3><p>Hosting, auth, payments, analytics and security. Shared and maintained.</p></div>
  </div>
</div></section>

<section class="vh-wrap vh-sec" id="how" aria-labelledby="how-title">
  <div class="vh-split">
    <div class="vh-col">
      <p class="vh-kicker">Five steps</p>
      <h2 class="vh-h2" id="how-title">How it works</h2>
      <ol class="vh-steps">
        <li><span>01</span><div><h3>Talk</h3><p>Chat with the analyst about the idea and what you bring.</p></div></li>
        <li><span>02</span><div><h3>Get a verdict</h3><p>Fund, not yet, or no. With a token budget and a proposed deal.</p></div></li>
        <li><span>03</span><div><h3>Sign</h3><p>Agree the terms. Ask to renegotiate if they don't fit.</p></div></li>
        <li><span>04</span><div><h3>Build and sell</h3><p>Agents build and run it. You talk to customers.</p></div></li>
        <li><span>05</span><div><h3>Check in</h3><p>Real results decide the next tranche.</p></div></li>
      </ol>
    </div>
    <div>
      <div class="vh-phone" aria-label="Example conversation with the analyst" role="img">
        <div class="vh-chat">
          <div class="vh-chat-head"><span class="vh-logo" aria-hidden="true">${rocket}</span><div><b>Venture Analyst</b><small>Example conversation</small></div></div>
          <div class="vh-chat-body">
            <p class="vh-msg me">I want to build a simple booking tool for plumbers. I know about 10 of them who'd try it.</p>
            <p class="vh-msg">That network is a real head start. Let's ship a first version you can show them, and I'll draft talking points for those 10 conversations.</p>
            <div class="vh-verdict">
              <div><span>Verdict</span><b class="good">Fund</b></div>
              <div><span>First tranche</span><b>3M tokens</b></div>
              <div><span>Deal</span><b>8% revenue share</b></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="vh-band" aria-labelledby="size-title"><div class="vh-wrap vh-sec">
  <div class="vh-split">
    <div class="vh-col">
      <p class="vh-kicker">Tranches and milestones</p>
      <h2 class="vh-h2" id="size-title">Sized to the idea.</h2>
      <p class="vh-lede">The first tranche unlocks the next milestone. Hit it, and your progress unlocks the next tranche, then the one after that.</p>
      <p class="vh-lede">The analyst picks milestones that fit your business: revenue, paying customers or active users. Results come from LFG's analytics and billing, so everyone sees the same numbers.</p>
      <div class="vh-results"><img src="/public/images/screenshots/venture-results.png" width="1196" height="480" loading="lazy" alt="Results card from the venture dashboard: revenue, paying customers and weekly active users rising over five readings."></div>
    </div>
    <div class="vh-plan" aria-label="Example milestone plan">
      <div class="vh-plan-top"><b>Booking app for plumbers</b><span>Example plan</span></div>
      <div class="vh-ms done"><span class="vh-ms-dot" aria-hidden="true">${tick}</span><div class="vh-ms-body"><div class="vh-ms-row"><b>Talk to 10 plumbers</b><span class="vh-tag done">Complete</span></div><span>Feedback on the first version</span></div></div>
      <div class="vh-ms now"><span class="vh-ms-dot" aria-hidden="true"></span><div class="vh-ms-body"><div class="vh-ms-row"><b>First 50 paying plumbers</b><span class="vh-tag now">In progress</span></div><span>Tranche 1 · 31 of 50 so far</span><div class="vh-bar"><span style="width:62%"></span></div></div></div>
      <div class="vh-ms"><span class="vh-ms-dot" aria-hidden="true">${lock}</span><div class="vh-ms-body"><div class="vh-ms-row"><b>$5K monthly revenue</b><span class="vh-tag">Locked</span></div><span>Unlocks tranche 2</span></div></div>
      <div class="vh-ms"><span class="vh-ms-dot" aria-hidden="true">${lock}</span><div class="vh-ms-body"><div class="vh-ms-row"><b>1,000 weekly active users</b><span class="vh-tag">Locked</span></div><span>Unlocks tranche 3</span></div></div>
    </div>
  </div>
  <div class="vh-sizes">
    <div class="vh-size"><small>Content-led product</small><b>~300K tokens</b><p>Landing page and a content plan on X.</p></div>
    <div class="vh-size"><small>Local service tool</small><b>~3M tokens</b><p>MVP plus a paid pilot with 10 customers.</p></div>
    <div class="vh-size"><small>Venture-scale platform</small><b>100M+ tokens</b><p>A staged build with design partners.</p></div>
  </div>
</div></section>

<section class="vh-wrap vh-sec" aria-labelledby="factory-title">
  <div class="vh-head">
    <p class="vh-kicker">The software factory</p>
    <h2 class="vh-h2" id="factory-title">A software factory that builds your product, and your custom agents.</h2>
    <p class="vh-lede">LFG is a team of specialised agents on one shared stack. They build your software, then keep it running, so you can spend your time on customers.</p>
  </div>
  <div class="vh-grid three">
    <div class="vh-tile"><h3>Product and design</h3><p>Scoped, designed and launched for you.</p></div>
    <div class="vh-tile"><h3>Engineering</h3><p>Web apps, mobile and integrations, tested and shipped.</p></div>
    <div class="vh-tile"><h3>Marketing</h3><p>Landing pages, content and short videos.</p></div>
    <div class="vh-tile"><h3>Sales</h3><p>Outreach and follow-ups that bring in customers.</p></div>
    <div class="vh-tile"><h3>Customer support</h3><p>Questions answered fast, around the clock.</p></div>
    <div class="vh-tile"><h3>Bookkeeping</h3><p>Your numbers, always up to date.</p></div>
    <div class="vh-tile"><h3>Hosting and security</h3><p>A production-ready setup from day one.</p></div>
    <div class="vh-tile"><h3>Analytics</h3><p>The readings that decide your next tranche.</p></div>
    <div class="vh-tile dark"><h3>Custom agents</h3><p>Agents built for your business: a quoting bot, a dispatcher, whatever your customers need.</p></div>
  </div>
</section>

<section class="vh-band" aria-labelledby="notyet-title"><div class="vh-wrap vh-sec">
  <div class="vh-split">
    <div class="vh-col">
      <p class="vh-kicker">When it's not a yes</p>
      <h2 class="vh-h2" id="notyet-title">Not yet isn't no.</h2>
      <p class="vh-lede">Most ideas that aren't funded just need more data or more clarity. You get a plan, not a dead end.</p>
      <ul class="vh-points">
        <li><b>What's missing</b><span>Clear gaps, like who pays and how much.</span></li>
        <li><b>What to do next</b><span>Concrete steps, like 10 customer conversations.</span></li>
        <li><b>Pick up where you left off</b><span>Come back with answers. Your conversation is saved; ask for a fresh assessment.</span></li>
      </ul>
    </div>
    <div class="vh-plan" aria-label="Example feedback">
      <div class="vh-plan-top"><b>Email automation for newsletter creators</b><span class="vh-tag warn">Needs more info</span></div>
      <div class="vh-fb"><small>Missing</small><p>Which creators, and what they pay for tools today.</p></div>
      <div class="vh-fb"><small>Next steps</small><p>Pick one niche. Talk to 10 creators in it.</p></div>
      <div class="vh-fb"><small>Then</small><p>Bring the answers back. The analyst reassesses.</p></div>
    </div>
  </div>
</div></section>

<section class="vh-wrap vh-sec" id="coach" aria-labelledby="coach-title">
  <div class="vh-split">
    <div class="vh-col">
      <p class="vh-kicker">Your coach</p>
      <h2 class="vh-h2" id="coach-title">LFG is also your coach.</h2>
      <p class="vh-lede">It remembers your journey, learns from you and grows with your business. Bring it ideas any time, and it helps you shape them into a venture worth building.</p>
    </div>
    <div class="vh-col">
      <div class="vh-tile"><h3>Remembers your context</h3><p>Every conversation builds on the last, so you never start from scratch.</p></div>
      <div class="vh-tile"><h3>Brainstorms with you</h3><p>Talk through ideas and get fresh suggestions for what to try next.</p></div>
      <div class="vh-tile"><h3>Keeps you honest</h3><p>Clear to-dos with success signals, checked at every check-in.</p></div>
    </div>
  </div>
</section>

<section class="vh-band" aria-label="Who brings what"><div class="vh-wrap vh-sec">
  <div class="vh-bring">
    <div><h3>You bring</h3><ul><li>The problem and the insight</li><li>Your network and first customers</li><li>Selling, feedback, follow-through</li></ul></div>
    <div><h3>LFG brings</h3><ul><li>Product, design and engineering</li><li>Marketing, support and operations</li><li>Infrastructure, security and upkeep</li></ul></div>
  </div>
</div></section>

<section class="vh-wrap vh-sec" aria-labelledby="faq-title">
  <h2 class="vh-h2" id="faq-title" style="margin-bottom:32px">Questions founders ask</h2>
  <div class="vh-grid">
    <div class="vh-tile"><h3>Do I pay anything upfront?</h3><p>No. LFG invests tokens and execution, not cash. We earn when you do.</p></div>
    <div class="vh-tile"><h3>Who runs the company?</h3><p>You do. LFG is your partner, with equity or a revenue share agreed and signed by both sides.</p></div>
    <div class="vh-tile"><h3>What if the answer is not yet?</h3><p>You get what's missing and the next steps. Come back with answers and ask for a fresh assessment.</p></div>
    <div class="vh-tile"><h3>How are new tranches released?</h3><p>Milestones. Real results unlock the next tranche.</p></div>
  </div>
</section>

<section class="vh-final" id="start" aria-labelledby="final-title"><div class="vh-wrap">
  <h2 id="final-title">Have an idea worth building?</h2>
  <p class="vh-lede">Start with a conversation. It's private to you and LFG's venture team.</p>
  ${ideaForm("idea-bottom")}
  <a class="vh-thesis" href="/venture-analyst/thesis">Read the thesis →</a>
</div></section>

</main>${SiteFooter()}</body></html>`;

// Static, trusted icon paths only.
const svg = (d: string, size = 18, width = 2.2) => html`<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${raw(d)}</svg>`;
const check = svg('<path d="m5 12 4 4 10-10"/>', 16);
const tick = svg('<path d="M20 6 9 17l-5-5"/>', 14, 3);
const arrow = svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', 18, 2.5);
const lock = svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 13, 2.2);
const rocket = svg('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>', 16, 2);
