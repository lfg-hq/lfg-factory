# Landing Pages

## When to Use This

Use this article when the ticket mentions any of the following:
- Landing page, marketing page, home page
- Hero section, above the fold
- CTA (call to action), conversion
- Pricing section, pricing table, plans
- Testimonials, social proof, reviews
- Features section, feature grid
- FAQ, accordion
- Footer, newsletter signup
- Stats, metrics, numbers section

---

## Quick Start

### Dependencies

```bash
# Core — Tailwind CSS (required)
npm install tailwindcss @tailwindcss/typography
npx tailwindcss init

# Animation (optional but recommended)
npm install framer-motion

# Icons
npm install lucide-react

# Forms / email capture
npm install react-hook-form zod @hookform/resolvers
```

`tailwind.config.ts`:
```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
```

### Key Principles

1. **One primary CTA per section** — don't split attention
2. **Mobile-first** — design for 375px width first, expand with `md:` and `lg:` prefixes
3. **Visual hierarchy** — headline > subheadline > CTA > supporting copy
4. **Social proof above the fold** — logos, star ratings, or user counts near the hero
5. **Fast perceived load** — use `aspect-ratio` placeholders, avoid layout shift
6. **Contrast for CTAs** — primary button must pass WCAG AA contrast against its background
7. **Consistent spacing** — use `py-16 md:py-24` for section padding throughout the page

---

## Patterns

### 1. Hero Section

Full-width hero with headline, subheadline, dual CTAs, and an optional product screenshot or illustration.

```tsx
// components/HeroSection.tsx
import { ArrowRight } from "lucide-react";

export function HeroSection() {
  return (
    <section className="relative overflow-hidden bg-white dark:bg-gray-950">
      {/* Gradient background blob */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-40 -z-10 transform-gpu overflow-hidden blur-3xl sm:-top-80"
      >
        <div
          className="relative left-[calc(50%-11rem)] aspect-[1155/678] w-[36.125rem] -translate-x-1/2 rotate-[30deg] bg-gradient-to-tr from-violet-500 to-indigo-400 opacity-20 sm:left-[calc(50%-30rem)] sm:w-[72.1875rem]"
          style={{
            clipPath:
              "polygon(74.1% 44.1%, 100% 61.6%, 97.5% 26.9%, 85.5% 0.1%, 80.7% 2%, 72.5% 32.5%, 60.2% 62.4%, 52.4% 68.1%, 47.5% 58.3%, 45.2% 34.5%, 27.5% 76.7%, 0.1% 64.9%, 17.9% 100%, 27.6% 76.8%, 76.1% 97.7%, 74.1% 44.1%)",
          }}
        />
      </div>

      <div className="mx-auto max-w-7xl px-6 pb-24 pt-16 sm:pb-32 lg:flex lg:px-8 lg:py-40">
        {/* Text column */}
        <div className="mx-auto max-w-2xl flex-shrink-0 lg:mx-0 lg:max-w-xl lg:pt-8">
          {/* Social proof badge */}
          <div className="mt-24 sm:mt-32 lg:mt-16">
            <a href="#" className="inline-flex space-x-6">
              <span className="rounded-full bg-indigo-600/10 px-3 py-1 text-sm font-semibold leading-6 text-indigo-600 ring-1 ring-inset ring-indigo-600/10 dark:bg-indigo-400/10 dark:text-indigo-400 dark:ring-indigo-400/20">
                What's new
              </span>
              <span className="inline-flex items-center space-x-2 text-sm font-medium leading-6 text-gray-600 dark:text-gray-300">
                <span>Just shipped v2.0</span>
                <ArrowRight className="h-4 w-4 text-gray-400" />
              </span>
            </a>
          </div>

          <h1 className="mt-10 text-4xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-6xl">
            Deploy your app{" "}
            <span className="text-indigo-600 dark:text-indigo-400">
              faster than ever
            </span>
          </h1>

          <p className="mt-6 text-lg leading-8 text-gray-600 dark:text-gray-300">
            Stop wrestling with infrastructure. Focus on building great products.
            Our platform handles deployments, scaling, and monitoring so you can
            ship with confidence.
          </p>

          {/* CTAs */}
          <div className="mt-10 flex items-center gap-x-6">
            <a
              href="#"
              className="rounded-md bg-indigo-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 transition-colors"
            >
              Get started free
            </a>
            <a
              href="#"
              className="text-sm font-semibold leading-6 text-gray-900 dark:text-white hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
            >
              Live demo <span aria-hidden="true">→</span>
            </a>
          </div>

          {/* Trust signals */}
          <p className="mt-6 text-xs text-gray-500 dark:text-gray-400">
            No credit card required · Free forever plan · Cancel anytime
          </p>
        </div>

        {/* Image / screenshot column */}
        <div className="mx-auto mt-16 flex max-w-2xl sm:mt-24 lg:ml-10 lg:mr-0 lg:mt-0 lg:max-w-none lg:flex-none xl:ml-32">
          <div className="max-w-3xl flex-none sm:max-w-5xl lg:max-w-none">
            <div className="-m-2 rounded-xl bg-gray-900/5 p-2 ring-1 ring-inset ring-gray-900/10 dark:bg-white/5 dark:ring-white/10 lg:-m-4 lg:rounded-2xl lg:p-4">
              <img
                src="/app-screenshot.png"
                alt="App screenshot"
                width={2432}
                height={1442}
                className="w-[76rem] rounded-md shadow-2xl ring-1 ring-gray-900/10 dark:ring-white/10"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
```

