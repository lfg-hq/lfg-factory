# Responsive Design

## When to Use This

Use these patterns whenever a UI must work across mobile (320px), tablet (768px), and desktop (1280px+). These patterns cover mobile-first breakpoints, fluid typography, responsive grids, image handling, container queries, and touch-friendly interactions.

## Quick Start

### Dependencies

```bash
# Tailwind CSS handles breakpoints out of the box
# For container queries:
npm install @tailwindcss/container-queries
```

```ts
// tailwind.config.ts
import containerQueries from "@tailwindcss/container-queries";

export default {
  plugins: [containerQueries],
};
```

### Key Principles

- Always design mobile-first — write base styles for mobile, then override for larger screens with `sm:`, `md:`, `lg:`
- Use `clamp()` for fluid typography — text scales smoothly between breakpoints without JavaScript
- Minimum touch target size is 44x44px — use `min-h-[44px] min-w-[44px]` for all interactive elements
- Avoid hiding content on mobile — simplify layout, not information
- Use `svh` (small viewport height) instead of `vh` on mobile to account for browser chrome

## Patterns

### 1. Mobile-First Tailwind Breakpoints Reference

```tsx
// Tailwind default breakpoints:
// sm  — 640px   (large phones, small tablets)
// md  — 768px   (tablets)
// lg  — 1024px  (small laptops)
// xl  — 1280px  (desktops)
// 2xl — 1536px  (large desktops)

export function BreakpointDemo() {
  return (
    <div>
      {/* Visible only on specific breakpoints */}
      <div className="block sm:hidden">Mobile only</div>
      <div className="hidden sm:block md:hidden">Tablet only</div>
      <div className="hidden md:block">Desktop and up</div>

      {/* Grid that changes columns at breakpoints */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-xl bg-blue-50 p-6 text-center font-medium text-blue-700">
            Card {i + 1}
          </div>
        ))}
      </div>

      {/* Stacked on mobile, side-by-side on desktop */}
      <div className="flex flex-col md:flex-row gap-4 mt-4">
        <div className="flex-1 rounded-xl bg-gray-100 p-6">Main content</div>
        <div className="w-full md:w-64 rounded-xl bg-gray-50 p-6">Sidebar</div>
      </div>

      {/* Spacing and typography scaling */}
      <div className="p-4 sm:p-6 lg:p-8 xl:p-12">
        <h1 className="text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-bold">
          Responsive heading
        </h1>
        <p className="mt-2 text-sm sm:text-base lg:text-lg text-gray-600">
          Body text that scales up at larger breakpoints.
        </p>
      </div>
    </div>
  );
}
```

### 2. Fluid Typography with `clamp()`

```tsx
// Add to globals.css
/*
:root {
  --text-fluid-sm:   clamp(0.8rem,  0.75rem + 0.25vw, 0.875rem);
  --text-fluid-base: clamp(1rem,    0.95rem + 0.25vw, 1.125rem);
  --text-fluid-lg:   clamp(1.125rem,1rem + 0.625vw,   1.5rem);
  --text-fluid-xl:   clamp(1.25rem, 1rem + 1.25vw,    2rem);
  --text-fluid-2xl:  clamp(1.5rem,  1rem + 2.5vw,     3rem);
  --text-fluid-3xl:  clamp(2rem,    1.5rem + 2.5vw,   4rem);
  --text-fluid-hero: clamp(2.5rem,  1.5rem + 5vw,     6rem);
}
*/

// tailwind.config.ts extension
// fontSize: {
//   "fluid-sm":   "var(--text-fluid-sm)",
//   "fluid-base": "var(--text-fluid-base)",
//   "fluid-lg":   "var(--text-fluid-lg)",
//   "fluid-xl":   "var(--text-fluid-xl)",
//   "fluid-2xl":  "var(--text-fluid-2xl)",
//   "fluid-3xl":  "var(--text-fluid-3xl)",
//   "fluid-hero": "var(--text-fluid-hero)",
// }

export function FluidTypographyHero() {
  return (
    <section className="px-4 py-16 sm:py-24 lg:py-32 text-center max-w-5xl mx-auto">
      <div
        className="inline-flex items-center gap-2 rounded-full bg-blue-100 px-4 py-1.5 mb-6"
        style={{ fontSize: "var(--text-fluid-sm)" }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
        <span className="text-blue-700 font-medium">New — AI-powered development</span>
      </div>

      <h1
        className="font-black tracking-tight text-gray-900 leading-none"
        style={{ fontSize: "var(--text-fluid-hero)" }}
      >
        Build products
        <br />
        <span className="bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
          at light speed
        </span>
      </h1>

      <p
        className="mt-6 text-gray-500 max-w-2xl mx-auto"
        style={{ fontSize: "var(--text-fluid-lg)" }}
      >
        The AI platform that turns your ideas into production-ready software.
        From PRD to deployed app in hours, not months.
      </p>

      <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
        <a
          href="/signup"
          className="w-full sm:w-auto rounded-xl bg-blue-600 px-8 py-4 font-semibold text-white
            hover:bg-blue-700 transition shadow-lg min-h-[44px] flex items-center justify-center"
          style={{ fontSize: "var(--text-fluid-base)" }}
        >
          Start building free
        </a>
        <a
          href="/demo"
          className="w-full sm:w-auto rounded-xl border-2 border-gray-200 px-8 py-4 font-semibold
            text-gray-700 hover:border-gray-400 transition min-h-[44px] flex items-center justify-center"
          style={{ fontSize: "var(--text-fluid-base)" }}
        >
          Watch demo
        </a>
      </div>
    </section>
  );
}
```

