import { z } from 'zod';

/**
 * A grounding snippet: the exact source sentence supporting a key field.
 *
 * Grounding is required for each typed-core field the LLM fills (price,
 * eligibility flags, validity, …). It makes human review seconds-fast and
 * catches hallucination: if the quote does not actually appear in the source
 * text, validation flags it (see `validate-record`).
 */
export const GroundingSchema = z.object({
  /** The deal-record field this quote supports, e.g. `"price"`, `"eligibility.new_customer_only"`. */
  field: z.string().min(1),
  /** Exact sentence from the page. Must be a verbatim substring of the source text. */
  quote: z.string().min(1),
});
export type Grounding = z.infer<typeof GroundingSchema>;

/**
 * An LLM-proposed new condition key. The LLM never invents columns; instead it
 * proposes, and recurring proposals are promoted into the vocabulary by a human
 * (see the `promote-field-proposal` skill).
 */
export const FieldProposalSchema = z.object({
  suggested_key: z.string().min(1),
  label: z.string().min(1),
  rationale: z.string().min(1),
  example_quote: z.string().min(1),
});
export type FieldProposal = z.infer<typeof FieldProposalSchema>;
