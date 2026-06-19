import { z } from 'zod';

/**
 * An append-only record of one human review decision on a candidate deal.
 *
 * The deal itself carries only its CURRENT verification state (`status`,
 * `verified_by`, `verified_at`); this table is the immutable AUDIT LOG of who
 * decided what, when, and why — a trust requirement (the product's value is
 * trust, and publication is gated on human review). Rows are never updated or
 * deleted; a re-decision appends a new row.
 */
export const ReviewAction = z.enum(['approve', 'reject']);
export type ReviewAction = z.infer<typeof ReviewAction>;

export const ReviewRecordSchema = z.object({
  id: z.string().uuid(),
  deal_id: z.string().uuid(),
  action: ReviewAction,
  /** The reviewer's identity (no anonymous decisions). */
  approver: z.string().min(1),
  /** Optional free-text reason (e.g. why a candidate was rejected). */
  reason: z.string().nullable().default(null),
  /** ISO-8601 timestamp of the decision. */
  decided_at: z.string().min(1),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