### 3. Responsive Grid Layouts

```tsx
// Auto-fill grid: fills available space, minimum card width
export function AutoFillGrid({ items }: { items: { id: string; title: string; description: string }[] }) {
  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))" }}
    >
      {items.map((item) => (
        <div key={item.id} className="rounded-xl border border-gray-200 bg-white p-5 hover:shadow-md transition">
          <h3 className="font-semibold text-gray-900">{item.title}</h3>
          <p className="mt-1 text-sm text-gray-500">{item.description}</p>
        </div>
      ))}
    </div>
  );
}

// Holy grail layout: header + sidebar + main + aside + footer
export function HolyGrailLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 h-16 border-b border-gray-200 bg-white px-4 flex items-center">
        Header
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — hidden on mobile */}
        <aside className="hidden lg:flex lg:w-60 xl:w-72 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
          Left sidebar
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          {children}
        </main>

        {/* Right aside — hidden below xl */}
        <aside className="hidden xl:flex xl:w-72 shrink-0 flex-col border-l border-gray-200 bg-gray-50 p-4">
          Right aside
        </aside>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white px-4 py-4 text-sm text-gray-500">
        Footer
      </footer>
    </div>
  );
}

// Masonry-style grid with CSS columns
export function MasonryGrid({ items }: { items: { id: string; content: React.ReactNode }[] }) {
  return (
    <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 [&>*]:break-inside-avoid [&>*]:mb-4">
      {items.map((item) => (
        <div key={item.id} className="rounded-xl border border-gray-200 bg-white p-4">
          {item.content}
        </div>
      ))}
    </div>
  );
}

// Feature grid: 1 col → 2 col → 3 col with featured first item
export function FeatureGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {/* Featured card spans full width on md, 2 cols on lg */}
      <div className="md:col-span-2 lg:col-span-2 rounded-2xl bg-gradient-to-br from-blue-600 to-violet-600 p-8 text-white">
        <h3 className="text-2xl font-bold">Featured Item</h3>
        <p className="mt-2 text-blue-200">This card takes up more space at larger breakpoints.</p>
      </div>

      {/* Regular cards */}
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-gray-200 p-6">
          <h3 className="font-semibold text-gray-900">Feature {i + 1}</h3>
          <p className="mt-1 text-sm text-gray-500">Supporting description text here.</p>
        </div>
      ))}
    </div>
  );
}
```

### 4. Responsive Images with srcset

