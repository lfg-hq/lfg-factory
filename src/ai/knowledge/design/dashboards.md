# Dashboards

## When to Use This

Use this guide when the ticket mentions any of the following:

- dashboard, admin panel, admin area
- analytics, stats, statistics, metrics, KPIs
- charts, graphs, data visualization
- sidebar layout, shell layout
- overview page, reporting page

---

## Quick Start

### Dependencies

```bash
npm install recharts lucide-react clsx
# recharts: charts (line, bar, pie, area, sparkline)
# lucide-react: icons for sidebar, stat cards, actions
# clsx: conditional classNames
```

Tailwind CSS must be configured. No additional UI library required — all components below are built from scratch with Tailwind.

### Key Principles

1. **Shell first** — Build the sidebar + header shell before adding any content. All pages share the same shell.
2. **Mobile-responsive by default** — Sidebar collapses to a drawer on small screens (`lg:` breakpoint is the cut-off).
3. **Semantic colors for trends** — Green (`text-emerald-500`) for positive, red (`text-red-500`) for negative. Never use raw colors.
4. **Always show empty states** — Every list, chart, or table must handle a zero-data state gracefully.
5. **Loading skeletons over spinners** — Use skeleton placeholders shaped like the real content, not a centered spinner.
6. **Whitespace is layout** — Use `gap-6`, `p-6`, and `space-y-4` generously. Overcrowded dashboards are unusable.

---

## Patterns

### 1. Sidebar + Header Shell Layout

Collapsible sidebar with user menu and notifications bell. The sidebar collapses to an icon-only strip on desktop and to a full-screen overlay drawer on mobile.

```tsx
// components/dashboard/Shell.tsx
"use client";

import { useState } from "react";
import {
  LayoutDashboard,
  BarChart2,
  Users,
  Settings,
  Bell,
  ChevronLeft,
  Menu,
  X,
  LogOut,
} from "lucide-react";
import clsx from "clsx";

const navItems = [
  { icon: LayoutDashboard, label: "Overview", href: "/dashboard" },
  { icon: BarChart2,       label: "Analytics", href: "/dashboard/analytics" },
  { icon: Users,           label: "Users",     href: "/dashboard/users" },
  { icon: Settings,        label: "Settings",  href: "/dashboard/settings" },
];

interface ShellProps {
  children: React.ReactNode;
  currentPath?: string;
}

export function Shell({ children, currentPath = "/dashboard" }: ShellProps) {
  const [collapsed, setCollapsed]     = useState(false);
  const [mobileOpen, setMobileOpen]   = useState(false);
  const [notifOpen, setNotifOpen]     = useState(false);

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-30 flex flex-col bg-white border-r border-gray-200 transition-all duration-200",
          "lg:relative lg:translate-x-0",
          collapsed ? "lg:w-16" : "lg:w-64",
          mobileOpen ? "w-64 translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between h-16 px-4 border-b border-gray-200 shrink-0">
          {!collapsed && (
            <span className="text-lg font-semibold text-gray-900 truncate">Acme</span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:flex items-center justify-center w-8 h-8 rounded-md text-gray-500 hover:bg-gray-100"
            aria-label="Toggle sidebar"
          >
            <ChevronLeft
              size={16}
              className={clsx("transition-transform", collapsed && "rotate-180")}
            />
          </button>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden flex items-center justify-center w-8 h-8 rounded-md text-gray-500 hover:bg-gray-100"
          >
            <X size={16} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-1">
          {navItems.map(({ icon: Icon, label, href }) => {
            const active = currentPath === href;
            return (
              <a
                key={href}
                href={href}
                className={clsx(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  active
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                )}
              >
                <Icon size={18} className="shrink-0" />
                {!collapsed && <span className="truncate">{label}</span>}
              </a>
            );
          })}
        </nav>

        {/* User section */}
        <div className="shrink-0 border-t border-gray-200 p-3">
          <div className={clsx("flex items-center gap-3", collapsed && "justify-center")}>
            <img
              src="https://ui-avatars.com/api/?name=John+Doe&background=6366f1&color=fff"
              alt="User avatar"
              className="w-8 h-8 rounded-full shrink-0"
            />
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">John Doe</p>
                <p className="text-xs text-gray-500 truncate">john@acme.com</p>
              </div>
            )}
            {!collapsed && (
              <button className="p-1 text-gray-400 hover:text-gray-600">
                <LogOut size={15} />
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between h-16 px-4 sm:px-6 bg-white border-b border-gray-200 shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden p-2 rounded-md text-gray-500 hover:bg-gray-100"
          >
            <Menu size={20} />
          </button>

          <div className="flex-1" />

          {/* Notifications bell */}
          <div className="relative">
            <button
              onClick={() => setNotifOpen(!notifOpen)}
              className="relative p-2 rounded-md text-gray-500 hover:bg-gray-100"
              aria-label="Notifications"
            >
              <Bell size={20} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
            </button>

            {notifOpen && (
              <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-lg border border-gray-200 z-50">
                <div className="p-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
                </div>
                <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                  {[
                    { title: "New user signed up", time: "2 min ago" },
                    { title: "Monthly report ready", time: "1 hr ago" },
                    { title: "Server alert resolved", time: "3 hr ago" },
                  ].map((n, i) => (
                    <li key={i} className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50">
                      <span className="mt-1.5 w-2 h-2 rounded-full bg-indigo-500 shrink-0" />
                      <div>
                        <p className="text-sm text-gray-800">{n.title}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{n.time}</p>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="p-3 border-t border-gray-100 text-center">
                  <a href="#" className="text-xs text-indigo-600 hover:underline">View all</a>
                </div>
              </div>
            )}
          </div>

          {/* User avatar in header */}
          <img
            src="https://ui-avatars.com/api/?name=John+Doe&background=6366f1&color=fff"
            alt="User"
            className="ml-3 w-8 h-8 rounded-full cursor-pointer"
          />
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
```

