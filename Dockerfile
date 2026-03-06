FROM oven/bun:1.2-slim AS base
WORKDIR /app

# Install dependencies (separate layer for caching)
FROM base AS deps
COPY package.json bun.lock ./
# --ignore-scripts skips better-sqlite3's native build (not needed in production — we use PostgreSQL)
RUN bun install --frozen-lockfile --production --ignore-scripts

# Build stage — install all deps (including dev) for type checking
FROM base AS builder
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

# Final runtime image
FROM base AS runner

# Create non-root user
RUN addgroup --system --gid 1001 bunjs && \
    adduser --system --uid 1001 bunjs

# Copy production deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=bunjs:bunjs . .

# Persistent volumes for SQLite db and user uploads
RUN mkdir -p /app/data /app/uploads && \
    chown -R bunjs:bunjs /app/data /app/uploads

USER bunjs

EXPOSE 8000

# Run DB migrations then start server
CMD ["sh", "-c", "bun run db:push && bun run src/index.ts"]
