import { html } from "hono/html";

/**
 * /apps — Instant Apps landing page.
 * Collects a plain-English app idea + email, verifies via 6-digit email OTP
 * (or Google login), then hands off to the /instant builder with the idea
 * auto-sent as the first message (via localStorage['lfg-instant-prompt']).
 */
export const AppsPage = ({
  turnstileSiteKey = "",
  isAuthenticated = false,
}: {
  turnstileSiteKey?: string;
  isAuthenticated?: boolean;
}) => html`<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Build an app instantly — LFG</title>
  <meta name="description" content="Describe your idea in plain English and get a working app instantly. Start with a prototype or MVP, then grow it into a complete product with LFG." />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['Manrope', 'sans-serif'], display: ['Sora', 'sans-serif'] },
          colors: {
            brand: { 50:'#eef2ff', 100:'#e0e7ff', 500:'#6366f1', 600:'#4f46e5', 700:'#4338ca' },
            ink: { 900:'#0f172a' },
            amber: { 500:'#ec4899', 600:'#db2777' }
          }
        }
      }
    }
  </script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    body { font-family: 'Manrope', sans-serif; }
    h1, h2, h3, .font-display { font-family: 'Sora', sans-serif; }
    .hero-bg { background: radial-gradient(1200px 600px at 70% -10%, #eef2ff 0%, rgba(238,242,255,0) 60%), linear-gradient(180deg, #ffffff 0%, #f8fafc 100%); }
    .gradient-text { background: linear-gradient(90deg, #4f46e5, #db2777); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    .fade-up { animation: fadeUp .5s ease-out both; }
    @keyframes fadeUp { from { opacity:0; transform:translateY(10px);} to { opacity:1; transform:translateY(0);} }
  </style>
</head>
<body class="text-ink-900 bg-white">
  <!-- Nav -->
  <header class="border-b border-slate-100">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
      <a href="/" class="flex items-center gap-2 font-display font-extrabold text-lg">
        <span class="w-8 h-8 rounded-lg bg-brand-600 text-white flex items-center justify-center"><i data-lucide="rocket" class="w-5 h-5"></i></span>
        LFG
      </a>
      <a href="/auth/login" class="text-sm font-semibold text-slate-600 hover:text-slate-900">Log in</a>
    </div>
  </header>

  <!-- Hero -->
  <section class="hero-bg">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 py-14 md:py-20 grid md:grid-cols-2 gap-10 md:gap-14 items-center">
      <!-- Left: pitch -->
      <div class="fade-up">
        <span class="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-brand-700 bg-brand-50 border border-brand-100 rounded-full px-3 py-1">
          <i data-lucide="sparkles" class="w-3.5 h-3.5"></i> Instant apps
        </span>
        <h1 class="font-display font-extrabold text-4xl md:text-5xl leading-[1.1] mt-5">
          Describe your idea.<br />Get a working app <span class="gradient-text">today.</span>
        </h1>
        <p class="text-slate-600 text-lg leading-relaxed mt-5 max-w-lg">
          No code. No tech team. Just tell us what you want to build — a quick prototype, an MVP, or a full product — and our AI builds it for you.
          <span class="text-slate-900 font-semibold">Start instantly, then grow it into a complete, production-ready product with LFG.</span>
        </p>

        <!-- 3-step strip -->
        <div class="mt-8 flex flex-col sm:flex-row gap-3">
          ${[
            ["1", "Describe it", "in plain English"],
            ["2", "Get a working app", "instantly"],
            ["3", "Keep building", "to a complete product"],
          ].map(
            ([n, t, s]) => html`<div class="flex items-start gap-3 flex-1">
              <span class="shrink-0 w-6 h-6 rounded-full bg-brand-600 text-white text-xs font-bold flex items-center justify-center mt-0.5">${n}</span>
              <div><div class="font-semibold text-sm text-slate-900">${t}</div><div class="text-xs text-slate-500">${s}</div></div>
            </div>`
          )}
        </div>
      </div>

      <!-- Right: form card -->
      <div class="fade-up">
        <div class="bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100 p-6 sm:p-8">
          <!-- Step 1: idea + email -->
          <div id="apps-step-1">
            <h2 class="font-display font-bold text-xl mb-1">What do you want to build?</h2>
            <p class="text-sm text-slate-500 mb-4">Describe it in plain English — we'll build a working version you can use.</p>
            <form id="apps-form" class="space-y-3">
              <textarea id="apps-idea" required rows="4"
                class="w-full p-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none text-sm resize-none"
                placeholder="Example: A booking site for my salon where clients pick a service, choose a time, and pay a deposit."></textarea>
              <input id="apps-email" type="email" required
                class="w-full p-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none text-sm"
                placeholder="you@business.com" />
              <div id="apps-turnstile"></div>
              <div id="apps-error-1" class="text-sm text-red-500 hidden"></div>
              <button type="submit" id="apps-start-btn"
                class="w-full bg-brand-600 text-white font-semibold py-3 rounded-xl hover:bg-brand-700 transition-colors flex items-center justify-center gap-2">
                <span id="apps-start-text">Start building</span> <i data-lucide="arrow-right" class="w-4 h-4"></i>
              </button>
            </form>

            <div class="flex items-center gap-3 my-4">
              <div class="h-px bg-slate-200 flex-1"></div>
              <span class="text-xs text-slate-400 font-medium">or</span>
              <div class="h-px bg-slate-200 flex-1"></div>
            </div>

            <button id="apps-google-btn" type="button"
              class="w-full border border-slate-200 bg-white text-slate-700 font-semibold py-3 rounded-xl hover:bg-slate-50 transition-colors flex items-center justify-center gap-2">
              <img src="https://www.google.com/favicon.ico" alt="" class="w-4 h-4" /> Continue with Google
            </button>

            <p class="text-center text-xs text-slate-400 mt-4">Free to start · No credit card · Built in minutes</p>
          </div>

          <!-- Step 2: verify code -->
          <div id="apps-step-2" class="hidden">
            <button type="button" onclick="appsBackToStep1()" class="text-sm text-slate-400 hover:text-slate-600 mb-3 flex items-center gap-1"><i data-lucide="arrow-left" class="w-4 h-4"></i> Back</button>
            <h2 class="font-display font-bold text-xl mb-1">Enter your code</h2>
            <p class="text-sm text-slate-500 mb-4">We sent a 6-digit code to <span id="apps-email-display" class="font-semibold text-slate-700"></span>.</p>
            <form id="apps-code-form" class="space-y-3">
              <input id="apps-code" type="text" inputmode="numeric" maxlength="6" required
                class="w-full p-3 rounded-xl border border-slate-200 text-center text-xl tracking-[0.4em] font-bold focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
                placeholder="000000" />
              <div id="apps-error-2" class="text-sm text-red-500 hidden"></div>
              <button type="submit" id="apps-verify-btn"
                class="w-full bg-brand-600 text-white font-semibold py-3 rounded-xl hover:bg-brand-700 transition-colors">
                Verify &amp; start building
              </button>
            </form>
            <button type="button" id="apps-resend-btn" onclick="appsResend()" class="text-sm font-semibold text-brand-700 hover:text-brand-800 mt-3">Resend code</button>
          </div>

          <!-- Handoff state -->
          <div id="apps-step-done" class="hidden text-center py-6">
            <div class="w-12 h-12 mx-auto mb-4 rounded-full border-4 border-slate-200 border-t-brand-600 animate-spin"></div>
            <h2 class="font-display font-bold text-xl mb-1">Setting up your workspace…</h2>
            <p class="text-sm text-slate-500">Taking you to the builder — your app starts building in a moment.</p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <footer class="border-t border-slate-100 py-8 text-center text-sm text-slate-400">
    Built with LFG · <a href="/" class="hover:text-slate-600">lfg.run</a>
  </footer>

  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onAppsTurnstileLoad" async defer></script>
  <script>
    lucide.createIcons();

    var TURNSTILE_SITE_KEY = '${turnstileSiteKey}';
    var IS_AUTHENTICATED = ${isAuthenticated ? "true" : "false"};
    var appsTurnstileToken = '';
    var appsTurnstileWidgetId = null;
    var appsTurnstileReady = false;
    var appsEmail = '';

    function onAppsTurnstileLoad() { appsTurnstileReady = true; renderAppsTurnstile(); }
    function renderAppsTurnstile() {
      if (!appsTurnstileReady || !TURNSTILE_SITE_KEY || typeof turnstile === 'undefined') return;
      var el = document.getElementById('apps-turnstile');
      if (!el || appsTurnstileWidgetId !== null) return;
      try {
        appsTurnstileWidgetId = turnstile.render(el, {
          sitekey: TURNSTILE_SITE_KEY, theme: 'light',
          callback: function (t) { appsTurnstileToken = t; },
          'expired-callback': function () { appsTurnstileToken = ''; },
          'error-callback': function () { appsTurnstileToken = ''; }
        });
      } catch (e) { console.error('Turnstile render error:', e); }
    }
    function resetAppsTurnstile() {
      appsTurnstileToken = '';
      if (typeof turnstile !== 'undefined' && appsTurnstileWidgetId !== null) {
        try { turnstile.reset(appsTurnstileWidgetId); } catch (e) {}
      }
    }
    renderAppsTurnstile();

    // Save the idea so the /instant builder auto-sends it as the first message.
    function stashIdea() {
      var idea = (document.getElementById('apps-idea').value || '').trim();
      if (idea) localStorage.setItem('lfg-instant-prompt', idea);
    }

    function showAppsError(id, msg) {
      var el = document.getElementById(id);
      if (el) { el.textContent = msg; el.classList.remove('hidden'); }
    }
    function hideAppsErrors() {
      document.querySelectorAll('#apps-error-1, #apps-error-2').forEach(function (el) { el.classList.add('hidden'); });
    }
    function setAppsStep(step) {
      document.getElementById('apps-step-1').classList.toggle('hidden', step !== 1);
      document.getElementById('apps-step-2').classList.toggle('hidden', step !== 2);
      document.getElementById('apps-step-done').classList.toggle('hidden', step !== 'done');
    }
    function appsBackToStep1() { hideAppsErrors(); setAppsStep(1); }
    function goToBuilder() { setAppsStep('done'); window.location.href = '/instant'; }

    // ── Google ──
    document.getElementById('apps-google-btn').addEventListener('click', async function () {
      stashIdea();
      try {
        var res = await fetch('/api/auth/sign-in/social', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'google', callbackURL: '/instant' }),
          credentials: 'include'
        });
        var data = await res.json().catch(function () { return {}; });
        if (data.url) { window.location.href = data.url; }
        else { showAppsError('apps-error-1', data.message || 'Could not start Google sign-in. Please try again.'); }
      } catch (e) { showAppsError('apps-error-1', 'Something went wrong. Please try again.'); }
    });

    // ── Start building (send email code) ──
    document.getElementById('apps-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      hideAppsErrors();
      var idea = (document.getElementById('apps-idea').value || '').trim();
      var email = (document.getElementById('apps-email').value || '').trim();
      if (idea.length < 12) { showAppsError('apps-error-1', 'Please describe what you want to build in a bit more detail.'); return; }
      if (!email) { showAppsError('apps-error-1', 'Please enter your email.'); return; }

      stashIdea();

      // Already logged in → skip verification, go straight to the builder.
      if (IS_AUTHENTICATED) { goToBuilder(); return; }

      if (TURNSTILE_SITE_KEY && !appsTurnstileToken) { showAppsError('apps-error-1', 'Please complete the bot check.'); return; }

      var btn = document.getElementById('apps-start-btn');
      var txt = document.getElementById('apps-start-text');
      btn.disabled = true; txt.textContent = 'Sending code…';
      try {
        var res = await fetch('/api/auth/email-otp/send-verification-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, type: 'sign-in', turnstileToken: appsTurnstileToken }),
          credentials: 'include'
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          showAppsError('apps-error-1', data.message || 'Could not send the code. Please try again.');
          resetAppsTurnstile();
          return;
        }
        appsEmail = email;
        document.getElementById('apps-email-display').textContent = email;
        hideAppsErrors();
        setAppsStep(2);
        // The token was consumed by this send; refresh it so Resend can reuse the widget.
        resetAppsTurnstile();
        setTimeout(function () { document.getElementById('apps-code').focus(); }, 100);
      } catch (err) {
        showAppsError('apps-error-1', 'Something went wrong. Please try again.');
        resetAppsTurnstile();
      } finally {
        btn.disabled = false; txt.textContent = 'Start building';
      }
    });

    // Keep the code field numeric
    document.getElementById('apps-code').addEventListener('input', function (e) {
      e.target.value = e.target.value.replace(/\\D/g, '').slice(0, 6);
    });

    // ── Verify code → session → builder ──
    document.getElementById('apps-code-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      hideAppsErrors();
      var code = (document.getElementById('apps-code').value || '').trim();
      if (code.length !== 6) { showAppsError('apps-error-2', 'Please enter the 6-digit code.'); return; }
      var btn = document.getElementById('apps-verify-btn');
      btn.disabled = true; btn.textContent = 'Verifying…';
      try {
        var res = await fetch('/api/auth/sign-in/email-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: appsEmail, otp: code }),
          credentials: 'include'
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          showAppsError('apps-error-2', data.message || 'That code is invalid or expired. Please try again.');
          return;
        }
        goToBuilder();
      } catch (err) {
        showAppsError('apps-error-2', 'Something went wrong. Please try again.');
      } finally {
        btn.disabled = false; btn.textContent = 'Verify & start building';
      }
    });

    // ── Resend ──
    async function appsResend() {
      hideAppsErrors();
      if (!appsEmail) return;
      var btn = document.getElementById('apps-resend-btn');
      btn.disabled = true; btn.textContent = 'Resending…';
      try {
        var res = await fetch('/api/auth/email-otp/send-verification-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: appsEmail, type: 'sign-in', turnstileToken: appsTurnstileToken }),
          credentials: 'include'
        });
        if (res.ok) { btn.textContent = 'Code sent!'; setTimeout(function () { btn.textContent = 'Resend code'; btn.disabled = false; }, 1800); }
        else { btn.textContent = 'Resend code'; btn.disabled = false; showAppsError('apps-error-2', 'Could not resend. Please try again.'); }
        resetAppsTurnstile();
      } catch (e) { btn.textContent = 'Resend code'; btn.disabled = false; }
    }
  </script>
</body>
</html>`;
