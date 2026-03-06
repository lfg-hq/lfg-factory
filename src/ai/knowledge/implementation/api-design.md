# API Design

## When to Use This

Use these patterns when building REST APIs with Express or Next.js App Router. Covers route structure, Zod request validation, standardized error handling, pagination, CORS, rate limiting, and file upload endpoints.

## Quick Start

### Dependencies

```bash
# Express
npm install express cors helmet express-rate-limit multer
npm install -D @types/express @types/cors @types/multer

# Validation
npm install zod

# Next.js (built-in — no extra install needed for routes)
# Rate limiting for Next.js
npm install @upstash/ratelimit @upstash/redis

# Logging
npm install pino pino-http
npm install -D pino-pretty
```

### Environment Variables

```env
PORT=3000
API_PREFIX=/api/v1
CORS_ORIGINS=http://localhost:3000,https://myapp.com
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
```

---

## Patterns

### 1. Express App Bootstrap with Middleware Stack

```typescript
// src/app.ts
import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { usersRouter } from './routes/users';
import { postsRouter } from './routes/posts';
import { ApiError } from './lib/api-error';

export function createApp(): Application {
  const app = express();

  // Security headers
  app.use(helmet());

  // CORS
  app.use(
    cors({
      origin: (process.env.CORS_ORIGINS ?? '').split(','),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use(pinoHttp({ autoLogging: process.env.NODE_ENV !== 'test' }));

  // Global rate limit
  app.use(
    rateLimit({
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
      max: Number(process.env.RATE_LIMIT_MAX ?? 100),
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later.' },
    })
  );

  // Health check (no auth, no rate limit beyond global)
  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

  // Versioned API routes
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/posts', postsRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        ...(err.details ? { details: err.details } : {}),
      });
    }

    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
```

---

### 2. Typed ApiError Class

```typescript
// src/lib/api-error.ts
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, message, 'BAD_REQUEST', details);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message, 'UNAUTHORIZED');
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message, 'FORBIDDEN');
  }

  static notFound(resource: string) {
    return new ApiError(404, `${resource} not found`, 'NOT_FOUND');
  }

  static conflict(message: string) {
    return new ApiError(409, message, 'CONFLICT');
  }

  static unprocessable(message: string, details?: unknown) {
    return new ApiError(422, message, 'UNPROCESSABLE', details);
  }

  static internal(message = 'Internal server error') {
    return new ApiError(500, message, 'INTERNAL');
  }
}
```

---

### 3. Async Handler Wrapper + Zod Validation Middleware

```typescript
// src/lib/route-helpers.ts
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ApiError } from './api-error';

// Wraps async route handlers so thrown errors flow to the error middleware
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Validates req.body against a Zod schema; throws 400 on failure
export function validate<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const formatted = result.error.flatten();
      return next(
        ApiError.badRequest('Validation failed', {
          fieldErrors: formatted.fieldErrors,
          formErrors: formatted.formErrors,
        })
      );
    }
    req.body = result.data; // replace with parsed + stripped data
    next();
  };
}

// Validates req.query against a Zod schema
export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(ApiError.badRequest('Invalid query parameters', result.error.flatten()));
    }
    (req as any).validatedQuery = result.data;
    next();
  };
}
```

---

### 4. Full CRUD Router with Zod Validation

