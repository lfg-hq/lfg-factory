# Email

## When to Use This

Use these patterns when sending transactional emails — verification, password reset, welcome messages, receipts, or notifications. Covers Resend SDK (recommended), SendGrid, and React Email for templating.

## Quick Start

### Dependencies

```bash
# Resend (recommended — modern API, generous free tier)
npm install resend

# SendGrid (alternative)
npm install @sendgrid/mail
npm install -D @types/sendgrid__mail

# React Email (template engine — works with both providers)
npm install @react-email/components @react-email/render react react-dom
npm install -D @types/react @types/react-dom

# Token generation for verification / password reset
npm install crypto  # built-in Node.js module, no install needed
```

### Environment Variables

```env
# Resend
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@yourapp.com
EMAIL_FROM_NAME=YourApp

# SendGrid (alternative)
SENDGRID_API_KEY=SG....

# App URLs
APP_URL=https://yourapp.com
```

---

## Patterns

### 1. Resend Client Setup and Base Mailer

```typescript
// src/lib/email/client.ts
import { Resend } from 'resend';

export const resend = new Resend(process.env.RESEND_API_KEY!);

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
}

export async function sendEmail(opts: EmailOptions): Promise<{ id: string }> {
  const from = `${process.env.EMAIL_FROM_NAME ?? 'App'} <${process.env.EMAIL_FROM!}>`;

  const { data, error } = await resend.emails.send({
    from,
    to: Array.isArray(opts.to) ? opts.to : [opts.to],
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    reply_to: opts.replyTo,
    tags: opts.tags,
  });

  if (error || !data) {
    throw new Error(`Failed to send email: ${error?.message ?? 'Unknown error'}`);
  }

  return { id: data.id };
}
```

---

### 2. React Email Templates

```tsx
// src/lib/email/templates/VerificationEmail.tsx
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import * as React from 'react';

interface VerificationEmailProps {
  username: string;
  verificationUrl: string;
  expiresInHours?: number;
}

export function VerificationEmail({
  username,
  verificationUrl,
  expiresInHours = 24,
}: VerificationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Verify your email address for YourApp</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Verify your email</Heading>
          <Text style={text}>Hi {username},</Text>
          <Text style={text}>
            Thanks for signing up! Click the button below to verify your email address.
            This link expires in {expiresInHours} hours.
          </Text>
          <Section style={btnContainer}>
            <Button style={button} href={verificationUrl}>
              Verify Email
            </Button>
          </Section>
          <Text style={text}>
            Or copy and paste this URL into your browser:
          </Text>
          <Link href={verificationUrl} style={link}>
            {verificationUrl}
          </Link>
          <Hr style={hr} />
          <Text style={footer}>
            If you did not create an account, you can ignore this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

// Inline styles — React Email renders to plain HTML, so CSS-in-JS is required
const main = { backgroundColor: '#f6f9fc', fontFamily: 'sans-serif' };
const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  maxWidth: '600px',
};
const h1 = { color: '#333', fontSize: '24px', fontWeight: 'bold', margin: '40px 0 8px' };
const text = { color: '#555', fontSize: '16px', lineHeight: '26px', margin: '0 0 16px' };
const btnContainer = { textAlign: 'center' as const, margin: '32px 0' };
const button = {
  backgroundColor: '#4F46E5',
  borderRadius: '6px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: 'bold',
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'block',
  padding: '12px 32px',
};
const link = { color: '#4F46E5', fontSize: '14px', wordBreak: 'break-all' as const };
const hr = { borderColor: '#e6ebf1', margin: '32px 0' };
const footer = { color: '#9ca3af', fontSize: '12px' };
```

