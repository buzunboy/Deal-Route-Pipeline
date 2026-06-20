# DealRoute pipeline — runs as scheduled jobs + an on-demand trigger.
# Uses Playwright's image so the default fetcher's Chromium + system deps are present.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS base
WORKDIR /app
# NOTE: NODE_ENV is intentionally NOT set to production here. This `base` stage
# feeds `deps`/`build`, which need devDependencies (TypeScript) — with
# NODE_ENV=production, `npm ci` omits devDeps and `npm run build` fails with
# `tsc: not found`. NODE_ENV=production is set on the `runtime` stage only.
# Git hooks (husky) are a dev-only concern; disable them in the image so the
# `prepare` lifecycle script never tries to install hooks during `npm ci`
# (no .git here, and husky isn't present in the prod-only `--omit=dev` install).
ENV HUSKY=0

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
ENV NODE_ENV=production
# Production deps only.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# `drizzle/` holds the SQL migrations the entrypoint applies on start.
COPY drizzle ./drizzle
COPY docs ./docs
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# The entrypoint applies pending migrations (idempotent), then runs the CLI with
# the passed command, e.g. `crawl --due`, `serve`, `monitor --due`. Set
# RUN_MIGRATIONS=false to skip migrating (when a separate job owns the schema).
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["help"]