```tsx
// Next.js Image component (recommended)
import Image from "next/image";

export function ResponsiveHeroImage() {
  return (
    <div className="relative w-full aspect-video rounded-2xl overflow-hidden">
      <Image
        src="/hero.jpg"
        alt="Dashboard preview"
        fill
        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 1200px"
        className="object-cover"
        priority // LCP image — load immediately
        quality={85}
      />
    </div>
  );
}

// Plain HTML srcset (React + Vite or non-Next environments)
export function SrcSetImage({
  src,
  alt,
  className = "",
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  // Assumes image service that accepts ?w= query param (e.g., Cloudinary, imgix)
  const base = src.split("?")[0];

  return (
    <img
      src={`${base}?w=800`}
      srcSet={`
        ${base}?w=400  400w,
        ${base}?w=800  800w,
        ${base}?w=1200 1200w,
        ${base}?w=1600 1600w
      `}
      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 80vw, 1200px"
      alt={alt}
      loading="lazy"
      decoding="async"
      className={`w-full h-auto ${className}`}
    />
  );
}

// Responsive picture with art direction — different crops per breakpoint
export function ArtDirectedImage({ alt }: { alt: string }) {
  return (
    <picture>
      {/* Mobile: portrait crop */}
      <source
        media="(max-width: 639px)"
        srcSet="/images/hero-portrait.webp 1x, /images/hero-portrait@2x.webp 2x"
        type="image/webp"
      />
      {/* Tablet: square crop */}
      <source
        media="(max-width: 1023px)"
        srcSet="/images/hero-square.webp 1x, /images/hero-square@2x.webp 2x"
        type="image/webp"
      />
      {/* Desktop: landscape crop */}
      <source
        srcSet="/images/hero-landscape.webp 1x, /images/hero-landscape@2x.webp 2x"
        type="image/webp"
      />
      {/* Fallback */}
      <img
        src="/images/hero-landscape.jpg"
        alt={alt}
        className="w-full h-auto"
        loading="lazy"
      />
    </picture>
  );
}
```

### 5. Container Queries

```tsx
// Container queries let a component respond to its PARENT container's size,
// not the viewport — critical for reusable components used in different layouts

export function ContainerQueryCard() {
  return (
    // 1. Mark the container
    <div className="@container rounded-xl border border-gray-200 p-4">
      {/* 2. Style based on container size, not viewport */}
      <div className="flex flex-col @sm:flex-row @sm:items-center gap-4">
        <div className="h-16 w-16 @sm:h-12 @sm:w-12 rounded-xl bg-blue-100 shrink-0 flex items-center justify-center">
          <svg className="h-8 w-8 @sm:h-6 @sm:w-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-gray-900 text-base @sm:text-sm">
            AI-Powered Builder
          </h3>
          <p className="text-sm @sm:text-xs text-gray-500 mt-0.5">
            Automatically generates production-ready code from your specifications.
          </p>
        </div>
        <button className="@sm:shrink-0 w-full @sm:w-auto rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition">
          Try it
        </button>
      </div>
    </div>
  );
}

// Full dashboard widget that adapts to sidebar vs main layout
export function AdaptiveWidget({ data }: { data: { label: string; value: string; change: string }[] }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 @[300px]:grid-cols-2 @[500px]:grid-cols-4 gap-3">
        {data.map((item) => (
          <div key={item.label} className="rounded-xl bg-white border border-gray-200 p-4">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{item.label}</p>
            <p className="text-xl @[300px]:text-2xl font-bold text-gray-900 mt-1">{item.value}</p>
            <p className="text-xs text-green-600 mt-0.5">{item.change}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 6. Touch-Friendly Tap Targets

```tsx
// All interactive elements must be at minimum 44x44px (Apple HIG / WCAG 2.5.5)

