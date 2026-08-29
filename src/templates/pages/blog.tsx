import { html } from "hono/html";
import type { BlogPost } from "../../utils/blog.ts";
import { Nav, Footer } from "../components/nav.tsx";

const MOBILE_JS = html`
<script>
  lucide.createIcons();

  // Blog CTA form
  const ctaForm = document.getElementById('cta-form');
  if (ctaForm) {
    ctaForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      const email = document.getElementById('cta-email').value.trim();
      const msgEl = document.getElementById('cta-message');
      const message = msgEl ? msgEl.value.trim() : '';
      const btn = document.getElementById('cta-btn');
      const status = document.getElementById('cta-status');
      if (!email) return;

      btn.disabled = true;
      btn.textContent = 'Sending...';
      status.className = 'text-xs hidden';

      try {
        const res = await fetch('/api/blog/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, message }),
        });
        if (!res.ok) throw new Error();
        const ok = document.createElement('p');
        ok.className = 'text-sm text-emerald-400 font-medium flex items-center gap-2';
        ok.innerHTML = '<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Got it, we will be in touch at <strong class="ml-1">' + email + '</strong>';
        ctaForm.replaceChildren(ok);
      } catch {
        btn.disabled = false;
        btn.innerHTML = 'Get in touch <svg class="w-3.5 h-3.5 inline-block ml-1" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>';
        status.textContent = 'Something went wrong, please try again.';
        status.className = 'text-xs text-red-400';
      }
    });
  }
</script>`;

function FeaturedCard(post: BlogPost) {
  return html`
    <a href="/blog/${post.slug}/" class="group block rounded-2xl border border-slate-200 bg-white shadow-sm hover:shadow-lg transition-all duration-200 overflow-hidden">
        <div class="flex flex-col sm:flex-row">
            <div class="sm:w-2/5 bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 p-8 sm:p-10 flex flex-col justify-between min-h-[200px] relative overflow-hidden">
                ${post.coverImage ? html`<img src="${post.coverImage}" alt="" class="absolute inset-0 w-full h-full object-cover" />
                <div class="absolute inset-0 bg-black/40"></div>` : ""}
                <span class="relative inline-flex items-center gap-1.5 bg-white/20 text-white text-xs font-semibold px-3 py-1 rounded-full w-fit">
                    <i data-lucide="star" class="w-3 h-3"></i> Latest
                </span>
                <div class="relative mt-6">
                    <p class="${post.coverImage ? "text-white/80" : "text-indigo-200"} text-xs font-semibold uppercase tracking-wider">${post.dateDisplay}</p>
                    <p class="text-white/70 text-xs mt-1">${post.readingMinutes} min read</p>
                </div>
            </div>
            <div class="sm:w-3/5 p-8 sm:p-10 flex flex-col justify-between">
                <div>
                    <h2 class="font-display text-2xl sm:text-3xl font-bold text-slate-900 leading-snug group-hover:text-indigo-700 transition-colors">${post.title}</h2>
                    <p class="text-slate-500 mt-3 text-sm leading-relaxed excerpt-clamp">${post.excerpt}</p>
                </div>
                <div class="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-indigo-700 group-hover:gap-3 transition-all">
                    Read post <i data-lucide="arrow-right" class="w-4 h-4"></i>
                </div>
            </div>
        </div>
    </a>`;
}

function PostCard(post: BlogPost) {
  return html`
    <a href="/blog/${post.slug}/" class="group block rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all duration-200 flex flex-col h-full">
        <div class="flex items-center gap-2 text-xs font-medium text-slate-400 mb-4">
            <i data-lucide="calendar" class="w-3.5 h-3.5"></i>
            <span>${post.dateDisplay}</span>
            <span class="text-slate-300">&bull;</span>
            <i data-lucide="clock" class="w-3.5 h-3.5"></i>
            <span>${post.readingMinutes} min</span>
        </div>
        <h2 class="font-display text-lg font-bold text-slate-900 leading-snug mb-3 group-hover:text-indigo-700 transition-colors title-clamp">${post.title}</h2>
        <p class="text-slate-500 text-sm leading-relaxed excerpt-clamp flex-1">${post.excerpt}</p>
        <div class="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
            <span class="text-xs font-semibold text-indigo-600 group-hover:text-indigo-800 transition-colors inline-flex items-center gap-1.5">
                Read post <i data-lucide="arrow-right" class="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform"></i>
            </span>
        </div>
    </a>`;
}