---

### 2. Stat Cards

Icon, value, label, and trend indicator with up/down arrow and percentage.

```tsx
// components/dashboard/StatCard.tsx
import { TrendingUp, TrendingDown } from "lucide-react";
import clsx from "clsx";

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ElementType;
  iconColor?: string;    // e.g. "text-indigo-600"
  iconBg?: string;       // e.g. "bg-indigo-50"
  trend?: number;        // positive = up, negative = down, undefined = no trend
  trendLabel?: string;   // e.g. "vs last month"
  loading?: boolean;
}

export function StatCard({
  label,
  value,
  icon: Icon,
  iconColor = "text-indigo-600",
  iconBg = "bg-indigo-50",
  trend,
  trendLabel = "vs last period",
  loading = false,
}: StatCardProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6 animate-pulse">
        <div className="flex items-start justify-between">
          <div className="h-10 w-10 bg-gray-200 rounded-xl" />
          <div className="h-4 w-16 bg-gray-200 rounded" />
        </div>
        <div className="mt-4 h-7 w-24 bg-gray-200 rounded" />
        <div className="mt-1 h-4 w-20 bg-gray-200 rounded" />
      </div>
    );
  }

  const isPositive = trend !== undefined && trend >= 0;
  const isNegative = trend !== undefined && trend < 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between">
        <div className={clsx("p-2.5 rounded-xl", iconBg)}>
          <Icon size={20} className={iconColor} />
        </div>

        {trend !== undefined && (
          <span
            className={clsx(
              "flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full",
              isPositive ? "text-emerald-700 bg-emerald-50" : "text-red-700 bg-red-50"
            )}
          >
            {isPositive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>

      <div className="mt-4">
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        <p className="text-sm text-gray-500 mt-0.5">{label}</p>
        {trend !== undefined && (
          <p className="text-xs text-gray-400 mt-1">{trendLabel}</p>
        )}
      </div>
    </div>
  );
}

// Usage
import { Users, DollarSign, ShoppingCart, Activity } from "lucide-react";

export function StatsRow() {
  const stats = [
    { label: "Total Revenue",  value: "$45,231",   icon: DollarSign,   iconColor: "text-emerald-600", iconBg: "bg-emerald-50",  trend: 20.1 },
    { label: "Active Users",   value: "2,350",      icon: Users,        iconColor: "text-blue-600",    iconBg: "bg-blue-50",     trend: 15.3 },
    { label: "New Orders",     value: "1,247",      icon: ShoppingCart, iconColor: "text-violet-600",  iconBg: "bg-violet-50",   trend: -4.5 },
    { label: "Uptime",         value: "99.9%",      icon: Activity,     iconColor: "text-orange-600",  iconBg: "bg-orange-50",   trend: 0.1  },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {stats.map((s) => (
        <StatCard key={s.label} {...s} />
      ))}
    </div>
  );
}
```

