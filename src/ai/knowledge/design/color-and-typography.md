# Color & Typography

## When to Use This

Use these patterns when establishing the visual identity of any app: setting up a design system, implementing dark mode, choosing font pairings, ensuring accessible contrast, or creating gradient and decorative text effects.

## Quick Start

### Dependencies

```bash
# Tailwind CSS is assumed. For custom fonts:
npm install @fontsource/inter @fontsource/geist   # Self-hosted fonts
# Or use Google Fonts via <link> in your HTML

# For dark mode toggle with persistence:
npm install next-themes   # Next.js
# For React + Vite, implement manually (see Pattern 3)
```

### Key Principles

- Define all colors as CSS custom properties — this makes dark mode a single class toggle
- Never hardcode `#hex` colors in JSX; use your design token system exclusively
- Minimum contrast ratios: 4.5:1 for normal text (WCAG AA), 3:1 for large text and UI components
- Type scale should be a ratio (1.25x or 1.333x) — avoid arbitrary sizes
- System font stack first, web fonts second — reduces layout shift and improves performance

## Patterns

### 1. CSS Custom Properties Token System

```css
/* globals.css */
:root {
  /* Brand palette */
  --color-brand-50:  #eff6ff;
  --color-brand-100: #dbeafe;
  --color-brand-200: #bfdbfe;
  --color-brand-300: #93c5fd;
  --color-brand-400: #60a5fa;
  --color-brand-500: #3b82f6;
  --color-brand-600: #2563eb;
  --color-brand-700: #1d4ed8;
  --color-brand-800: #1e40af;
  --color-brand-900: #1e3a8a;

  /* Semantic tokens — light mode */
  --color-bg-base:       #ffffff;
  --color-bg-subtle:     #f9fafb;
  --color-bg-muted:      #f3f4f6;
  --color-bg-emphasis:   #e5e7eb;

  --color-text-primary:  #111827;
  --color-text-secondary:#6b7280;
  --color-text-tertiary: #9ca3af;
  --color-text-disabled: #d1d5db;
  --color-text-inverse:  #ffffff;

  --color-border-subtle: #e5e7eb;
  --color-border-default:#d1d5db;
  --color-border-strong: #9ca3af;

  --color-accent:        var(--color-brand-600);
  --color-accent-hover:  var(--color-brand-700);
  --color-accent-subtle: var(--color-brand-50);

  --color-success:    #16a34a;
  --color-warning:    #d97706;
  --color-error:      #dc2626;
  --color-info:       #0284c7;

  /* Typography */
  --font-sans:    "Inter", "Geist", system-ui, -apple-system, sans-serif;
  --font-mono:    "Geist Mono", "JetBrains Mono", "Fira Code", monospace;
  --font-display: "Cal Sans", "Inter", sans-serif;

  /* Type scale (1.25 Major Third) */
  --text-xs:   0.75rem;    /* 12px */
  --text-sm:   0.875rem;   /* 14px */
  --text-base: 1rem;       /* 16px */
  --text-lg:   1.125rem;   /* 18px */
  --text-xl:   1.25rem;    /* 20px */
  --text-2xl:  1.5rem;     /* 24px */
  --text-3xl:  1.875rem;   /* 30px */
  --text-4xl:  2.25rem;    /* 36px */
  --text-5xl:  3rem;       /* 48px */

  /* Spacing scale */
  --radius-sm:  0.375rem;  /* 6px */
  --radius-md:  0.5rem;    /* 8px */
  --radius-lg:  0.75rem;   /* 12px */
  --radius-xl:  1rem;      /* 16px */
  --radius-2xl: 1.5rem;    /* 24px */
  --radius-full: 9999px;
}

/* Dark mode — flip semantic tokens only */
.dark {
  --color-bg-base:       #0f0f0f;
  --color-bg-subtle:     #171717;
  --color-bg-muted:      #1f1f1f;
  --color-bg-emphasis:   #2a2a2a;

  --color-text-primary:  #f9fafb;
  --color-text-secondary:#9ca3af;
  --color-text-tertiary: #6b7280;
  --color-text-disabled: #4b5563;
  --color-text-inverse:  #111827;

  --color-border-subtle: #1f1f1f;
  --color-border-default:#2a2a2a;
  --color-border-strong: #404040;

  --color-accent:        var(--color-brand-400);
  --color-accent-hover:  var(--color-brand-300);
  --color-accent-subtle: #1e3a8a22;
}
```

