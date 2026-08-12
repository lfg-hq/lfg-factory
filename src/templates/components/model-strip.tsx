import { html } from "hono/html";

// Logos live in public/images/models/ (served at /public/...). `mono` marks
// single-color (black) marks so they invert to stay visible in dark mode.
const MODELS: Array<{ slug: string; label: string; mono?: boolean }> = [
  { slug: "claude", label: "Claude" },
  { slug: "openai", label: "GPT", mono: true },
  { slug: "gemini", label: "Gemini" },
  { slug: "grok", label: "Grok", mono: true },
  { slug: "deepseek", label: "DeepSeek" },
  { slug: "kimi", label: "Kimi", mono: true },
  { slug: "glm", label: "GLM", mono: true },
];

/** A row of AI-model logo chips (Claude, GPT, Gemini, Grok, DeepSeek, Kimi, GLM). */
export const ModelStrip = () => html`
<div class="flex flex-wrap items-center justify-center gap-3">
  ${MODELS.map(
    (m) => html`
    <div class="flex items-center gap-2.5 pl-3 pr-4 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:shadow-md hover:border-brand-300 transition-all">
      <img src="/public/images/models/${m.slug}.svg" alt="${m.label} logo" loading="lazy" class="${m.mono ? "dark:invert" : ""}" style="width:22px;height:22px" />
      <span class="text-sm font-semibold text-slate-700">${m.label}</span>
    </div>`
  )}
</div>`;