---

### 2. Feature Grid

Three-column card grid with icon, title, and description. Collapses to single column on mobile.

```tsx
// components/FeatureGrid.tsx
import {
  Zap,
  Shield,
  BarChart3,
  Globe,
  Code2,
  HeartHandshake,
  type LucideIcon,
} from "lucide-react";

interface Feature {
  name: string;
  description: string;
  icon: LucideIcon;
}

const features: Feature[] = [
  {
    name: "Lightning fast",
    description:
      "Deploy in seconds with our optimized build pipeline. Zero cold starts on the free plan.",
    icon: Zap,
  },
  {
    name: "Enterprise security",
    description:
      "SOC2 Type II certified. End-to-end encryption. SSO with SAML 2.0 and OIDC.",
    icon: Shield,
  },
  {
    name: "Real-time analytics",
    description:
      "Track performance, errors, and user behavior from a single dashboard.",
    icon: BarChart3,
  },
  {
    name: "Global edge network",
    description:
      "Serve users from 200+ locations worldwide. Sub-50ms latency anywhere.",
    icon: Globe,
  },
  {
    name: "Any framework",
    description:
      "Next.js, Remix, SvelteKit, Astro, or plain HTML. We run it all.",
    icon: Code2,
  },
  {
    name: "24/7 support",
    description:
      "Talk to a real engineer whenever you need help. Average response time: 4 minutes.",
    icon: HeartHandshake,
  },
];

export function FeatureGrid() {
  return (
    <section className="bg-white dark:bg-gray-950 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        {/* Section header */}
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-base font-semibold leading-7 text-indigo-600 dark:text-indigo-400">
            Everything you need
          </h2>
          <p className="mt-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
            Built for teams that move fast
          </p>
          <p className="mt-6 text-lg leading-8 text-gray-600 dark:text-gray-300">
            Stop stitching together tools. Get everything in one platform
            designed for modern development workflows.
          </p>
        </div>

        {/* Grid */}
        <div className="mx-auto mt-16 max-w-2xl sm:mt-20 lg:mt-24 lg:max-w-none">
          <dl className="grid max-w-xl grid-cols-1 gap-x-8 gap-y-16 lg:max-w-none lg:grid-cols-3">
            {features.map((feature) => (
              <div key={feature.name} className="flex flex-col">
                <dt className="flex items-center gap-x-3 text-base font-semibold leading-7 text-gray-900 dark:text-white">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-600">
                    <feature.icon
                      className="h-5 w-5 text-white"
                      aria-hidden="true"
                    />
                  </div>
                  {feature.name}
                </dt>
                <dd className="mt-4 flex flex-auto flex-col text-base leading-7 text-gray-600 dark:text-gray-300">
                  <p className="flex-auto">{feature.description}</p>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
```

---

### 3. Pricing Table

Three-tier pricing with monthly/annual toggle, popular plan highlighted, and feature checklist.

