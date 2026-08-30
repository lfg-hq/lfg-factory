import { html } from "hono/html";
import { SiteHead, SiteNav, SiteFooter } from "../components/site.tsx";

/**
 * The software-services-firm landing page — the strongest ICP in the brief.
 *
 * Built entirely on one thesis: client expectations are changing as AI
 * compresses the cost of producing code, while services firms still price and
 * staff on headcount. Everything here serves that argument.
 *
 * Two rules held throughout: no replacement language about developers, and no
 * modelled economics presented as results. The claims are directional
 * ("reduce the engineering labour per project"), never "5 engineers to 1".
 */

const FLOW: Array<[string, string]> = [
  ["Client requirement", "What the client actually asked for, in their words"],
  ["Scope", "What is in, what is out, and what it depends on"],
  ["PRD", "Written down and reviewable before anyone builds"],
  ["Technical architecture", "Decisions made once, on the record"],
  ["Tickets", "A dependency-aware graph, not a flat list"],
  ["Execution", "Agents build in isolated environments, in parallel"],
  ["QA", "Tests, behaviour and acceptance criteria checked"],
  ["Reviewer approval", "Your senior engineer signs off"],
  ["Client delivery", "With the trail that shows how it got there"],
];

const OBJECTIONS: Array<[string, string]> = [
  ["My customers already expect an AI discount.",
   "They do, and that pressure is not going away. The question is whether the efficiency shows up in your cost structure as well as your pricing. If you pass on lower billable hours without changing how delivery works, you absorb the whole compression yourself. The point of the factory is to change what a project costs you to deliver, so you have something to give."],
  ["My developers already use Claude Code. Why do I need this?",
   "Because a coding agent makes an individual developer faster at an individual task. It does not scope the project, hold the architecture, sequence the dependencies, run the regression pass, or keep the trail your client will ask for. Today your developers do that coordination by hand, which quietly makes each of them the bottleneck. LFG moves that work into the pipeline and runs the same agents inside it."],
  ["I cannot let agents loose on a client repository.",
   "Nor would we. Work happens on branches in isolated environments, never against a client's main line. Nothing merges without a person approving it, and every change traces back to the ticket and requirement that produced it. The controls are the reason this is sellable to your clients, not an afterthought."],
  ["Our developers understand the client's systems better than any AI.",
   "Agreed, and that is the point. The factory is not a substitute for domain knowledge — it is a way to package it. Architecture decisions, conventions, the awkward parts of a client's stack and the corrections you have already made become context the pipeline carries into the next ticket, instead of living in one engineer's head."],
  ["My clients care about accountability.",
   "So the audit trail matters more than the speed. Requirements, tickets, diffs, test results and approvals all stay traceable, and a named engineer signs off on every release. When a client asks why something was built the way it was, there is an answer with a date on it."],
  ["Will this replace my developers?",
   "No, and we would not sell it that way. Your senior engineers become the control layer for a great deal more software execution than they could write themselves. The work that disappears is the coordination overhead — context-feeding, retry-babysitting, first-pass review — not the judgment."],
];

const ECONOMICS: Array<[string, string, string]> = [
  ["trending-up", "Delivery capacity",
   "Take on more concurrent client projects without growing the bench in proportion. Capacity stops being a hiring decision."],
  ["shield", "Margin",
   "Reduce the engineering labour a project requires, so AI efficiency lands in your cost structure rather than only in your quote."],
  ["users", "Senior leverage",
   "Experienced engineers supervise several streams of execution instead of hand-writing each implementation."],
];