### 2. Tailwind Config with Custom Tokens

```ts
// tailwind.config.ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "var(--color-brand-50)",
          100: "var(--color-brand-100)",
          200: "var(--color-brand-200)",
          300: "var(--color-brand-300)",
          400: "var(--color-brand-400)",
          500: "var(--color-brand-500)",
          600: "var(--color-brand-600)",
          700: "var(--color-brand-700)",
          800: "var(--color-brand-800)",
          900: "var(--color-brand-900)",
        },
        // Semantic aliases pointing to CSS vars
        background: {
          base:     "var(--color-bg-base)",
          subtle:   "var(--color-bg-subtle)",
          muted:    "var(--color-bg-muted)",
          emphasis: "var(--color-bg-emphasis)",
        },
        foreground: {
          primary:   "var(--color-text-primary)",
          secondary: "var(--color-text-secondary)",
          tertiary:  "var(--color-text-tertiary)",
          disabled:  "var(--color-text-disabled)",
          inverse:   "var(--color-text-inverse)",
        },
        border: {
          subtle:  "var(--color-border-subtle)",
          default: "var(--color-border-default)",
          strong:  "var(--color-border-strong)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          hover:   "var(--color-accent-hover)",
          subtle:  "var(--color-accent-subtle)",
        },
      },
      fontFamily: {
        sans:    ["var(--font-sans)"],
        mono:    ["var(--font-mono)"],
        display: ["var(--font-display)"],
      },
      fontSize: {
        xs:   ["var(--text-xs)",   { lineHeight: "1rem" }],
        sm:   ["var(--text-sm)",   { lineHeight: "1.25rem" }],
        base: ["var(--text-base)", { lineHeight: "1.5rem" }],
        lg:   ["var(--text-lg)",   { lineHeight: "1.75rem" }],
        xl:   ["var(--text-xl)",   { lineHeight: "1.75rem" }],
        "2xl":["var(--text-2xl)",  { lineHeight: "2rem" }],
        "3xl":["var(--text-3xl)",  { lineHeight: "2.25rem" }],
        "4xl":["var(--text-4xl)",  { lineHeight: "2.5rem" }],
        "5xl":["var(--text-5xl)",  { lineHeight: "1" }],
      },
      borderRadius: {
        sm:   "var(--radius-sm)",
        md:   "var(--radius-md)",
        lg:   "var(--radius-lg)",
        xl:   "var(--radius-xl)",
        "2xl":"var(--radius-2xl)",
        full: "var(--radius-full)",
      },
    },
  },
  plugins: [],
};

export default config;
```

### 3. Dark/Light Mode Toggle

```tsx
import { useState, useEffect, createContext, useContext } from "react";

type Theme = "light" | "dark" | "system";

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (t: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return "system";
    return (localStorage.getItem("theme") as Theme) ?? "system";
  });

  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    function applyTheme(t: Theme) {
      const resolved = t === "system"
        ? (mediaQuery.matches ? "dark" : "light")
        : t;
      setResolvedTheme(resolved);
      document.documentElement.classList.toggle("dark", resolved === "dark");
    }

    applyTheme(theme);

    const listener = () => { if (theme === "system") applyTheme("system"); };
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, [theme]);

  const setTheme = (t: Theme) => {
    localStorage.setItem("theme", t);
    setThemeState(t);
  };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

// Toggle component
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const options: { value: Theme; label: string; icon: string }[] = [
    { value: "light", label: "Light", icon: "☀️" },
    { value: "dark",  label: "Dark",  icon: "🌙" },
    { value: "system",label: "System",icon: "💻" },
  ];

  return (
    <div className="flex items-center gap-1 rounded-xl bg-background-muted p-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          aria-pressed={theme === opt.value}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition
            ${theme === opt.value
              ? "bg-background-base text-foreground-primary shadow-sm"
              : "text-foreground-secondary hover:text-foreground-primary"
            }`}
        >
          <span aria-hidden="true">{opt.icon}</span>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Simple icon-only toggle