```tsx
// components/PricingTable.tsx
"use client";
import { useState } from "react";
import { Check } from "lucide-react";

interface Plan {
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  description: string;
  features: string[];
  cta: string;
  popular?: boolean;
}

const plans: Plan[] = [
  {
    name: "Starter",
    monthlyPrice: 0,
    annualPrice: 0,
    description: "Perfect for side projects and learning.",
    features: [
      "3 projects",
      "100 GB bandwidth",
      "1 team member",
      "Community support",
      "Basic analytics",
    ],
    cta: "Get started free",
  },
  {
    name: "Pro",
    monthlyPrice: 29,
    annualPrice: 19,
    description: "For growing teams shipping production apps.",
    features: [
      "Unlimited projects",
      "1 TB bandwidth",
      "10 team members",
      "Priority support",
      "Advanced analytics",
      "Custom domains",
      "SSO",
    ],
    cta: "Start free trial",
    popular: true,
  },
  {
    name: "Enterprise",
    monthlyPrice: 99,
    annualPrice: 79,
    description: "Dedicated infrastructure for large organizations.",
    features: [
      "Everything in Pro",
      "Unlimited bandwidth",
      "Unlimited team members",
      "Dedicated support engineer",
      "SLA guarantee",
      "Custom contracts",
      "On-prem option",
    ],
    cta: "Contact sales",
  },
];

export function PricingTable() {
  const [annual, setAnnual] = useState(false);

  return (
    <section className="bg-gray-50 dark:bg-gray-900 py-24 sm:py-32" id="pricing">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        {/* Header */}
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
            Simple, transparent pricing
          </h2>
          <p className="mt-6 text-lg leading-8 text-gray-600 dark:text-gray-300">
            Start free. Upgrade when you need to. No hidden fees.
          </p>
        </div>

        {/* Toggle */}
        <div className="mt-10 flex items-center justify-center gap-x-4">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Monthly
          </span>
          <button
            onClick={() => setAnnual(!annual)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 ${
              annual ? "bg-indigo-600" : "bg-gray-200 dark:bg-gray-700"
            }`}
            role="switch"
            aria-checked={annual}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                annual ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Annual
            <span className="ml-1.5 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-400">
              Save 35%
            </span>
          </span>
        </div>

        {/* Cards */}
        <div className="mx-auto mt-16 grid max-w-lg grid-cols-1 gap-8 lg:max-w-none lg:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`flex flex-col rounded-3xl p-8 ring-1 ${
                plan.popular
                  ? "bg-indigo-600 ring-indigo-600"
                  : "bg-white ring-gray-200 dark:bg-gray-800 dark:ring-gray-700"
              }`}
            >
              {plan.popular && (
                <div className="mb-4">
                  <span className="rounded-full bg-indigo-400/10 px-3 py-1 text-xs font-semibold leading-5 text-white ring-1 ring-inset ring-indigo-400/30">
                    Most popular
                  </span>
                </div>
              )}

              <h3
                className={`text-lg font-semibold leading-8 ${
                  plan.popular
                    ? "text-white"
                    : "text-gray-900 dark:text-white"
                }`}
              >
                {plan.name}
              </h3>

              <p
                className={`mt-4 text-sm leading-6 ${
                  plan.popular ? "text-indigo-200" : "text-gray-600 dark:text-gray-300"
                }`}
              >
                {plan.description}
              </p>

              <p className="mt-6 flex items-baseline gap-x-1">
                <span
                  className={`text-4xl font-bold tracking-tight ${
                    plan.popular ? "text-white" : "text-gray-900 dark:text-white"
                  }`}
                >
                  ${annual ? plan.annualPrice : plan.monthlyPrice}
                </span>
                {(annual ? plan.annualPrice : plan.monthlyPrice) > 0 && (
                  <span
                    className={`text-sm font-semibold leading-6 ${
                      plan.popular ? "text-indigo-200" : "text-gray-600 dark:text-gray-400"
                    }`}
                  >
                    /month
                  </span>
                )}
              </p>

              <a
                href="#"
                className={`mt-6 block rounded-md px-3 py-2 text-center text-sm font-semibold leading-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 transition-colors ${
                  plan.popular
                    ? "bg-white text-indigo-600 hover:bg-indigo-50 focus-visible:outline-white"
                    : "bg-indigo-600 text-white hover:bg-indigo-500 focus-visible:outline-indigo-600"
                }`}
              >
                {plan.cta}
              </a>

              <ul
                role="list"
                className={`mt-8 space-y-3 text-sm leading-6 ${
                  plan.popular ? "text-indigo-200" : "text-gray-600 dark:text-gray-300"
                }`}
              >
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-x-3">
                    <Check
                      className={`h-5 w-5 flex-shrink-0 ${
                        plan.popular ? "text-white" : "text-indigo-600 dark:text-indigo-400"
                      }`}
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
```

