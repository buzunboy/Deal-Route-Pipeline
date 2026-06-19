import { z } from 'zod';

/**
 * A detected change between two crawls of the same source/deal. Monitoring diffs
 * the price/terms region (via the evidence `content_hash`); a change re-extracts
 * and re-queues for review while KEEPING the old evidence. Disappearance/expiry
 * auto-expires the deal.
 */
export const ChangeSchema = z.object({
  id: z.string().uuid(),
  deal_id: z.string().uuid().nullable(),
  source_id: z.string().uuid(),
  kind: z.enum(['content_changed', 'disappeared', 'unchanged']),
  previous_hash: z.string().nullable(),
  current_hash: z.string().nullable(),
  detected_at: z.string().min(1),
});
export type Change = z.infer<typeof ChangeSchema>;
