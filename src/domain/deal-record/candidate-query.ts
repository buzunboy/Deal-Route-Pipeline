import { z } from 'zod';
import { DealStatus } from './enums.js';

/**
 * The query model for the GATED admin candidate-review feed (`GET /api/candidates`).
 *
 * Sibling to {@link PublishedQuery} but for the internal review queue, not the
 * public feed: it can filter by ANY status (the public feed is locked to
 * `published`) and surfaces low-confidence candidates for triage. Same discipline
 * — one DOMAIN shape that the `DealRepository.listCandidates` port speaks, both DB
 * adapters implement identically (LSP), and the HTTP layer parses raw query strings
 * into. Absent filter ⇒ no constraint, so the default query reproduces the original
 * "candidate + in_review, newest-confidence-first" behaviour.
 */

/** Default page size for the review queue when the caller doesn't specify one. */
export const CANDIDATES_DEFAULT_LIMIT = 50;
/**
 * Hard ceiling on a single review-queue page. The endpoint is Bearer-gated (not
 * public) so the abuse surface is smaller than the public feed, but an unbounded
 * page would still let one request pin the DB pool — cap it in the domain so every
 * caller is bounded identically.
 */
export const CANDIDATES_MAX_LIMIT = 200;
/** Hard ceiling on `offset` (deep offsets scan-and-discard; bound the work). */
export const CANDIDATES_MAX_OFFSET = 100_000;

/**
 * The statuses the review queue defaults to when the caller gives no `status`
 * filter: the two pre-approval states a reviewer acts on. An explicit `status`
 * filter narrows to exactly that one status (including terminal ones, so a reviewer
 * can audit published/rejected/expired deals too).
 */
export const REVIEWABLE_STATUSES: readonly DealStatus[] = [
  DealStatus.enum.candidate,
  DealStatus.enum.in_review,
];

/**
 * Filters a reviewer may apply. All optional; absent ⇒ no constraint on that field.
 * `status` narrows to a single status (default: the reviewable pair). `service`
 * matches exactly (case-sensitive, as stored). `confidenceMax` is inclusive on the
 * deal's stored `confidence` — surfaces the lowest-confidence candidates for triage.
 */
export const CandidateFiltersSchema = z.object({
  status: DealStatus.optional(),
  service: z.string().min(1).optional(),
  confidenceMax: z.number().min(0).max(1).optional(),
});
export type CandidateFilters = z.infer<typeof CandidateFiltersSchema>;

/** A fully-resolved, bounded candidate query the repo executes. */
export interface CandidateQuery {
  filters: CandidateFilters;
  limit: number;
  offset: number;
}