---

### 4. Testimonials

Avatar, star rating, quote, and name/title. Responsive grid that adapts from 1 to 3 columns.

```tsx
// components/Testimonials.tsx
interface Testimonial {
  body: string;
  author: {
    name: string;
    role: string;
    company: string;
    imageUrl: string;
  };
}

const testimonials: Testimonial[] = [
  {
    body: "We cut our deploy time from 45 minutes to under 2 minutes. The DX is just phenomenal. Our team is shipping features daily now instead of weekly.",
    author: {
      name: "Sarah Chen",
      role: "CTO",
      company: "Acme Corp",
      imageUrl: "https://i.pravatar.cc/64?img=1",
    },
  },
  {
    body: "Migrated our entire infrastructure in a weekend. Zero downtime, zero stress. I wish we'd done this two years ago.",
    author: {
      name: "Marcus Johnson",
      role: "Lead Engineer",
      company: "Bloom Health",
      imageUrl: "https://i.pravatar.cc/64?img=3",
    },
  },
  {
    body: "The support team is unreal. Had a question at 2am and got a detailed answer in under 5 minutes. This level of care is rare.",
    author: {
      name: "Priya Patel",
      role: "Engineering Manager",
      company: "Finova",
      imageUrl: "https://i.pravatar.cc/64?img=5",
    },
  },
  {
    body: "Best developer tool purchase we've made this year. The ROI was obvious within the first week.",
    author: {
      name: "Alex Rivera",
      role: "VP Engineering",
      company: "Scalr",
      imageUrl: "https://i.pravatar.cc/64?img=7",
    },
  },
  {
    body: "We evaluated five platforms. This one won on every dimension that matters: speed, reliability, and price.",
    author: {
      name: "Jordan Kim",
      role: "Founder",
      company: "Launchpad Studio",
      imageUrl: "https://i.pravatar.cc/64?img=9",
    },
  },
  {
    body: "Onboarded our whole 20-person team in an afternoon. The docs are clear and the product just works.",
    author: {
      name: "Taylor Brooks",
      role: "DevOps Lead",
      company: "NexGen",
      imageUrl: "https://i.pravatar.cc/64?img=11",
    },
  },
];

function StarRating() {
  return (
    <div className="flex gap-x-1 text-yellow-400" aria-label="5 out of 5 stars">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg
          key={i}
          className="h-4 w-4 fill-current"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
        </svg>
      ))}
    </div>
  );
}

export function Testimonials() {
  return (
    <section className="bg-white dark:bg-gray-950 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
            Loved by engineering teams worldwide
          </h2>
          <p className="mt-6 text-lg leading-8 text-gray-600 dark:text-gray-300">
            Over 10,000 teams trust us to run their production infrastructure.
          </p>
        </div>

        {/* Masonry-style 3-column grid */}
        <div className="mx-auto mt-16 grid max-w-2xl grid-cols-1 grid-rows-1 gap-8 text-sm leading-6 text-gray-900 sm:mt-20 sm:grid-cols-2 xl:mx-0 xl:max-w-none xl:grid-cols-3">
          {testimonials.map((testimonial) => (
            <figure
              key={testimonial.author.name}
              className="rounded-2xl bg-gray-50 p-6 shadow-sm ring-1 ring-gray-900/5 dark:bg-gray-800 dark:ring-white/10"
            >
              <StarRating />
              <blockquote className="mt-4 text-gray-700 dark:text-gray-300">
                <p>"{testimonial.body}"</p>
              </blockquote>
              <figcaption className="mt-6 flex items-center gap-x-4">
                <img
                  src={testimonial.author.imageUrl}
                  alt={testimonial.author.name}
                  className="h-10 w-10 rounded-full bg-gray-100 object-cover"
                  width={40}
                  height={40}
                  loading="lazy"
                />
                <div>
                  <div className="font-semibold text-gray-900 dark:text-white">
                    {testimonial.author.name}
                  </div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {testimonial.author.role}, {testimonial.author.company}
                  </div>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
```

---

### 5. CTA Section

High-contrast gradient background with compelling copy and email capture form.