---

### 3. Charts (Line, Bar, Pie/Donut using Recharts)

Always wrap charts in a loading skeleton and an empty state check.

```tsx
// components/dashboard/Charts.tsx
"use client";

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// --- Shared skeleton ---
function ChartSkeleton() {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 animate-pulse">
      <div className="h-5 w-32 bg-gray-200 rounded mb-6" />
      <div className="h-48 bg-gray-100 rounded-xl" />
    </div>
  );
}

// --- Line Chart ---
const lineData = [
  { month: "Jan", revenue: 4000, expenses: 2400 },
  { month: "Feb", revenue: 3000, expenses: 1398 },
  { month: "Mar", revenue: 6000, expenses: 5000 },
  { month: "Apr", revenue: 8000, expenses: 3908 },
  { month: "May", revenue: 5000, expenses: 4800 },
  { month: "Jun", revenue: 9000, expenses: 3800 },
];

export function RevenueLineChart({ loading = false }: { loading?: boolean }) {
  if (loading) return <ChartSkeleton />;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-6">Revenue vs Expenses</h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={lineData} margin={{ top: 0, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="revenue"  stroke="#6366f1" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="expenses" stroke="#f43f5e" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// --- Bar Chart ---
const barData = [
  { day: "Mon", value: 120 },
  { day: "Tue", value: 230 },
  { day: "Wed", value: 180 },
  { day: "Thu", value: 340 },
  { day: "Fri", value: 270 },
  { day: "Sat", value: 90  },
  { day: "Sun", value: 60  },
];

export function WeeklyBarChart({ loading = false }: { loading?: boolean }) {
  if (loading) return <ChartSkeleton />;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-6">Weekly Sign-ups</h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={barData} margin={{ top: 0, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: 12 }}
            cursor={{ fill: "#f9fafb" }}
          />
          <Bar dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// --- Donut / Pie Chart ---
const pieData = [
  { name: "Organic",   value: 400, color: "#6366f1" },
  { name: "Paid",      value: 300, color: "#8b5cf6" },
  { name: "Referral",  value: 200, color: "#a78bfa" },
  { name: "Social",    value: 100, color: "#c4b5fd" },
];

export function TrafficDonutChart({ loading = false }: { loading?: boolean }) {
  if (loading) return <ChartSkeleton />;

  const total = pieData.reduce((s, d) => s + d.value, 0);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Traffic Sources</h3>
      <div className="flex items-center gap-6">
        <div className="relative">
          <ResponsiveContainer width={140} height={140}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={65}
                paddingAngle={3}
                dataKey="value"
                strokeWidth={0}
              >
                {pieData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-xl font-bold text-gray-900">{total}</span>
            <span className="text-xs text-gray-400">total</span>
          </div>
        </div>

        <ul className="flex-1 space-y-2">
          {pieData.map((d) => (
            <li key={d.name} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
                <span className="text-gray-600">{d.name}</span>
              </div>
              <span className="font-medium text-gray-900">
                {Math.round((d.value / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

---

### 4. Activity Feed / Recent Items List

Avatar, action text, and relative timestamp. Good for recent transactions, events, or audit logs.

```tsx
// components/dashboard/ActivityFeed.tsx
import { formatDistanceToNow } from "date-fns";  // or implement manually

interface ActivityItem {
  id: string;
  user: {
    name: string;
    avatar?: string;
  };
  action: string;
  target?: string;
  timestamp: Date;
  type?: "create" | "update" | "delete" | "login";
}

const typeColors: Record<string, string> = {
  create: "bg-emerald-500",
  update: "bg-blue-500",
  delete: "bg-red-500",
  login:  "bg-gray-400",
};

