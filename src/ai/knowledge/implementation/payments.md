# Payments & Billing (Stripe)

## When to Use This

- Ticket mentions: payments, stripe, checkout, subscription, billing, pricing, invoices, refunds
- Any feature that collects money, manages plans, or handles recurring charges

---

## Quick Start

### Dependencies

```bash
npm install stripe @stripe/stripe-js @stripe/react-stripe-js
```

### Environment Variables

```bash
# Server-side only — never expose these to the browser
STRIPE_SECRET_KEY=sk_live_...         # or sk_test_... for development
STRIPE_WEBHOOK_SECRET=whsec_...       # from Stripe Dashboard > Webhooks

# Client-side safe (publishable key)
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...   # Next.js
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...          # Vite / React SPA
```

> Never commit real keys. Use `.env.local` (Next.js) or `.env` (dotenv). The secret key must only ever exist on the server.

---

## Patterns

---

### 1. One-Time Checkout (Stripe Checkout Sessions)

The simplest and most secure way to collect a one-time payment. Stripe hosts the payment page.

**Server — create a checkout session**

```typescript
// lib/stripe.ts
import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
  typescript: true,
});
```

```typescript
// app/api/checkout/route.ts  (Next.js App Router)
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const { priceId, userId, email } = await req.json();

  if (!priceId || !userId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      customer_email: email,
      client_reference_id: userId,       // tie the session back to your user
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/cancel`,
      metadata: {
        userId,
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Client — redirect to Stripe Checkout**

```typescript
// components/CheckoutButton.tsx
"use client";

import { useState } from "react";

interface CheckoutButtonProps {
  priceId: string;
  label?: string;
}

export function CheckoutButton({ priceId, label = "Buy Now" }: CheckoutButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheckout = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to create checkout session");
      }

      // Redirect to Stripe-hosted checkout page
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleCheckout}
        disabled={loading}
        className="px-6 py-2 bg-indigo-600 text-white rounded-lg disabled:opacity-50"
      >
        {loading ? "Redirecting..." : label}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

**Server — verify completed session on success page**

```typescript
// app/checkout/success/page.tsx
import { stripe } from "@/lib/stripe";

interface Props {
  searchParams: { session_id?: string };
}

export default async function SuccessPage({ searchParams }: Props) {
  const sessionId = searchParams.session_id;

  if (!sessionId) {
    return <p>Invalid session.</p>;
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (session.payment_status !== "paid") {
    return <p>Payment not yet completed.</p>;
  }

  return (
    <div>
      <h1>Payment successful!</h1>
      <p>Thank you for your purchase. A receipt has been sent to {session.customer_email}.</p>
    </div>
  );
}
```

---

### 2. Subscription Billing (Recurring Plans + Customer Portal)

Use `mode: "subscription"` in the checkout session. After the customer subscribes, always manage the source of truth via webhooks — do not trust the success redirect alone.

**Server — create a subscription checkout session**

```typescript
// app/api/subscribe/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { priceId } = await req.json();

  // Load or create a Stripe customer for this user
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  let customerId = user?.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: session.user.email!,
      metadata: { userId: session.user.id },
    });
    customerId = customer.id;

    await db.update(users)
      .set({ stripeCustomerId: customerId })
      .where(eq(users.id, session.user.id));
  }

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      metadata: { userId: session.user.id },
    },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/billing?success=true`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
  });

  return NextResponse.json({ url: checkoutSession.url });
}
```

**Server — create a customer portal session (manage/cancel subscription)**

```typescript
// app/api/billing/portal/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  if (!user?.stripeCustomerId) {
    return NextResponse.json({ error: "No billing account found" }, { status: 400 });
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings/billing`,
  });

  return NextResponse.json({ url: portalSession.url });
}
```

**Client — manage billing button**

```typescript
// components/ManageBillingButton.tsx
"use client";

import { useState } from "react";

