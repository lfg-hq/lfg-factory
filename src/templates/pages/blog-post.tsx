import { html, raw } from "hono/html";
import { Nav, Footer } from "../components/nav.tsx";
import type { BlogPost } from "../../utils/blog.ts";

export function BlogPostPage({
  post,
  recentPosts,
}: {
  post: BlogPost;
  recentPosts: BlogPost[];
}) {
  const recentItems =
    recentPosts.length > 0
      ? recentPosts.map(
          (item) => html`
            <a href="/blog/${item.slug}/" class="block border border-slate-200 rounded-xl p-4 hover:border-indigo-300 transition-colors">
                <p class="text-xs text-slate-500 font-semibold mb-1">${item.dateDisplay}</p>
                <p class="font-semibold text-slate-900 leading-snug text-sm">${item.title}</p>
            </a>`
        )
      : html`<p class="text-sm text-slate-500">No additional posts yet.</p>`;

  return html`<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${post.title} | LFG Blog</title>
    <meta name="description" content="${post.excerpt}">
    <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
      body { font-family: 'Manrope', sans-serif; }
      .font-display { font-family: 'Sora', sans-serif; }
      .prose h1, .prose h2, .prose h3, .prose h4 { font-family: 'Sora', sans-serif; color: #0f172a; margin-top: 1.6em; margin-bottom: 0.6em; font-weight: 700; }
      .prose h1 { font-size: 1.75rem; }
      .prose h2 { font-size: 1.4rem; }
      .prose h3 { font-size: 1.15rem; }
      .prose p, .prose li { color: #334155; line-height: 1.8; margin-bottom: 0.75rem; }
      .prose ul, .prose ol { padding-left: 1.25rem; margin: 1rem 0; }
      .prose ul li { list-style-type: disc; }
      .prose ol li { list-style-type: decimal; }
      .prose strong { color: #0f172a; font-weight: 600; }
      .prose code { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 0.35rem; padding: 0.12rem 0.4rem; font-size: 0.875em; color: #4f46e5; }
      .prose pre { background: #0f172a; color: #e2e8f0; padding: 1.25rem; border-radius: 0.75rem; overflow-x: auto; margin: 1.5rem 0; }
      .prose pre code { background: transparent; border: none; padding: 0; color: inherit; font-size: 0.875rem; }
      .prose blockquote { border-left: 3px solid #6366f1; margin: 1.5rem 0; padding: 0.5rem 1rem; color: #475569; background: #f8fafc; border-radius: 0 0.5rem 0.5rem 0; }
      .prose hr { border: none; border-top: 1px solid #e2e8f0; margin: 2rem 0; }
      .prose table { width: 100%; border-collapse: collapse; margin: 1.25rem 0; font-size: 0.9rem; }
      .prose th, .prose td { border: 1px solid #e2e8f0; padding: 0.6rem 0.75rem; text-align: left; }
      .prose th { background: #f8fafc; color: #0f172a; font-weight: 600; }
      .prose a { color: #4f46e5; text-decoration: underline; text-underline-offset: 2px; }
      .prose a:hover { color: #4338ca; }
      /* The shared Nav toggles html.dark; the prose colours above are hardcoded,
         so they need explicit dark counterparts or the article goes unreadable. */
      html.dark .prose h1, html.dark .prose h2, html.dark .prose h3, html.dark .prose h4 { color: #e6edf3; }
      html.dark .prose p, html.dark .prose li { color: #b0bac6; }
      html.dark .prose strong { color: #e6edf3; }
      html.dark .prose code { background: #1c2128; border-color: rgba(255,255,255,0.1); color: #a5b4fc; }
      html.dark .prose blockquote { background: rgba(99,102,241,0.06); color: #8b949e; }
      html.dark .prose hr { border-top-color: rgba(255,255,255,0.08); }
      html.dark .prose th, html.dark .prose td { border-color: rgba(255,255,255,0.08); }
      html.dark .prose th { background: #161b22; color: #e6edf3; }
      html.dark .prose a { color: #818cf8; }
    </style>
</head>
<body class="text-slate-900 bg-slate-50">
    ${ Nav({ activePage: "blog" }) }

    <main class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 sm:pt-32 pb-10 sm:pb-14">
        <div class="mb-6">
            <a href="/blog/" class="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-indigo-600 transition-colors">
                <i data-lucide="arrow-left" class="w-4 h-4"></i> All posts
            </a>
        </div>

        <div class="grid lg:grid-cols-12 gap-10">
            <article class="lg:col-span-8 rounded-2xl border border-slate-200 bg-white p-6 sm:p-10 shadow-sm">
                <header class="mb-8">
                    <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                        ${post.dateDisplay} &bull; ${post.readingMinutes} min read
                    </p>
                    <h1 class="font-display font-bold text-3xl sm:text-4xl text-slate-900 leading-tight">${post.title}</h1>
                    <p class="text-slate-600 mt-4 text-lg leading-relaxed">${post.excerpt}</p>
                </header>
                <div class="prose max-w-none">
                    ${raw(post.contentHtml)}
                </div>
            </article>

            <aside class="lg:col-span-4 space-y-6">
                <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sticky top-24">
                    <h2 class="font-display text-lg font-bold text-slate-900 mb-4">Recent posts</h2>
                    <div class="space-y-3">
                        ${recentItems}
                    </div>
                    <div class="mt-6 pt-4 border-t border-slate-100">
                        <a href="/blog/" class="inline-flex items-center gap-2 text-sm font-semibold text-indigo-700 hover:text-indigo-800 transition-colors">
                            All posts <i data-lucide="arrow-right" class="w-4 h-4"></i>
                        </a>
                    </div>
                </div>
            </aside>
        </div>
    </main>

    ${ Footer() }

    <script>
      lucide.createIcons();
    </script>
</body>
</html>`;
}
