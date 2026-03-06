# Testing

## When to Use This

Use these patterns when setting up a test suite, writing API integration tests, testing React components, or mocking external dependencies. Covers Vitest (recommended for new projects) and Jest, plus Supertest for HTTP testing and React Testing Library.

## Quick Start

### Dependencies

```bash
# Vitest (recommended — faster, native ESM, compatible with Vite)
npm install -D vitest @vitest/coverage-v8 @vitest/ui

# Jest (Node.js / non-Vite projects)
npm install -D jest @types/jest ts-jest

# API testing
npm install -D supertest @types/supertest

# React component testing
npm install -D @testing-library/react @testing-library/user-event @testing-library/jest-dom
# For Next.js + Vitest:
npm install -D @vitejs/plugin-react jsdom

# Mocking HTTP (for external API calls)
npm install -D msw
```

### Environment Variables

```env
# .env.test
DATABASE_URL=postgresql://user:password@localhost:5432/mydb_test
NODE_ENV=test
JWT_SECRET=test-secret-do-not-use-in-production
```

---

## Patterns

### 1. Vitest Config — Node.js (Express API)

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,           // no need to import describe/it/expect
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/test/**', 'src/**/*.d.ts', 'src/**/index.ts'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    // Run tests in band for tests that share DB state
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
});
```

```typescript
// src/test/setup.ts
import { beforeAll, afterAll, afterEach, vi } from 'vitest';

// Load test env
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

// Global cleanup after each test
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// Database setup — run migrations once before all tests
beforeAll(async () => {
  // await runMigrations(); // run migrations if needed
});

afterAll(async () => {
  // await pool.end();
});
```

---

### 2. Jest Config — Node.js / TypeScript

```typescript
// jest.config.ts
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts', '**/*.spec.ts'],
  setupFilesAfterFramework: ['<rootDir>/src/test/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/test/**'],
  coverageThreshold: {
    global: { statements: 80, branches: 75, functions: 80, lines: 80 },
  },
  clearMocks: true,
  restoreMocks: true,
};

export default config;
```

---

### 3. Vitest + React (Next.js / Vite)

```typescript
// vitest.config.ts (React / Next.js)
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup-react.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', '**/*.stories.tsx'],
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

```typescript
// src/test/setup-react.ts
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { server } from './mocks/server'; // MSW server

// Cleanup DOM after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Start/stop MSW mock server
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

---

### 4. Supertest — Express API Integration Tests

```typescript
// src/test/helpers/app.ts — shared app instance for tests
import { createApp } from '../../app';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';

export const app = createApp();
export const request = supertest(app);

export function createAuthToken(payload: {
  sub: string;
  email: string;
  role?: string;
}): string {
  return jwt.sign(
    { sub: payload.sub, email: payload.email, role: payload.role ?? 'USER' },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );
}

export const testUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'test@example.com',
  name: 'Test User',
  role: 'USER',
};

export const adminUser = {
  id: '00000000-0000-0000-0000-000000000002',
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'ADMIN',
};
```

```typescript
// src/routes/__tests__/posts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { request, createAuthToken, testUser } from '../test/helpers/app';

// Mock the DB module so tests are fast and don't need a real DB
vi.mock('../../db', () => ({
  db: {
    query: {
      posts: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn() })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn() })),
      })),
    })),
  },
}));

import { db } from '../../db';

const token = createAuthToken({ sub: testUser.id, email: testUser.email });

