# Authentication & Authorization

## When to Use This

- Ticket mentions: login, signup, register, auth, password, OAuth, JWT, session, protected routes, forgot password, reset password, email verification, role, permission, RBAC, social login, Google auth, GitHub auth, 2FA, MFA

---

## Quick Start

### Dependencies

```bash
# JWT + password hashing (core, framework-agnostic)
npm install jsonwebtoken bcryptjs
npm install -D @types/jsonwebtoken @types/bcryptjs

# Session-based auth
npm install express-session connect-pg-simple
npm install -D @types/express-session

# OAuth with Passport.js
npm install passport passport-google-oauth20 passport-github2
npm install -D @types/passport @types/passport-google-oauth20 @types/passport-github2

# Next.js — use Auth.js (formerly NextAuth)
npm install next-auth@beta

# Validation
npm install zod

# Rate limiting (login protection)
npm install express-rate-limit

# Email (for verification / reset flows)
npm install resend
```

### Environment Variables

```bash
# .env
JWT_SECRET=your-256-bit-secret-at-least-32-chars
JWT_REFRESH_SECRET=different-secret-for-refresh-tokens
SESSION_SECRET=another-long-random-secret

# OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# App URL (for OAuth callbacks and email links)
APP_URL=http://localhost:3000

# Next.js Auth.js
AUTH_SECRET=...  # openssl rand -base64 32
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...
```

---

## Patterns

### 1. Email/Password Signup + Login (JWT)

```typescript
// lib/auth/password.ts
import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

```typescript
// lib/auth/jwt.ts
import jwt from "jsonwebtoken";

const ACCESS_SECRET = process.env.JWT_SECRET!;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;

export interface TokenPayload {
  sub: string;       // user id
  email: string;
  role: string;
  type: "access" | "refresh";
}

export function signAccessToken(payload: Omit<TokenPayload, "type">): string {
  return jwt.sign({ ...payload, type: "access" }, ACCESS_SECRET, {
    expiresIn: "15m",
    algorithm: "HS256",
  });
}

export function signRefreshToken(payload: Omit<TokenPayload, "type">): string {
  return jwt.sign({ ...payload, type: "refresh" }, REFRESH_SECRET, {
    expiresIn: "7d",
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, REFRESH_SECRET) as TokenPayload;
}
```

```typescript
// routes/auth.ts (Express)
import { Router } from "express";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../lib/auth/jwt";
import { db } from "../db";
import { users, refreshTokens } from "../db/schema";
import { eq } from "drizzle-orm";
import { loginRateLimiter } from "../middleware/rate-limit";

const router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  name: z.string().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// POST /auth/signup
router.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  const { email, password, name } = parsed.data;

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return res.status(409).json({ error: "Email already registered" });
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(users)
    .values({ email, passwordHash, name: name ?? null, role: "user" })
    .returning({ id: users.id, email: users.email, role: users.role });

  const tokenPayload = { sub: user.id, email: user.email, role: user.role };
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);

  // Store refresh token in DB
  await db.insert(refreshTokens).values({
    userId: user.id,
    token: refreshToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  // Set refresh token in httpOnly cookie
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/auth/refresh",
  });

  res.status(201).json({ accessToken, user: { id: user.id, email: user.email, role: user.role } });
});

// POST /auth/login
router.post("/login", loginRateLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { email, password } = parsed.data;

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    // Constant-time response to prevent user enumeration
    await hashPassword("dummy-to-prevent-timing-attack");
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const tokenPayload = { sub: user.id, email: user.email, role: user.role };
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);

  await db.insert(refreshTokens).values({
    userId: user.id,
    token: refreshToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/auth/refresh",
  });

  res.json({ accessToken, user: { id: user.id, email: user.email, role: user.role } });
});

// POST /auth/logout
router.post("/logout", async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (token) {
    await db.delete(refreshTokens).where(eq(refreshTokens.token, token));
  }
  res.clearCookie("refreshToken", { path: "/auth/refresh" });
  res.json({ ok: true });
});

