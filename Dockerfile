# DealRoute pipeline — runs as scheduled jobs + an on-demand trigger.
# Uses Playwright's image so the default fetcher's Chromium + system deps are present.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS base
WORKDIR /app
ENV NODE_ENV=production

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
# Production deps only.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY docs ./docs

# The CLI is the entrypoint; pass a command, e.g. `crawl --due`, `serve`, `monitor --due`.
ENTRYPOINT ["node", "dist/adapters/cli/main.js"]
CMD ["help"]
