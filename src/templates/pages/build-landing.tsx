import { html } from "hono/html";

export const BuildLandingPage = () => html`
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LFG Build, Turn your idea into a working app</title>
  <meta name="description" content="Describe what you want to build. LFG turns your idea into a working web app in minutes, no code required.">
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Manrope', 'sans-serif'],
            display: ['Sora', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          },
          colors: {
            brand: { 50:'#eef2ff',100:'#e0e7ff',200:'#c7d2fe',300:'#a5b4fc',400:'#818cf8',500:'#6366f1',600:'#4f46e5',700:'#4338ca',800:'#3730a3',900:'#312e81' },
          },
          animation: {
            'fade-up': 'fadeUp 0.7s ease-out both',
            'fade-in': 'fadeIn 0.5s ease-out both',
            'pulse-slow': 'pulse 3s ease-in-out infinite',
            'float': 'float 6s ease-in-out infinite',
          },
          keyframes: {
            fadeUp: { '0%': { opacity: '0', transform: 'translateY(24px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
            fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
            float: { '0%,100%': { transform: 'translateY(0px)' }, '50%': { transform: 'translateY(-8px)' } },
          }
        }
      }
    }
  </script>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      background: #080b11;
      overflow-x: hidden;
    }
    .grid-bg {
      background-image:
        linear-gradient(rgba(99,102,241,0.06) 1px, transparent 1px),
        linear-gradient(90deg, rgba(99,102,241,0.06) 1px, transparent 1px);
      background-size: 48px 48px;
    }
    .glow-purple {
      background: radial-gradient(circle, rgba(99,102,241,0.22) 0%, transparent 70%);
    }
    .glow-violet {
      background: radial-gradient(circle, rgba(139,92,246,0.18) 0%, transparent 65%);
    }
    .prompt-box {
      background: rgba(255,255,255,0.04);
      border: 1.5px solid rgba(255,255,255,0.09);
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .prompt-box:focus-within {
      border-color: rgba(99,102,241,0.6);
      box-shadow: 0 0 0 4px rgba(99,102,241,0.12), 0 0 40px rgba(99,102,241,0.08);
    }
    .prompt-box textarea {
      background: transparent;
      color: #e6edf3;
      resize: none;
      outline: none;
      caret-color: #818cf8;
    }
    .prompt-box textarea::placeholder { color: rgba(255,255,255,0.3); }
    .example-chip {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.55);
      transition: all 0.15s;
      cursor: pointer;
    }
    .example-chip:hover {
      background: rgba(99,102,241,0.12);
      border-color: rgba(99,102,241,0.3);
      color: #a5b4fc;
    }
    .build-btn {
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      transition: opacity 0.2s, transform 0.15s;
    }
    .build-btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .build-btn:active { transform: translateY(0); }
    .build-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .stat-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.07);
    }
    .feature-card {
      background: rgba(255,255,255,0.025);
      border: 1px solid rgba(255,255,255,0.07);
      transition: border-color 0.2s, background 0.2s;
    }
    .feature-card:hover {
      background: rgba(99,102,241,0.07);
      border-color: rgba(99,102,241,0.2);
    }
    @keyframes typing-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    .typing-cursor { animation: typing-blink 1s infinite; }
  </style>
</head>
<body class="font-sans text-white">

  <!-- Background layers -->
  <div class="fixed inset-0 grid-bg pointer-events-none"></div>
  <div class="fixed top-0 left-1/4 w-[600px] h-[500px] glow-purple pointer-events-none -translate-y-1/4"></div>
  <div class="fixed bottom-0 right-1/4 w-[500px] h-[400px] glow-violet pointer-events-none translate-y-1/3"></div>

  <!-- Nav -->
  <nav class="relative z-50 flex items-center justify-between px-6 py-5 max-w-6xl mx-auto">
    <a href="/" class="flex items-center gap-2.5">
      <div class="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center">
        <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
      </div>
      <span class="font-display font-bold text-lg tracking-tight">LFG</span>
    </a>
    <div class="flex items-center gap-3">
      <a href="/auth/login" class="text-sm text-white/60 hover:text-white transition-colors px-3 py-2">Sign in</a>
      <a href="/auth/register" class="text-sm font-semibold bg-white/10 hover:bg-white/15 border border-white/10 rounded-lg px-4 py-2 transition-all">Get started free</a>
    </div>
  </nav>

  <!-- Hero -->
  <main class="relative z-10 flex flex-col items-center px-4 pt-12 pb-24 sm:pt-20">

    <!-- Badge -->
    <div class="animate-fade-up inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-brand-600/15 border border-brand-500/25 mb-8" style="animation-delay:0s">
      <span class="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-slow"></span>
      <span class="text-xs font-bold text-brand-300 uppercase tracking-wider">AI-Powered App Builder</span>
    </div>

    <!-- Headline -->
    <h1 class="animate-fade-up font-display font-bold text-4xl sm:text-5xl md:text-6xl text-center leading-[1.1] tracking-tight mb-5 max-w-3xl" style="animation-delay:0.08s">
      Describe it.<br>
      <span style="background: linear-gradient(135deg, #818cf8 0%, #a78bfa 40%, #c084fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">We build it.</span>
    </h1>

    <p class="animate-fade-up text-lg text-white/50 text-center max-w-xl mb-10 leading-relaxed" style="animation-delay:0.15s">
      Turn any idea into a working internal tool in minutes. No code, no setup, just describe what you need.
    </p>

    <!-- Prompt box -->
    <div class="animate-fade-up w-full max-w-2xl" style="animation-delay:0.22s">
      <div class="prompt-box rounded-2xl p-4">
        <textarea
          id="prompt-input"
          rows="4"
          class="w-full text-base font-sans leading-relaxed"
          placeholder="Describe the app you want to build...

e.g. A CRM dashboard where my sales team can track leads, add notes, and see a pipeline view of deals"
        ></textarea>
        <div class="flex items-center justify-between mt-3 pt-3 border-t border-white/[0.06]">
          <span class="text-xs text-white/30 font-mono" id="char-count">0 / 2000</span>
          <button id="build-btn" class="build-btn text-white font-semibold text-sm px-6 py-2.5 rounded-xl inline-flex items-center gap-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            Start building
          </button>
        </div>
      </div>

      <!-- Example prompts -->
      <div class="mt-4 flex flex-wrap gap-2" id="examples">
        <span class="example-chip text-xs px-3 py-1.5 rounded-full">📋 Lead tracking CRM</span>
        <span class="example-chip text-xs px-3 py-1.5 rounded-full">📦 Inventory management system</span>
        <span class="example-chip text-xs px-3 py-1.5 rounded-full">🎫 Customer support ticket board</span>
        <span class="example-chip text-xs px-3 py-1.5 rounded-full">📊 Analytics dashboard</span>
        <span class="example-chip text-xs px-3 py-1.5 rounded-full">📅 Team scheduling tool</span>
        <span class="example-chip text-xs px-3 py-1.5 rounded-full">🔗 API request builder</span>
      </div>
    </div>

    <!-- Stats -->
    <div class="animate-fade-up flex flex-wrap justify-center gap-4 mt-14" style="animation-delay:0.3s">
      <div class="stat-card rounded-xl px-6 py-4 text-center">
        <div class="font-display font-bold text-2xl text-white">~2 min</div>
        <div class="text-xs text-white/40 mt-1">to first working app</div>
      </div>
      <div class="stat-card rounded-xl px-6 py-4 text-center">
        <div class="font-display font-bold text-2xl text-white">0</div>
        <div class="text-xs text-white/40 mt-1">lines of code needed</div>
      </div>
      <div class="stat-card rounded-xl px-6 py-4 text-center">
        <div class="font-display font-bold text-2xl text-white">Full stack</div>
        <div class="text-xs text-white/40 mt-1">UI + backend + DB</div>
      </div>
    </div>

    <!-- Feature cards -->
    <div class="animate-fade-up grid sm:grid-cols-3 gap-4 mt-16 w-full max-w-3xl" style="animation-delay:0.36s">
      <div class="feature-card rounded-xl p-5">
        <div class="w-8 h-8 rounded-lg bg-brand-600/20 flex items-center justify-center mb-3">
          <svg class="w-4 h-4 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
        </div>
        <h3 class="font-display font-semibold text-sm text-white mb-1">AI understands context</h3>
        <p class="text-xs text-white/40 leading-relaxed">Describe in plain English. The AI figures out the data model, UI, and logic.</p>
      </div>
      <div class="feature-card rounded-xl p-5">
        <div class="w-8 h-8 rounded-lg bg-violet-600/20 flex items-center justify-center mb-3">
          <svg class="w-4 h-4 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
        </div>
        <h3 class="font-display font-semibold text-sm text-white mb-1">Live preview instantly</h3>
        <p class="text-xs text-white/40 leading-relaxed">See your app running in real time as it's built. Iterate with follow-up instructions.</p>
      </div>
      <div class="feature-card rounded-xl p-5">
        <div class="w-8 h-8 rounded-lg bg-emerald-600/20 flex items-center justify-center mb-3">
          <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        </div>
        <h3 class="font-display font-semibold text-sm text-white mb-1">Export or keep building</h3>
        <p class="text-xs text-white/40 leading-relaxed">Download the full source code or keep refining with the agent. Your app, your code.</p>
      </div>
    </div>

  </main>

  <!-- Footer -->
  <footer class="relative z-10 border-t border-white/[0.05] py-8 px-6">
    <div class="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 bg-brand-600 rounded flex items-center justify-center">
          <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        </div>
        <span class="font-display font-bold text-sm text-white/60">LFG</span>
      </div>
      <div class="flex gap-6 text-xs text-white/30">
        <a href="/" class="hover:text-white/60 transition-colors">Home</a>
        <a href="/agent/" class="hover:text-white/60 transition-colors">Agent</a>
        <a href="/services/" class="hover:text-white/60 transition-colors">Services</a>
        <a href="https://github.com/lfg-hq/lfg" class="hover:text-white/60 transition-colors">GitHub</a>
      </div>
      <p class="text-xs text-white/20">&copy; ${new Date().getFullYear()} LFG. All rights reserved.</p>
    </div>
  </footer>

  <script>
    const textarea = document.getElementById('prompt-input');
    const charCount = document.getElementById('char-count');
    const buildBtn = document.getElementById('build-btn');
    const MAX = 2000;

    // Char counter
    textarea.addEventListener('input', function() {
      const len = this.value.length;
      charCount.textContent = len + ' / ' + MAX;
      if (len > MAX) this.value = this.value.slice(0, MAX);
    });

    // Ctrl/Cmd + Enter to submit
    textarea.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleBuild();
      }
    });

    // Example chips
    document.getElementById('examples').querySelectorAll('.example-chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        const text = this.textContent.replace(/^[^\w]+/, '').trim();
        textarea.value = 'Build me ' + text.toLowerCase();
        textarea.focus();
        const len = textarea.value.length;
        charCount.textContent = len + ' / ' + MAX;
      });
    });

    // Build button
    buildBtn.addEventListener('click', handleBuild);

    function handleBuild() {
      const prompt = textarea.value.trim();
      if (!prompt) {
        textarea.focus();
        textarea.classList.add('ring-red-500');
        setTimeout(function() { textarea.classList.remove('ring-red-500'); }, 1500);
        return;
      }

      // Save prompt to localStorage for pickup after auth
      localStorage.setItem('lfg-instant-prompt', prompt);

      buildBtn.disabled = true;
      buildBtn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Setting up...';

      // Check if already logged in
      fetch('/api/auth/get-session', { credentials: 'include' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data && data.user) {
            window.location.href = '/instant';
          } else {
            window.location.href = '/auth/register?next=/instant';
          }
        })
        .catch(function() {
          window.location.href = '/auth/register?next=/instant';
        });
    }
  </script>

</body>
</html>
`;