export default router;
```

---

### 2. Session-Based Auth (Express + express-session)

```typescript
// lib/session.ts
import session from "express-session";
import connectPg from "connect-pg-simple";

const PgStore = connectPg(session);

export const sessionMiddleware = session({
  store: new PgStore({
    conString: process.env.DATABASE_URL,
    tableName: "sessions",
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 15, // prune expired sessions every 15 min
  }),
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  name: "sid", // don't leak the default "connect.sid" name
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

// Augment express-session types
declare module "express-session" {
  interface SessionData {
    userId: string;
    email: string;
    role: string;
  }
}
```

```typescript
// routes/auth-session.ts
import { Router } from "express";
import { verifyPassword, hashPassword } from "../lib/auth/password";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";

const router = Router();

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Regenerate session on login to prevent session fixation
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Session error" });
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.role = user.role;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Session save error" });
      res.json({ user: { id: user.id, email: user.email, role: user.role } });
    });
  });
});

// POST /auth/logout
router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Logout failed" });
    res.clearCookie("sid");
    res.json({ ok: true });
  });
});

// GET /auth/me
router.get("/me", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  res.json({ user: { id: req.session.userId, email: req.session.email, role: req.session.role } });
});

export default router;
```

---

### 3. OAuth — Passport.js (Google + GitHub)

```typescript
// lib/passport.ts
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL: `${process.env.APP_URL}/auth/google/callback`,
      scope: ["profile", "email"],
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) return done(new Error("No email from Google"));

        let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

        if (!user) {
          [user] = await db
            .insert(users)
            .values({
              email,
              name: profile.displayName,
              googleId: profile.id,
              avatarUrl: profile.photos?.[0]?.value ?? null,
              emailVerified: true, // Google emails are pre-verified
              role: "user",
            })
            .returning();
        } else if (!user.googleId) {
          // Link Google to existing account
          [user] = await db
            .update(users)
            .set({ googleId: profile.id })
            .where(eq(users.id, user.id))
            .returning();
        }

        done(null, user);
      } catch (err) {
        done(err as Error);
      }
    }
  )
);

passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      callbackURL: `${process.env.APP_URL}/auth/github/callback`,
      scope: ["user:email"],
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) return done(new Error("No email from GitHub"));

        let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

        if (!user) {
          [user] = await db
            .insert(users)
            .values({
              email,
              name: profile.displayName || profile.username,
              githubId: profile.id,
              avatarUrl: profile.photos?.[0]?.value ?? null,
              emailVerified: true,
              role: "user",
            })
            .returning();
        }

        done(null, user);
      } catch (err) {
        done(err as Error);
      }
    }
  )
);

// Required for session-based passport (serialize/deserialize)
passport.serializeUser((user: any, done) => done(null, user.id));
passport.deserializeUser(async (id: string, done) => {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    done(null, user ?? false);
  } catch (err) {
    done(err);
  }
});

export default passport;
```

```typescript
// routes/oauth.ts
import { Router } from "express";
import passport from "../lib/passport";
import { signAccessToken, signRefreshToken } from "../lib/auth/jwt";

const router = Router();

// Google
router.get("/auth/google", passport.authenticate("google"));
router.get(
  "/auth/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "/login?error=oauth" }),
  (req, res) => {
    const user = req.user as any;
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
    // Redirect with token to frontend (use a short-lived code in production)
    res.redirect(`${process.env.APP_URL}/auth/callback?token=${accessToken}`);
  }
);

// GitHub
router.get("/auth/github", passport.authenticate("github"));
router.get(
  "/auth/github/callback",
  passport.authenticate("github", { session: false, failureRedirect: "/login?error=oauth" }),
  (req, res) => {
    const user = req.user as any;
    const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
    res.redirect(`${process.env.APP_URL}/auth/callback?token=${accessToken}`);
  }
);

