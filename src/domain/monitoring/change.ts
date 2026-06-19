import { z } from 'zod';

/**
 * A detected change between two crawls of the same source/deal. Monitoring diffs
 * the price/terms region (via the evidence `content_hash`):
 *  - `content_changed` → re-extract + re-queue, KEEPING the old evidence;
 *  - `disappeared`     → the page is unreachable (an `error` fetch). Auto-expiry
 *    only fires after N consecutive disappearances, so a single transient error
 *    never retracts a verified deal;
 *  - `blocked`         → login/captcha/anti-bot. NOT proof the offer is gone:
 *    routed to manual capture, never auto-expired;
 *  - `unchanged`       → recorded for audit.
 */
export const ChangeKind = z.enum(['content_changed', 'disappeared', 'blocked', 'unchanged']);
export type ChangeKind = z.infer<typeof ChangeKind>;

export const ChangeSchema = z.object({
  id: z.string().uuid(),
  deal_id: z.string().uuid().nullable(),
  source_id: z.string().uuid(),
  kind: ChangeKind,
  previous_hash: z.string().nullable(),
  current_hash: z.string().nullable(),
  detected_at: z.string().min(1),
});
export type Change = z.infer<typeof ChangeSchema>;
