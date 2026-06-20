import { z } from 'zod';
import { Country, RouteType } from './enums.js';

/**
 * The query model for the public published-deals feed (the `/v1/deals` read API).
 *
 * These are DOMAIN types, not HTTP types: the `DealRepository.listPublished` /
 * `countPublished` port speaks in them, both DB adapters implement identical
 * filter/sort/paginate semantics over them (LSP), and the HTTP layer parses raw
 * query strings INTO them at its boundary. Keeping one typed shape means the
 * adapters and the API can never disagree on what a filter means.
 *
 * The feed ALWAYS serves `status = 'published'` only — that is not a filter the
 * caller can change; it is the trust boundary baked into the repo method.
 */

/** Default page size when the caller doesn't specify one. */
export const PUBLISHED_DEFAULT_LIMIT = 20;
/**
 * Hard ceiling on a single page. A public, unauthenticated endpoint must not let a
 * caller request an unbounded page (one looping `?limit=100000` could pin the DB
 * pool away from the admin API). Pages are capped here, in the domain, so EVERY
 * caller — HTTP today, anything later — is bounded identically. Rate-limiting
 * proper is a CDN/proxy concern (see ARCHITECTURE.md); this is the floor guard.
 */
export const PUBLISHED_MAX_LIMIT = 100;
/**
 * Hard ceiling on `offset`. Deep offsets force Postgres to scan-and-discard every
 * skipped row, so an unbounded `?offset=1000000000` is a cheap way to make the DB
 * do expensive work on an unauthenticated endpoint. Cap it; a caller needing to
 * page further than this should narrow filters (keyset pagination is a later
 * option). An over-cap offset is a 400 at the HTTP boundary, never a silent clamp.
 */
export const PUBLISHED_MAX_OFFSET = 10_000;

/**
 * Sort orders the feed offers. `cost_asc` = cheapest true monthly cost first (the
 * default product view); `verified_desc` = most-recently-verified first (freshness).
 * Both adapters must order identically — including the deterministic id tiebreaker —
 * so pagination is stable.
 */
export const PublishedSort = z.enum(['cost_asc', 'verified_desc']);
export type PublishedSort = z.infer<typeof PublishedSort>;

export const PUBLISHED_DEFAULT_SORT: PublishedSort = 'cost_asc';

/**
 * Filters a caller may apply. All optional; absent ⇒ no constraint on that field.
 * `priceMax` filters on `true_cost_monthly` (the normalised monthly figure we
 * rank on), inclusive. `service` matches exactly (case-sensitive, as stored).
 */
export const PublishedFiltersSchema = z.object({
  service: z.string().min(1).optional(),
  country: Country.optional(),
  routeType: RouteType.optional(),
  priceMax: z.number().nonnegative().optional(),
});
export type PublishedFilters = z.infer<typeof PublishedFiltersSchema>;

/** A fully-resolved, bounded query the repo executes. Built at the HTTP boundary. */
export interface PublishedQuery {
  filters: PublishedFilters;
  sort: PublishedSort;
  limit: number;
  offset: number;
}