export const SoftwareServicesPage = () => html`
<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
${SiteHead({
  title: "AI for Software Services Companies | LFG Software Factory",
  description: "Turn your software services company into an AI software factory. Increase delivery capacity, shorten cycles and protect margins without growing engineering headcount proportionally.",
  path: "/software-services/",
})}
</head>
<body class="text-slate-900 font-sans selection:bg-brand-600 selection:text-white">

${SiteNav({ active: "software-services" })}

<main>

  <!-- HERO -->
  <section class="relative pt-28 sm:pt-36 pb-16 overflow-hidden mesh">
    <div class="absolute -top-10 right-[8%] w-72 h-72 rounded-full bg-brand-100 blur-3xl animate-drift"></div>
    <div class="absolute top-24 left-[4%] w-80 h-80 rounded-full bg-pink-100 blur-3xl animate-drift" style="animation-delay:1s"></div>
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass shadow-sm mb-7 animate-fade-up">
        <span class="w-2 h-2 rounded-full bg-brand-500 animate-pulse"></span>
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">For software services firms</span>
      </div>
      <h1 class="font-display font-semibold text-4xl sm:text-5xl lg:text-6xl leading-[1.08] tracking-tight text-slate-900 animate-fade-up max-w-4xl">
        Turn your software services company into an
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-pink-500">AI software factory.</span>
      </h1>
      <p class="text-lg text-slate-600 mt-6 max-w-2xl leading-relaxed animate-fade-up">
        Increase project capacity, shorten delivery cycles and protect margins without increasing engineering headcount at the same rate.
      </p>
      <div class="mt-8 flex flex-col sm:flex-row gap-3 animate-fade-up">
        <a href="#pilot" class="px-7 py-3.5 rounded-full bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2">
          Run one project through LFG <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </a>
        <a href="#economics" class="px-7 py-3.5 rounded-full border border-slate-300 bg-white text-slate-800 font-semibold hover:border-brand-400 hover:text-brand-700 transition-colors inline-flex items-center justify-center gap-2">
          See the economics
        </a>
      </div>
    </div>
  </section>

  <!-- THE TWO MODELS -->
  <section class="band-tint py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-12">
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">What scales when you win more work?</h2>
        <p class="text-slate-600 text-lg mt-4">That single question separates the two models.</p>
      </div>
      <div class="grid md:grid-cols-2 gap-6">
        <div class="rounded-2xl border border-slate-200 bg-white p-8">
          <p class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-5">The old model</p>
          <p class="font-display font-bold text-2xl text-slate-900 mb-4">More projects</p>
          <div class="link-v"></div>
          <div class="node mb-4"><span class="text-sm font-semibold text-slate-700">More developers</span></div>
          <p class="text-sm text-slate-600 leading-relaxed">Capacity is a hiring decision. Margin is whatever survives the gap between the bid and the bench.</p>
        </div>
        <div class="rounded-2xl border border-brand-200 bg-white p-8 ring-1 ring-brand-100">
          <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-5">The factory model</p>
          <p class="font-display font-bold text-2xl text-slate-900 mb-4">More projects</p>
          <div class="link-v"></div>
          <div class="node node-accent mb-2"><span class="text-sm font-semibold text-brand-700">More agent execution</span></div>
          <p class="text-center text-sm text-slate-400 mb-2">+</p>
          <div class="node node-accent mb-4"><span class="text-sm font-semibold text-brand-700">More senior oversight</span></div>
          <p class="text-sm text-slate-600 leading-relaxed">Capacity is a throughput decision. Your seniors supervise execution instead of producing all of it.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- THE PIPELINE -->
  <section class="band py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">The pipeline</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">From client requirement to client delivery.</h2>
        <p class="text-slate-600 text-lg mt-4">The same path every engagement takes, so the trail looks the same on every project you hand back.</p>
      </div>
      <div class="rounded-2xl border border-slate-200 bg-white p-7 sm:p-9">
        ${FLOW.map(([step, note], i) => html`
          ${i > 0 ? html`<div class="link-v"></div>` : ""}
          <div class="node ${i === FLOW.length - 1 ? "node-ok" : i === 7 ? "node-accent" : ""} text-left flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
            <span class="text-sm font-semibold ${i === FLOW.length - 1 ? "text-emerald-700" : i === 7 ? "text-brand-700" : "text-slate-800"}">${step}</span>
            <span class="text-xs text-slate-500 sm:text-right">${note}</span>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- ECONOMICS -->
  <section id="economics" class="band-tint py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Economics</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Your clients already know what AI does to the cost of code.</h2>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          They will expect that efficiency in your timelines and your pricing, whether or not your delivery model is ready for it. Giving each developer a coding agent speeds up individual tasks, but you still coordinate requirements, teams, QA, reviews and releases the way you always have — so the saving never reaches your cost structure.
        </p>
        <p class="text-slate-600 text-lg mt-4 leading-relaxed">
          LFG changes the unit of production. That is what makes room to bid competitively without giving away the margin.
        </p>
      </div>
      <div class="grid md:grid-cols-3 gap-6">
        ${ECONOMICS.map(([icon, title, body]) => html`
          <div class="rounded-2xl border border-slate-200 bg-white p-7">
            <div class="w-11 h-11 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
            <h3 class="font-display font-bold text-lg mb-2">${title}</h3>
            <p class="text-sm text-slate-600 leading-relaxed">${body}</p>
          </div>`)}
      </div>
      <div class="mt-8 rounded-xl border-l-4 border-brand-500 bg-white p-6">
        <p class="text-slate-700 leading-relaxed">
          We are not going to put a modelled margin chart on this page. The honest version is that the effect depends on your stack, your clients and how much of your delivery is coordination rather than construction &mdash; which is exactly what a pilot measures. <a href="#pilot" class="font-semibold text-brand-700 hover:underline">Run one project through it</a> and use your own numbers.
        </p>
      </div>
    </div>
  </section>

  <!-- OBJECTIONS -->
  <section class="band py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Straight answers</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">The objections we actually get.</h2>
      </div>
      <div class="space-y-8">
        ${OBJECTIONS.map(([q, a]) => html`
          <div>
            <p class="font-display font-bold text-lg text-slate-900 mb-2.5">${q}</p>
            <p class="text-slate-600 leading-relaxed">${a}</p>
          </div>`)}
      </div>
    </div>
  </section>

  <!-- FITS YOUR TEAM -->
  <section class="band-tint py-20">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="max-w-2xl mb-12">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">Fit</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900">Shaped around how your firm already works.</h2>
        <p class="text-slate-600 text-lg mt-4">
          We configure the product to the client rather than handing over something generic and expecting you to adapt to it. No migration, no rebuild of your process &mdash; it attaches to the repositories and the way of working you have today.
        </p>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        <div class="rounded-2xl border border-brand-200 bg-white p-6 ring-1 ring-brand-100">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="sliders-horizontal" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Configured to your process</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Your standards, your definition of done, your review rules and the shape of the work you deliver. We tune the product per client, not per plan tier.</p>
        </div>
        <div class="rounded-2xl border border-brand-200 bg-white p-6 ring-1 ring-brand-100">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="palette" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Under your own brand</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Deliver on it as your own capability, on your own domain. <a href="/white-label/" class="font-semibold text-brand-700 hover:underline">See white-label</a>.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="folder-git-2" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Your repositories</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Branches and pull requests land in the GitHub or GitLab repo the client already owns.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="users" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Your engineers</h3>
          <p class="text-sm text-slate-600 leading-relaxed">They hold the review gate and the architecture calls, which is where their judgment pays.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="cpu" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Your model policy</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Some clients will not allow certain vendors near their code. Set the policy per project.</p>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 text-brand-700 flex items-center justify-center mb-4"><i data-lucide="server" class="w-4 h-4"></i></div>
          <h3 class="font-display font-bold text-base mb-2">Your infrastructure</h3>
          <p class="text-sm text-slate-600 leading-relaxed">Run it in your own environment when a client's requirements demand it. The core is MIT.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- PILOT -->
  <section id="pilot" class="band py-20">
    <div class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="mb-10">
        <p class="text-xs font-bold text-brand-600 uppercase tracking-wider mb-2">The offer</p>
        <h2 class="font-display font-bold text-3xl md:text-4xl text-slate-900 mb-4">Run one project through LFG.</h2>
        <p class="text-slate-600 text-lg leading-relaxed mb-6">
          Pick a real project or backlog item — ideally one you have already scoped and priced the traditional way. We put it through the pipeline, and you compare it against your own baseline:
        </p>
        <div class="flex flex-wrap gap-2 mb-6">
          ${["Delivery time", "Engineering involvement", "Cost", "Code quality", "Defects", "Review workload"]
            .map((m) => html`<span class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700">${m}</span>`)}
        </div>
        <p class="text-slate-600 leading-relaxed">That makes the decision empirical instead of a matter of believing our marketing.</p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-xl">
        <form id="pilot-form" class="space-y-4">
          <div class="grid sm:grid-cols-2 gap-3">
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Name *</label>
              <input name="name" required placeholder="Your name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Work email *</label>
              <input name="email" type="email" required placeholder="you@firm.com" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
            </div>
          </div>
          <div class="grid sm:grid-cols-2 gap-3">
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Firm</label>
              <input name="firm" placeholder="Firm name" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white" />
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-600 mb-1 block">Delivery headcount</label>
              <select name="headcount" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white text-slate-700">
                <option value="">Select range</option>
                <option value="1-10">1-10</option>
                <option value="10-50">10-50</option>
                <option value="50-200">50-200</option>
                <option value="200-1000">200-1000</option>
                <option value="1000+">1000+</option>
              </select>
            </div>
          </div>
          <div>
            <label class="text-xs font-semibold text-slate-600 mb-1 block">The project you would put through it *</label>
            <textarea name="brief" required rows="4" placeholder="One real project, ideally already scoped and priced the traditional way, so there is a baseline to compare against." class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none bg-white resize-none"></textarea>
          </div>
          <button type="submit" class="w-full inline-flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white py-3 rounded-lg font-semibold text-sm transition-colors">
            <i data-lucide="send" class="w-4 h-4"></i><span class="btn-text">Book a factory pilot</span>
          </button>
          <div id="pilot-success" class="hidden text-center py-2 text-sm font-semibold text-emerald-600">
            <i data-lucide="check-circle" class="w-4 h-4 inline mr-1"></i>Got it. We will reply within one business day.
          </div>
          <div id="pilot-error" class="hidden text-center py-2 text-sm text-red-500"></div>
        </form>
      </div>
    </div>
  </section>