function ActivityRow({ item }: { item: ActivityItem }) {
  const initials = item.user.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
  const dotColor = item.type ? typeColors[item.type] : "bg-gray-400";

  return (
    <li className="flex items-start gap-3 py-3">
      {/* Avatar */}
      {item.user.avatar ? (
        <img src={item.user.avatar} alt={item.user.name} className="w-8 h-8 rounded-full shrink-0 mt-0.5" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5">
          {initials}
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-800">
          <span className="font-medium">{item.user.name}</span>{" "}
          <span className="text-gray-500">{item.action}</span>{" "}
          {item.target && <span className="font-medium text-gray-800">{item.target}</span>}
        </p>
        <p className="text-xs text-gray-400 mt-0.5">
          {formatDistanceToNow(item.timestamp, { addSuffix: true })}
        </p>
      </div>

      <span className={`mt-2 w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
    </li>
  );
}

interface ActivityFeedProps {
  items: ActivityItem[];
  loading?: boolean;
}

export function ActivityFeed({ items, loading = false }: ActivityFeedProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6 animate-pulse space-y-4">
        <div className="h-5 w-28 bg-gray-200 rounded" />
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex gap-3">
            <div className="w-8 h-8 bg-gray-200 rounded-full shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 bg-gray-200 rounded w-3/4" />
              <div className="h-3 bg-gray-100 rounded w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-900">Recent Activity</h3>
        <a href="#" className="text-xs text-indigo-600 hover:underline">View all</a>
      </div>

      {items.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-gray-400">No recent activity</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

// Example data
export const sampleActivity: ActivityItem[] = [
  { id: "1", user: { name: "Sarah Chen"  }, action: "created project",  target: "Q1 Roadmap",     timestamp: new Date(Date.now() - 2 * 60 * 1000),       type: "create" },
  { id: "2", user: { name: "James Park"  }, action: "updated",          target: "Design System",  timestamp: new Date(Date.now() - 18 * 60 * 1000),      type: "update" },
  { id: "3", user: { name: "Maria Lopez" }, action: "deleted",          target: "Draft #4",       timestamp: new Date(Date.now() - 60 * 60 * 1000),      type: "delete" },
  { id: "4", user: { name: "Tom Wright"  }, action: "logged in",                                  timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000),   type: "login"  },
];
```

---

### 5. Sparkline Cards (Data Overview with Mini Chart)

Small inline line or area chart inside a stat card for trend context.

```tsx
// components/dashboard/SparklineCard.tsx
"use client";

import { AreaChart, Area, ResponsiveContainer } from "recharts";
import clsx from "clsx";

interface SparklineCardProps {
  label: string;
  value: string;
  change: number;
  data: { v: number }[];
  color?: string;   // hex, e.g. "#6366f1"
}

export function SparklineCard({
  label,
  value,
  change,
  data,
  color = "#6366f1",
}: SparklineCardProps) {
  const positive = change >= 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
        </div>
        <span
          className={clsx(
            "text-xs font-semibold px-2 py-0.5 rounded-full",
            positive ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
          )}
        >
          {positive ? "+" : ""}{change}%
        </span>
      </div>

      <ResponsiveContainer width="100%" height={48}>
        <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0}    />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#grad-${label})`}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Usage
function SparklineRow() {
  const generate = (base: number) =>
    Array.from({ length: 12 }, (_, i) => ({ v: base + Math.random() * 40 - 20 + i * 3 }));

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <SparklineCard label="Page Views"    value="128.4K" change={12.5}  data={generate(100)} color="#6366f1" />
      <SparklineCard label="Conversions"   value="3.2%"   change={-1.8}  data={generate(60)}  color="#f43f5e" />
      <SparklineCard label="Avg Session"   value="4m 12s" change={8.0}   data={generate(80)}  color="#10b981" />
      <SparklineCard label="Bounce Rate"   value="42.1%"  change={-3.2}  data={generate(50)}  color="#f59e0b" />
    </div>
  );
}
```

---

### 6. Quick Actions Panel

Buttons for common primary actions, typically shown near the top of a dashboard.

```tsx
// components/dashboard/QuickActions.tsx
import { Plus, Download, Share2, RefreshCw } from "lucide-react";

interface Action {
  label: string;
  icon: React.ElementType;
  onClick: () => void;
  variant?: "primary" | "secondary";
}

export function QuickActions({ actions }: { actions: Action[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map(({ label, icon: Icon, onClick, variant = "secondary" }) => (
        <button
          key={label}
          onClick={onClick}
          className={
            variant === "primary"
              ? "inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
              : "inline-flex items-center gap-2 px-4 py-2 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
          }
        >
          <Icon size={15} />
          {label}
        </button>
      ))}
    </div>
  );
}

// Usage
export function DashboardHeader() {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Overview</h1>
        <p className="text-sm text-gray-500 mt-0.5">Welcome back — here's what's happening.</p>
      </div>
      <QuickActions
        actions={[
          { label: "Refresh",   icon: RefreshCw, onClick: () => window.location.reload(), variant: "secondary" },
          { label: "Export",    icon: Download,  onClick: () => console.log("export"),    variant: "secondary" },
          { label: "New Report",icon: Plus,      onClick: () => console.log("new"),       variant: "primary"   },
        ]}
      />
    </div>
  );
}
```

---

### 7. Full KPI Dashboard Layout

Assembles stat cards, sparklines, charts, and activity feed into a complete page. Drop this inside `<Shell>`.

```tsx
// app/dashboard/page.tsx  (Next.js app router)
// pages/dashboard.tsx     (Next.js pages router / Vite)
"use client";

import { useState, useEffect } from "react";
import { Shell }            from "@/components/dashboard/Shell";
import { StatsRow }         from "@/components/dashboard/StatCard";
import { SparklineRow }     from "@/components/dashboard/SparklineCard";
import { RevenueLineChart,
         WeeklyBarChart,
         TrafficDonutChart } from "@/components/dashboard/Charts";
import { ActivityFeed,
         sampleActivity }   from "@/components/dashboard/ActivityFeed";
import { DashboardHeader }  from "@/components/dashboard/QuickActions";

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate data fetch
    const t = setTimeout(() => setLoading(false), 1200);
    return () => clearTimeout(t);
  }, []);

  return (
    <Shell currentPath="/dashboard">
      <DashboardHeader />

      {/* Row 1: stat cards */}
      <StatsRow />

      {/* Row 2: sparklines */}
      <div className="mt-4">
        <SparklineRow />
      </div>

      {/* Row 3: main charts */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <RevenueLineChart loading={loading} />
        </div>
        <TrafficDonutChart loading={loading} />
      </div>

      {/* Row 4: bar chart + activity feed */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WeeklyBarChart loading={loading} />
        <ActivityFeed items={loading ? [] : sampleActivity} loading={loading} />
      </div>
    </Shell>
  );
}
```

---

### 8. Settings / Profile Page Layout

Two-column settings layout with a left navigation list and right content panel.

```tsx
// components/dashboard/SettingsLayout.tsx
"use client";

import { useState } from "react";
import { User, Bell, Shield, CreditCard, Link } from "lucide-react";
import clsx from "clsx";

const sections = [
  { id: "profile",        label: "Profile",       icon: User       },
  { id: "notifications",  label: "Notifications", icon: Bell       },
  { id: "security",       label: "Security",      icon: Shield     },
  { id: "billing",        label: "Billing",       icon: CreditCard },
  { id: "integrations",   label: "Integrations",  icon: Link       },
];

export function SettingsLayout() {
  const [active, setActive] = useState("profile");

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage your account preferences.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-6">
        {/* Sidebar nav */}
        <nav className="sm:w-48 shrink-0">
          <ul className="space-y-1">
            {sections.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  onClick={() => setActive(id)}
                  className={clsx(
                    "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors",
                    active === id
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-gray-600 hover:bg-gray-100"
                  )}
                >
                  <Icon size={16} className="shrink-0" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Content panel */}
        <div className="flex-1 bg-white rounded-2xl border border-gray-200 p-6">
          {active === "profile"  && <ProfileSection />}
          {active === "notifications" && <NotificationsSection />}
          {active === "security" && <SecuritySection />}
          {active === "billing"  && <BillingSection />}
          {active === "integrations" && <IntegrationsSection />}
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 py-4 border-b border-gray-100 last:border-0">
      <div>
        <p className="text-sm font-medium text-gray-800">{label}</p>
        {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <div className="sm:col-span-2">{children}</div>
    </div>
  );
}

function ProfileSection() {
  return (
    <div>
      <h2 className="text-base font-semibold text-gray-900 mb-4">Profile</h2>

      {/* Avatar upload */}
      <div className="flex items-center gap-4 mb-6 pb-6 border-b border-gray-100">
        <img
          src="https://ui-avatars.com/api/?name=John+Doe&background=6366f1&color=fff"
          alt="Avatar"
          className="w-16 h-16 rounded-full"
        />
        <div>
          <button className="text-sm text-indigo-600 font-medium hover:underline">Change photo</button>
          <p className="text-xs text-gray-400 mt-1">JPG, PNG or GIF. Max 2MB.</p>
        </div>
      </div>

      <FieldRow label="Full name">
        <input
          type="text"
          defaultValue="John Doe"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </FieldRow>

      <FieldRow label="Email" hint="We'll send notifications here.">
        <input
          type="email"
          defaultValue="john@acme.com"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </FieldRow>

      <FieldRow label="Timezone">
        <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white">
          <option>UTC (GMT+0)</option>
          <option>Eastern Time (GMT-5)</option>
          <option>Pacific Time (GMT-8)</option>
        </select>
      </FieldRow>

      <div className="mt-6 flex justify-end">
        <button className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
          Save changes
        </button>
      </div>
    </div>
  );
}

function NotificationsSection() {
  const [email, setEmail]  = useState(true);
  const [push, setPush]    = useState(false);
  const [digest, setDigest]= useState(true);

  const Toggle = ({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) => (
    <button
      onClick={() => onChange(!value)}
      className={clsx(
        "relative w-10 h-5 rounded-full transition-colors focus:outline-none",
        value ? "bg-indigo-600" : "bg-gray-200"
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
          value && "translate-x-5"
        )}
      />
    </button>
  );

  return (
    <div>
      <h2 className="text-base font-semibold text-gray-900 mb-4">Notifications</h2>
      <FieldRow label="Email notifications" hint="Get notified by email for important events.">
        <Toggle value={email} onChange={setEmail} />
      </FieldRow>
      <FieldRow label="Push notifications" hint="Receive browser push notifications.">
        <Toggle value={push} onChange={setPush} />
      </FieldRow>
      <FieldRow label="Weekly digest" hint="A summary of your activity each week.">
        <Toggle value={digest} onChange={setDigest} />
      </FieldRow>
    </div>
  );
}

function SecuritySection() {
  return (
    <div>
      <h2 className="text-base font-semibold text-gray-900 mb-4">Security</h2>
      <FieldRow label="Current password">
        <input type="password" placeholder="••••••••" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
      </FieldRow>
      <FieldRow label="New password">
        <input type="password" placeholder="••••••••" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
      </FieldRow>
      <FieldRow label="Confirm new password">
        <input type="password" placeholder="••••••••" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
      </FieldRow>
      <div className="mt-6 flex justify-end">
        <button className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
          Update password
        </button>
      </div>
    </div>
  );
}

function BillingSection() {
  return (
    <div>
      <h2 className="text-base font-semibold text-gray-900 mb-4">Billing</h2>
      <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 flex items-start gap-3 mb-6">
        <div className="flex-1">
          <p className="text-sm font-semibold text-indigo-900">Pro Plan — $49/mo</p>
          <p className="text-xs text-indigo-600 mt-0.5">Renews on April 1, 2026</p>
        </div>
        <button className="text-xs text-indigo-700 font-medium border border-indigo-300 px-3 py-1 rounded-lg hover:bg-indigo-100 transition-colors">
          Manage
        </button>
      </div>
      <FieldRow label="Payment method" hint="Card on file.">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-gray-700">•••• •••• •••• 4242</span>
          <span className="text-xs text-gray-400">Visa</span>
          <button className="ml-auto text-xs text-indigo-600 hover:underline">Update</button>
        </div>
      </FieldRow>
    </div>
  );
}

function IntegrationsSection() {
  const integrations = [
    { name: "GitHub",  connected: true,  description: "Sync repositories and issues." },
    { name: "Slack",   connected: false, description: "Send alerts to Slack channels."  },
    { name: "Zapier",  connected: false, description: "Automate workflows with 5000+ apps." },
  ];

  return (
    <div>
      <h2 className="text-base font-semibold text-gray-900 mb-4">Integrations</h2>
      <ul className="space-y-3">
        {integrations.map(({ name, connected, description }) => (
          <li key={name} className="flex items-center gap-4 p-4 border border-gray-200 rounded-xl">
            <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-sm font-bold text-gray-600">
              {name[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">{name}</p>
              <p className="text-xs text-gray-400 truncate">{description}</p>
            </div>
            <button
              className={clsx(
                "shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors",
                connected
                  ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  : "bg-indigo-600 text-white hover:bg-indigo-700"
              )}
            >
              {connected ? "Disconnect" : "Connect"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

## Common Mistakes

- **Sidebar not collapsible on mobile** — Always add a mobile overlay drawer using `fixed inset-0` with a backdrop. The sidebar should start as `hidden` and slide in via `translate-x-0` when `mobileOpen` is true. Use the `lg:` breakpoint as the cut-off where the sidebar is always visible.

- **Charts without loading states** — `recharts` renders with zero height if the parent has no size during first render. Always show a skeleton placeholder and only render `<ResponsiveContainer>` after data is available. Use `animate-pulse` for skeleton shapes that match the chart dimensions.

- **No empty states for data sections** — Every list, table, and chart must have a zero-state: a short message and optional CTA. Returning `null` or an empty container leaves confusing blank space.

- **Not using semantic colors for trends** — Always use `text-emerald-*` / `bg-emerald-*` for positive trends and `text-red-*` / `bg-red-*` for negative. Never use blue or gray for trend indicators as they carry no semantic meaning.

- **Overcrowded layouts without whitespace** — Use `gap-4` or `gap-6` between grid cells. Sections should have `mb-6` spacing. Cards need at least `p-5` or `p-6` internal padding. Cramped dashboards are the most common visual complaint.

- **Forgetting `min-w-0` on flex children** — Text inside flex containers will overflow unless you add `min-w-0` to the flex child and `truncate` to the text element. This is especially important for sidebar nav labels and user names.

- **Using pixel widths for the chart wrapper** — `ResponsiveContainer` requires a parent with a defined width. Always place it inside a `div` with `w-full` or a fixed width. Avoid placing it directly inside a flex item without `flex-1 min-w-0`.

---

## Framework-Specific Notes

### Next.js (App Router Layouts)

Use a shared layout file to wrap all dashboard routes with the shell, avoiding prop drilling and re-rendering:

```tsx
// app/dashboard/layout.tsx
import { Shell } from "@/components/dashboard/Shell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}
```

For active link highlighting, import `usePathname` from `next/navigation` inside the `Shell` component:

```tsx
"use client";
import { usePathname } from "next/navigation";

// Inside Shell:
const pathname = usePathname();
// Pass to navItems comparison:
const active = pathname === href || pathname.startsWith(href + "/");
```

For navigation links, replace `<a href>` with Next.js `<Link href>` to get client-side navigation:

```tsx
import Link from "next/link";
// Replace: <a href={href} ...>
// With:    <Link href={href} ...>
```

Mark the shell as `"use client"` because it uses `useState` for sidebar collapse state.

### React + Vite

Use `react-router-dom` for routing. Wrap routes in a layout component:

```tsx
// App.tsx
import { Routes, Route } from "react-router-dom";
import { Shell }         from "./components/dashboard/Shell";
import { DashboardPage } from "./pages/Dashboard";
import { AnalyticsPage } from "./pages/Analytics";

function DashboardLayout() {
  return (
    <Shell>
      <Routes>
        <Route index       element={<DashboardPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/dashboard/*" element={<DashboardLayout />} />
    </Routes>
  );
}
```

For active link detection, use the `useLocation` hook from `react-router-dom`:

```tsx
import { useLocation, Link } from "react-router-dom";

const { pathname } = useLocation();
const active = pathname === href;
```

Replace all `<a href>` tags in the sidebar nav with `<Link to={href}>` for client-side routing without full page reloads.