export function ManageBillingButton() {
  const [loading, setLoading] = useState(false);

  const handlePortal = async () => {
    setLoading(true);
    const res = await fetch("/api/billing/portal", { method: "POST" });
    const { url, error } = await res.json();
    if (error) {
      alert(error);
      setLoading(false);
      return;
    }
    window.location.href = url;
  };

  return (
    <button
      onClick={handlePortal}
      disabled={loading}
      className="px-4 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50"
    >
      {loading ? "Loading..." : "Manage Billing"}
    </button>
  );
}
```

---

### 3. Webhook Handling (Signature Verification + Event Types)

Webhooks are how Stripe tells your server what actually happened. Always verify the signature. Never provision access from the checkout success redirect — do it here.

**Setup in Stripe Dashboard**: Webhooks > Add endpoint > `https://yourdomain.com/api/webhooks/stripe`

**Key events to handle**:
- `checkout.session.completed` — payment or subscription started
- `invoice.payment_succeeded` — recurring payment collected
- `invoice.payment_failed` — payment failed, notify user
- `customer.subscription.updated` — plan changed
- `customer.subscription.deleted` — subscription cancelled

```typescript
// app/api/webhooks/stripe/route.ts
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import { users, subscriptions } from "@/db/schema";
import { eq } from "drizzle-orm";

// IMPORTANT: disable body parsing — Stripe needs the raw body to verify the signature
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = headers().get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook signature verification failed";
    console.error("Stripe webhook error:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(session);
        break;
      }
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentSucceeded(invoice);
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(invoice);
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(sub);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(sub);
        break;
      }
      default:
        // Unhandled event type — acknowledge receipt
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (err) {
    console.error(`Error processing Stripe event ${event.type}:`, err);
    // Return 500 so Stripe retries the webhook
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId ?? session.client_reference_id;
  if (!userId) return;

  if (session.mode === "subscription" && session.subscription) {
    const sub = await stripe.subscriptions.retrieve(session.subscription as string);

    await db.insert(subscriptions).values({
      userId,
      stripeSubscriptionId: sub.id,
      stripeCustomerId: sub.customer as string,
      stripePriceId: sub.items.data[0].price.id,
      status: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
    }).onConflictDoUpdate({
      target: subscriptions.stripeSubscriptionId,
      set: {
        status: sub.status,
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
      },
    });
  }

  if (session.mode === "payment") {
    // Grant one-time access, add credits, etc.
    await db.update(users)
      .set({ hasPurchased: true })
      .where(eq(users.id, userId));
  }
}

async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
  if (!invoice.subscription) return;

  const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);

  await db.update(subscriptions)
    .set({
      status: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
    })
    .where(eq(subscriptions.stripeSubscriptionId, sub.id));
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  if (!invoice.subscription) return;

  await db.update(subscriptions)
    .set({ status: "past_due" })
    .where(eq(subscriptions.stripeSubscriptionId, invoice.subscription as string));

  // TODO: email user about failed payment
}

async function handleSubscriptionUpdated(sub: Stripe.Subscription) {
  await db.update(subscriptions)
    .set({
      status: sub.status,
      stripePriceId: sub.items.data[0].price.id,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
    })
    .where(eq(subscriptions.stripeSubscriptionId, sub.id));
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription) {
  await db.update(subscriptions)
    .set({ status: "canceled" })
    .where(eq(subscriptions.stripeSubscriptionId, sub.id));
}
```

**Testing webhooks locally** — use the Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# Copy the webhook signing secret it prints and put it in STRIPE_WEBHOOK_SECRET
```

---

### 4. Pricing Page Integration

Fetch prices from Stripe at build time (or on-demand with revalidation) so your pricing page always reflects the real prices in Stripe Dashboard.

```typescript
// lib/stripe-products.ts
import { stripe } from "@/lib/stripe";
import type Stripe from "stripe";

export interface PricingPlan {
  id: string;
  priceId: string;
  name: string;
  description: string | null;
  amount: number;           // in cents
  currency: string;
  interval: "month" | "year" | null;
  features: string[];
}

