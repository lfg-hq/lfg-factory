import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { db } from "../config/db.ts";
import { env } from "../config/env.ts";
import {
  users as user,
  sessions as session,
  accounts as account,
  verifications as verification,
  profiles,
  llmApiKeys,
  applicationState,
} from "../db/schema/users.ts";
import { sendEmail } from "../utils/email.ts";

// NOTE: We do NOT use Better Auth's organization plugin because our custom
// organization schema (organizations.ts) has additional fields (stripe, description,
// etc.) and would conflict on the "organization" table name. Organization CRUD
// is handled by our own routes instead.

export const auth = betterAuth({
  appName: "LFG",
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  // Localhost is a dev convenience only — trusting it in production would let a
  // page served from a local origin drive authenticated requests.
  trustedOrigins:
    env.NODE_ENV === "production"
      ? [env.BETTER_AUTH_URL]
      : [env.BETTER_AUTH_URL, "http://localhost:8000", "http://localhost:3000"],

  database: drizzleAdapter(db, {
    // Must track config/db.ts, which swaps in the PG driver for
    // DATABASE_DRIVER=postgresql. Hardcoding "sqlite" made Better Auth emit
    // SQLite-dialect behaviour against a Postgres connection.
    provider: env.DATABASE_DRIVER === "postgresql" ? "pg" : "sqlite",
    schema: { user, session, account, verification },
    usePlural: false,
  }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
    requireEmailVerification: true, // block sign-in until the email is verified

    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your LFG password",
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2>Reset your password</h2>
            <p>Hi ${user.name || "there"},</p>
            <p>Click the link below to reset your LFG password. This link expires in 1 hour.</p>
            <p><a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Reset Password</a></p>
            <p style="color:#64748b;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `,
        text: `Reset your LFG password: ${url}`,
      });
    },
  },

  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Verify your LFG email",
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2>Verify your email</h2>
            <p>Hi ${user.name || "there"},</p>
            <p>Click below to verify your email address for LFG.</p>
            <p><a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Verify Email</a></p>
            <p style="color:#64748b;font-size:13px;">If you didn't create an account, you can safely ignore this email.</p>
          </div>
        `,
        text: `Verify your LFG email: ${url}`,
      });
    },
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
  },

  socialProviders: {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh every day
  },

  // Passwordless 6-digit email login (used by the /apps instant-app flow).
  // sign-in with an OTP auto-creates the account if it doesn't exist.
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 60 * 10, // 10 minutes
      sendVerificationOTP: async ({ email, otp }) => {
        await sendEmail({
          to: email,
          subject: "Your LFG verification code",
          text: `Your verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
          html: `<div style="font-family:sans-serif;max-width:480px">
            <h2 style="color:#0f172a">Your verification code</h2>
            <p style="font-size:2rem;font-weight:700;letter-spacing:0.2em;color:#4f46e5">${otp}</p>
            <p style="color:#64748b">This code expires in 10 minutes.</p>
          </div>`,
        });
      },
    }),
  ],

  // Auto-create profile + llmApiKeys + applicationState on signup
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            await db.insert(profiles).values({
              userId: user.id,
            });
            await db.insert(llmApiKeys).values({
              userId: user.id,
            });
            await db.insert(applicationState).values({
              userId: user.id,
            });
          } catch (err) {
            console.error("Failed to create user profile rows:", err);
          }
        },
      },
    },
  },
});

export type Auth = typeof auth;