```tsx
// components/CTASection.tsx
"use client";
import { useState } from "react";

export function CTASection() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Replace with your email capture logic (API call, Resend, Mailchimp, etc.)
    console.log("Email submitted:", email);
    setSubmitted(true);
  };

  return (
    <section className="relative isolate overflow-hidden bg-gray-900 py-16 sm:py-24 lg:py-32">
      {/* Background gradient blobs */}
      <div
        className="absolute left-1/2 top-0 -z-10 -translate-x-1/2 blur-3xl xl:-top-6"
        aria-hidden="true"
      >
        <div
          className="aspect-[1155/678] w-[72.1875rem] bg-gradient-to-tr from-violet-600 to-indigo-400 opacity-30"
          style={{
            clipPath:
              "polygon(74.1% 44.1%, 100% 61.6%, 97.5% 26.9%, 85.5% 0.1%, 80.7% 2%, 72.5% 32.5%, 60.2% 62.4%, 52.4% 68.1%, 47.5% 58.3%, 45.2% 34.5%, 27.5% 76.7%, 0.1% 64.9%, 17.9% 100%, 27.6% 76.8%, 76.1% 97.7%, 74.1% 44.1%)",
          }}
        />
      </div>

      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Start shipping faster today.
            <br />
            No credit card required.
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-gray-300">
            Join 10,000+ teams who cut their deployment time by 90%. Set up in
            under 5 minutes.
          </p>

          {submitted ? (
            <div className="mt-10 rounded-xl bg-white/10 px-6 py-4 text-white ring-1 ring-inset ring-white/20">
              <p className="text-sm font-semibold">You're on the list!</p>
              <p className="mt-1 text-sm text-gray-300">
                We'll reach out to {email} shortly.
              </p>
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="mx-auto mt-10 flex max-w-md gap-x-4"
            >
              <label htmlFor="email-address" className="sr-only">
                Email address
              </label>
              <input
                id="email-address"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-w-0 flex-auto rounded-md border-0 bg-white/5 px-3.5 py-2 text-white shadow-sm ring-1 ring-inset ring-white/10 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-white sm:text-sm sm:leading-6"
                placeholder="Enter your email"
              />
              <button
                type="submit"
                className="flex-none rounded-md bg-white px-3.5 py-2.5 text-sm font-semibold text-gray-900 shadow-sm hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white transition-colors"
              >
                Get early access
              </button>
            </form>
          )}

          <p className="mt-4 text-sm text-gray-400">
            We care about your privacy. Unsubscribe anytime.
          </p>
        </div>
      </div>
    </section>
  );
}
```

---

### 6. Footer

Multi-column link grid, social icons, newsletter signup, and copyright line.