```typescript
// src/routes/posts.ts
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate, validateQuery } from '../lib/route-helpers';
import { ApiError } from '../lib/api-error';
import { requireAuth } from '../middleware/auth';
import { db } from '../db';

export const postsRouter = Router();

// Schemas
const createPostSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  content: z.string().min(1),
  published: z.boolean().default(false),
  tags: z.array(z.string()).max(10).default([]),
});

const updatePostSchema = createPostSchema.partial();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  published: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  search: z.string().optional(),
});

// GET /api/v1/posts
postsRouter.get(
  '/',
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const query = (req as any).validatedQuery as z.infer<typeof listQuerySchema>;

    const posts = await db.query.posts.findMany({
      where: query.published !== undefined
        ? (posts, { eq, isNull, and }) => and(eq(posts.published, query.published!), isNull(posts.deletedAt))
        : (posts, { isNull }) => isNull(posts.deletedAt),
      limit: query.limit + 1,
      orderBy: (posts, { desc }) => [desc(posts.createdAt)],
    });

    const hasNext = posts.length > query.limit;
    const items = hasNext ? posts.slice(0, query.limit) : posts;
    const nextCursor = hasNext ? items[items.length - 1].id : null;

    res.json({
      data: items,
      pagination: {
        hasNext,
        nextCursor,
        limit: query.limit,
      },
    });
  })
);

// GET /api/v1/posts/:id
postsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const post = await db.query.posts.findFirst({
      where: (posts, { eq, and, isNull }) =>
        and(eq(posts.id, req.params.id), isNull(posts.deletedAt)),
      with: { author: true, tags: { with: { tag: true } } },
    });

    if (!post) throw ApiError.notFound('Post');
    res.json({ data: post });
  })
);

// POST /api/v1/posts
postsRouter.post(
  '/',
  requireAuth,
  validate(createPostSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createPostSchema>;

    const [post] = await db.insert(posts).values({
      ...body,
      authorId: req.user.id,
    }).returning();

    res.status(201).json({ data: post });
  })
);

// PATCH /api/v1/posts/:id
postsRouter.patch(
  '/:id',
  requireAuth,
  validate(updatePostSchema),
  asyncHandler(async (req, res) => {
    const existing = await db.query.posts.findFirst({
      where: (posts, { eq, and, isNull }) =>
        and(eq(posts.id, req.params.id), isNull(posts.deletedAt)),
    });

    if (!existing) throw ApiError.notFound('Post');
    if (existing.authorId !== req.user.id) throw ApiError.forbidden();

    const [updated] = await db
      .update(posts)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(posts.id, req.params.id))
      .returning();

    res.json({ data: updated });
  })
);

// DELETE /api/v1/posts/:id (soft delete)
postsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await db.query.posts.findFirst({
      where: (posts, { eq, and, isNull }) =>
        and(eq(posts.id, req.params.id), isNull(posts.deletedAt)),
    });

    if (!existing) throw ApiError.notFound('Post');
    if (existing.authorId !== req.user.id) throw ApiError.forbidden();

    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, req.params.id));

    res.status(204).send();
  })
);
```

---

### 5. Cursor-Based Pagination Helper

```typescript
// src/lib/pagination.ts
import { z } from 'zod';

export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export type CursorPaginationParams = z.infer<typeof cursorPaginationSchema>;

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    hasNext: boolean;
    hasPrev: boolean;
    nextCursor: string | null;
    prevCursor: string | null;
    total?: number;
  };
}

export function buildCursorResponse<T extends { id: string; createdAt: Date }>(
  items: T[],
  limit: number
): PaginatedResponse<T> {
  const hasNext = items.length > limit;
  const data = hasNext ? items.slice(0, limit) : items;

  return {
    data,
    pagination: {
      hasNext,
      hasPrev: false, // requires separate query to determine
      nextCursor: hasNext ? data[data.length - 1].id : null,
      prevCursor: data.length > 0 ? data[0].id : null,
    },
  };
}

// Offset pagination schema (simpler, use for admin UIs)
export const offsetPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function buildOffsetResponse<T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number
): PaginatedResponse<T> & { pagination: { page: number; pageSize: number; totalPages: number } } {
  return {
    data,
    pagination: {
      hasNext: page * pageSize < total,
      hasPrev: page > 1,
      nextCursor: null,
      prevCursor: null,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}
```

---

### 6. Auth Middleware (JWT)