describe('GET /api/v1/posts', () => {
  beforeEach(() => {
    vi.mocked(db.query.posts.findMany).mockResolvedValue([
      {
        id: 'post-1',
        title: 'Hello World',
        slug: 'hello-world',
        content: 'Content here',
        published: true,
        authorId: testUser.id,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ]);
  });

  it('returns a list of posts', async () => {
    const res = await request.get('/api/v1/posts').expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Hello World');
    expect(res.body.pagination).toBeDefined();
  });

  it('accepts limit and cursor query params', async () => {
    await request.get('/api/v1/posts?limit=5').expect(200);
    expect(db.query.posts.findMany).toHaveBeenCalled();
  });

  it('rejects invalid limit', async () => {
    const res = await request.get('/api/v1/posts?limit=999').expect(400);
    expect(res.body.error).toBe('Invalid query parameters');
  });
});

describe('POST /api/v1/posts', () => {
  it('requires authentication', async () => {
    await request
      .post('/api/v1/posts')
      .send({ title: 'Test', content: 'Content', slug: 'test' })
      .expect(401);
  });

  it('validates the request body', async () => {
    const res = await request
      .post('/api/v1/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '' }) // missing required fields
      .expect(400);

    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details.fieldErrors).toBeDefined();
  });

  it('creates a post', async () => {
    const newPost = {
      id: 'post-new',
      title: 'New Post',
      slug: 'new-post',
      content: 'Some content',
      published: false,
      authorId: testUser.id,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    const mockReturning = vi.fn().mockResolvedValue([newPost]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

    const res = await request
      .post('/api/v1/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New Post', slug: 'new-post', content: 'Some content' })
      .expect(201);

    expect(res.body.data.title).toBe('New Post');
  });
});
```

---

### 5. Module Mocking Patterns

```typescript
// Mocking a module entirely (Vitest)
vi.mock('../../lib/s3', () => ({
  generatePresignedUploadUrl: vi.fn().mockResolvedValue({
    uploadUrl: 'https://s3.example.com/upload',
    key: 'uploads/test.jpg',
    publicUrl: 'https://cdn.example.com/uploads/test.jpg',
    expiresAt: new Date(Date.now() + 300_000),
  }),
  deleteS3Object: vi.fn().mockResolvedValue(undefined),
}));

// Mocking a specific method with a spy
import * as emailModule from '../../lib/email/send';
vi.spyOn(emailModule, 'sendVerificationEmail').mockResolvedValue({ id: 'email-123' });

// Restore after test
afterEach(() => vi.restoreAllMocks());

// Mocking environment variables
beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.AWS_REGION = 'us-east-1';
});

// Mocking Date
it('uses the current timestamp', () => {
  const fixedDate = new Date('2024-01-01T00:00:00Z');
  vi.setSystemTime(fixedDate);

  const result = createTimestamp();
  expect(result).toEqual(fixedDate);

  vi.useRealTimers();
});

// Mocking timers
it('calls callback after delay', async () => {
  vi.useFakeTimers();
  const callback = vi.fn();

  scheduleAfter(1000, callback);
  expect(callback).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1000);
  expect(callback).toHaveBeenCalledOnce();

  vi.useRealTimers();
});
```

---

### 6. React Component Testing with React Testing Library

```tsx
// src/components/__tests__/SearchInput.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchInput } from '../SearchInput';

describe('SearchInput', () => {
  it('renders with placeholder', () => {
    render(<SearchInput onSearch={vi.fn()} placeholder="Search posts..." />);
    expect(screen.getByPlaceholderText('Search posts...')).toBeInTheDocument();
  });

  it('calls onSearch after debounce delay', async () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });

    render(<SearchInput onSearch={onSearch} debounceMs={300} />);
    const input = screen.getByRole('searchbox');

    await user.type(input, 'hello');
    expect(onSearch).not.toHaveBeenCalled(); // debounce not yet fired

    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(onSearch).toHaveBeenCalledWith('hello');
    expect(onSearch).toHaveBeenCalledTimes(1); // only once, not once per char

    vi.useRealTimers();
  });

  it('clears input and calls onSearch with empty string', async () => {
    const onSearch = vi.fn();
    const user = userEvent.setup();

    render(<SearchInput onSearch={onSearch} initialValue="hello" debounceMs={0} />);

    const clearBtn = screen.getByRole('button');
    await user.click(clearBtn);

    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(onSearch).toHaveBeenCalledWith('');
  });

  it('shows loading spinner when isLoading is true', () => {
    render(<SearchInput onSearch={vi.fn()} isLoading={true} />);
    expect(document.querySelector('svg.animate-spin')).toBeInTheDocument();
  });
});
```

```tsx
// src/components/__tests__/FileUploader.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileUploader } from '../FileUploader';

