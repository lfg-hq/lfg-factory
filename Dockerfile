FROM oven/bun:1.2-slim AS base
WORKDIR /app

# Install dependencies (separate layer for caching)
FROM base AS deps
COPY package.json bun.lock ./
# --ignore-scripts skips better-sqlite3's native build (not needed in production — we use PostgreSQL)
RUN bun install --frozen-lockfile --production --ignore-scripts

# Check application imports using the same dependencies as the runtime image.
# Bun performs this check itself; no second install or native postinstall is needed.
FROM deps AS builder
COPY . .
RUN bun build src/index.ts --target=bun --packages=external --outdir=/tmp/lfg-import-check

# Final runtime image
FROM base AS runner

# curl for health checks; nodejs because the preview screenshot runs
# scripts/screenshot-worker.mjs via `spawn("node", …)` — Playwright hangs under
# Bun, so we drive the remote CDP browser with Node. Without node here the
# screenshot feature fails with "spawn node ENOENT" in production.
RUN apt-get update && apt-get install -y --no-install-recommends curl nodejs && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN addgroup --system --gid 1001 bunjs && \
    adduser --system --uid 1001 bunjs

# Copy production deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder --chown=bunjs:bunjs /app/src ./src
COPY --chown=bunjs:bunjs . .

# Persistent volumes for SQLite db and user uploads
RUN mkdir -p /app/data /app/uploads && \
    chown -R bunjs:bunjs /app/data /app/uploads

USER bunjs

EXPOSE 8000

# Run DB migrations then start server
CMD ["sh", "-c", "bun run scripts/safe-schema-push.ts && bun run src/index.ts"]