</main>

${SiteFooter()}

<script>
  (function () {
    var form = document.getElementById('pilot-form');
    if (!form) return;
    var FREE = ['gmail.com','googlemail.com','yahoo.com','yahoo.co.in','hotmail.com','outlook.com','live.com','aol.com','icloud.com','me.com','proton.me','protonmail.com','mail.com','gmx.com','yandex.com','rediffmail.com'];
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      var btnText = form.querySelector('.btn-text');
      var ok = document.getElementById('pilot-success');
      var err = document.getElementById('pilot-error');
      ok.classList.add('hidden');
      err.classList.add('hidden');
      var data = Object.fromEntries(new FormData(form).entries());
      data.intent = 'pilot';
      var domain = String(data.email || '').split('@')[1];
      domain = domain ? domain.toLowerCase().trim() : '';
      if (domain && FREE.indexOf(domain) !== -1) {
        err.textContent = 'Please use your work email address, not a personal one.';
        err.classList.remove('hidden');
        return;
      }
      btn.disabled = true;
      btnText.textContent = 'Sending...';
      try {
        var res = await fetch('/api/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (res.ok) {
          form.reset();
          ok.classList.remove('hidden');
          lucide.createIcons();
        } else {
          var d = await res.json();
          err.textContent = d.error || 'Something went wrong. Please try again.';
          err.classList.remove('hidden');
        }
      } catch (e2) {
        err.textContent = 'Unable to submit. Email us at hello@lfg.run';
        err.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btnText.textContent = 'Book a factory pilot';
      }
    });
  })();
</script>

</body>
</html>
`;