```tsx
// components/Footer.tsx
import { Github, Twitter, Linkedin, Youtube } from "lucide-react";

const navigation = {
  product: [
    { name: "Features", href: "#" },
    { name: "Pricing", href: "#pricing" },
    { name: "Changelog", href: "#" },
    { name: "Roadmap", href: "#" },
    { name: "Docs", href: "#" },
  ],
  company: [
    { name: "About", href: "#" },
    { name: "Blog", href: "#" },
    { name: "Careers", href: "#" },
    { name: "Press", href: "#" },
    { name: "Contact", href: "#" },
  ],
  legal: [
    { name: "Privacy Policy", href: "#" },
    { name: "Terms of Service", href: "#" },
    { name: "Cookie Policy", href: "#" },
    { name: "Security", href: "#" },
  ],
  social: [
    { name: "GitHub", href: "#", icon: Github },
    { name: "Twitter", href: "#", icon: Twitter },
    { name: "LinkedIn", href: "#", icon: Linkedin },
    { name: "YouTube", href: "#", icon: Youtube },
  ],
};

export function Footer() {
  return (
    <footer className="bg-gray-900" aria-labelledby="footer-heading">
      <h2 id="footer-heading" className="sr-only">
        Footer
      </h2>

      <div className="mx-auto max-w-7xl px-6 pb-8 pt-16 sm:pt-24 lg:px-8 lg:pt-32">
        <div className="xl:grid xl:grid-cols-3 xl:gap-8">
          {/* Brand column */}
          <div className="space-y-8">
            <span className="text-xl font-bold text-white">YourBrand</span>
            <p className="text-sm leading-6 text-gray-300">
              Making deployment effortless for engineering teams worldwide.
            </p>
            <div className="flex space-x-6">
              {navigation.social.map((item) => (
                <a
                  key={item.name}
                  href={item.href}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  <span className="sr-only">{item.name}</span>
                  <item.icon className="h-5 w-5" aria-hidden="true" />
                </a>
              ))}
            </div>
          </div>

          {/* Links columns */}
          <div className="mt-16 grid grid-cols-3 gap-8 xl:col-span-2 xl:mt-0">
            <div>
              <h3 className="text-sm font-semibold leading-6 text-white">
                Product
              </h3>
              <ul role="list" className="mt-6 space-y-4">
                {navigation.product.map((item) => (
                  <li key={item.name}>
                    <a
                      href={item.href}
                      className="text-sm leading-6 text-gray-300 hover:text-white transition-colors"
                    >
                      {item.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold leading-6 text-white">
                Company
              </h3>
              <ul role="list" className="mt-6 space-y-4">
                {navigation.company.map((item) => (
                  <li key={item.name}>
                    <a
                      href={item.href}
                      className="text-sm leading-6 text-gray-300 hover:text-white transition-colors"
                    >
                      {item.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold leading-6 text-white">
                Legal
              </h3>
              <ul role="list" className="mt-6 space-y-4">
                {navigation.legal.map((item) => (
                  <li key={item.name}>
                    <a
                      href={item.href}
                      className="text-sm leading-6 text-gray-300 hover:text-white transition-colors"
                    >
                      {item.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-16 border-t border-white/10 pt-8 sm:mt-20 lg:mt-24">
          <p className="text-xs leading-5 text-gray-400">
            &copy; {new Date().getFullYear()} YourBrand, Inc. All rights
            reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
```

---

### 7. Stats / Social Proof Section

Bold numbers with labels. Great for above-the-fold credibility.

```tsx
// components/StatsSection.tsx
interface Stat {
  value: string;
  label: string;
  sublabel?: string;
}

const stats: Stat[] = [
  { value: "10,000+", label: "Teams deployed", sublabel: "Across 40 countries" },
  { value: "99.99%", label: "Uptime SLA", sublabel: "Last 12 months" },
  { value: "2.1s", label: "Avg deploy time", sublabel: "Down from 47 minutes" },
  { value: "$0", label: "To get started", sublabel: "Free plan, no card needed" },
];

export function StatsSection() {
  return (
    <section className="bg-indigo-600 py-16 sm:py-24">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center lg:max-w-none">
          <h2 className="text-3xl font-bold tracking-tight text-white">
            Numbers that matter
          </h2>
        </div>

        <dl className="mt-16 grid grid-cols-1 gap-0.5 overflow-hidden rounded-2xl text-center sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="flex flex-col bg-white/5 p-8 hover:bg-white/10 transition-colors"
            >
              <dt className="text-sm font-semibold leading-6 text-indigo-200">
                {stat.label}
              </dt>
              <dd className="order-first text-3xl font-bold tracking-tight text-white">
                {stat.value}
              </dd>
              {stat.sublabel && (
                <dd className="mt-1 text-xs text-indigo-300">{stat.sublabel}</dd>
              )}
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
```

---

### 8. FAQ Accordion

Accessible, animated accordion using only React state — no library required.

