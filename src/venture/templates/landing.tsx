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
<html lang="en"><head>${SiteHead({ title: "LFG Ventures | Your AI venture partner", description: "LFG is a venture partner that invests tokens and agent execution, not cash. Your business, built free. We get paid, only if you do. Start with a conversation.", path: "/venture-analyst" })}
<link rel="stylesheet" href="/public/venture/landing.css">
<script defer src="/public/venture/landing.js"></script></head>
<body class="vh-body text-slate-900 font-sans">${SiteNav({})}
<main class="vh">

<section class="vh-hero">
  <span class="vh-badge"><span class="vh-logo" aria-hidden="true">${rocket}</span>LFG Ventures · your AI venture partner</span>
  <h1>Your business, built free. <span class="vl-grad">We get paid, only if you do.</span></h1>
  <p class="vh-lede">LFG is a venture partner. Instead of cash, we invest tokens and the agents that turn them into execution, in exchange for equity or a share of revenue. You stay the founder.</p>
  ${ideaForm("idea-top")}
  <ul class="vh-trust">
    <li>${check}No upfront cost</li>
    <li>${check}Equity or revenue share</li>
    <li>${check}Milestones unlock more tokens</li>
  </ul>
</section>

<div class="vh-wrap">
  <section class="vh-work" aria-labelledby="work-title">
    <div class="vh-work-head"><h2 id="work-title">Agents at work</h2><span>This week on the example venture</span></div>
    <ul>
      <li><span class="vh-live" aria-hidden="true"></span><small>Sales agent</small><p>Sent 42 follow-ups to local plumbers</p></li>
      <li><span class="vh-live" aria-hidden="true"></span><small>Engineering agent</small><p>Shipped SMS reminders before every job</p></li>
      <li><span class="vh-live" aria-hidden="true"></span><small>Support agent</small><p>Rescheduled 6 jobs overnight</p></li>
      <li><span class="vh-live" aria-hidden="true"></span><small>Marketing agent</small><p>Posted a 60-second demo reel</p></li>
      <li><span class="vh-live" aria-hidden="true"></span><small>Bookkeeping agent</small><p>Reconciled 24 subscriptions</p></li>
      <li class="custom"><span class="vh-live" aria-hidden="true"></span><small>Custom agent · quote bot</small><p>Priced 14 jobs from customer photos</p></li>
    </ul>
  </section>

  <section class="vh-shot" aria-labelledby="shot-title">
    <div class="vh-head">
      <p class="vh-kicker">Your venture dashboard</p>
      <h2 class="vh-h2" id="shot-title">Every token, every milestone, in plain view.</h2>
      <p class="vh-lede">See the objective you're working toward and how close you are, what the agents are building, how many tokens are left in the tranche and what your customers are doing.</p>
    </div>
    <div class="vh-frame">
      <div class="vh-frame-bar" aria-hidden="true"><i></i><i></i><i></i><span>lfg.run/venture-analyst/dashboard</span></div>
      <img src="/public/images/screenshots/venture-dashboard.png" width="2560" height="1720" loading="lazy" alt="The LFG venture dashboard for a plumbers' booking app in week 5: the tranche 1 objective, will plumbers pay $49 a month, is 96% done at 24 of 25 paying plumbers; 2.2M of 3M tokens spent, 770K left, 2 of 5 work items shipped and $1,176 in monthly revenue.">
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
    <p class="vh-lede">Other venture funds write a cheque and leave the building to you. LFG invests tokens, leveraged by agents that turn them into execution: the product, the launch and the day-to-day running of the business. We earn our equity or revenue share only when the business works.</p>
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
      <p class="vh-kicker">A gamified way to build companies</p>
      <h2 class="vh-h2" id="how-title">How it works</h2>
      <ol class="vh-steps">
        <li><span>01</span><div><h3>Talk</h3><p>Chat with the analyst about the idea and what you bring.</p></div></li>
        <li><span>02</span><div><h3>Get a verdict</h3><p>Fund, not yet, or no. With a token budget and a proposed deal.</p></div></li>
        <li><span>03</span><div><h3>Sign</h3><p>Agree the terms. Ask to renegotiate if they don't fit.</p></div></li>
        <li><span>04</span><div><h3>Build toward the milestone</h3><p>The first tranche of tokens is for one milestone. Agents build and run it. You talk to customers.</p></div></li>
        <li><span>05</span><div><h3>Check in and level up</h3><p>Real results unlock the next tranche, and the loop starts again.</p></div></li>
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
  <div class="vh-loop" aria-labelledby="loop-title">
    <h3 id="loop-title">The loop</h3>
    <ol>
      <li><span class="vh-loop-n">1</span><b>Tranche</b><span>Tokens for the next milestone</span></li>
      <li><span class="vh-loop-n">2</span><b>Build</b><span>Agents execute: product, marketing, sales</span></li>
      <li><span class="vh-loop-n">3</span><b>Milestone</b><span>Revenue, customers or active users</span></li>
      <li><span class="vh-loop-n">4</span><b>Results</b><span>Measured by LFG's analytics and billing</span></li>
    </ol>
    <p class="vh-loop-back">${repeat}Hit the milestone and the next tranche unlocks. Every level funds the next one.</p>
  </div>
