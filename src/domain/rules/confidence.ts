import type { LlmExtractedDeal } from '../deal-record/index.js';

/** Confidence at or below this lands a candidate in must-review regardless of rules. */
export const MUST_REVIEW_CONFIDENCE_THRESHOLD = 0.7;

/** Penalty applied per failed sanity rule (never raises confidence). */
const PER_FAILURE_PENALTY = 0.2;
/** Penalty when a key field lacks a grounding quote. */
const MISSING_GROUNDING_PENALTY = 0.15;

/** Key typed-core fields that should each carry a grounding quote. */
export const KEY_GROUNDED_FIELDS = ['price', 'eligibility', 'validity'] as const;

/**
 * Adjust the model's self-reported confidence downward based on deterministic
 * signals. Confidence is only ever lowered, never raised — a wrong deal slipping
 * through is the worst-case bug, so we are conservative by construction.
 *
 * Pure: same inputs ⇒ same output, clamped to [0, 1].
 */
export function adjustConfidence(
  deal: Pick<LlmExtractedDeal, 'confidence' | 'grounding'>,
  failedRuleCount: number,
): number {
  const groundedFields = new Set(deal.grounding.map((g) => topLevelField(g.field)));
  const missingGrounding = KEY_GROUNDED_FIELDS.filter((f) => !groundedFields.has(f)).length;

  const penalty =
    failedRuleCount * PER_FAILURE_PENALTY + missingGrounding * MISSING_GROUNDING_PENALTY;

  return clamp01(deal.confidence - penalty);
}

/** A candidate must go to human review if confidence is low or any rule failed. */
export function mustReview(adjustedConfidence: number, failedRuleCount: number): boolean {
  return adjustedConfidence <= MUST_REVIEW_CONFIDENCE_THRESHOLD || failedRuleCount > 0;
}

/** `eligibility.new_customer_only` → `eligibility`. */
function topLevelField(field: string): string {
  const dot = field.indexOf('.');
  return dot === -1 ? field : field.slice(0, dot);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