export function TouchFriendlyControls() {
  return (
    <div className="space-y-4">
      {/* Icon button — use padding to enlarge hit area */}
      <button
        aria-label="Delete item"
        className="flex h-11 w-11 items-center justify-center rounded-xl text-gray-500
          hover:bg-gray-100 active:bg-gray-200 transition touch-manipulation"
        // touch-manipulation: disables double-tap zoom, makes taps feel instant
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>

      {/* Checkbox with large tap area */}
      <label className="flex items-center gap-3 cursor-pointer group">
        <div className="relative flex h-11 w-11 items-center justify-center rounded-xl
          group-hover:bg-gray-100 transition touch-manipulation">
          <input
            type="checkbox"
            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          />
        </div>
        <span className="text-sm text-gray-700">Accept terms and conditions</span>
      </label>

      {/* List items — full-width tap */}
      <ul className="rounded-xl border border-gray-200 divide-y divide-gray-100">
        {["Option A", "Option B", "Option C"].map((opt) => (
          <li key={opt}>
            <button
              className="flex w-full items-center justify-between px-4 py-3.5 text-sm text-gray-700
                hover:bg-gray-50 active:bg-gray-100 transition min-h-[44px] touch-manipulation"
            >
              <span>{opt}</span>
              <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      {/* Slider with large handle */}
      <div className="px-2">
        <label className="block text-sm font-medium text-gray-700 mb-3">Volume</label>
        <input
          type="range"
          min={0}
          max={100}
          defaultValue={60}
          className="w-full h-2 rounded-full bg-gray-200 appearance-none cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:h-6
            [&::-webkit-slider-thumb]:w-6
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-blue-600
            [&::-webkit-slider-thumb]:shadow-md
            [&::-webkit-slider-thumb]:cursor-grab"
        />
      </div>

      {/* Swipeable card hint (CSS only) */}
      <div
        className="rounded-xl border border-gray-200 bg-white p-4 overflow-x-auto
          snap-x snap-mandatory flex gap-3"
        style={{ scrollbarWidth: "none" }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="snap-start shrink-0 w-[280px] rounded-xl bg-gray-50 p-4"
          >
            <p className="font-medium text-gray-900">Swipe card {i + 1}</p>
            <p className="text-sm text-gray-500 mt-1">Swipe horizontally to see more</p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 7. Responsive Navigation Pattern (Full Example)

```tsx
import { useState } from "react";

// Combines: sticky header + mobile drawer + desktop sidebar
export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navItems = [
    { label: "Dashboard", href: "/", icon: "⊞" },
    { label: "Projects", href: "/projects", icon: "◈" },
    { label: "Team", href: "/team", icon: "◎" },
    { label: "Settings", href: "/settings", icon: "⚙" },
  ];

  return (
    <div className="flex h-[100svh] overflow-hidden bg-gray-50">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:w-56 xl:w-64 shrink-0 flex-col bg-white border-r border-gray-200">
        <div className="flex h-16 items-center px-5 border-b border-gray-200">
          <span className="font-bold text-gray-900">LFG Platform</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium
                text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition min-h-[44px]"
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </a>
          ))}
        </nav>
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 z-50 w-72 bg-white border-r border-gray-200
            flex flex-col lg:hidden">
            <div className="flex h-16 items-center justify-between px-5 border-b border-gray-200">
              <span className="font-bold text-gray-900">LFG Platform</span>
              <button
                onClick={() => setSidebarOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-gray-100"
              >
                <svg className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-0.5">
              {navItems.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium
                    text-gray-700 hover:bg-gray-100 transition min-h-[44px]"
                >
                  <span className="text-base">{item.icon}</span>
                  {item.label}
                </a>
              ))}
            </nav>
          </aside>
        </>
      )}

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Mobile header */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-gray-200
          bg-white px-4 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
            className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-gray-100 transition"
          >
            <svg className="h-5 w-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="font-bold text-gray-900">LFG Platform</span>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
```

## Common Mistakes

- **Do not use `vh` for mobile full-screen layouts** — browser chrome (address bar) takes space that `vh` does not account for; use `100svh` (small viewport height) instead
- **Do not use fixed pixel breakpoints in media queries** — use Tailwind's breakpoint classes to stay consistent; mixing custom `@media` queries and Tailwind classes causes confusion
- **Do not hide navigation on mobile without providing an alternative** — if the sidebar disappears below `lg`, always provide a hamburger button
- **Do not make tap targets smaller than 44x44px** — icon buttons with just `h-5 w-5` icons are only 20px — wrap them in a larger button element
- **Do not use `overflow-hidden` on the body to prevent scroll without also setting `height: 100%`** — on iOS, this alone does not stop scroll bounce
- **Do not use `position: fixed` on mobile without testing the keyboard** — when the soft keyboard opens, fixed elements can overlap the input
- **Do not forget `touch-manipulation`** — add this to interactive elements that need to feel instant on mobile; it disables the 300ms tap delay on touch devices

## Framework-Specific Notes

### Next.js

- Use `100svh` in the root layout to avoid mobile viewport height issues: `className="min-h-[100svh]"`
- The App Router supports separate `loading.tsx` per route — these display while the page is streaming; use them with skeleton layouts
- For responsive images, always use `next/image` with `sizes` prop — it automatically generates `srcset` and serves WebP

### React + Vite

- Use `@media` queries in CSS modules or styled components for values that Tailwind cannot express (e.g., `print` media, `hover: hover` pointer detection)
- For detecting breakpoint in JS (rare, prefer CSS): use a `useMediaQuery` hook

```tsx
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

// Usage:
// const isMobile = useMediaQuery("(max-width: 767px)");
```