export default router;
```

---

### 4. Next.js — Auth.js (NextAuth v5 / beta)

```typescript
// auth.ts (project root)
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { verifyPassword } from "@/lib/auth/password";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db),
  session: { strategy: "jwt" },
  providers: [
    Google,
    GitHub,
    Credentials({
      credentials: {
        email: { type: "email" },
        password: { type: "password" },
      },
      async authorize(credentials) {
        const parsed = z
          .object({ email: z.string().email(), password: z.string().min(1) })
          .safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;
        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user || !user.passwordHash) return null;

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      (session.user as any).role = token.role;
      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});
```

```typescript
// app/api/auth/[...nextauth]/route.ts
export { handlers as GET, handlers as POST } from "@/auth";
```

```typescript
// middleware.ts (protect routes in Next.js)
import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const isAuthenticated = !!req.auth;
  const isAuthRoute = req.nextUrl.pathname.startsWith("/login") ||
                      req.nextUrl.pathname.startsWith("/signup");

  if (!isAuthenticated && !isAuthRoute) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (isAuthenticated && isAuthRoute) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
```

```typescript
// lib/auth-types.ts — extend session types
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: { id: string; role: string } & DefaultSession["user"];
  }
}
```

---

### 5. JWT Middleware for Protected Routes (Express)

```typescript
// middleware/auth.ts
import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, type TokenPayload } from "../lib/auth/jwt";

export interface AuthRequest extends Request {
  user?: TokenPayload;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyAccessToken(token);
    if (payload.type !== "access") {
      res.status(401).json({ error: "Invalid token type" });
      return;
    }
    req.user = payload;
    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      res.status(401).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    } else {
      res.status(401).json({ error: "Invalid token" });
    }
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}
```

```typescript
// Usage in routes
import { requireAuth, requireRole } from "../middleware/auth";

// Protected route
router.get("/profile", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Admin-only route
router.delete("/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  // ...
});
```

---

### 6. Refresh Token Rotation

```typescript
// routes/auth-refresh.ts
import { Router } from "express";
import { verifyRefreshToken, signAccessToken, signRefreshToken } from "../lib/auth/jwt";
import { db } from "../db";
import { refreshTokens } from "../db/schema";
import { eq, and, gt } from "drizzle-orm";

const router = Router();

// POST /auth/refresh
// Only accessible via cookie (path="/auth/refresh" on the cookie)
router.post("/refresh", async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) {
    return res.status(401).json({ error: "No refresh token" });
  }

  // Verify JWT signature first
  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid refresh token" });
  }

  // Check token exists in DB and is not expired (rotation check)
  const [stored] = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.token, token),
        gt(refreshTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!stored) {
    // Possible token reuse — invalidate all tokens for this user
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, payload.sub));
    res.clearCookie("refreshToken", { path: "/auth/refresh" });
    return res.status(401).json({ error: "Refresh token reuse detected" });
  }

  // Rotate: delete old token, issue new pair
  await db.delete(refreshTokens).where(eq(refreshTokens.token, token));

  const tokenPayload = { sub: payload.sub, email: payload.email, role: payload.role };
  const newAccessToken = signAccessToken(tokenPayload);
  const newRefreshToken = signRefreshToken(tokenPayload);

  await db.insert(refreshTokens).values({
    userId: payload.sub,
    token: newRefreshToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  res.cookie("refreshToken", newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/auth/refresh",
  });

  res.json({ accessToken: newAccessToken });
});

export default router;
```

---

### 7. Forgot Password / Reset Password Flow

```typescript
// lib/auth/reset-token.ts
import crypto from "node:crypto";
import { db } from "../../db";
import { passwordResetTokens } from "../../db/schema";
import { eq, and, gt } from "drizzle-orm";

export async function createResetToken(userId: string): Promise<string> {
  // Invalidate existing tokens for this user
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));

  const token = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash: hashedToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
  });

  return token; // Send raw token to user, store only hash
}

export async function consumeResetToken(
  token: string
): Promise<{ userId: string } | null> {
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const [record] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashedToken),
        gt(passwordResetTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!record) return null;

  // Delete after first use
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, record.id));

  return { userId: record.userId };
}
```

```typescript
// routes/password-reset.ts
import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { createResetToken, consumeResetToken } from "../lib/auth/reset-token";
import { hashPassword } from "../lib/auth/password";
import { sendPasswordResetEmail } from "../lib/email";
import { loginRateLimiter } from "../middleware/rate-limit";

