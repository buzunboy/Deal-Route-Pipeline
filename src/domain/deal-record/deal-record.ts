import { z } from 'zod';
import { Country, DealStatus, RouteType } from './enums.js';
import { PriceSchema } from './price.js';
import { EligibilitySchema } from './eligibility.js';
import { ValiditySchema } from './validity.js';
import { GroundingSchema, FieldProposalSchema } from './grounding.js';

// v2 (2026-06-20): added `price.prepaid_months` for prepaid-term amortisation.
// v3 (2026-06-20): added `affiliate_disclosure` (default true) + `published_at`
// for the EU-Omnibus disclosure at publish (Step 2). All additive/defaulted, so
// v1/v2 rows parse unchanged.
export const CURRENT_SCHEMA_VERSION = 3 as const;

/**
 * The fields the LLM is allowed to PROPOSE for a single deal record.
 *
 * Deliberately excludes anything the LLM must not own: `id`, `schema_version`,
 * `evidence_id`, `status`, `true_cost_monthly` (derived), `verified_by/at`.
 * Raw LLM JSON is parsed through this schema at the boundary before it is
 * trusted (`.claude/rules/code-style.md`: never trust raw LLM data).
 */
export const LlmExtractedDealSchema = z.object({
  service: z.string().min(1),
  route_type: RouteType,
  provider: z.string().min(1),
  headline: z.string().min(1),
  price: PriceSchema,
  country: Country,
  eligibility: EligibilitySchema,
  validity: ValiditySchema,
  // The LLM may send `null` for an "empty" optional list/object; accept absent OR
  // null and normalise to the empty default rather than rejecting the whole deal.
  included_items: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
  /** Free-form structured extras that don't fit the typed core. Never dropped. */
  attributes: z
    .record(z.unknown())
    .nullish()
    .transform((v) => v ?? {}),
  /** Verbatim terms text from the page. Kept exactly as found. */
  raw_conditions_text: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  source_url: z.string().url(),
  /** 0..1 model confidence. Sanity rules may downgrade this; never upgrade. */
  confidence: z.number().min(0).max(1),
  grounding: z
    .array(GroundingSchema)
    .nullish()
    .transform((v) => v ?? []),
  /** True when at least one condition could not be mapped to the vocabulary. */
  unmapped_conditions: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  /** Proposed new vocabulary keys for unmapped conditions. */
  field_proposals: z
    .array(FieldProposalSchema)
    .nullish()
    .transform((v) => v ?? []),
});
export type LlmExtractedDeal = z.infer<typeof LlmExtractedDealSchema>;

/**
 * The full persisted deal record: the LLM-proposed core plus the fields the
 * pipeline owns (identity, evidence link, derived true cost, lifecycle status,
 * verification audit).
 */
export const DealRecordSchema = LlmExtractedDealSchema.extend({
  id: z.string().uuid(),
  schema_version: z.number().int().positive(),
  /** Normalised monthly cost derived deterministically from price (pure rule). */
  true_cost_monthly: z.number().nonnegative(),
  /** Link to the immutable evidence bundle captured at crawl time. */
  evidence_id: z.string().uuid(),
  status: DealStatus,
  verified_by: z.string().nullable().default(null),
  /** ISO-8601 timestamp of human verification, or null. */
  verified_at: z.string().nullable().default(null),
  /**
   * EU-Omnibus/UWG affiliate-placement disclosure for the PUBLIC feed: true when a
   * published deal may be a paid/affiliate placement. **Defaults true** — the safe
   * side is to over-disclose; a reviewer may set it false at approve-time for a
   * non-affiliate deal. Set by the human at publish, never LLM-proposed. Exposed in
   * the public DTO so the landing page can render the legally-required disclosure.
   */
  affiliate_disclosure: z.boolean().default(true),
  /**
   * ISO-8601 timestamp of when a human PUBLISHED this deal — distinct from
   * `verified_at` (last verification). Null until published. Set on the approve path.
   */
  published_at: z.string().nullable().default(null),
});
export type DealRecord = z.infer<typeof DealRecordSchema>;