```typescript
// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ApiError } from '../lib/api-error';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

// Extend Express Request type globally
declare global {
  namespace Express {
    interface Request {
      user: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(ApiError.unauthorized('Missing or malformed Authorization header'));
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    req.user = payload;
    next();
  } catch (err) {
    next(ApiError.unauthorized('Invalid or expired token'));
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden('Insufficient permissions'));
    }
    next();
  };
}
```

---

### 7. Stricter Per-Route Rate Limiting

```typescript
// src/middleware/rate-limit.ts
import rateLimit from 'express-rate-limit';

// Tight limit for auth endpoints
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many auth attempts, please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? 'unknown',
});

// Medium limit for write endpoints
export const writeRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Usage in routes:
// router.post('/login', authRateLimit, validate(loginSchema), asyncHandler(loginHandler));
```

---

### 8. Next.js App Router — Route Handler Patterns

```typescript
// app/api/posts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const createPostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  published: z.boolean().default(false),
});

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit = Math.min(Number(searchParams.get('limit') ?? 20), 100);
  const cursor = searchParams.get('cursor');

  const posts = await prisma.post.findMany({
    where: { deletedAt: null, published: true },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: 'desc' },
    include: { author: { select: { name: true } } },
  });

  const hasNext = posts.length > limit;
  const data = hasNext ? posts.slice(0, limit) : posts;

  return NextResponse.json({
    data,
    pagination: {
      hasNext,
      nextCursor: hasNext ? data[data.length - 1].id : null,
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = createPostSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: result.error.flatten() },
      { status: 400 }
    );
  }

  const post = await prisma.post.create({
    data: { ...result.data, authorId: session.user.id },
  });

  return NextResponse.json({ data: post }, { status: 201 });
}

// app/api/posts/[id]/route.ts
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const post = await prisma.post.findFirst({
    where: { id: params.id, deletedAt: null },
    include: { author: { select: { name: true, email: true } } },
  });

  if (!post) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ data: post });
}
```

---

## Common Mistakes

- **Not using `asyncHandler` in Express**: An `async` route that throws will crash the process or hang the request if not wrapped. Always wrap async handlers.

- **Returning the raw Prisma/DB error to the client**: Never do `res.json({ error: err.message })` for unhandled DB errors. The error may contain internal table names, SQL, or sensitive info. Always map to a safe `ApiError.internal()`.

- **Forgetting to call `next(err)` in error middleware**: Express error middleware must have 4 parameters: `(err, req, res, next)`. If you forget `next`, TypeScript won't catch it and Express won't route to the error handler.

- **Zod `.parse()` vs `.safeParse()`**: Use `.safeParse()` in middleware so you can return a structured error. `.parse()` throws a `ZodError` which you'd need to catch separately.

- **CORS allowing `*` with `credentials: true`**: This combination is rejected by browsers. You must specify an explicit origin list when using `credentials: true`.

- **Forgetting `Content-Type: application/json` on fetch from frontend**: Express JSON middleware will silently leave `req.body` empty if the request has no content-type header.

- **Cursor pagination using offset internally**: Using `OFFSET N` in SQL for cursor-based pagination defeats the purpose. Use `WHERE id > cursor` or `WHERE created_at < cursor` to keep queries O(1).

---

## Framework-Specific Notes

### Next.js

- Route Handlers in `app/api/` do not run Express middleware. Replicate auth and validation logic using helper functions called at the top of each handler.
- Use `export const runtime = 'edge'` for lightweight handlers that do not need Node.js APIs.
- Use `export const dynamic = 'force-dynamic'` to opt out of static caching when the response depends on cookies, headers, or real-time DB data.
- Zod validation errors should return `NextResponse.json(..., { status: 400 })` — there is no centralized error handler.

### Express

- Mount all routers under a versioned prefix (`/api/v1`) from the start. Changing it later breaks clients.
- Use `express-async-errors` as an alternative to the `asyncHandler` wrapper — it patches Express internally to handle async throws automatically.
- Keep the error handler as the very last `app.use()` call, after all routes.