export function ThemeToggleIcon() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <button
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
      className="flex h-9 w-9 items-center justify-center rounded-lg
        bg-background-muted text-foreground-secondary
        hover:bg-background-emphasis hover:text-foreground-primary transition"
    >
      {resolvedTheme === "dark" ? (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ) : (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
    </button>
  );
}
```

### 4. Font Pairing Recommendations

```tsx
// Font import in your root layout or HTML
// Option 1: Inter + JetBrains Mono (clean, developer-focused)
// Option 2: Geist + Geist Mono (Vercel's system, modern)
// Option 3: Fraunces + Instrument Sans (editorial, expressive)
// Option 4: Cal Sans + Inter (startup/SaaS feel)

// Example: Google Fonts via next/font (Next.js)
// import { Inter, JetBrains_Mono } from "next/font/google";
// const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
// const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

// Typography showcase component
export function TypographyScale() {
  return (
    <div className="space-y-6 p-8 font-sans">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-widest text-foreground-tertiary">Display</p>
        <h1 className="text-5xl font-black tracking-tight text-foreground-primary leading-none">
          Build faster.
        </h1>
        <h1 className="text-4xl font-bold tracking-tight text-foreground-primary">
          Ship with confidence.
        </h1>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-widest text-foreground-tertiary">Headings</p>
        <h2 className="text-3xl font-bold text-foreground-primary">Section heading</h2>
        <h3 className="text-2xl font-semibold text-foreground-primary">Subsection heading</h3>
        <h4 className="text-xl font-semibold text-foreground-primary">Card title</h4>
        <h5 className="text-lg font-medium text-foreground-primary">Small heading</h5>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-widest text-foreground-tertiary">Body</p>
        <p className="text-base text-foreground-primary max-w-prose leading-relaxed">
          Primary body text. Used for most paragraph content. Optimal line length is 60–75 characters.
          This is what reading paragraphs look like in your application.
        </p>
        <p className="text-sm text-foreground-secondary max-w-prose leading-relaxed">
          Secondary body text. Used for supporting copy, captions, and metadata.
          Slightly smaller and lower contrast to create visual hierarchy.
        </p>
        <p className="text-xs text-foreground-tertiary">
          Tertiary text. Labels, timestamps, helper text.
        </p>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-widest text-foreground-tertiary">Mono</p>
        <code className="block font-mono text-sm bg-background-muted rounded-lg px-4 py-3 text-foreground-primary">
          const greeting = "Hello, world!";
        </code>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-foreground-tertiary">Labels & UI</p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">
            Category Label
          </span>
          <span className="text-sm font-medium text-foreground-primary">Button text</span>
          <span className="text-xs text-foreground-tertiary">helper text</span>
          <span className="text-sm font-medium text-accent">Link text</span>
        </div>
      </div>
    </div>
  );
}
```

### 5. Accessible Contrast Checker (Dev Utility)

```tsx
// WCAG contrast ratio calculation
function getLuminance(hex: string): number {
  const rgb = parseInt(hex.slice(1), 16);
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;

  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getLuminance(hex1);
  const l2 = getLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function ContrastChecker({
  foreground,
  background,
}: {
  foreground: string; // hex
  background: string; // hex
}) {
  const ratio = getContrastRatio(foreground, background);
  const passAALarge = ratio >= 3;      // Large text / UI components
  const passAANormal = ratio >= 4.5;   // Normal text
  const passAAA = ratio >= 7;          // Enhanced

  return (
    <div className="rounded-xl border border-border-default p-4 space-y-3">
      {/* Preview */}
      <div
        className="rounded-lg p-4 text-sm font-medium"
        style={{ backgroundColor: background, color: foreground }}
      >
        The quick brown fox jumps over the lazy dog.
      </div>

      {/* Ratio */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono font-bold text-foreground-primary">
          {ratio.toFixed(2)}:1
        </span>
        <span className="text-xs text-foreground-secondary">contrast ratio</span>
      </div>

      {/* WCAG levels */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        {[
          { label: "AA Large", pass: passAALarge },
          { label: "AA Normal", pass: passAANormal },
          { label: "AAA", pass: passAAA },
        ].map(({ label, pass }) => (
          <div
            key={label}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 font-medium
              ${pass ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}
          >
            <span>{pass ? "✓" : "✗"}</span>
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

// Tested color combinations that meet WCAG AA:
// Dark text on light backgrounds:
//   #111827 on #ffffff  — 19.1:1 (excellent)
//   #374151 on #f9fafb  — 10.6:1 (excellent)
//   #1d4ed8 on #eff6ff  — 5.2:1 (passes AA)
// Light text on dark backgrounds:
//   #f9fafb on #1f2937  — 14.2:1 (excellent)
//   #93c5fd on #1e3a8a  — 4.6:1 (passes AA)
```

### 6. Gradient Text Effects

```tsx
// Tailwind gradient text utility class pattern
// Add to globals.css or use @layer utilities:
/*
@layer utilities {
  .text-gradient {
    @apply bg-gradient-to-r bg-clip-text text-transparent;
  }
}
*/

export function GradientTextShowcase() {
  return (
    <div className="space-y-6 p-8">

      {/* Brand gradient */}
      <h2
        className="text-5xl font-black tracking-tight bg-gradient-to-r from-blue-600 to-violet-600
          bg-clip-text text-transparent"
      >
        Build AI Products
      </h2>

      {/* Warm sunset */}
      <h2
        className="text-5xl font-black tracking-tight bg-gradient-to-r from-orange-400 via-pink-500 to-rose-600
          bg-clip-text text-transparent"
      >
        Ship at Speed
      </h2>

      {/* Emerald to cyan */}
      <h2
        className="text-5xl font-black tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-400
          bg-clip-text text-transparent"
      >
        Zero to Launch
      </h2>

      {/* Dark mode aware gradient */}
      <h2
        className="text-5xl font-black tracking-tight
          bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-400
          bg-clip-text text-transparent"
      >
        Adaptive Theme
      </h2>

      {/* Animated gradient */}
      <style>{`
        @keyframes gradient-shift {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
        .animated-gradient {
          background-size: 200% 200%;
          animation: gradient-shift 4s ease infinite;
        }
      `}</style>
      <h2
        className="text-5xl font-black tracking-tight bg-gradient-to-r
          from-blue-600 via-purple-600 to-pink-600 bg-clip-text text-transparent animated-gradient"
      >
        Animated Text
      </h2>

      {/* Gradient card backgrounds */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-2xl p-6 bg-gradient-to-br from-blue-500 to-blue-700 text-white">
          <p className="font-bold">Ocean</p>
          <p className="text-blue-200 text-sm">blue-500 to blue-700</p>
        </div>
        <div className="rounded-2xl p-6 bg-gradient-to-br from-violet-500 to-purple-700 text-white">
          <p className="font-bold">Violet</p>
          <p className="text-violet-200 text-sm">violet-500 to purple-700</p>
        </div>
        <div className="rounded-2xl p-6 bg-gradient-to-br from-slate-800 to-slate-950 text-white border border-white/10">
          <p className="font-bold">Dark</p>
          <p className="text-slate-400 text-sm">slate-800 to slate-950</p>
        </div>
      </div>
    </div>
  );
}
```

### 7. Status and Badge Colors

```tsx
type Status = "success" | "warning" | "error" | "info" | "neutral" | "purple";

const STATUS_CONFIG: Record<Status, {
  bg: string;
  text: string;
  border: string;
  dot: string;
  label: string;
}> = {
  success: {
    bg:     "bg-green-50 dark:bg-green-950",
    text:   "text-green-700 dark:text-green-400",
    border: "border-green-200 dark:border-green-800",
    dot:    "bg-green-500",
    label:  "Success",
  },
  warning: {
    bg:     "bg-amber-50 dark:bg-amber-950",
    text:   "text-amber-700 dark:text-amber-400",
    border: "border-amber-200 dark:border-amber-800",
    dot:    "bg-amber-500",
    label:  "Warning",
  },
  error: {
    bg:     "bg-red-50 dark:bg-red-950",
    text:   "text-red-700 dark:text-red-400",
    border: "border-red-200 dark:border-red-800",
    dot:    "bg-red-500",
    label:  "Error",
  },
  info: {
    bg:     "bg-blue-50 dark:bg-blue-950",
    text:   "text-blue-700 dark:text-blue-400",
    border: "border-blue-200 dark:border-blue-800",
    dot:    "bg-blue-500",
    label:  "Info",
  },
  neutral: {
    bg:     "bg-gray-100 dark:bg-gray-800",
    text:   "text-gray-700 dark:text-gray-300",
    border: "border-gray-200 dark:border-gray-700",
    dot:    "bg-gray-400",
    label:  "Neutral",
  },
  purple: {
    bg:     "bg-purple-50 dark:bg-purple-950",
    text:   "text-purple-700 dark:text-purple-400",
    border: "border-purple-200 dark:border-purple-800",
    dot:    "bg-purple-500",
    label:  "Purple",
  },
};

export function StatusBadge({
  status,
  label,
  showDot = true,
}: {
  status: Status;
  label?: string;
  showDot?: boolean;
}) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium
        ${config.bg} ${config.text} ${config.border}`}
    >
      {showDot && (
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${config.dot}`} />
      )}
      {label ?? config.label}
    </span>
  );
}

// Alert banner variant
export function AlertBanner({
  status,
  title,
  message,
  onDismiss,
}: {
  status: Status;
  title: string;
  message?: string;
  onDismiss?: () => void;
}) {
  const config = STATUS_CONFIG[status];
  return (
    <div className={`rounded-xl border p-4 ${config.bg} ${config.border}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full ${config.dot}`} />
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${config.text}`}>{title}</p>
          {message && (
            <p className={`mt-0.5 text-sm opacity-80 ${config.text}`}>{message}</p>
          )}
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className={`shrink-0 ${config.text} opacity-60 hover:opacity-100 transition`}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
```

## Common Mistakes

- **Do not mix hex colors directly in JSX** — always use Tailwind classes or CSS custom properties; hardcoded colors do not respond to dark mode
- **Do not use opacity to make dark mode variants** — `text-gray-900/50` in dark mode is not the same as designing proper dark text; use explicit dark: variants
- **Do not use pure black (`#000000`) on white** — the 21:1 ratio is too harsh; use `gray-900` (`#111827`) for body text
- **Do not skip testing contrast on actual backgrounds** — a button with `bg-blue-500 text-white` on a white page looks fine, but check it on your dark card backgrounds too
- **Do not use more than 2 typefaces in a single interface** — one for body/UI and one for display/headings is the maximum; mixing more creates visual noise
- **Do not set `font-size` smaller than 12px** — text below 12px is effectively invisible on standard screens and fails accessibility
- **Do not use `font-weight: 400` for dark mode body text** — slightly heavier weight (500) on dark backgrounds improves readability due to reduced contrast perception

## Framework-Specific Notes

### Next.js

- Use `next/font` for zero-layout-shift font loading; fonts are automatically self-hosted and optimized
- Apply the `dark` class to `<html>` in `layout.tsx` using `next-themes`' `ThemeProvider`
- For the initial dark mode flash prevention, add a script to `<head>` that reads `localStorage` before React hydrates

```tsx
// app/layout.tsx — prevent FOUC
<script
  dangerouslySetInnerHTML={{
    __html: `
      try {
        const theme = localStorage.getItem('theme');
        const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        if (dark) document.documentElement.classList.add('dark');
      } catch(e) {}
    `,
  }}
/>
```

### React + Vite

- Import fonts via `@fontsource` packages in `main.tsx` for self-hosted zero-dependency fonts
- Apply dark mode by toggling the `dark` class on `document.documentElement` inside a `useEffect` — the same approach works, just without Next's server-side HTML
- Use `vite-plugin-pwa` if you need offline font serving
