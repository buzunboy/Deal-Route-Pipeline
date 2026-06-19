import { z } from 'zod';

/**
 * An append-only record of one human review decision on a PROPOSED source (a
 * tier-4 `pending_approval` domain surfaced by discovery/ingestion). Mirrors the
 * deal `ReviewRecord`: the source carries its current `status`; this is the
 * immutable audit log of who promoted/rejected which proposed domain, when, and
 * why — the human gate on the source-promotion loop. Rows are never mutated.
 */
export const SourceReviewAction = z.enum(['approve', 'reject']);
export type SourceReviewAction = z.infer<typeof SourceReviewAction>;

export const SourceReviewRecordSchema = z.object({
  id: z.string().uuid(),
  source_id: z.string().uuid(),
  action: SourceReviewAction,
  /** The reviewer's identity (no anonymous decisions). */
  approver: z.string().min(1),
  /** Optional free-text reason (e.g. why a proposed source was rejected). */
  reason: z.string().nullable().default(null),
  /** ISO-8601 timestamp of the decision. */
  decided_at: z.string().min(1),
});
export type SourceReviewRecord = z.infer<typeof SourceReviewRecordSchema>;
