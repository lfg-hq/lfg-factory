# Animations & Transitions

## When to Use This

Use these patterns for any UI motion: hover effects, focus rings, enter/exit transitions, skeleton loaders, page transitions, scroll-triggered reveals, and micro-interactions. Motion should enhance usability, never distract from it.

## Quick Start

### Dependencies

```bash
npm install framer-motion
```

### Key Principles

- Always respect `prefers-reduced-motion` — wrap all non-essential animations in this media query check
- Enter animations should be fast (150–300ms); exit animations should be slightly faster (100–200ms)
- Use `ease-out` for elements entering the screen (fast start, slow end feels natural)
- Use `ease-in` for elements leaving (slow start, fast exit feels natural)
- Never animate `width`, `height`, or `margin` — they cause layout recalculations; animate `transform` and `opacity` instead
- Keep Framer Motion for complex multi-state animations; use Tailwind `transition-*` classes for simple hover/focus effects

## Patterns

### 1. CSS Transitions for Hover and Focus

```tsx
export function TransitionShowcase() {
  return (
    <div className="space-y-6 p-8">

      {/* Button hover — bg color + shadow */}
      <button className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white
        shadow-sm transition-all duration-200 ease-out
        hover:bg-blue-700 hover:shadow-md hover:-translate-y-0.5
        active:translate-y-0 active:shadow-sm
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
        Primary Button
      </button>

      {/* Card hover — lift with shadow */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6 cursor-pointer
        transition-all duration-300 ease-out
        hover:shadow-xl hover:-translate-y-1 hover:border-gray-300">
        <h3 className="font-semibold text-gray-900">Hover Card</h3>
        <p className="text-sm text-gray-500 mt-1">Lifts on hover with smooth shadow transition.</p>
      </div>

      {/* Link underline animation */}
      <a
        href="#"
        className="relative text-gray-900 font-medium no-underline
          after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-full
          after:bg-blue-600 after:scale-x-0 after:origin-left
          after:transition-transform after:duration-300 after:ease-out
          hover:after:scale-x-100"
      >
        Animated underline link
      </a>

      {/* Icon rotate on hover */}
      <button className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 transition-colors group">
        Settings
        <svg
          className="h-4 w-4 transition-transform duration-300 group-hover:rotate-90"
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {/* Input focus ring */}
      <input
        type="text"
        placeholder="Focus me"
        className="w-full max-w-sm rounded-xl border border-gray-300 px-4 py-2.5 text-sm
          outline-none ring-0 ring-blue-500 ring-offset-2
          transition-all duration-200
          focus:border-blue-500 focus:ring-2"
      />
    </div>
  );
}
```

### 2. Framer Motion Basics: animate, variants, layout

```tsx
import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";

// Always check prefers-reduced-motion
function useAnimation() {
  const reduce = useReducedMotion();
  return {
    initial: reduce ? {} : { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    exit: reduce ? {} : { opacity: 0, y: -8 },
    transition: { duration: reduce ? 0 : 0.25, ease: [0.25, 0.1, 0.25, 1] },
  };
}

// Fade + slide in on mount
export function FadeInCard({ children }: { children: React.ReactNode }) {
  const anim = useAnimation();
  return (
    <motion.div
      initial={anim.initial}
      animate={anim.animate}
      exit={anim.exit}
      transition={anim.transition}
      className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
    >
      {children}
    </motion.div>
  );
}

// Staggered list — children animate in sequence
const listVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, x: -16 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.25, ease: "easeOut" } },
};

export function StaggeredList({ items }: { items: string[] }) {
  const reduce = useReducedMotion();

  if (reduce) {
    return (
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item} className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700">{item}</li>
        ))}
      </ul>
    );
  }

  return (
    <motion.ul
      className="space-y-2"
      variants={listVariants}
      initial="hidden"
      animate="visible"
    >
      {items.map((item) => (
        <motion.li
          key={item}
          variants={itemVariants}
          className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700"
        >
          {item}
        </motion.li>
      ))}
    </motion.ul>
  );
}

// Layout animation — smooth reordering
export function SortableCards() {
  const [cards, setCards] = useState(["Alpha", "Beta", "Gamma", "Delta"]);

  const moveUp = (i: number) => {
    if (i === 0) return;
    setCards((prev) => {
      const next = [...prev];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  };

  return (
    <ul className="space-y-2">
      {cards.map((card, i) => (
        <motion.li
          key={card}
          layout // enables smooth position transition
          transition={{ duration: 0.25, ease: "easeInOut" }}
          className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3"
        >
          <span className="text-sm font-medium text-gray-900">{card}</span>
          <button
            onClick={() => moveUp(i)}
            disabled={i === 0}
            className="text-xs text-gray-500 hover:text-gray-900 disabled:opacity-30 transition"
          >
            Move up
          </button>
        </motion.li>
      ))}
    </ul>
  );
}
```

