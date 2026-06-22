import type { DealRecord } from './deal-record.js';

/**
 * The admin (gated) "Published deals" screen projection + query (ACR-10).
 *
 * Distinct from the PUBLIC feed (`published-query` / `public-dto`): the admin screen
 * shows publication HISTORY, so it includes deals that have LEFT the published set
 * (`expired`), mapped to a panel-facing lifecycle status. It is Bearer-gated, so —
 * unlike the public DTO's strict allow-list — it can surface internal-ish fields the
 * reviewer needs; we still keep it a small curated row (the panel's exact columns),
 * not the whole record.
 */

/** Default page size for the admin published screen. */
export const ADMIN_PUBLISHED_DEFAULT_LIMIT = 50;
/** Hard ceiling on a single admin-published page (bound the gated read's work). */
export const ADMIN_PUBLISHED_MAX_LIMIT = 200;
/** Hard ceiling on `offset` (deep offsets scan-and-discard; bound the work). */
export const ADMIN_PUBLISHED_MAX_OFFSET = 100_000;

/**
 * The deal statuses the admin published screen lists: `published` (currently live)
 * and `expired` (was live, now off). Ordered newest-published-first then id.
 */
export const ADMIN_PUBLISHED_STATUSES = ['published', 'expired'] as const;

/** The panel-facing lifecycle status for an admin published row. */
export type AdminPublishedStatus = 'live' | 're-review' | 'unpublished';

/** One row on the admin "Published deals" screen. */
export interface AdminPublishedDeal {
  id: string;
  service: string;
  provider: string;
  /** The deal's country (the panel labels this column "geo"). */
  geo: string;
  /** The amortised monthly true cost (the panel labels this "true_monthly"). */
  true_monthly: number;
  /** ISO-8601 publish instant, or null if never stamped. */
  published_at: string | null;
  status: AdminPublishedStatus;
}

/** A fully-resolved, bounded admin-published query the repo executes. */
export interface AdminPublishedQuery {
  limit: number;
  offset: number;
}

/**
 * Map a stored deal's lifecycle status to the panel's published-screen status.
 * `published` → live; `expired` → unpublished. (`re-review` has no single backing
 * pipeline status — a re-queued deal returns to `candidate`/`in_review` and so isn't
 * in the published set at all — so it is never emitted today; it stays in the union
 * for forward-compatibility with the panel's column.)
 */
export function toAdminPublishedStatus(dealStatus: string): AdminPublishedStatus {
  return dealStatus === 'expired' ? 'unpublished' : 'live';
}

/** Project a stored deal into an admin published-screen row (pure). */
export function toAdminPublishedDeal(deal: DealRecord): AdminPublishedDeal {
  return {
    id: deal.id,
    service: deal.service,
    provider: deal.provider,
    geo: deal.country,
    true_monthly: deal.true_cost_monthly,
    published_at: deal.published_at,
    status: toAdminPublishedStatus(deal.status),
  };
}