</section>

<section class="vh-band" aria-labelledby="size-title"><div class="vh-wrap vh-sec">
  <div class="vh-split">
    <div class="vh-col">
      <p class="vh-kicker">Tranches and objectives</p>
      <h2 class="vh-h2" id="size-title">Sized to the idea.</h2>
      <p class="vh-lede">Each tranche of tokens is released against one objective: a question your business needs answered. The agents build only what helps validate it. Answer it with real results, and the next tranche unlocks.</p>
      <p class="vh-lede">The analyst sets objectives that fit your business and measures them in revenue, paying customers or active users. Results come from LFG's analytics and billing, so everyone sees the same numbers.</p>
      <div class="vh-results"><img src="/public/images/screenshots/venture-results.png" width="1196" height="480" loading="lazy" alt="Results card from the venture dashboard: revenue, paying customers and weekly active users rising over five readings."></div>
    </div>
    <div class="vh-plan vh-obj" aria-label="Example tranche objective">
      <div class="vh-plan-top"><span>Tranche 1 · objective</span><span class="vh-tag done">3M tokens released</span></div>
      <p class="vh-obj-q">Will independent plumbers pay $49 a month to stop missing jobs?</p>
      <span class="vh-obj-pass">Passes at 25 paying plumbers by week 6 · 24 so far</span>
      <div class="vh-bar"><span style="width:96%"></span></div>
      <ul class="vh-obj-work">
        <li><div><b>Build a WhatsApp booking flow</b><span>to validate: plumbers will move bookings off the phone</span></div><span class="vh-tag good">Validated · 1.4M</span></li>
        <li><div><b>Launch a page that takes a $49 deposit</b><span>to validate: they'll pay before it's finished</span></div><span class="vh-tag good">Validated · 310K</span></li>
        <li><div><b>Run outreach to 200 local plumbers</b><span>to validate: demand beyond the founder's network</span></div><span class="vh-tag warn">Testing · 250K</span></li>
      </ul>
      <p class="vh-obj-next">${lock}Next objective: can it reach $5K a month? Unlocks tranche 2</p>
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
    <p class="vh-lede">Your venture's tokens run a factory of specialised agents on one shared stack. They build your software, then keep it running, so you can spend your time on customers.</p>
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
  <p class="vh-lede">Your business, built free. We get paid, only if you do. Start with a conversation, private to you and LFG's venture team.</p>
  ${ideaForm("idea-bottom")}
  <a class="vh-thesis" href="/venture-analyst/thesis">Read the thesis →</a>
</div></section>

</main>${SiteFooter()}</body></html>`;

// Static, trusted icon paths only.
const svg = (d: string, size = 18, width = 2.2) => html`<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${raw(d)}</svg>`;
const check = svg('<path d="m5 12 4 4 10-10"/>', 16);
const arrow = svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', 18, 2.5);
const repeat = svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>', 18, 2);
const lock = svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 13, 2.2);
const rocket = svg('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>', 16, 2);