### 3. AnimatePresence for Enter/Exit

```tsx
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";

// Modal with AnimatePresence
export function AnimatedModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition"
      >
        Open Modal
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-black/50"
            />

            {/* Panel */}
            <motion.div
              key="modal"
              initial={{ opacity: 0, scale: 0.95, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
              className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2
                rounded-2xl bg-white p-6 shadow-2xl"
            >
              <h2 className="text-lg font-bold text-gray-900">Modal Title</h2>
              <p className="mt-2 text-sm text-gray-500">Modal content goes here.</p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition"
                >
                  Confirm
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

// Toast notification queue
type Toast = { id: string; message: string; type: "success" | "error" | "info" };

export function ToastStack({ toasts, onDismiss }: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  const TYPE_STYLES: Record<Toast["type"], string> = {
    success: "bg-green-600",
    error:   "bg-red-600",
    info:    "bg-gray-800",
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 32, transition: { duration: 0.15 } }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className={`pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-3
              text-sm font-medium text-white shadow-lg min-w-[280px] max-w-[360px]
              ${TYPE_STYLES[toast.type]}`}
          >
            <span className="flex-1">{toast.message}</span>
            <button
              onClick={() => onDismiss(toast.id)}
              className="opacity-70 hover:opacity-100 transition"
              aria-label="Dismiss"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
```

### 4. Scroll-Triggered Animations

```tsx
import { motion, useInView } from "framer-motion";
import { useRef } from "react";

// Hook: animate when element enters viewport
function useScrollReveal(threshold = 0.2) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: threshold });
  return { ref, inView };
}

export function ScrollRevealSection() {
  const { ref, inView } = useScrollReveal();

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="py-16 text-center"
    >
      <h2 className="text-3xl font-bold text-gray-900">Revealed on scroll</h2>
      <p className="mt-3 text-gray-500">This section fades in when it enters the viewport.</p>
    </motion.div>
  );
}

// Staggered feature grid with scroll trigger
const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 32 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
};

export function ScrollRevealGrid({ features }: {
  features: { icon: string; title: string; description: string }[]
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.15 });

  return (
    <motion.div
      ref={ref}
      variants={containerVariants}
      initial="hidden"
      animate={inView ? "visible" : "hidden"}
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6"
    >
      {features.map((feature) => (
        <motion.div
          key={feature.title}
          variants={cardVariants}
          className="rounded-2xl border border-gray-200 bg-white p-6 hover:shadow-md transition"
        >
          <div className="text-2xl mb-3">{feature.icon}</div>
          <h3 className="font-semibold text-gray-900">{feature.title}</h3>
          <p className="text-sm text-gray-500 mt-1">{feature.description}</p>
        </motion.div>
      ))}
    </motion.div>
  );
}
```

### 5. Skeleton Loaders

```tsx
// Base skeleton — reusable pulse animation
function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-gray-200 dark:bg-gray-700 ${className}`}
    />
  );
}

// Card skeleton
export function CardSkeleton() {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4" aria-busy="true" aria-label="Loading">
      {/* Avatar + name row */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="space-y-1.5 flex-1">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-6 w-16 rounded-full" />
      </div>

      {/* Text block */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
      </div>

      {/* Image placeholder */}
      <Skeleton className="h-40 w-full rounded-xl" />

      {/* Action row */}
      <div className="flex gap-2">
        <Skeleton className="h-8 flex-1 rounded-lg" />
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
    </div>
  );
}

// Text skeleton that mimics paragraph layout
export function TextSkeleton({ lines = 4 }: { lines?: number }) {
  const widths = ["w-full", "w-5/6", "w-full", "w-4/6", "w-full", "w-3/4"];
  return (
    <div className="space-y-2.5" aria-busy="true" aria-label="Loading content">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-4 ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

// Nav skeleton
export function NavSkeleton() {
  return (
    <div className="flex items-center justify-between px-6 h-16 border-b border-gray-200">
      <Skeleton className="h-8 w-24 rounded-lg" />
      <div className="flex gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-16 rounded-md" />
        ))}
      </div>
      <Skeleton className="h-9 w-24 rounded-lg" />
    </div>
  );
}

