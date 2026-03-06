# Navigation

## When to Use This

Use these patterns for any application shell: marketing sites, dashboards, admin panels, mobile apps. These patterns cover the full navigation surface — top nav, sidebar, mobile drawers, tabs, and breadcrumbs.

## Quick Start

### Dependencies

```bash
# For routing (choose one)
npm install react-router-dom   # React + Vite
# Next.js has built-in routing via next/link and next/navigation
```

### Key Principles

- Always provide visible active state on the current route — users should never be disoriented
- Mobile navigation must be touch-friendly — minimum 44x44px tap targets
- Keyboard navigation must work — use `role="navigation"`, proper `aria-label`, and logical tab order
- Collapse sidebars on mobile to a drawer — never show them inline on small screens
- Use `aria-current="page"` on the active link, not just a CSS class

## Patterns

### 1. Responsive Navbar

```tsx
import { useState } from "react";

type NavItem = {
  label: string;
  href: string;
};

const NAV_ITEMS: NavItem[] = [
  { label: "Home", href: "/" },
  { label: "Features", href: "/features" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
];

export function Navbar({ currentPath }: { currentPath: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/60">
      <nav
        aria-label="Main navigation"
        className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8 h-16"
      >
        {/* Logo */}
        <a href="/" className="flex items-center gap-2 font-bold text-xl text-gray-900">
          <div className="h-8 w-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <span className="text-white text-sm font-black">L</span>
          </div>
          LFG
        </a>

        {/* Desktop links */}
        <ul className="hidden md:flex items-center gap-1" role="list">
          {NAV_ITEMS.map((item) => {
            const isActive = currentPath === item.href;
            return (
              <li key={item.href}>
                <a
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition
                    ${isActive
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                    }`}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>

        {/* Desktop CTA */}
        <div className="hidden md:flex items-center gap-3">
          <a
            href="/login"
            className="text-sm font-medium text-gray-600 hover:text-gray-900 transition"
          >
            Sign in
          </a>
          <a
            href="/signup"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white
              hover:bg-blue-700 transition shadow-sm"
          >
            Get started
          </a>
        </div>

        {/* Mobile menu button */}
        <button
          onClick={() => setMobileOpen((o) => !o)}
          aria-expanded={mobileOpen}
          aria-controls="mobile-menu"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          className="md:hidden flex h-10 w-10 items-center justify-center rounded-lg
            text-gray-600 hover:bg-gray-100 transition"
        >
          {mobileOpen ? (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </nav>

      {/* Mobile menu */}
      {mobileOpen && (
        <div
          id="mobile-menu"
          className="md:hidden border-t border-gray-200 bg-white px-4 py-3 space-y-1"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = currentPath === item.href;
            return (
              <a
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setMobileOpen(false)}
                className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition
                  ${isActive
                    ? "bg-blue-50 text-blue-700"
                    : "text-gray-700 hover:bg-gray-100"
                  }`}
              >
                {item.label}
              </a>
            );
          })}
          <div className="pt-2 border-t border-gray-100 space-y-1">
            <a href="/login" className="block rounded-lg px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition">
              Sign in
            </a>
            <a href="/signup" className="block rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white text-center hover:bg-blue-700 transition">
              Get started
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
```

### 2. Collapsible Dashboard Sidebar

```tsx
import { useState } from "react";

type SidebarItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  badge?: number;
};

type SidebarSection = {
  title?: string;
  items: SidebarItem[];
};

const SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    items: [
      {
        label: "Dashboard",
        href: "/dashboard",
        icon: (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
        ),
      },
      {
        label: "Projects",
        href: "/projects",
        icon: (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        ),
        badge: 3,
      },
    ],
  },
  {
    title: "Settings",
    items: [
      {
        label: "Team",
        href: "/settings/team",
        icon: (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        ),
      },
      {
        label: "Billing",
        href: "/settings/billing",
        icon: (
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
          </svg>
        ),
      },
    ],
  },
];

export function Sidebar({
  currentPath,
  defaultCollapsed = false,
}: {
  currentPath: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <aside
      className={`flex h-full flex-col border-r border-gray-200 bg-gray-50 transition-all duration-300
        ${collapsed ? "w-16" : "w-60"}`}
      aria-label="Sidebar navigation"
    >
      {/* Header */}
      <div className={`flex items-center border-b border-gray-200 px-3 py-4
        ${collapsed ? "justify-center" : "justify-between"}`}
      >
        {!collapsed && (
          <span className="font-bold text-gray-900 text-sm">Workspace</span>
        )}
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500
            hover:bg-gray-200 transition"
        >
          <svg
            className={`h-4 w-4 transition-transform ${collapsed ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {SIDEBAR_SECTIONS.map((section, sIdx) => (
          <div key={sIdx}>
            {section.title && !collapsed && (
              <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                {section.title}
              </p>
            )}
            <ul className="space-y-0.5" role="list">
              {section.items.map((item) => {
                const isActive = currentPath === item.href ||
                  (item.href !== "/" && currentPath.startsWith(item.href));
                return (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      title={collapsed ? item.label : undefined}
                      className={`group flex items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium
                        transition relative
                        ${isActive
                          ? "bg-blue-100 text-blue-700"
                          : "text-gray-700 hover:bg-gray-200 hover:text-gray-900"
                        }`}
                    >
                      <span className={`shrink-0 ${isActive ? "text-blue-600" : "text-gray-500 group-hover:text-gray-700"}`}>
                        {item.icon}
                      </span>
                      {!collapsed && (
                        <>
                          <span className="truncate flex-1">{item.label}</span>
                          {item.badge && (
                            <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full
                              bg-blue-600 text-xs font-bold text-white">
                              {item.badge}
                            </span>
                          )}
                        </>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className={`border-t border-gray-200 p-3 ${collapsed ? "flex justify-center" : ""}`}>
        <a
          href="/settings"
          className={`flex items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium
            text-gray-700 hover:bg-gray-200 transition`}
          title={collapsed ? "Settings" : undefined}
        >
          <svg className="h-5 w-5 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          {!collapsed && <span>Settings</span>}
        </a>
      </div>
    </aside>
  );
}
```

### 3. Breadcrumbs

```tsx
type Crumb = {
  label: string;
  href?: string;
};

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol
        role="list"
        className="flex flex-wrap items-center gap-1 text-sm"
      >
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={i} className="flex items-center gap-1">
              {i > 0 && (
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5 text-gray-400 shrink-0"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
              {isLast || !crumb.href ? (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={`font-medium truncate max-w-[180px]
                    ${isLast ? "text-gray-900" : "text-gray-500"}`}
                >
                  {crumb.label}
                </span>
              ) : (
                <a
                  href={crumb.href}
                  className="text-gray-500 hover:text-gray-900 transition truncate max-w-[180px]"
                >
                  {crumb.label}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// Usage:
// <Breadcrumbs crumbs={[
//   { label: "Home", href: "/" },
//   { label: "Projects", href: "/projects" },
//   { label: "LFG Platform" },
// ]} />
```

### 4. Mobile Hamburger Drawer

```tsx
import { useEffect } from "react";

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

export function MobileDrawer({ open, onClose, title, children }: MobileDrawerProps) {
  // Lock body scroll when drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300
          ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      />

      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? "Navigation menu"}
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-full flex-col bg-white shadow-xl
          transition-transform duration-300 ease-in-out
          ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-4">
          {title && <span className="font-semibold text-gray-900">{title}</span>}
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg
              text-gray-500 hover:bg-gray-100 transition"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </>
  );
}

// Usage:
// const [drawerOpen, setDrawerOpen] = useState(false);
// <button onClick={() => setDrawerOpen(true)}>Menu</button>
// <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Menu">
//   <nav>...</nav>
// </MobileDrawer>
```

### 5. Tab Navigation

```tsx
import { useState } from "react";

type Tab = {
  id: string;
  label: string;
  count?: number;
  content: React.ReactNode;
};

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
  variant?: "underline" | "pill";
}

export function Tabs({ tabs, defaultTab, variant = "underline" }: TabsProps) {
  const [activeId, setActiveId] = useState(defaultTab ?? tabs[0]?.id);

  const activeTab = tabs.find((t) => t.id === activeId);

  return (
    <div>
      {/* Tab list */}
      <div
        role="tablist"
        aria-label="Tabs"
        className={`flex ${variant === "underline"
          ? "border-b border-gray-200 gap-1"
          : "bg-gray-100 rounded-xl p-1 gap-1 w-fit"
        }`}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${tab.id}`}
              onClick={() => setActiveId(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition outline-none
                focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1
                ${variant === "underline"
                  ? isActive
                    ? "border-b-2 border-blue-600 text-blue-600 -mb-px"
                    : "border-b-2 border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300"
                  : isActive
                  ? "bg-white text-gray-900 shadow-sm rounded-lg"
                  : "text-gray-600 hover:text-gray-900 rounded-lg"
                }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span
                  className={`ml-1 rounded-full px-2 py-0.5 text-xs font-semibold
                    ${isActive
                      ? variant === "underline" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-700"
                      : "bg-gray-200 text-gray-600"
                    }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          hidden={tab.id !== activeId}
          className="pt-6"
        >
          {tab.id === activeId && tab.content}
        </div>
      ))}
    </div>
  );
}

// Usage:
// <Tabs
//   variant="pill"
//   tabs={[
//     { id: "overview", label: "Overview", content: <OverviewPanel /> },
//     { id: "tickets", label: "Tickets", count: 12, content: <TicketsPanel /> },
//     { id: "settings", label: "Settings", content: <SettingsPanel /> },
//   ]}
// />
```

### 6. Bottom Navigation for Mobile

```tsx
type BottomNavItem = {
  label: string;
  href: string;
  icon: (active: boolean) => React.ReactNode;
};

const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  {
    label: "Home",
    href: "/",
    icon: (active) => (
      <svg className="h-6 w-6" fill={active ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 0 : 1.5}
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    label: "Search",
    href: "/search",
    icon: (active) => (
      <svg className="h-6 w-6" fill={active ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 0 : 1.5}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
  },
  {
    label: "Create",
    href: "/new",
    icon: (active) => (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    ),
  },
  {
    label: "Profile",
    href: "/profile",
    icon: (active) => (
      <svg className="h-6 w-6" fill={active ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 0 : 1.5}
          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    ),
  },
];

export function BottomNav({ currentPath }: { currentPath: string }) {
  return (
    <nav
      aria-label="Bottom navigation"
      className="fixed bottom-0 inset-x-0 z-40 border-t border-gray-200 bg-white
        safe-bottom" // handles iPhone home bar
    >
      <ul
        role="list"
        className="flex items-stretch"
      >
        {BOTTOM_NAV_ITEMS.map((item) => {
          const isActive = currentPath === item.href ||
            (item.href !== "/" && currentPath.startsWith(item.href));

          // Special create button styling
          if (item.href === "/new") {
            return (
              <li key={item.href} className="flex-1">
                <a
                  href={item.href}
                  aria-label={item.label}
                  className="flex flex-col items-center justify-center h-16 gap-0.5 px-2 py-2"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 shadow-md text-white">
                    {item.icon(false)}
                  </div>
                </a>
              </li>
            );
          }

          return (
            <li key={item.href} className="flex-1">
              <a
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex flex-col items-center justify-center h-16 gap-0.5 px-2 py-2 transition
                  ${isActive ? "text-blue-600" : "text-gray-500"}`}
              >
                {item.icon(isActive)}
                <span className="text-xs font-medium">{item.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
```

## Common Mistakes

- **Do not use `div` for navigation** — always use semantic `<nav>` with an `aria-label` so screen readers announce the landmark
- **Do not rely on color alone for active state** — use font-weight, background, or an underline in addition to color change; color alone fails WCAG
- **Do not make tap targets smaller than 44px** — bottom nav items and sidebar links must be at least 44x44px for touch usability
- **Do not forget `aria-current="page"`** — this is how screen readers know which link is the current page; a CSS class alone does nothing for accessibility
- **Do not open a sidebar drawer without locking body scroll** — the page behind will scroll while the user tries to use the drawer
- **Do not use hover-only dropdowns** — they do not work on touch screens; always provide a click/tap toggle
- **Do not hardcode active states** — derive them from the current route; hardcoded active styles break when routes change

## Framework-Specific Notes

### Next.js

- Use `usePathname()` from `next/navigation` to get the current path for active state detection
- Use `<Link>` from `next/link` instead of `<a>` for client-side navigation — it prefetches on hover
- For layouts with a sidebar, put it in `app/layout.tsx` or a shared `layout.tsx` within the route group
- The `active` class on `<Link>` is not automatic — you must check `pathname === item.href` yourself

```tsx
"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = pathname === href;
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={isActive ? "text-blue-600 font-semibold" : "text-gray-600 hover:text-gray-900"}
    >
      {children}
    </Link>
  );
}
```

### React + Vite

- Use `useLocation()` from `react-router-dom` to get the current path
- Use `<NavLink>` from `react-router-dom` — it provides an `isActive` prop via a render function
- For protected sidebar items, wrap in your auth context check before rendering