const router = Router();

// POST /auth/forgot-password
router.post("/forgot-password", loginRateLimiter, async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email" });
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, parsed.data.email))
    .limit(1);

  // Always respond OK to prevent user enumeration
  if (user) {
    const token = await createResetToken(user.id);
    const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;
    await sendPasswordResetEmail(user.email, resetUrl);
  }

  res.json({ ok: true, message: "If that email exists, a reset link was sent." });
});

// POST /auth/reset-password
router.post("/reset-password", async (req, res) => {
  const parsed = z
    .object({
      token: z.string().min(1),
      password: z.string().min(8).max(100),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const result = await consumeResetToken(parsed.data.token);
  if (!result) {
    return res.status(400).json({ error: "Invalid or expired reset token" });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await db.update(users).set({ passwordHash }).where(eq(users.id, result.userId));

  // Optionally: invalidate all refresh tokens for this user
  res.json({ ok: true });
});

export default router;
```

---

### 8. Email Verification

```typescript
// lib/auth/email-verification.ts
import crypto from "node:crypto";
import { db } from "../../db";
import { emailVerificationTokens } from "../../db/schema";
import { eq, and, gt } from "drizzle-orm";

export async function createVerificationToken(userId: string): Promise<string> {
  await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId));

  const token = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  await db.insert(emailVerificationTokens).values({
    userId,
    tokenHash: hashedToken,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  });

  return token;
}

export async function verifyEmailToken(token: string): Promise<string | null> {
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const [record] = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, hashedToken),
        gt(emailVerificationTokens.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!record) return null;

  await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.id, record.id));
  return record.userId;
}
```

```typescript
// routes/verify-email.ts
import { Router } from "express";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { verifyEmailToken } from "../lib/auth/email-verification";

const router = Router();

// GET /auth/verify-email?token=xxx
router.get("/verify-email", async (req, res) => {
  const { token } = req.query;

  if (typeof token !== "string") {
    return res.status(400).json({ error: "Invalid token" });
  }

  const userId = await verifyEmailToken(token);
  if (!userId) {
    return res.status(400).json({ error: "Invalid or expired verification link" });
  }

  await db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));

  res.redirect(`${process.env.APP_URL}/dashboard?verified=1`);
});

export default router;
```

---

### 9. Role-Based Access Control (RBAC)

```typescript
// lib/auth/rbac.ts

export type Role = "admin" | "manager" | "user" | "guest";

// Define role hierarchy — higher index = more permissions
const ROLE_HIERARCHY: Role[] = ["guest", "user", "manager", "admin"];

export function hasRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_HIERARCHY.indexOf(userRole) >= ROLE_HIERARCHY.indexOf(requiredRole);
}

// Define permissions per resource
export type Permission =
  | "users:read"
  | "users:write"
  | "users:delete"
  | "billing:read"
  | "billing:write"
  | "content:read"
  | "content:write"
  | "content:delete";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  guest: ["content:read"],
  user: ["content:read", "content:write", "billing:read"],
  manager: ["content:read", "content:write", "content:delete", "billing:read", "billing:write", "users:read"],
  admin: [
    "users:read", "users:write", "users:delete",
    "billing:read", "billing:write",
    "content:read", "content:write", "content:delete",
  ],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
```

```typescript
// middleware/rbac.ts
import type { Response, NextFunction } from "express";
import type { AuthRequest } from "./auth";
import { can, type Permission, type Role } from "../lib/auth/rbac";

export function requirePermission(permission: Permission) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const role = req.user?.role as Role | undefined;
    if (!role || !can(role, permission)) {
      res.status(403).json({ error: "Forbidden", required: permission });
      return;
    }
    next();
  };
}
```

```typescript
// Usage
router.get("/admin/users", requireAuth, requirePermission("users:read"), async (req, res) => {
  const allUsers = await db.select().from(users);
  res.json(allUsers);
});