// Profile skeleton
export function ProfileSkeleton() {
  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <Skeleton className="h-24 w-24 rounded-full" />
      <div className="space-y-2 text-center">
        <Skeleton className="h-6 w-40 mx-auto" />
        <Skeleton className="h-4 w-56 mx-auto" />
        <Skeleton className="h-4 w-32 mx-auto" />
      </div>
      <div className="flex gap-3 mt-2">
        <Skeleton className="h-10 w-28 rounded-xl" />
        <Skeleton className="h-10 w-28 rounded-xl" />
      </div>
    </div>
  );
}
```

### 6. Page Transitions

```tsx
import { AnimatePresence, motion } from "framer-motion";

// Wrap your router outlet with this
const pageVariants = {
  initial: { opacity: 0, y: 8 },
  enter:   { opacity: 1, y: 0, transition: { duration: 0.25, ease: "easeOut" } },
  exit:    { opacity: 0, y: -8, transition: { duration: 0.15, ease: "easeIn" } },
};

// For React Router:
export function PageTransitionWrapper({
  children,
  routeKey,
}: {
  children: React.ReactNode;
  routeKey: string; // use location.pathname or location.key
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={routeKey}
        variants={pageVariants}
        initial="initial"
        animate="enter"
        exit="exit"
        className="w-full"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

// Slide transition for multi-step forms / wizards
export function StepTransition({
  step,
  direction,
  children,
}: {
  step: number;
  direction: "forward" | "backward";
  children: React.ReactNode;
}) {
  const xIn = direction === "forward" ? 48 : -48;
  const xOut = direction === "forward" ? -48 : 48;

  return (
    <AnimatePresence mode="wait" initial={false} custom={direction}>
      <motion.div
        key={step}
        initial={{ opacity: 0, x: xIn }}
        animate={{ opacity: 1, x: 0, transition: { duration: 0.25, ease: "easeOut" } }}
        exit={{ opacity: 0, x: xOut, transition: { duration: 0.15, ease: "easeIn" } }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
```

### 7. Micro-Interactions

```tsx
import { motion, useAnimate } from "framer-motion";
import { useState } from "react";

// Button press feedback
export function PressButton({ children, onClick }: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      transition={{ duration: 0.1 }}
      onClick={onClick}
      className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white
        hover:bg-blue-700 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 outline-none"
    >
      {children}
    </motion.button>
  );
}

// Toggle switch with spring animation
export function AnimatedToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer group">
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative flex h-6 w-11 items-center rounded-full transition-colors duration-200
          focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 outline-none
          ${checked ? "bg-blue-600" : "bg-gray-300"}`}
      >
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className={`absolute h-5 w-5 rounded-full bg-white shadow-sm
            ${checked ? "left-[22px]" : "left-0.5"}`}
        />
      </button>
      <span className="text-sm font-medium text-gray-700">{label}</span>
    </label>
  );
}

// Like button with heart burst
export function LikeButton({ initialCount = 0 }: { initialCount?: number }) {
  const [liked, setLiked] = useState(false);
  const [count, setCount] = useState(initialCount);
  const [scope, animate] = useAnimate();

  const handleLike = async () => {
    if (liked) {
      setLiked(false);
      setCount((c) => c - 1);
      return;
    }
    setLiked(true);
    setCount((c) => c + 1);
    // Burst animation
    await animate(scope.current, { scale: [1, 1.3, 0.9, 1.1, 1] }, { duration: 0.4 });
  };

  return (
    <button
      ref={scope}
      onClick={handleLike}
      aria-pressed={liked}
      aria-label={liked ? "Unlike" : "Like"}
      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition
        hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 outline-none"
    >
      <svg
        className={`h-5 w-5 transition-colors duration-200 ${liked ? "text-red-500" : "text-gray-400"}`}
        fill={liked ? "currentColor" : "none"}
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      </svg>
      <motion.span
        key={count}
        initial={{ y: liked ? -8 : 8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.2 }}
        className={liked ? "text-red-600" : "text-gray-600"}
      >
        {count}
      </motion.span>
    </button>
  );
}

// Number counter animation
export function AnimatedCounter({ value, duration = 1 }: { value: number; duration?: number }) {
  const [scope, animate] = useAnimate();

  useState(() => {
    // Animate number from 0 to value on mount
    let start = 0;
    const step = (timestamp: number) => {
      if (!start) start = timestamp;
      const progress = Math.min((timestamp - start) / (duration * 1000), 1);
      // easeOutQuart
      const eased = 1 - Math.pow(1 - progress, 4);
      if (scope.current) {
        scope.current.textContent = Math.round(eased * value).toLocaleString();
      }
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  return (
    <span
      ref={scope}
      className="tabular-nums font-bold text-gray-900"
    >
      0
    </span>
  );
}

// Expanding search bar
export function ExpandingSearch() {
  const [expanded, setExpanded] = useState(false);

  return (
    <motion.div
      animate={{ width: expanded ? 280 : 40 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      className="relative flex items-center h-10 rounded-xl bg-gray-100 overflow-hidden"
    >
      <button
        onClick={() => setExpanded((e) => !e)}
        className="absolute left-0 flex h-10 w-10 items-center justify-center shrink-0 text-gray-500 hover:text-gray-900 transition z-10"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.input
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            type="search"
            placeholder="Search..."
            autoFocus
            className="w-full bg-transparent pl-10 pr-3 text-sm outline-none text-gray-900 placeholder:text-gray-400"
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
```

### 8. Reduced Motion Handling

```tsx
import { useReducedMotion } from "framer-motion";

// Global animation config factory — respect prefers-reduced-motion
export function useMotionConfig() {
  const reduce = useReducedMotion();

  return {
    // Fade only — safe for reduced motion (no positional movement)
    fade: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: reduce ? 0.1 : 0.25 },
    },
    // Slide — disabled when reduced
    slideUp: {
      initial: { opacity: 0, y: reduce ? 0 : 16 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: reduce ? 0 : -8 },
      transition: { duration: reduce ? 0.1 : 0.3, ease: "easeOut" },
    },
    // Scale — disabled when reduced
    popIn: {
      initial: { opacity: 0, scale: reduce ? 1 : 0.9 },
      animate: { opacity: 1, scale: 1 },
      exit: { opacity: 0, scale: reduce ? 1 : 0.95 },
      transition: { duration: reduce ? 0.1 : 0.2 },
    },
    // Spring — disabled when reduced
    spring: {
      type: reduce ? "tween" : "spring",
      stiffness: 400,
      damping: 30,
      duration: reduce ? 0.1 : undefined,
    },
  };
}

// CSS-only reduced motion — add to globals.css
/*
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
*/
```

## Common Mistakes

- **Do not animate `width`, `height`, `top`, `left`, or `margin`** — these trigger layout recalculations on every frame; only animate `transform` (translate, scale, rotate) and `opacity`
- **Do not use `transition: all`** — it applies transitions to every property, including layout-triggering ones; always specify the property: `transition-colors`, `transition-transform`, etc.
- **Do not forget `AnimatePresence` for exit animations** — without it, Framer Motion elements disappear instantly when removed from the DOM
- **Do not skip `useReducedMotion`** — approximately 25% of users have motion-sensitive conditions; always check this in production apps
- **Do not make entry animations longer than 300ms** — users perceive anything longer as slow; 150–250ms is the sweet spot for most UI elements
- **Do not animate decorative elements that repeat** — parallax scrolling backgrounds, looping animations, and auto-playing carousels are the most common vestibular disorder triggers
- **Do not use `key` changes to force re-animation unless necessary** — changing keys unmounts/remounts components, which is expensive; use `animate` prop changes instead

## Framework-Specific Notes

### Next.js

- Mark any component using Framer Motion with `"use client"` — motion hooks use browser APIs
- For page transitions in the App Router, wrap individual page content (not the layout) with `AnimatePresence`; the layout persists across navigations
- Use `LazyMotion` to reduce bundle size — load only the animation features you need

```tsx
import { LazyMotion, domAnimation } from "framer-motion";

// In your root layout:
<LazyMotion features={domAnimation}>
  {children}
</LazyMotion>
```

### React + Vite

- Framer Motion works out of the box with Vite
- For route-level page transitions with React Router, use `useLocation` as the key for `AnimatePresence`

```tsx
import { useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";

export function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        {/* your routes */}
      </Routes>
    </AnimatePresence>
  );
}
```
