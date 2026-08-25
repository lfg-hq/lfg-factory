import { html, raw } from "hono/html";

interface BuildLandingPageProps {
  turnstileSiteKey?: string;
}

const buildExamples = [
  ["users", "Client onboarding portal", "Collect documents, track progress, assign tasks and keep customers updated."],
  ["git-pull-request-arrow", "Approval workflow", "Route requests, capture decisions and preserve a clear activity history."],
  ["layout-dashboard", "Operations dashboard", "Bring spreadsheets, forms and APIs into one useful operational view."],
  ["files", "Document-processing tool", "Extract structured information from files and route the results for review."],
  ["blocks", "Internal business application", "Replace repetitive manual work with software shaped around your process."],
  ["sparkles", "AI-assisted workflow", "Add practical summarization, classification, drafting or data extraction."],
  ["panel-top", "Customer portal", "Let customers submit information, see status and access documents in one place."],
  ["rocket", "MVP or product prototype", "Launch a focused first release to test demand with real customers."],
] as const;

const faqs = [
  ["What can you build for CAD $999?", "A tightly scoped first release of a web application, such as an internal workflow, dashboard, client portal or lightweight business tool."],
  ["Is every application CAD $999?", "No. CAD $999 is the starting price for projects that fit the Build Sprint constraints. Larger projects receive a fixed-price proposal before development begins."],
  ["Will I receive the source code?", "Yes. You receive the source code for the paid project, subject to the project agreement."],
  ["Can you finish something I started in an AI app builder?", "Yes. LFG can review projects from Replit, Lovable and similar tools, determine what is usable and turn the prototype into a reliable production application."],
  ["Why not build it myself with an AI app builder?", "Use an app builder when you want to direct the agent, make product decisions, test the application and manage deployment yourself. LFG is for customers who want an accountable team to own the agreed result."],
  ["Who reviews AI-generated code?", "LFG engineers review architecture, implementation, security risks and release readiness before anything ships."],
  ["What happens after the first release?", "Take over the code, engage LFG for another fixed-price release, or retain the team for ongoing maintenance and development."],
  ["Is the Build Blueprint really free?", "Yes. The initial Build Blueprint is free and does not require you to purchase development. You can also take it to another developer."],
  ["How quickly will I receive the blueprint?", "The automated system begins after email verification and usually prepares the first version within minutes. If more context is needed, it will ask a few focused questions first."],
  ["Do you guarantee delivery in 10 business days?", "The delivery target applies only to accepted Build Sprint projects after scope approval and receipt of the required customer information."],
] as const;