```tsx
// src/lib/email/templates/PasswordResetEmail.tsx
import {
  Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text, Link,
} from '@react-email/components';
import * as React from 'react';

interface PasswordResetEmailProps {
  username: string;
  resetUrl: string;
  expiresInMinutes?: number;
}

export function PasswordResetEmail({
  username,
  resetUrl,
  expiresInMinutes = 60,
}: PasswordResetEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your YourApp password</Preview>
      <Body style={{ backgroundColor: '#f6f9fc', fontFamily: 'sans-serif' }}>
        <Container style={{ backgroundColor: '#fff', margin: '0 auto', padding: '40px', maxWidth: '600px' }}>
          <Heading style={{ fontSize: '24px', color: '#111' }}>Reset your password</Heading>
          <Text style={{ color: '#555', fontSize: '16px', lineHeight: '26px' }}>
            Hi {username},
          </Text>
          <Text style={{ color: '#555', fontSize: '16px', lineHeight: '26px' }}>
            We received a request to reset your password. Click the button below to choose a new
            password. This link expires in {expiresInMinutes} minutes.
          </Text>
          <Section style={{ textAlign: 'center', margin: '32px 0' }}>
            <Button
              href={resetUrl}
              style={{
                backgroundColor: '#DC2626',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '16px',
                fontWeight: 'bold',
                padding: '12px 32px',
                textDecoration: 'none',
              }}
            >
              Reset Password
            </Button>
          </Section>
          <Text style={{ color: '#555', fontSize: '14px' }}>
            If you did not request a password reset, please ignore this email. Your password will
            not be changed.
          </Text>
          <Hr style={{ borderColor: '#e6ebf1', margin: '32px 0' }} />
          <Link href={resetUrl} style={{ color: '#4F46E5', fontSize: '13px', wordBreak: 'break-all' }}>
            {resetUrl}
          </Link>
        </Container>
      </Body>
    </Html>
  );
}
```

---

### 3. Email Sending Helpers (Verification + Password Reset)

```typescript
// src/lib/email/send.ts
import { render } from '@react-email/render';
import { randomBytes } from 'crypto';
import { sendEmail } from './client';
import { VerificationEmail } from './templates/VerificationEmail';
import { PasswordResetEmail } from './templates/PasswordResetEmail';
import React from 'react';

const APP_URL = process.env.APP_URL!;

// Generates a cryptographically secure token
export function generateToken(length = 32): string {
  return randomBytes(length).toString('hex');
}

export async function sendVerificationEmail(opts: {
  to: string;
  username: string;
  token: string;
}) {
  const verificationUrl = `${APP_URL}/verify-email?token=${opts.token}`;

  const html = await render(
    React.createElement(VerificationEmail, {
      username: opts.username,
      verificationUrl,
      expiresInHours: 24,
    })
  );

  return sendEmail({
    to: opts.to,
    subject: 'Verify your email address',
    html,
    tags: [{ name: 'type', value: 'verification' }],
  });
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  username: string;
  token: string;
}) {
  const resetUrl = `${APP_URL}/reset-password?token=${opts.token}`;

  const html = await render(
    React.createElement(PasswordResetEmail, {
      username: opts.username,
      resetUrl,
      expiresInMinutes: 60,
    })
  );

  return sendEmail({
    to: opts.to,
    subject: 'Reset your password',
    html,
    tags: [{ name: 'type', value: 'password-reset' }],
  });
}

export async function sendWelcomeEmail(opts: { to: string; username: string }) {
  // Simple welcome — no separate template needed for basic cases
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px;">
      <h1 style="color: #111;">Welcome to YourApp, ${opts.username}!</h1>
      <p style="color: #555; font-size: 16px;">
        Your account is all set. Head over to your dashboard to get started.
      </p>
      <a href="${APP_URL}/dashboard" style="display:inline-block;background:#4F46E5;color:#fff;
         padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-top:16px;">
        Go to Dashboard
      </a>
    </div>
  `;

  return sendEmail({
    to: opts.to,
    subject: `Welcome to YourApp!`,
    html,
    tags: [{ name: 'type', value: 'welcome' }],
  });
}
```

---

### 4. Verification and Password Reset Flow (API Routes)

```typescript
// src/routes/auth/verify-email.ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db';
import { users, emailVerificationTokens } from '../../db/schema';
import { generateToken, sendVerificationEmail } from '../../lib/email/send';
import { asyncHandler, validate } from '../../lib/route-helpers';
import { ApiError } from '../../lib/api-error';
import { eq, and, gt, isNull } from 'drizzle-orm';

export const verifyEmailRouter = Router();