function AutomateCTA() {
  return html`
    <div class="my-10 rounded-2xl bg-slate-900 px-8 py-10 sm:px-12 sm:py-11">
        <div class="flex flex-col sm:flex-row sm:items-start gap-8">

            <div class="flex-1 min-w-0">
                <h2 class="font-display font-bold text-xl text-white leading-snug">Automate your engineering workflows</h2>
                <p class="text-slate-400 text-sm mt-1.5">Drop your email, we'll reach out with ideas for your stack.</p>
            </div>

            <form id="cta-form" class="flex-1 min-w-0 flex flex-col gap-3">

                <!-- Email pill row -->
                <div class="flex items-center gap-2 p-1.5 rounded-xl bg-white/10 border border-white/10 focus-within:border-indigo-500 transition-colors">
                    <input
                        id="cta-email"
                        type="email"
                        required
                        placeholder="you@company.com"
                        class="flex-1 bg-transparent text-white placeholder-slate-500 text-sm px-3 py-1.5 focus:outline-none"
                    />
                    <button type="submit" id="cta-btn"
                        class="flex-shrink-0 inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-all whitespace-nowrap">
                        Get in touch
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
                    </button>
                </div>

                <!-- Native details/summary toggle, always clickable, no JS needed -->
                <details class="group">
                    <summary class="list-none cursor-pointer text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1.5 select-none w-fit">
                        <svg class="w-3.5 h-3.5 transition-transform duration-200 group-open:rotate-180" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                        Add context <span class="text-slate-600">(optional)</span>
                    </summary>
                    <textarea
                        id="cta-message"
                        rows="3"
                        placeholder="e.g. We lose hours each week on manual dependency updates and code review triage..."
                        class="mt-3 w-full text-sm text-white placeholder-slate-600 bg-white/10 border border-white/10 focus:border-indigo-500 focus:outline-none rounded-xl px-4 py-3 resize-none transition-colors"
                    ></textarea>
                </details>

                <p id="cta-status" class="text-xs hidden"></p>
            </form>

        </div>
    </div>`;
}

function EmptyState() {
  return html`
    <div class="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center col-span-3">
        <div class="w-14 h-14 bg-indigo-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <i data-lucide="pen-line" class="w-7 h-7 text-indigo-500"></i>
        </div>
        <h2 class="font-display text-xl font-bold text-slate-900 mb-2">Posts coming soon</h2>
        <p class="text-slate-500 text-sm max-w-md mx-auto">We're writing up what we've learned building LFG, delivering client software through the factory, and running the pipeline in production.</p>
        <a href="https://github.com/lfg-hq/lfg" target="_blank" rel="noopener noreferrer" class="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-indigo-600 transition-colors">
<svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg> Follow on GitHub
        </a>
    </div>`;
}

export function BlogPage({ posts }: { posts: BlogPost[] }) {
  const [featured, ...rest] = posts;

  return html`<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LFG Blog | Engineering Notes and Build Playbooks</title>
    <meta name="description" content="Practical engineering notes, build playbooks, and shipping lessons from LFG.">
    <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        darkMode: 'class',
        theme: {
          extend: {
            fontFamily: {
              sans: ['Manrope', 'sans-serif'],
              display: ['Sora', 'sans-serif'],
            },
            colors: {
              brand: { 50:'#eef2ff',100:'#e0e7ff',200:'#c7d2fe',300:'#a5b4fc',400:'#818cf8',500:'#6366f1',600:'#4f46e5',700:'#4338ca',800:'#3730a3',900:'#312e81' },
            }
          }
        }
      }
    </script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
      body { font-family: 'Manrope', sans-serif; }
      .font-display { font-family: 'Sora', sans-serif; }
      .excerpt-clamp {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .title-clamp {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
    </style>
</head>
<body class="text-slate-900 bg-slate-50">
    ${ Nav({ activePage: "blog" }) }

    <main class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 sm:pt-32 pb-16">

        <header class="mb-12">
            <h1 class="font-display font-bold text-4xl sm:text-5xl text-slate-900 leading-tight">Engineering notes<br class="hidden sm:block"> that stay practical</h1>
            <p class="text-slate-500 mt-4 text-base max-w-xl">Shipping lessons, build playbooks, and engineering insights from the LFG team.</p>
        </header>

        ${
          posts.length === 0
            ? html`<div class="grid grid-cols-1">${EmptyState()}</div>`
            : html`
          <!-- Featured post -->
          <div class="mb-2">
              ${FeaturedCard(featured!)}
          </div>

          <!-- CTA -->
          ${AutomateCTA()}

          <!-- Post grid -->
          ${rest.length > 0 ? html`
          <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              ${rest.map((p) => PostCard(p))}
          </div>` : ""}
        `
        }

    </main>

    ${ Footer() }
    ${MOBILE_JS}
</body>
</html>`;
}