```tsx
// components/FAQSection.tsx
"use client";
import { useState } from "react";
import { Plus, Minus } from "lucide-react";

interface FAQItem {
  question: string;
  answer: string;
}

const faqs: FAQItem[] = [
  {
    question: "Is there a free plan?",
    answer:
      "Yes. Our Starter plan is free forever with 3 projects and 100 GB of bandwidth per month. No credit card required to sign up.",
  },
  {
    question: "Can I upgrade or downgrade at any time?",
    answer:
      "Absolutely. You can change your plan from your account settings at any time. Upgrades take effect immediately; downgrades apply at the start of your next billing cycle.",
  },
  {
    question: "How does the annual discount work?",
    answer:
      "When you choose annual billing, you get 2 months free compared to monthly billing. The discount is applied automatically at checkout.",
  },
  {
    question: "What happens if I exceed my bandwidth limit?",
    answer:
      "We'll notify you at 80% and 100% usage. On the Starter plan, requests will be rate-limited. On paid plans, we apply reasonable overage charges of $0.02 per GB.",
  },
  {
    question: "Do you support custom domains?",
    answer:
      "Custom domains are available on Pro and Enterprise plans. You can add unlimited custom domains and we handle SSL certificates automatically via Let's Encrypt.",
  },
  {
    question: "Is my data secure?",
    answer:
      "We're SOC 2 Type II certified. All data is encrypted at rest (AES-256) and in transit (TLS 1.3). We perform regular third-party security audits.",
  },
];

function FAQItem({ item, isOpen, onToggle }: { item: FAQItem; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-gray-200 dark:border-gray-700">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between py-6 text-left"
        aria-expanded={isOpen}
      >
        <span className="text-base font-semibold leading-7 text-gray-900 dark:text-white">
          {item.question}
        </span>
        <span className="ml-6 flex h-7 items-center">
          {isOpen ? (
            <Minus className="h-5 w-5 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
          ) : (
            <Plus className="h-5 w-5 text-gray-400" aria-hidden="true" />
          )}
        </span>
      </button>

      {/* Answer with smooth height transition via max-height trick */}
      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          isOpen ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <p className="pb-6 text-base leading-7 text-gray-600 dark:text-gray-300">
          {item.answer}
        </p>
      </div>
    </div>
  );
}

export function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section className="bg-white dark:bg-gray-950 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-4xl divide-y divide-gray-900/10 dark:divide-white/10">
          <h2 className="text-2xl font-bold leading-10 tracking-tight text-gray-900 dark:text-white">
            Frequently asked questions
          </h2>

          <dl className="mt-10 space-y-0">
            {faqs.map((faq, index) => (
              <FAQItem
                key={faq.question}
                item={faq}
                isOpen={openIndex === index}
                onToggle={() =>
                  setOpenIndex(openIndex === index ? null : index)
                }
              />
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
```

---

### 9. Full Page Assembly

Wire all sections together into a complete landing page.

```tsx
// app/page.tsx  (Next.js App Router)
// For Vite: src/pages/LandingPage.tsx

import { HeroSection } from "@/components/HeroSection";
import { StatsSection } from "@/components/StatsSection";
import { FeatureGrid } from "@/components/FeatureGrid";
import { Testimonials } from "@/components/Testimonials";
import { PricingTable } from "@/components/PricingTable";
import { FAQSection } from "@/components/FAQSection";
import { CTASection } from "@/components/CTASection";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar"; // see Navigation knowledge article

export default function LandingPage() {
  return (
    <div className="bg-white dark:bg-gray-950">
      <Navbar />

      <main>
        {/* 1. Hook — get the visitor's attention immediately */}
        <HeroSection />

        {/* 2. Credibility — show numbers right after hero */}
        <StatsSection />

        {/* 3. Value proposition — what you do and why it's different */}
        <FeatureGrid />

        {/* 4. Social proof — real people love this */}
        <Testimonials />

        {/* 5. Pricing — remove the money question before it becomes an objection */}
        <PricingTable />

        {/* 6. Handle remaining doubts */}
        <FAQSection />

        {/* 7. Final push — last chance CTA */}
        <CTASection />
      </main>

      <Footer />
    </div>
  );
}
```

**Navbar (minimal sticky version):**

