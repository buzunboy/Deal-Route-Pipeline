#!/bin/sh
# Container entrypoint: apply pending DB migrations, then run the CLI with the
# passed command. A first deploy (or a deploy that adds a migration) brings the
# schema up to date BEFORE the app touches it — otherwise the first command hits
# missing tables (Pre-C-2: "Dockerfile never runs migrations").
#
# Migrations are idempotent (drizzle tracks applied ones), so running this on
# every container start is safe. Set RUN_MIGRATIONS=false to skip (e.g. when an
# external migration job owns the schema and app containers must not race it).
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "entrypoint: applying database migrations..."
  node dist/adapters/db/migrate.js
fi

# Hand off to the CLI with whatever command was passed (crawl --due, serve, ...).
exec node dist/adapters/cli/main.js "$@"