router.delete("/admin/users/:id", requireAuth, requirePermission("users:delete"), async (req, res) => {
  await db.delete(users).where(eq(users.id, req.params.id));
  res.json({ ok: true });
});
```

---

### 10. Rate Limiting Login Attempts

```typescript
// middleware/rate-limit.ts
import rateLimit from "express-rate-limit";

// Strict limit for auth endpoints (prevent brute force)
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                    // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
  // Use IP + email combo for more granular limiting
  keyGenerator: (req) => {
    const email = (req.body?.email ?? "").toLowerCase();
    return `${req.ip}:${email}`;
  },
  skipSuccessfulRequests: true, // Don't count successful logins
});

// Lighter limit for general API
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
```

---

### 11. React Frontend — Auth State + Protected Routes

```typescript
// lib/auth-client.ts
const ACCESS_TOKEN_KEY = "access_token";

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setAccessToken(token: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
}

// Axios/fetch interceptor to auto-refresh
export async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res = await fetch(input, { ...init, headers });

  if (res.status === 401) {
    const json = await res.clone().json().catch(() => ({}));
    if (json?.code === "TOKEN_EXPIRED") {
      // Try to refresh
      const refreshRes = await fetch("/auth/refresh", { method: "POST", credentials: "include" });
      if (refreshRes.ok) {
        const { accessToken } = await refreshRes.json();
        setAccessToken(accessToken);
        headers.set("Authorization", `Bearer ${accessToken}`);
        res = await fetch(input, { ...init, headers });
      } else {
        clearAccessToken();
        window.location.href = "/login";
      }
    }
  }

  return res;
}
```

```typescript
// context/AuthContext.tsx
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { getAccessToken, setAccessToken, clearAccessToken, apiFetch } from "../lib/auth-client";

interface User {
  id: string;
  email: string;
  role: string;
  name?: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    apiFetch("/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data?.user ?? null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      credentials: "include",
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error ?? "Login failed");
    }
    const { accessToken, user } = await res.json();
    setAccessToken(accessToken);
    setUser(user);
  }, []);

  const logout = useCallback(async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "include" });
    clearAccessToken();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
```

```typescript
// components/ProtectedRoute.tsx (React Router)
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

interface Props {
  requiredRole?: string;
  redirectTo?: string;
}

