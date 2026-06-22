import { z } from 'zod';
import type { ReviewAction } from '../review/review-record.js';

/**
 * Today's reviewer-throughput summary (ACR-6) — counts of the review decisions taken
 * on the current UTC day plus the average time a decided candidate had been waiting.
 * Backs `GET /api/metrics/throughput?period=today` and the Dashboard's
 * "Today's throughput" card.
 *
 * `avg_review_seconds` is the mean of `decided_at − evidence.captured_at` over today's
 * decisions (an owner decision — there is no separate "started reviewing" timestamp,
 * so capture→decision is the honest latency signal; it is dominated by queue wait).
 * It is `null` when no decision today has a resolvable capture time (the card then
 * renders an em-dash). Returned as raw SECONDS, not a pre-formatted string — the panel
 * owns display formatting (this matches the written ACR-6 contract).
 */

export const ThroughputSummarySchema = z.object({
  /** Approvals decided today (UTC). */
  approved: z.number().int().nonnegative(),
  /** Rejections decided today (UTC). */
  rejected: z.number().int().nonnegative(),
  /** Reviewer edits decided today (UTC). */
  edited: z.number().int().nonnegative(),
  /**
   * Mean `decided_at − captured_at` over today's decisions, in whole seconds, or
   * null when no decision today has a resolvable capture time. Non-negative (a
   * negative latency from clock skew is clamped to 0 before averaging).
   */
  avg_review_seconds: z.number().int().nonnegative().nullable(),
});
export type ThroughputSummary = z.infer<typeof ThroughputSummarySchema>;

/** Map a review action to its throughput counter key (the panel's three buckets). */
const ACTION_KEY: Record<ReviewAction, 'approved' | 'rejected' | 'edited'> = {
  approve: 'approved',
  reject: 'rejected',
  edit: 'edited',
};

/**
 * One decision's contribution to throughput: which action, and the latency from the
 * candidate's evidence capture to the decision (null when the capture time is
 * unknown, so the decision still counts but doesn't enter the latency average).
 */
export interface ThroughputDecision {
  action: ReviewAction;
  /** `decided_at − captured_at` in seconds, or null when capture time is unknown. */
  latencySeconds: number | null;
}

/**
 * Aggregate today's decisions into the throughput summary (pure). The use-case has
 * already bounded the input to the current UTC day and resolved each decision's
 * capture latency; this owns the count-by-action tally + the mean (clamping negative
 * latencies to 0, ignoring null-latency decisions in the average, floor to whole
 * seconds). An empty input yields all-zero counts + null average.
 */
export function buildThroughput(decisions: readonly ThroughputDecision[]): ThroughputSummary {
  let approved = 0;
  let rejected = 0;
  let edited = 0;
  let latencySum = 0;
  let latencyCount = 0;
  for (const d of decisions) {
    if (ACTION_KEY[d.action] === 'approved') approved++;
    else if (ACTION_KEY[d.action] === 'rejected') rejected++;
    else edited++;
    if (d.latencySeconds !== null) {
      latencySum += Math.max(0, d.latencySeconds);
      latencyCount++;
    }
  }
  const avg_review_seconds = latencyCount === 0 ? null : Math.floor(latencySum / latencyCount);
  return { approved, rejected, edited, avg_review_seconds };
}