// Mock fetch for presign endpoint
global.fetch = vi.fn();
// Mock XMLHttpRequest for S3 upload
class MockXHR {
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 200;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn(() => setTimeout(() => this.onload?.(), 0));
}

describe('FileUploader', () => {
  const onUploadComplete = vi.fn();

  beforeEach(() => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          uploadUrl: 'https://s3.example.com/put',
          key: 'uploads/test.jpg',
          publicUrl: 'https://cdn.example.com/uploads/test.jpg',
        },
      }),
    } as any);

    (global as any).XMLHttpRequest = MockXHR;
  });

  it('shows idle state initially', () => {
    render(<FileUploader onUploadComplete={onUploadComplete} />);
    expect(screen.getByText(/drag & drop/i)).toBeInTheDocument();
  });

  it('calls onUploadComplete after successful upload', async () => {
    render(<FileUploader onUploadComplete={onUploadComplete} />);

    const file = new File(['content'], 'photo.jpg', { type: 'image/jpeg' });
    const input = document.querySelector('input[type="file"]')!;
    await userEvent.upload(input, file);

    await waitFor(() => {
      expect(onUploadComplete).toHaveBeenCalledWith(
        expect.objectContaining({ publicUrl: 'https://cdn.example.com/uploads/test.jpg' })
      );
    });
  });
});
```

---

### 7. MSW (Mock Service Worker) — Mock External APIs

```typescript
// src/test/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  // Mock Resend email API
  http.post('https://api.resend.com/emails', () => {
    return HttpResponse.json({ id: 'email-mock-id' }, { status: 200 });
  }),

  // Mock S3 presigned URL upload
  http.put('https://*.s3.amazonaws.com/*', () => {
    return new HttpResponse(null, { status: 200 });
  }),

  // Mock an external REST API
  http.get('https://api.github.com/users/:username', ({ params }) => {
    return HttpResponse.json({
      login: params.username,
      id: 12345,
      name: 'Mock User',
    });
  }),

  // Simulate a network error
  http.get('https://api.flaky.com/data', () => {
    return HttpResponse.error();
  }),
];
```

```typescript
// src/test/mocks/server.ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
```

```typescript
// Override handlers per-test
import { server } from '../test/mocks/server';
import { http, HttpResponse } from 'msw';

it('handles Resend API failure', async () => {
  server.use(
    http.post('https://api.resend.com/emails', () => {
      return HttpResponse.json({ error: 'API error' }, { status: 500 });
    })
  );

  await expect(sendVerificationEmail({ to: 'a@b.com', username: 'Test', token: 'abc' }))
    .rejects.toThrow('Failed to send email');
});
```

---

### 8. Test Utilities and Custom Matchers

```typescript
// src/test/utils.ts
import { db } from '../db';
import { users, posts } from '../db/schema';
import { createAuthToken } from './helpers/app';
import type { InferInsertModel } from 'drizzle-orm';

// DB factory helpers — create test records and clean up after
export async function createTestUser(
  overrides: Partial<InferInsertModel<typeof users>> = {}
) {
  const [user] = await db.insert(users).values({
    email: `test-${Date.now()}@example.com`,
    name: 'Test User',
    role: 'USER',
    ...overrides,
  }).returning();
  return user;
}

export async function createTestPost(
  authorId: string,
  overrides: Partial<InferInsertModel<typeof posts>> = {}
) {
  const [post] = await db.insert(posts).values({
    title: 'Test Post',
    slug: `test-post-${Date.now()}`,
    content: 'Test content',
    published: false,
    authorId,
    ...overrides,
  }).returning();
  return post;
}

