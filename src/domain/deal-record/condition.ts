import { z } from 'zod';

/**
 * A long-tail eligibility/validity condition.
 *
 * Each condition maps to a key in the controlled `condition_vocabulary`. When the
 * LLM hits a condition with no known key it does NOT invent a column: it records
 * the condition with `key: "other"`, the page sets `unmapped_conditions: true`,
 * and a `field_proposals` entry is emitted (governed promotion loop).
 *
 * `source_quote` is the verbatim sentence from the page that grounds the
 * condition — never paraphrased, never invented.
 */
export const ConditionSchema = z.object({
  /** Canonical vocabulary key, or the literal `"other"` for an unmapped condition. */
  key: z.string().min(1),
  /** Human-readable label (from the vocabulary, or a proposed label for `other`). */
  label: z.string().min(1),
  /** Optional structured payload for the condition (e.g. `{ months: 6 }`). */
  value: z.record(z.unknown()).optional(),
  /** Exact source sentence supporting this condition. Required — no grounding, no condition. */
  source_quote: z.string().min(1),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const OTHER_CONDITION_KEY = 'other' as const;