// POST /auth/send-verification — sends or resends the verification email
verifyEmailRouter.post(
  '/send-verification',
  validate(z.object({ email: z.string().email() })),
  asyncHandler(async (req, res) => {
    const { email } = req.body as { email: string };

    const user = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, email),
    });
    if (!user) throw ApiError.notFound('User');
    if (user.emailVerifiedAt) {
      return res.json({ message: 'Email already verified' });
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await db.insert(emailVerificationTokens).values({
      userId: user.id,
      token,
      expiresAt,
    }).onConflictDoUpdate({
      target: emailVerificationTokens.userId,
      set: { token, expiresAt },
    });

    await sendVerificationEmail({ to: email, username: user.name ?? email, token });

    res.json({ message: 'Verification email sent' });
  })
);

// POST /auth/verify-email — confirms the token
verifyEmailRouter.post(
  '/verify-email',
  validate(z.object({ token: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const { token } = req.body as { token: string };

    const record = await db.query.emailVerificationTokens.findFirst({
      where: (t, { eq, and, gt }) =>
        and(eq(t.token, token), gt(t.expiresAt, new Date())),
      with: { user: true },
    });

    if (!record) throw ApiError.badRequest('Invalid or expired verification token');

    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, record.userId));

    await db
      .delete(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, record.userId));

    res.json({ message: 'Email verified successfully' });
  })
);

// POST /auth/forgot-password
verifyEmailRouter.post(
  '/forgot-password',
  validate(z.object({ email: z.string().email() })),
  asyncHandler(async (req, res) => {
    const { email } = req.body as { email: string };

    const user = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, email),
    });

    // Always return success to prevent email enumeration
    if (user) {
      const token = generateToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

      await db.insert(passwordResetTokens).values({ userId: user.id, token, expiresAt })
        .onConflictDoUpdate({
          target: passwordResetTokens.userId,
          set: { token, expiresAt },
        });

      await sendPasswordResetEmail({ to: email, username: user.name ?? email, token });
    }

    res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
  })
);
```

---

### 5. SendGrid Alternative

```typescript
// src/lib/email/sendgrid.ts
import sgMail from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

export interface SendGridEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  templateId?: string;
  dynamicTemplateData?: Record<string, unknown>;
}

export async function sendWithSendGrid(opts: SendGridEmailOptions): Promise<void> {
  const msg: sgMail.MailDataRequired = {
    to: opts.to,
    from: {
      email: process.env.EMAIL_FROM!,
      name: process.env.EMAIL_FROM_NAME ?? 'App',
    },
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    ...(opts.templateId
      ? {
          templateId: opts.templateId,
          dynamicTemplateData: opts.dynamicTemplateData,
        }
      : {}),
  };

  await sgMail.send(msg);
}

// SendGrid dynamic template usage (design templates in SendGrid dashboard):
// await sendWithSendGrid({
//   to: user.email,
//   subject: 'Welcome!',
//   html: '',
//   templateId: 'd-abc123...',
//   dynamicTemplateData: { username: user.name, ctaUrl: `${APP_URL}/dashboard` },
// });
```

---

### 6. Newsletter Signup Pattern

```typescript
// src/routes/newsletter.ts
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../lib/route-helpers';
import { resend } from '../lib/email/client';

export const newsletterRouter = Router();

const subscribeSchema = z.object({
  email: z.string().email(),
  firstName: z.string().optional(),
});

// POST /newsletter/subscribe
newsletterRouter.post(
  '/subscribe',
  validate(subscribeSchema),
  asyncHandler(async (req, res) => {
    const { email, firstName } = req.body as z.infer<typeof subscribeSchema>;

    // Resend Audiences API — manages subscriber list
    const { data, error } = await resend.contacts.create({
      email,
      firstName,
      audienceId: process.env.RESEND_AUDIENCE_ID!,
      unsubscribed: false,
    });

    if (error) {
      // Ignore duplicate subscriber errors
      if (!error.message?.includes('already exists')) {
        throw new Error(`Newsletter signup failed: ${error.message}`);
      }
    }

    // Send confirmation email
    await resend.emails.send({
      from: `${process.env.EMAIL_FROM_NAME} <${process.env.EMAIL_FROM}>`,
      to: [email],
      subject: "You're subscribed!",
      html: `<p>Hi${firstName ? ` ${firstName}` : ''}! Thanks for subscribing to our newsletter.</p>`,
    });

    res.json({ message: 'Subscribed successfully' });
  })
);