export function ProtectedRoute({ requiredRole, redirectTo = "/login" }: Props) {
  const { user, loading } = useAuth();

  if (loading) return <div>Loading...</div>;
  if (!user) return <Navigate to={redirectTo} replace />;
  if (requiredRole && user.role !== requiredRole && user.role !== "admin") {
    return <Navigate to="/unauthorized" replace />;
  }

  return <Outlet />;
}
```

```typescript
// App.tsx usage
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import LoginPage from "./pages/Login";
import DashboardPage from "./pages/Dashboard";
import AdminPage from "./pages/Admin";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<DashboardPage />} />
          </Route>
          <Route element={<ProtectedRoute requiredRole="admin" redirectTo="/dashboard" />}>
            <Route path="/admin" element={<AdminPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
```

---

## DB Schema (Drizzle)

```typescript
// db/schema/auth.ts
import { pgTable, text, timestamp, boolean, unique } from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),         // null for OAuth-only users
  role: text("role").notNull().default("user"),
  emailVerified: boolean("email_verified").notNull().default(false),
  googleId: text("google_id").unique(),
  githubId: text("github_id").unique(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

---

## Common Mistakes

### Storing passwords in plaintext
Always hash with bcrypt (cost factor 12+). Never md5, sha1, or sha256 alone.
```typescript
// WRONG
user.password = req.body.password;

// CORRECT
user.passwordHash = await bcrypt.hash(req.body.password, 12);
```

### JWT without expiration
Always set `expiresIn`. Access tokens should be short (15m). Refresh tokens longer (7d).
```typescript
// WRONG
jwt.sign({ sub: userId }, secret);

// CORRECT
jwt.sign({ sub: userId }, secret, { expiresIn: "15m" });
```

### Not using httpOnly cookies for refresh tokens
Refresh tokens in localStorage are readable by JavaScript (XSS risk). Use httpOnly cookies.
```typescript
// WRONG — refresh token in localStorage
localStorage.setItem("refreshToken", token);

// CORRECT — httpOnly cookie, scoped to /auth/refresh
res.cookie("refreshToken", token, { httpOnly: true, secure: true, sameSite: "lax", path: "/auth/refresh" });
```

### CSRF with cookie auth
When using cookies for auth, protect POST/PUT/DELETE endpoints with CSRF tokens or use SameSite=Strict/Lax.
```typescript
import csrf from "csurf";
app.use(csrf({ cookie: { httpOnly: true } }));
// Frontend: send req.csrfToken() in X-CSRF-Token header
```

### Not rate-limiting login attempts
Without rate limiting, brute-force attacks are trivial. Always apply a rate limiter to `/auth/login`, `/auth/forgot-password`, etc.

### User enumeration via response timing
Use constant-time comparisons. When a user is not found, still run bcrypt to normalize response time.
```typescript
if (!user) {
  await bcrypt.compare("dummy", "$2b$12$placeholderHashToNormalizeTiming");
  return res.status(401).json({ error: "Invalid credentials" });
}
```

### Not validating OAuth emails
Some OAuth providers can return unverified emails. Check `profile.emails[0].verified` for Google before trusting the email.

### Insecure direct object reference on password reset
Always validate the reset token server-side. Never trust a userId sent in the request body alongside the token.

---

## Framework-Specific Notes

### Next.js (Auth.js / NextAuth v5)

- Use the `auth()` helper in Server Components and Route Handlers — no middleware needed for data fetching.
- For App Router, wrap layout with `SessionProvider` from `next-auth/react` for client components.
- Store role in the JWT callback and surface it on the session so frontend and middleware can both access it.
- Use `unstable_update` (Auth.js v5) to refresh session data without re-login.
- Database adapter handles session/account tables automatically — do not create them manually.
- For credentials provider, always use `authorized` callback in middleware to avoid exposing pages.

```typescript
// Server Component — get session server-side
import { auth } from "@/auth";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <div>Hello {session.user.email}</div>;
}
```

```typescript
// Route Handler — protect API route
import { auth } from "@/auth";

export const GET = auth(async (req) => {
  if (!req.auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ user: req.auth.user });
});
```

### Express

- Apply `sessionMiddleware` and `passport.initialize()` / `passport.session()` before routes.
- Use `helmet()` for security headers (sets `X-Content-Type-Options`, `X-Frame-Options`, etc.).
- For API-only servers, JWT is preferred over sessions — stateless scales better.
- Always run the app behind a reverse proxy (nginx) and set `app.set("trust proxy", 1)` to get real client IPs for rate limiting.

```typescript
import helmet from "helmet";
import cookieParser from "cookie-parser";

app.use(helmet());
app.use(cookieParser());
app.set("trust proxy", 1); // Required when behind nginx/load balancer
app.use(sessionMiddleware);
```

### React (Frontend Auth State + Protected Routes)

- Store only the access token in memory (React state) or localStorage for SPAs. Never store refresh tokens in localStorage.
- On page load, attempt a silent refresh (`/auth/refresh` with `credentials: "include"`) to restore auth state from the httpOnly cookie before showing a loading screen.
- Use an axios interceptor or a custom `apiFetch` wrapper to attach Bearer tokens and auto-refresh on 401.
- For Next.js App Router, prefer server-side session checks via `auth()` — avoid client-only auth state where possible.

```typescript
// Silent refresh on app init (SPA)
useEffect(() => {
  fetch("/auth/refresh", { method: "POST", credentials: "include" })
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (data?.accessToken) {
        setAccessToken(data.accessToken);
        setUser(data.user);
      }
    })
    .finally(() => setLoading(false));
}, []);
```