export async function getPricingPlans(): Promise<PricingPlan[]> {
  const prices = await stripe.prices.list({
    active: true,
    expand: ["data.product"],
    type: "recurring",
  });

  return prices.data
    .filter((price) => price.unit_amount !== null)
    .map((price) => {
      const product = price.product as Stripe.Product;
      const features = (product.metadata?.features ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);

      return {
        id: product.id,
        priceId: price.id,
        name: product.name,
        description: product.description,
        amount: price.unit_amount!,
        currency: price.currency,
        interval: price.recurring?.interval ?? null,
        features,
      };
    })
    .sort((a, b) => a.amount - b.amount);
}
```

```typescript
// app/pricing/page.tsx  (Next.js — server component with ISR)
import { getPricingPlans } from "@/lib/stripe-products";
import { CheckoutButton } from "@/components/CheckoutButton";

export const revalidate = 3600; // Revalidate every hour

function formatPrice(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(amount / 100);
}

export default async function PricingPage() {
  const plans = await getPricingPlans();

  return (
    <div className="max-w-5xl mx-auto py-16 px-4">
      <h1 className="text-4xl font-bold text-center mb-12">Simple, transparent pricing</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {plans.map((plan) => (
          <div
            key={plan.priceId}
            className="border border-gray-200 rounded-2xl p-8 flex flex-col"
          >
            <h2 className="text-xl font-semibold mb-1">{plan.name}</h2>
            {plan.description && (
              <p className="text-gray-500 text-sm mb-4">{plan.description}</p>
            )}
            <div className="mb-6">
              <span className="text-4xl font-bold">
                {formatPrice(plan.amount, plan.currency)}
              </span>
              {plan.interval && (
                <span className="text-gray-400 ml-1">/ {plan.interval}</span>
              )}
            </div>
            <ul className="space-y-2 mb-8 flex-1">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-sm">
                  <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  {feature}
                </li>
              ))}
            </ul>
            <CheckoutButton priceId={plan.priceId} label={`Get ${plan.name}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

### 5. Refunds and Cancellations

**Issue a refund (server)**

```typescript
// app/api/refund/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { orders } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId, reason } = await req.json();

  // Look up the order — verify it belongs to this user
  const order = await db.query.orders.findFirst({
    where: and(
      eq(orders.id, orderId),
      eq(orders.userId, session.user.id)
    ),
  });

  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  if (order.refunded) {
    return NextResponse.json({ error: "Already refunded" }, { status: 400 });
  }

  try {
    const refund = await stripe.refunds.create({
      payment_intent: order.stripePaymentIntentId,
      reason: reason ?? "requested_by_customer",
    });

    await db.update(orders)
      .set({ refunded: true, refundId: refund.id })
      .where(eq(orders.id, orderId));

    return NextResponse.json({ refund: { id: refund.id, status: refund.status } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refund failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Cancel a subscription immediately (server)**

```typescript
// app/api/subscription/cancel/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { subscriptions } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sub = await db.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.userId, session.user.id),
      eq(subscriptions.status, "active")
    ),
  });

  if (!sub) {
    return NextResponse.json({ error: "No active subscription" }, { status: 404 });
  }

  try {
    // cancel_at_period_end: true = cancel at end of billing cycle (preferred UX)
    // cancel_at_period_end: false = cancel immediately
    const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    await db.update(subscriptions)
      .set({
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(updated.current_period_end * 1000),
      })
      .where(eq(subscriptions.stripeSubscriptionId, sub.stripeSubscriptionId));

    return NextResponse.json({ message: "Subscription will cancel at period end" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cancellation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

---

### 6. Invoice Management

Retrieve and list invoices for a user's billing history page.

```typescript
// app/api/billing/invoices/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface InvoiceSummary {
  id: string;
  number: string | null;
  amount: number;
  currency: string;
  status: string | null;
  created: number;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  if (!user?.stripeCustomerId) {
    return NextResponse.json({ invoices: [] });
  }

  const invoices = await stripe.invoices.list({
    customer: user.stripeCustomerId,
    limit: 24,
  });

  const summaries: InvoiceSummary[] = invoices.data.map((inv) => ({
    id: inv.id,
    number: inv.number,
    amount: inv.amount_paid,
    currency: inv.currency,
    status: inv.status,
    created: inv.created,
    hostedUrl: inv.hosted_invoice_url,
    pdfUrl: inv.invoice_pdf,
  }));

  return NextResponse.json({ invoices: summaries });
}
```

```typescript
// components/InvoiceHistory.tsx
"use client";

import { useEffect, useState } from "react";
import type { InvoiceSummary } from "@/app/api/billing/invoices/route";

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

export function InvoiceHistory() {
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/billing/invoices")
      .then((r) => r.json())
      .then((d) => setInvoices(d.invoices ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-gray-500">Loading invoices...</p>;
  if (invoices.length === 0) return <p className="text-sm text-gray-500">No invoices yet.</p>;

  return (
    <div className="divide-y divide-gray-100">
      {invoices.map((inv) => (
        <div key={inv.id} className="flex items-center justify-between py-3">
          <div>
            <p className="text-sm font-medium">{formatDate(inv.created)}</p>
            <p className="text-xs text-gray-500">#{inv.number ?? inv.id}</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm font-semibold">
              {formatAmount(inv.amount, inv.currency)}
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                inv.status === "paid"
                  ? "bg-green-100 text-green-700"
                  : "bg-yellow-100 text-yellow-700"
              }`}
            >
              {inv.status}
            </span>
            {inv.pdfUrl && (
              <a
                href={inv.pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-indigo-600 hover:underline"
              >
                PDF
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

### 7. Usage-Based Billing (Metered)

For per-seat, per-API-call, or per-unit pricing. Report usage to Stripe; Stripe invoices at the end of each billing period.

**Setup in Stripe Dashboard**: Create a price with `Recurring` billing and `Usage is metered`, with `aggregate_usage: sum`.

**Report usage on the server**

```typescript
// lib/usage.ts
import { stripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import { subscriptions } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Record metered usage for a user.
 * Call this whenever the user consumes a billable unit (API call, token, seat, etc.)
 */
export async function reportUsage(userId: string, quantity: number): Promise<void> {
  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  });

  if (!sub || sub.status !== "active") {
    throw new Error("No active subscription found for user");
  }

  // Get the subscription item ID (needed for usage records)
  const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const subscriptionItemId = stripeSubscription.items.data[0].id;

  await stripe.subscriptionItems.createUsageRecord(subscriptionItemId, {
    quantity,
    timestamp: Math.floor(Date.now() / 1000),
    action: "increment",
  });
}
```

**Example — report usage on an API endpoint**

```typescript
// app/api/process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { reportUsage } from "@/lib/usage";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ... do the actual work ...
  const unitsUsed = 1;

  // Report usage to Stripe — fire and forget (don't block the response)
  reportUsage(session.user.id, unitsUsed).catch((err) => {
    console.error("Failed to report usage:", err);
  });

  return NextResponse.json({ success: true });
}
```

**Retrieve current usage summary**

```typescript
// app/api/billing/usage/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { subscriptions } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, session.user.id),
  });

  if (!sub) {
    return NextResponse.json({ usage: null });
  }

  const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const subscriptionItemId = stripeSubscription.items.data[0].id;

  const summaries = await stripe.subscriptionItems.listUsageRecordSummaries(
    subscriptionItemId,
    { limit: 1 }
  );

  const latest = summaries.data[0];

  return NextResponse.json({
    usage: latest
      ? {
          totalUsage: latest.total_usage,
          periodStart: latest.period.start,
          periodEnd: latest.period.end,
        }
      : null,
  });
}
```

---

## Common Mistakes

**Not verifying webhook signatures**
Always call `stripe.webhooks.constructEvent()` before processing any webhook payload. Without this, anyone can POST fake events to your endpoint.

**Using test keys in production**
`pk_test_` / `sk_test_` keys will silently accept fake card numbers and not charge real money. Use `pk_live_` / `sk_live_` in production. Add a startup assertion if needed:

```typescript
if (process.env.NODE_ENV === "production" && !process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
  throw new Error("Production requires a live Stripe secret key");
}
```

**Trusting the checkout success redirect for provisioning access**
The success URL can be visited directly or replayed. Always provision access from webhooks (`checkout.session.completed`, `invoice.payment_succeeded`), not from the redirect.

**Storing card details directly**
Never store full card numbers, CVVs, or sensitive payment data. Stripe's tokenization handles this. Storing even partial card data triggers PCI DSS compliance requirements.

**Not handling `cancel_at_period_end` separately**
A subscription with `cancel_at_period_end: true` still has `status: "active"`. Check both fields when deciding whether to show upgrade prompts.

**Forgetting idempotency keys on retries**
For POST requests you might retry (e.g. creating charges), pass `idempotencyKey` to avoid double charges:

```typescript
await stripe.paymentIntents.create(
  { amount: 2000, currency: "usd" },
  { idempotencyKey: `pi-${orderId}` }
);
```

**Not returning 500 on webhook processing errors**
If your handler throws, return HTTP 500 so Stripe retries. If you return 200 on an error, Stripe marks the webhook as delivered and never retries.

---

## Framework-Specific Notes

### Next.js

**App Router**: Use `export const runtime = "nodejs"` on webhook routes. The Edge Runtime does not support all Node.js crypto APIs that Stripe needs for signature verification.

**Disable body parsing on webhook route**: In the App Router, `req.text()` reads the raw body correctly. In Pages Router, you must disable Next.js body parsing:

```typescript
// pages/api/webhooks/stripe.ts  (Pages Router)
import type { NextApiRequest, NextApiResponse } from "next";
import { buffer } from "micro";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const buf = await buffer(req);
  const signature = req.headers["stripe-signature"] as string;
  // ... constructEvent(buf, signature, secret)
}
```

**Server Actions**: You can call `stripe.checkout.sessions.create()` directly in a Server Action — no API route needed:

```typescript
// app/actions/checkout.ts
"use server";

import { stripe } from "@/lib/stripe";
import { redirect } from "next/navigation";

export async function createCheckoutAction(priceId: string) {
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/success`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
  });

  redirect(session.url!);
}
```

### Express

```typescript
// routes/webhooks.ts
import express from "express";
import Stripe from "stripe";
import { stripe } from "../lib/stripe";

const router = express.Router();

// IMPORTANT: use express.raw() — not express.json() — for this route
router.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"] as string;

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Signature verification failed";
      return res.status(400).send(`Webhook Error: ${message}`);
    }

    switch (event.type) {
      case "checkout.session.completed":
        // handle ...
        break;
    }

    res.json({ received: true });
  }
);

export default router;
```

Register with raw body parser **before** the global `express.json()` middleware:

```typescript
// index.ts
import webhookRouter from "./routes/webhooks";

// Webhooks must come BEFORE express.json()
app.use("/api/webhooks", webhookRouter);

// Global JSON middleware — after webhooks
app.use(express.json());
```

### React (Frontend)

Use `@stripe/react-stripe-js` for Stripe Elements (custom card forms instead of hosted Checkout).

```typescript
// app/layout.tsx or _app.tsx — load Stripe once at the root
import { Elements } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <Elements stripe={stripePromise}>
          {children}
        </Elements>
      </body>
    </html>
  );
}
```

```typescript
// components/CardForm.tsx — custom card input with Stripe Elements
"use client";

import { useState, FormEvent } from "react";
import { useStripe, useElements, PaymentElement } from "@stripe/react-stripe-js";

interface CardFormProps {
  clientSecret: string;   // from stripe.paymentIntents.create() on the server
  onSuccess: () => void;
}

export function CardForm({ clientSecret, onSuccess }: CardFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setLoading(true);
    setErrorMessage(null);

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/payment/complete`,
      },
      redirect: "if_required",
    });

    if (error) {
      setErrorMessage(error.message ?? "Payment failed");
      setLoading(false);
      return;
    }

    onSuccess();
    setLoading(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {errorMessage && (
        <p className="text-sm text-red-600">{errorMessage}</p>
      )}
      <button
        type="submit"
        disabled={!stripe || loading}
        className="w-full py-2 bg-indigo-600 text-white rounded-lg disabled:opacity-50"
      >
        {loading ? "Processing..." : "Pay Now"}
      </button>
    </form>
  );
}
```

**Server — create a PaymentIntent for the card form**

```typescript
// app/api/payment-intent/route.ts
import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const { amount, currency = "usd" } = await req.json();

  const intent = await stripe.paymentIntents.create({
    amount,       // in cents
    currency,
    automatic_payment_methods: { enabled: true },
  });

  // Return ONLY the client secret — never the full PaymentIntent object
  return NextResponse.json({ clientSecret: intent.client_secret });
}
```