// POST /newsletter/unsubscribe
newsletterRouter.post(
  '/unsubscribe',
  validate(z.object({ email: z.string().email() })),
  asyncHandler(async (req, res) => {
    const { email } = req.body as { email: string };

    // Look up contact by email and mark unsubscribed
    const { data: contacts } = await resend.contacts.list({
      audienceId: process.env.RESEND_AUDIENCE_ID!,
    });

    const contact = contacts?.data?.find((c: any) => c.email === email);
    if (contact) {
      await resend.contacts.update({
        id: contact.id,
        audienceId: process.env.RESEND_AUDIENCE_ID!,
        unsubscribed: true,
      });
    }

    res.json({ message: 'Unsubscribed successfully' });
  })
);
```

---

### 7. Email Queue with Bull/BullMQ (for high volume)

```typescript
// src/lib/email/queue.ts
import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { sendEmail } from './client';
import { render } from '@react-email/render';
import React from 'react';

const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

export interface EmailJob {
  type: 'verification' | 'password-reset' | 'welcome' | 'custom';
  to: string;
  subject: string;
  templateProps?: Record<string, unknown>;
  html?: string;
}

export const emailQueue = new Queue<EmailJob>('email', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

// Start the worker (call once at app startup)
export function startEmailWorker() {
  const worker = new Worker<EmailJob>(
    'email',
    async (job: Job<EmailJob>) => {
      const { type, to, subject, templateProps, html } = job.data;

      let emailHtml = html ?? '';

      if (type === 'verification' && templateProps) {
        const { VerificationEmail } = await import('./templates/VerificationEmail');
        emailHtml = await render(
          React.createElement(VerificationEmail, templateProps as any)
        );
      }

      await sendEmail({ to, subject, html: emailHtml });
    },
    { connection, concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    console.error(`Email job ${job?.id} failed:`, err.message);
  });

  return worker;
}

// Usage: enqueue instead of sending directly
// await emailQueue.add('send', {
//   type: 'verification',
//   to: user.email,
//   subject: 'Verify your email',
//   templateProps: { username: user.name, verificationUrl, expiresInHours: 24 },
// });
```

---

## Common Mistakes

- **Rendering React Email templates synchronously**: `render()` from `@react-email/render` is async. Always `await render(...)`.

- **Sending in the request/response cycle**: For any volume beyond a few emails per second, sending inline will slow down API responses and fail under load. Use a queue (Bull, BullMQ, or a simple job table) and send asynchronously.

- **Not handling Resend/SendGrid errors**: Both SDKs return an `error` object rather than throwing. Always check `if (error)` and handle it.

- **Email enumeration in forgot-password**: Never return a different response based on whether the email exists. Always return "if an account exists..." to prevent email enumeration attacks.

- **Using `process.env.APP_URL` without trailing slash in URL construction**: `${APP_URL}/reset-password?token=...` will break if `APP_URL` includes a trailing slash. Either strip it with `.replace(/\/$/, '')` or use the `URL` constructor.

- **Not storing tokens securely**: Store only a hashed version of the token in the DB (`crypto.createHash('sha256').update(token).digest('hex')`). Send the plain token to the user. This prevents DB leaks from exposing valid tokens.

  ```typescript
  import { createHash } from 'crypto';
  const hashedToken = createHash('sha256').update(token).digest('hex');
  // Store hashedToken in DB, send token to user
  ```

- **Forgetting to delete tokens after use**: Always delete or invalidate a token after it is successfully used, to prevent replay attacks.

---

## Framework-Specific Notes

### Next.js

- Place email sending logic in Server Actions or Route Handlers — never in Client Components.
- Use environment variables prefixed with `RESEND_` etc. without `NEXT_PUBLIC_` — never expose API keys to the browser.
- For previewing React Email templates in development, run `email dev` with the React Email CLI:
  ```bash
  npx email dev --dir src/lib/email/templates
  ```

### Express

- Initialize the Resend client once at module load time, not per request.
- Add email queue worker startup to your `src/index.ts` alongside other workers.
- For local development, use Resend's test email (`delivered@resend.dev`) to avoid sending real emails during testing.
