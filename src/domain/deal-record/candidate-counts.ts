import { z } from 'zod';
import { RouteType } from './enums.js';

/**
 * Aggregate counts for the review-queue view-cards + filter rail (ACR-5).
 *
 * Backs `GET /api/candidates/counts`. The panel's queue screen renders four
 * view-cards and a per-route filter rail from these numbers; computing them from
 * filtered list reads (one read per card) is wasteful and — for `rejected_today`
 * — can't express a real date bound from a single page of results. So the counts
 * are computed server-side in ONE call.
 *
 * Split by source:
 *  - the deal-derived counts (`all_pending`, `low_confidence`, `human_edited`,
 *    `by_route`) come from the `deals` table over the reviewable statuses;
 *  - `rejected_today` comes from the `reviews` AUDIT log (a reject appends a row),
 *    date-bounded to the current UTC day — the only true "today" count, since a
 *    deal's row carries no reject timestamp distinct from its other lifecycle.
 *
 * Both DB adapters MUST produce identical numbers for the same data (LSP); the
 * pure threshold + the reviewable-status set live in the domain so neither adapter
 * re-defines them.
 */

/**
 * The confidence at/below which a reviewable candidate is "low confidence" for the
 * queue's low-confidence card (inclusive). A domain constant so both adapters and
 * the card agree on the same cut.
 */
export const LOW_CONFIDENCE_MAX = 0.5;

/** Per-route reviewable counts — every {@link RouteType} key present (0 when none). */
export const CandidateCountsByRouteSchema = z.object({
  bundle: z.number().int().nonnegative(),
  standalone: z.number().int().nonnegative(),
  promo: z.number().int().nonnegative(),
  regional: z.number().int().nonnegative(),
});
export type CandidateCountsByRoute = z.infer<typeof CandidateCountsByRouteSchema>;

export const CandidateCountsSchema = z.object({
  /** Reviewable deals (status `candidate` + `in_review`). */
  all_pending: z.number().int().nonnegative(),
  /** Reviewable deals with `confidence <= LOW_CONFIDENCE_MAX`. */
  low_confidence: z.number().int().nonnegative(),
  /** Reviewable deals a human has corrected (`human_edited` non-empty). */
  human_edited: z.number().int().nonnegative(),
  /** Deals rejected on the current UTC day, from the reviews audit log. */
  rejected_today: z.number().int().nonnegative(),
  /** Reviewable deals broken down by route type. */
  by_route: CandidateCountsByRouteSchema,
});
export type CandidateCounts = z.infer<typeof CandidateCountsSchema>;

/** The deal-derived slice of the counts (everything except `rejected_today`). */
export type CandidateDealCounts = Omit<CandidateCounts, 'rejected_today'>;

/** A zero-filled by-route map — the starting point both adapters tally onto. */
export function zeroByRoute(): CandidateCountsByRoute {
  return { bundle: 0, standalone: 0, promo: 0, regional: 0 };
}

/** Type-guard a string as a known route key (defends the adapter tally loops). */
export function isRouteType(value: string): value is RouteType {
  return value === 'bundle' || value === 'standalone' || value === 'promo' || value === 'regional';
}