export const BuildLandingPage = ({ turnstileSiteKey = "" }: BuildLandingPageProps = {}) => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LFG Build Sprint — Custom software in 10 business days</title>
  <meta name="description" content="Turn one business workflow into working software. Fixed-price LFG Build Sprints start at CAD $999, with a free Build Blueprint before you commit.">
  <meta property="og:title" content="LFG Build Sprint — One workflow. Working software.">
  <meta property="og:description" content="Accepted Build Sprint projects receive a working first release within 10 business days. Starting at CAD $999.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://lfg.run/build-sprint">
  <meta property="og:image" content="https://lfg.run/public/images/social/build-sprint-og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="LFG Build Sprint">
  <meta name="twitter:description" content="One workflow. Working software. 10 business days. Starting at CAD $999.">
  <meta name="twitter:image" content="https://lfg.run/public/images/social/build-sprint-og.png">
  <link rel="canonical" href="https://lfg.run/build-sprint">
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/public/css/build-sprint.css?v=1">
  <script src="https://unpkg.com/lucide@latest" defer></script>
  ${turnstileSiteKey ? html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>` : ""}
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header" id="top">
    <div class="container nav-wrap">
      <a class="brand" href="/" aria-label="LFG home"><span class="brand-mark">L</span><span>LFG</span></a>
      <nav class="desktop-nav" aria-label="Primary navigation">
        <a href="#how-it-works">How it works</a><a href="#what-we-build">What we build</a><a href="#examples">Examples</a><a href="#faq">FAQ</a>
      </nav>
      <a class="button button-small" href="#blueprint" data-track="nav_blueprint">Get free blueprint <i data-lucide="arrow-up-right"></i></a>
      <button class="menu-button" type="button" aria-label="Open navigation" aria-expanded="false"><i data-lucide="menu"></i></button>
    </div>
    <nav class="mobile-nav" aria-label="Mobile navigation">
      <a href="#how-it-works">How it works</a><a href="#what-we-build">What we build</a><a href="#examples">Examples</a><a href="#faq">FAQ</a><a href="#blueprint">Get free blueprint</a>
    </nav>
  </header>

  <main id="main">
    <section class="hero section-dark">
      <div class="hero-orb orb-one"></div><div class="hero-orb orb-two"></div>
      <div class="container hero-grid">
        <div class="hero-copy reveal">
          <p class="eyebrow"><span></span> AI-native software delivery</p>
          <h1>Turn one business workflow into <em>working software</em> in 10 business days.</h1>
          <p class="hero-lede">Describe the problem in plain language. LFG scopes, builds, tests and deploys the solution using AI agents—with senior engineers responsible for the final release.</p>
          <div class="price-callout"><span>Fixed-price Build Sprints</span><strong>start at CAD $999</strong></div>
          <div class="button-row">
            <a class="button button-primary" href="#blueprint" data-track="hero_blueprint">Get my free Build Blueprint <i data-lucide="arrow-right"></i></a>
            <a class="button button-ghost" href="#blueprint" data-track="hero_apply">Apply for a Build Sprint</a>
          </div>
          <ul class="trust-list" aria-label="Build Sprint assurances">
            <li><i data-lucide="check"></i>No technical specification required</li><li><i data-lucide="check"></i>Know the scope before paying</li><li><i data-lucide="check"></i>Keep the source code</li><li><i data-lucide="check"></i>Senior engineer reviewed</li>
          </ul>
        </div>
        <div class="delivery-board reveal" aria-label="Example LFG delivery board">
          <div class="board-top"><span class="window-dots"><b></b><b></b><b></b></span><span>client-onboarding-v1</span><span class="live-pill"><i data-lucide="radio"></i> Live progress</span></div>
          <div class="board-summary"><div><span>Release</span><strong>First working version</strong></div><span class="on-track">On track</span></div>
          <div class="board-progress"><span style="width:78%"></span></div>
          <div class="board-list">
            <div class="board-row done"><i data-lucide="circle-check-big"></i><div><strong>PRD approved</strong><span>Scope locked · acceptance criteria set</span></div><small>Done</small></div>
            <div class="board-row active"><i data-lucide="loader-circle"></i><div><strong>Dashboard implementation</strong><span>2 agents working in isolated environments</span></div><small>Building</small></div>
            <div class="board-row done"><i data-lucide="shield-check"></i><div><strong>Integration tests</strong><span>18 of 18 acceptance checks passed</span></div><small>Passed</small></div>
            <div class="board-row"><i data-lucide="user-check"></i><div><strong>Senior review</strong><span>Architecture and release readiness</span></div><small>Scheduled</small></div>
            <div class="board-row muted"><i data-lucide="rocket"></i><div><strong>Release ready</strong><span>Deploy and hand over source code</span></div><small>Next</small></div>
          </div>
          <div class="board-footer"><span><i data-lucide="calendar-days"></i> Day 7 of 10</span><span><i data-lucide="git-branch"></i> 12 tickets complete</span></div>
        </div>
      </div>
      <div class="container workflow-strip" aria-label="LFG delivery workflow">
        ${["Business idea", "Build Blueprint", "Approved scope", "AI agents build", "Senior review", "Working software"].map((item, i) => html`<div class="flow-item"><span>${String(i + 1).padStart(2, "0")}</span><strong>${item}</strong></div>${i < 5 ? html`<i data-lucide="arrow-right" aria-hidden="true"></i>` : ""}`)}
      </div>
    </section>

    <section class="problem section-light">
      <div class="container split-heading reveal">
        <div><p class="eyebrow dark"><span></span> The problem</p><h2>Your business should not depend on spreadsheets, inboxes and copy-pasting.</h2></div>
        <div class="body-copy"><p>Important workflows rarely fit off-the-shelf software. Traditional agencies can be slow and expensive. AI app builders are fast, but still make you define the product, guide the agent, verify the code and finish the implementation.</p><p><strong>LFG combines AI development speed with the accountability of an experienced product and engineering team.</strong></p></div>
      </div>
      <div class="container problem-grid reveal">
        <article><span>01</span><i data-lucide="sheet"></i><h3>Spreadsheet operations</h3><p>Your team runs critical processes through increasingly complicated spreadsheets.</p></article>
        <article><span>02</span><i data-lucide="repeat-2"></i><h3>Manual data movement</h3><p>Employees copy information between email, forms, CRMs and internal systems.</p></article>
        <article><span>03</span><i data-lucide="construction"></i><h3>Unfinished AI prototypes</h3><p>Your prototype works in a demo, but it is not ready for customers or operations.</p></article>
        <article><span>04</span><i data-lucide="lightbulb"></i><h3>Software idea, no team</h3><p>You know what should be built without wanting to hire and manage a whole team.</p></article>
      </div>
    </section>

    <section class="offer-section section-ink" id="offer">
      <div class="container offer-grid">
        <div class="offer-copy reveal"><p class="eyebrow"><span></span> The focused offer</p><h2>One clearly defined project. One fixed price. One working release.</h2><p>We review the project before you pay. If it fits the sprint, the accepted scope is fixed and measured against written acceptance criteria.</p><div class="not-fit"><strong>Larger than the sprint?</strong><span>You will receive a separate fixed-price proposal—never a surprise invoice.</span></div></div>
        <article class="offer-card reveal">
          <div class="offer-card-top"><div><span>LFG</span><h3>Build Sprint</h3></div><div class="price"><small>Starting at</small><strong>CAD $999</strong></div></div>
          <p class="delivery-note"><i data-lucide="timer"></i> First release within 10 business days for accepted sprint projects</p>
          <div class="included-grid">
            ${["Free Build Blueprint", "Scope + acceptance criteria", "Up to three primary screens", "One user role", "Basic authentication", "Database setup", "One straightforward integration", "Responsive web application", "Live deployment", "Source-code handoff", "Acceptance testing", "One revision cycle", "Senior engineer review"].map(item => html`<span><i data-lucide="check"></i>${item}</span>`)}
          </div>
          <a class="button button-primary button-full" href="#blueprint" data-track="offer_qualify">Check whether my project qualifies <i data-lucide="arrow-right"></i></a>
          <p class="fine-print">No payment is taken until LFG confirms the project fits the sprint.</p>
        </article>
      </div>
    </section>

    <section class="build-types section-light" id="what-we-build">
      <div class="container centered-heading reveal"><p class="eyebrow dark"><span></span> What we build</p><h2>Built for real business workflows</h2><p>Focused web applications that replace friction with a clear, reliable path from input to outcome.</p></div>
      <div class="container build-grid reveal">
        ${buildExamples.map(([icon, title, copy], index) => html`<article><div class="card-head"><span>${String(index + 1).padStart(2, "0")}</span><i data-lucide="${icon}"></i></div><h3>${title}</h3><p>${copy}</p></article>`)}
      </div>
    </section>

    <section class="process section-paper" id="how-it-works">
      <div class="container process-layout">
        <div class="process-intro reveal"><p class="eyebrow dark"><span></span> How it works</p><h2>From business problem to working product</h2><p>Every decision is visible. Every build is measured against the scope you approved.</p><a href="#blueprint" class="text-link" data-track="process_blueprint">Start with a free blueprint <i data-lucide="arrow-right"></i></a></div>
        <ol class="process-list reveal">
          ${[
            ["Describe the workflow", "Explain what happens today, who is involved and what outcome you want."],
            ["Receive the Build Blueprint", "Get a recommended workflow, feature scope, screen list, assumptions and delivery estimate."],
            ["Approve the fixed scope", "We confirm sprint fit or provide a separate fixed-price proposal."],
            ["Watch it get built", "See the requirements, tickets, progress, tests and review status."],
            ["Review the working release", "Test the agreed workflow against its acceptance criteria."],
            ["Launch and take ownership", "We deploy the product and hand over the source code."],
          ].map(([title, copy], i) => html`<li><span>${String(i + 1).padStart(2, "0")}</span><div><h3>${title}</h3><p>${copy}</p></div><i data-lucide="${i === 5 ? "flag" : "arrow-down"}"></i></li>`)}
        </ol>
      </div>
    </section>

    <section class="comparison section-light">
      <div class="container comparison-heading reveal"><div><p class="eyebrow dark"><span></span> The difference</p><h2>Not another do-it-yourself AI app builder</h2></div><p>Tools such as Replit, Lovable and Emergent can be useful for prototypes. LFG is for customers who want the business result without becoming the product manager, prompt engineer, QA tester and deployment engineer.</p></div>
      <div class="container table-wrap reveal" role="region" aria-label="AI app builder and LFG comparison" tabindex="0">
        <table><thead><tr><th>Capability</th><th>Instant AI builder</th><th>LFG Build Sprint</th></tr></thead><tbody>
          ${[
            ["Requirements discovery", "Customer-led", "LFG-led"], ["Product scope", "Customer-defined", "Included"], ["Application generation", "Included", "Included"], ["Code review", "Customer responsibility", "Included"], ["Testing against requirements", "Customer responsibility", "Included"], ["Deployment", "Usually self-service", "Included"], ["Source-code handoff", "Varies", "Included"], ["Delivery accountability", "No", "Yes"], ["Fixed project price", "Usually subscription / usage", "Yes"], ["Human engineering oversight", "Limited or optional", "Included"],
          ].map(([capability, instant, lfg]) => html`<tr><th>${capability}</th><td><i data-lucide="minus"></i>${instant}</td><td><i data-lucide="circle-check"></i>${lfg}</td></tr>`)}
        </tbody></table>
      </div>
      <div class="container comparison-statement reveal"><strong>They give you an AI builder.</strong><em>We give you a finished build.</em><p>Use an AI builder when you want to build it yourself. Use LFG when you need someone accountable for delivering it.</p></div>
    </section>

    <section class="factory section-dark">
      <div class="container centered-heading light reveal"><p class="eyebrow"><span></span> The production system</p><h2>AI speed. Engineering accountability.</h2><p>AI agents accelerate execution. Humans remain responsible for product decisions, code quality and delivery.</p></div>
      <div class="container factory-grid reveal">
        <article><div class="factory-number">01</div><i data-lucide="scan-search"></i><h3>Define</h3><ul><li>Business requirements</li><li>Workflow analysis</li><li>Build Blueprint</li><li>Acceptance criteria</li><li>Technical planning</li></ul></article>
        <article><div class="factory-number">02</div><i data-lucide="bot"></i><h3>Build</h3><ul><li>Prioritized ticket graph</li><li>Parallel coding agents</li><li>Isolated environments</li><li>Automated testing</li><li>Visible progress</li></ul></article>
        <article><div class="factory-number">03</div><i data-lucide="badge-check"></i><h3>Ship</h3><ul><li>Senior engineer review</li><li>Product acceptance review</li><li>Deployment</li><li>Documentation</li><li>Source-code handoff</li></ul></article>
      </div>
    </section>

    <section class="proof section-light" id="examples">
      <div class="container split-heading reveal"><div><p class="eyebrow dark"><span></span> Real product proof</p><h2>Built using the same factory</h2></div><p class="body-copy">These are live LFG products—not concept art, fabricated testimonials or vanity metrics. Each moved through the same requirements, ticketing, agent execution and review pipeline.</p></div>
      <div class="container proof-grid reveal">
        <a href="https://mags.run" target="_blank" rel="noopener noreferrer"><div class="proof-image"><img src="/public/images/screenshots/mags.png" alt="mags.run cloud infrastructure product interface" loading="lazy"></div><div class="proof-copy"><span>Internal product · Live</span><h3>mags.run <i data-lucide="arrow-up-right"></i></h3><p><strong>Problem:</strong> AI workloads need fast access to isolated cloud machines.</p><p><strong>Built:</strong> A service for launching and managing on-demand cloud VMs.</p></div></a>
        <a href="https://easylogs.co" target="_blank" rel="noopener noreferrer"><div class="proof-image"><img src="/public/images/screenshots/easylogs.png" alt="Easylogs hosted logging interface" loading="lazy"></div><div class="proof-copy"><span>Internal product · Live</span><h3>Easylogs <i data-lucide="arrow-up-right"></i></h3><p><strong>Problem:</strong> Small teams needed simpler application logging without a complex observability stack.</p><p><strong>Built:</strong> A hosted logging, live-tail and search product.</p></div></a>
        <a href="https://kitereach.com" target="_blank" rel="noopener noreferrer"><div class="proof-image"><img src="/public/images/screenshots/kitereach.png" alt="KiteReach outreach workflow interface" loading="lazy"></div><div class="proof-copy"><span>Internal product · Live</span><h3>KiteReach <i data-lucide="arrow-up-right"></i></h3><p><strong>Problem:</strong> Sales teams juggle repetitive research and outreach across channels.</p><p><strong>Built:</strong> A focused AI-assisted outreach workflow.</p></div></a>
      </div>
    </section>

    <section class="blueprint-section section-paper" id="blueprint">
      <div class="container blueprint-layout">
        <div class="blueprint-copy reveal"><p class="eyebrow dark"><span></span> Free Build Blueprint</p><h2>Tell us what you want to improve or build</h2><p class="lead">No technical documentation is required. Explain the workflow in plain language.</p>
          <div class="blueprint-preview"><div class="preview-top"><span>LFG / BUILD BLUEPRINT</span><span class="free-label">FREE</span></div><h3>Your plan will include</h3><ul><li><i data-lucide="check"></i>Problem and target-user summary</li><li><i data-lucide="check"></i>Proposed workflow and core features</li><li><i data-lucide="check"></i>Suggested screens and integrations</li><li><i data-lucide="check"></i>First-release scope and exclusions</li><li><i data-lucide="check"></i>Delivery range and preliminary price band</li><li><i data-lucide="check"></i>Build Sprint qualification and next step</li></ul><p><i data-lucide="lock-keyhole"></i> Full implementation architecture is created only after a paid project begins.</p></div>
        </div>
        <form class="blueprint-form reveal" id="blueprint-form" novalidate>
          <div class="form-progress"><span>Project details</span><small>About 3 minutes</small></div>
          <div class="field field-full"><label for="project-idea">What would you like to build or improve? <b>*</b></label><textarea id="project-idea" name="project_idea" rows="6" minlength="30" required placeholder="Today, customers email us documents. Our staff enters the information into a spreadsheet and sends status updates. We want a portal that collects the documents and shows the customer their progress."></textarea><small>Describe what happens today and what a better outcome looks like.</small></div>
          <div class="form-grid">
            <div class="field"><label for="audience">Who will use it? <b>*</b></label><select id="audience" name="audience" required><option value="">Choose one</option><option>Internal employees</option><option>Existing customers</option><option>New customers</option><option>Vendors or partners</option><option>General public</option><option>Multiple groups</option></select></div>
            <div class="field"><label for="current-workflow">How do you handle this today? <b>*</b></label><select id="current-workflow" name="current_workflow" required><option value="">Choose one</option><option>Spreadsheet</option><option>Email</option><option>Forms</option><option>Existing software</option><option>Manual process</option><option>We have not started yet</option><option>Other</option></select></div>
            <div class="field field-full"><label for="integration">Does it need to connect to another system?</label><input id="integration" name="integration" placeholder="HubSpot, QuickBooks, Google Drive, Stripe, internal API, etc."></div>
            <div class="field"><label for="timeline">How soon would you like to begin? <b>*</b></label><select id="timeline" name="timeline" required><option value="">Choose one</option><option>Immediately</option><option>Within 30 days</option><option>Within three months</option><option>Researching for later</option></select></div>
            <div class="field"><label for="budget">Budget range <b>*</b></label><select id="budget" name="budget" required><option value="">Choose one</option><option>CAD $999–$2,500</option><option>CAD $2,500–$5,000</option><option>CAD $5,000–$15,000</option><option>CAD $15,000+</option><option>Not sure yet</option></select></div>
            <div class="field"><label for="lead-name">Name <b>*</b></label><input id="lead-name" name="name" autocomplete="name" required placeholder="Jane Founder"></div>
            <div class="field"><label for="work-email">Work email <b>*</b></label><input id="work-email" name="email" type="email" autocomplete="email" required placeholder="jane@company.com"></div>
            <div class="field"><label for="company">Company name <b>*</b></label><input id="company" name="company" autocomplete="organization" required placeholder="Acme Inc."></div>
            <div class="field"><label for="website">Website</label><input id="website" name="website" type="url" autocomplete="url" placeholder="https://company.com"></div>
          </div>
          <input type="hidden" name="utm_source"><input type="hidden" name="utm_medium"><input type="hidden" name="utm_campaign"><input type="hidden" name="utm_content"><input type="hidden" name="utm_term"><input type="hidden" name="referrer"><input type="hidden" name="landing_variant" value="build-sprint-a">
          <div id="blueprint-turnstile"></div>
          <p class="form-error" id="form-error" role="alert"></p>
          <button class="button button-primary button-full" type="submit" id="blueprint-submit">Generate my free Blueprint <i data-lucide="arrow-right"></i></button>
          <p class="consent">By submitting, you agree that LFG may contact you about your project. See our <a href="/privacy/">privacy policy</a> and <a href="/terms/">terms</a>.</p>
        </form>
      </div>
    </section>

    <section class="faq section-light" id="faq">
      <div class="container faq-layout"><div class="faq-intro reveal"><p class="eyebrow dark"><span></span> Common questions</p><h2>Clear answers before you commit</h2><p>Still unsure? The free blueprint is the easiest way to find out whether your project fits.</p><a href="#blueprint" class="text-link" data-track="faq_blueprint">Scope my project <i data-lucide="arrow-right"></i></a></div>
        <div class="faq-list reveal">${faqs.map(([question, answer], i) => html`<details ${i === 0 ? raw("open") : ""}><summary>${question}<i data-lucide="plus"></i></summary><p>${answer}</p></details>`)}</div>
      </div>
    </section>

    <section class="final-cta section-ink"><div class="container reveal"><p class="eyebrow"><span></span> Your next release starts here</p><h2>Bring us one workflow.<br><em>We’ll bring back working software.</em></h2><p>See the proposed scope, delivery range and likely cost before you commit.</p><a class="button button-primary" href="#blueprint" data-track="final_blueprint">Get my free Build Blueprint <i data-lucide="arrow-right"></i></a></div></section>
  </main>

  <footer><div class="container footer-grid"><a class="brand" href="/"><span class="brand-mark">L</span><span>LFG</span></a><p>AI handles execution. Senior engineers own the outcome.</p><div><a href="#how-it-works">How it works</a><a href="#what-we-build">What we build</a><a href="#faq">FAQ</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a></div><small>© ${new Date().getFullYear()} LFG Inc. All rights reserved.</small></div></footer>

  <div class="verify-modal" id="verify-modal" hidden role="dialog" aria-modal="true" aria-labelledby="verify-title">
    <div class="verify-card"><button class="modal-close" type="button" aria-label="Close verification"><i data-lucide="x"></i></button>
      <div class="verify-icon"><i data-lucide="mail-check"></i></div><p class="eyebrow dark"><span></span> One quick check</p><h2 id="verify-title">Verify your work email</h2><p>We sent a 6-digit code to <strong id="verify-email"></strong>. Your blueprint starts generating after verification.</p>
      <form id="verify-form"><label for="verify-code">Verification code</label><input id="verify-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" required><p class="form-error" id="verify-error" role="alert"></p><button class="button button-primary button-full" type="submit" id="verify-submit">Verify and create Blueprint <i data-lucide="arrow-right"></i></button></form>
      <button class="resend-button" type="button" id="resend-code">Didn’t receive it? Resend code</button>
    </div>
  </div>

  <script>window.LFG_BUILD_SPRINT = ${raw(JSON.stringify({ turnstileSiteKey }).replace(/</g, "\\u003c"))};</script>
  <script src="/public/js/build-sprint.js?v=1" defer></script>
</body>
</html>`;