// Teardown helper — delete all test data in reverse FK order
export async function cleanTestData() {
  await db.delete(posts).execute();
  await db.delete(users).execute();
}

// Auth header helper
export function authHeader(userId: string, email: string, role = 'USER') {
  const token = createAuthToken({ sub: userId, email, role });
  return { Authorization: `Bearer ${token}` };
}

// Custom Vitest matchers
import { expect } from 'vitest';

expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    return {
      pass,
      message: () =>
        `expected ${received} to be within [${floor}, ${ceiling}]`,
    };
  },
  toHaveErrorCode(received: { body: { code?: string } }, code: string) {
    const pass = received.body?.code === code;
    return {
      pass,
      message: () =>
        `expected response to have error code "${code}", got "${received.body?.code}"`,
    };
  },
});

// Type declaration for custom matchers
declare module 'vitest' {
  interface Assertion<R = any> {
    toBeWithinRange(floor: number, ceiling: number): R;
    toHaveErrorCode(code: string): R;
  }
}
```

---

### 9. Coverage and CI Configuration

```json
// package.json scripts
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage",
    "test:ci": "vitest run --coverage --reporter=verbose"
  }
}
```

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: user
          POSTGRES_PASSWORD: password
          POSTGRES_DB: mydb_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run test:ci
        env:
          DATABASE_URL: postgresql://user:password@localhost:5432/mydb_test
          JWT_SECRET: ci-test-secret
      - uses: codecov/codecov-action@v4
        with: { file: ./coverage/lcov.info }
```

---

## Common Mistakes

- **Using `vi.mock()` after imports**: `vi.mock()` calls are hoisted to the top of the file by Vitest/Jest. Always place them at the top level of the file, before any code that uses the mocked module, and do not use variables defined in the test scope inside `vi.mock()` factory functions.

- **Not clearing mocks between tests**: Use `clearMocks: true` in the config or call `vi.clearAllMocks()` in `afterEach`. Otherwise mock call counts and return values bleed between tests.

- **Using `setTimeout` for async waits in tests**: Never `await new Promise(r => setTimeout(r, 500))`. Use `await waitFor(() => expect(...))` from Testing Library, or `vi.advanceTimersByTimeAsync()` with fake timers.

- **Asserting on implementation details instead of behavior**: Do not test that a specific internal function was called. Test what the user or API consumer sees. Use `getByRole`, `getByText`, or response body assertions.

- **Sharing database state between tests**: Tests that write to a real DB must isolate their data. Use transactions that roll back, or delete inserted records in `afterEach`. Never rely on insertion order across test files.

- **Forgetting to restore `vi.setSystemTime`**: Always call `vi.useRealTimers()` in `afterEach` or `finally` when using `vi.useFakeTimers()`, otherwise time is frozen for all subsequent tests.

- **Not testing error paths**: Always test what happens when the DB returns null, an external API fails, or validation rejects input. Error handling code is the most likely place for bugs.

---

## Framework-Specific Notes

### Next.js

- For App Router Route Handler testing, use Vitest with `environment: 'node'` and test them via Supertest wrapping a custom server, or test the handler function directly by constructing a `NextRequest`.
- Server Actions cannot be tested directly with Supertest. Extract the business logic into a service function and test the service layer.
- For Client Component tests, use `environment: 'jsdom'` and mock `next/navigation` hooks:
  ```typescript
  vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/',
  }));
  ```

### Express

- Always test the full HTTP layer (method, URL, headers, body, status code) via Supertest rather than calling route handler functions directly. This ensures middleware runs correctly.
- Use a separate test database or transactions to avoid polluting development data.
- Test middleware in isolation by calling it as a function with mock `req`, `res`, and `next`, then asserting on `next` call arguments.
