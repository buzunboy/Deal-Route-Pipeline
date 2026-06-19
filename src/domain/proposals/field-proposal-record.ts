import { z } from 'zod';

/**
 * A persisted, aggregated field proposal. The pipeline counts proposals by
 * `suggested_key`; once `count` crosses a human-set threshold the proposal
 * surfaces for promotion into the `condition_vocabulary` (or a first-class
 * field) via the `promote-field-proposal` skill. Promotion is governed and
 * human-approved — the LLM never invents columns.
 */
export const FieldProposalRecordSchema = z.object({
  id: z.string().uuid(),
  suggested_key: z.string().min(1),
  label: z.string().min(1),
  rationale: z.string().min(1),
  example_quote: z.string().min(1),
  /** Number of times this key has been proposed across extractions. */
  count: z.number().int().positive().default(1),
  status: z.enum(['open', 'promoted', 'rejected']).default('open'),
  first_seen_at: z.string().min(1),
  last_seen_at: z.string().min(1),
});
export type FieldProposalRecord = z.infer<typeof FieldProposalRecordSchema>;
