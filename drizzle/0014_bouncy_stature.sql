-- Make `sources.url` unique (the natural key) so `sources.upsert` is idempotent.
-- Before this, the upsert keyed on the random `id`, so re-running seed-import
-- INSERTed duplicate rows (observed: 49 -> 98). Adding the unique index alone would
-- FAIL on a DB that already has duplicates, so first collapse any duplicate URLs to a
-- single row (keep the earliest-seen, then lowest id), then create the index.
DELETE FROM "sources" a
USING "sources" b
WHERE a."url" = b."url"
  AND (
    COALESCE(a."last_seen", 'epoch'::timestamptz), a."id"
  ) > (
    COALESCE(b."last_seen", 'epoch'::timestamptz), b."id"
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "sources_url_unique" ON "sources" USING btree ("url");