```tsx
// components/Navbar.tsx
"use client";
import { useState, useEffect } from "react";
import { Menu, X } from "lucide-react";

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-shadow duration-200 ${
        scrolled
          ? "bg-white/90 shadow-sm backdrop-blur-sm dark:bg-gray-950/90"
          : "bg-transparent"
      }`}
    >
      <nav className="mx-auto flex max-w-7xl items-center justify-between p-6 lg:px-8" aria-label="Global">
        <div className="flex lg:flex-1">
          <a href="/" className="-m-1.5 p-1.5 text-xl font-bold text-gray-900 dark:text-white">
            YourBrand
          </a>
        </div>

        {/* Desktop nav */}
        <div className="hidden lg:flex lg:gap-x-12">
          {["Features", "Pricing", "Docs", "Blog"].map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase()}`}
              className="text-sm font-semibold leading-6 text-gray-900 hover:text-indigo-600 dark:text-white dark:hover:text-indigo-400 transition-colors"
            >
              {item}
            </a>
          ))}
        </div>

        <div className="hidden lg:flex lg:flex-1 lg:justify-end lg:gap-x-4">
          <a href="/login" className="text-sm font-semibold leading-6 text-gray-900 dark:text-white hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
            Log in
          </a>
          <a
            href="/signup"
            className="rounded-md bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 transition-colors"
          >
            Get started
          </a>
        </div>

        {/* Mobile menu button */}
        <div className="flex lg:hidden">
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="-m-2.5 inline-flex items-center justify-center rounded-md p-2.5 text-gray-700 dark:text-gray-300"
          >
            <span className="sr-only">Toggle menu</span>
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="lg:hidden bg-white dark:bg-gray-900 px-6 py-4 border-t border-gray-200 dark:border-gray-800">
          <div className="flex flex-col gap-y-4">
            {["Features", "Pricing", "Docs", "Blog"].map((item) => (
              <a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="text-sm font-semibold text-gray-900 dark:text-white"
                onClick={() => setMobileOpen(false)}
              >
                {item}
              </a>
            ))}
            <hr className="border-gray-200 dark:border-gray-700" />
            <a href="/login" className="text-sm font-semibold text-gray-900 dark:text-white">
              Log in
            </a>
            <a
              href="/signup"
              className="rounded-md bg-indigo-600 px-3.5 py-2.5 text-center text-sm font-semibold text-white"
            >
              Get started
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
```

---

## Common Mistakes

**CTAs that don't stand out**
- Primary CTA must have high contrast against its background. Use a solid brand color, not an outline button.
- The page should have one "loudest" CTA at any given scroll position.

**Too much text, poor visual hierarchy**
- Headlines: 3xl–6xl bold. Subheadlines: lg–xl. Body copy: base–lg.
- Break long feature lists into cards rather than bullet paragraphs.
- Use whitespace aggressively: `py-24 sm:py-32` between sections.

**Missing mobile responsiveness**
- Always use `grid-cols-1` as the base, then `sm:grid-cols-2 lg:grid-cols-3`.
- Test at 375px, 768px, and 1280px viewports.
- Sticky navbar must not cover content: ensure `scroll-mt-20` on anchor sections.

**No social proof above the fold**
- Add a trust badge, star rating, or "X teams already using this" line inside or directly below the hero.
- Company logos work well: `grayscale opacity-60 hover:opacity-100 transition`.

**Slow loading images**
- Always specify `width` and `height` on `<img>` to prevent layout shift.
- Use `loading="lazy"` for images below the fold.
- For Next.js, use `<Image>` from `next/image` with proper `sizes` prop.
- Use `aspect-ratio` divs as placeholders before images load.

**Inconsistent section backgrounds**
- Alternate between `bg-white` and `bg-gray-50` (light mode) or `bg-gray-950` and `bg-gray-900` (dark mode) to create natural section separation without borders.

---

## Framework-Specific Notes

### Next.js

```tsx
// app/layout.tsx — Set up font and dark mode
import { Inter } from "next/font/google";
import type { Metadata } from "next";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "YourBrand — Tagline here",
  description: "Your 160-character meta description for SEO.",
  openGraph: {
    title: "YourBrand — Tagline here",
    description: "Your 160-character meta description.",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
```

- Use `"use client"` only on components that need `useState`, `useEffect`, or event handlers. Keep server components for static sections (hero text, feature grid, footer).
- Anchor links in the same page work with `href="#section-id"` and `id="section-id"` on the target section element. Add `scroll-mt-20` to account for the sticky navbar.
- For animated number counters, use `"use client"` with `useIntersectionObserver` to trigger on scroll.

```tsx
// Smooth scroll behavior — add to globals.css
html {
  scroll-behavior: smooth;
}
```

### React + Vite

```tsx
// src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// src/App.tsx
import { LandingPage } from "./pages/LandingPage";

export default function App() {
  return <LandingPage />;
}
```

`index.css`:
```css
@import "tailwindcss";

html {
  scroll-behavior: smooth;
}
```

- With Vite, all components are client-side by default — no `"use client"` directive needed.
- For routing between pages (landing + dashboard), use `react-router-dom`:

```bash
npm install react-router-dom
```

```tsx
// src/App.tsx with routing
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { LandingPage } from "./pages/LandingPage";
import { Dashboard } from "./pages/Dashboard";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- Vite handles `import.meta.env.VITE_*` for environment variables (never use `process.env` in browser code).
- For production builds: `npm run build` outputs to `dist/`. Use `vite preview` to test locally.
