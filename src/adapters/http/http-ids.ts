/**
 * Shared HTTP id-boundary helper. Both routers take a `:id` path segment that maps to
 * a Postgres `uuid` column; a non-UUID value (e.g. `GET /v1/deals/abc`) would otherwise
 * reach the DB and surface as a 500 (`invalid input syntax for type uuid`). Validating
 * the shape at the boundary lets the caller 404 a malformed id cleanly — the same
 * response a valid-but-missing id gets — without leaking a DB error.
 *
 * The in-memory adapter accepts any string as a key, so this guard also keeps the two
 * adapters behaving the same at the HTTP edge (a malformed id is "not found" on both).
 */

/**
 * Canonical UUID shape (any version), case-insensitive — as an UNANCHORED fragment so
 * it can be both tested whole (here) and embedded in a route regex (the review API's
 * `:id` routes). The ONE source of truth for "a `uuid` column's accepted form"; keep
 * both id boundaries (this matcher + the route segments) keyed off it so they can't drift.
 */
export const UUID_PATTERN =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);

/** True when `value` is a syntactically valid UUID (the `uuid` column's accepted form). */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
