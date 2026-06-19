import { z } from 'zod';
import { LlmExtractedDealSchema, type LlmExtractedDeal } from './deal-record/index.js';
import { BoundaryValidationError } from './errors/index.js';

/**
 * The LLM is asked to return a JSON object `{ "deals": [...] }`. A page may hold
 * zero or more offers, so `deals` is an array (possibly empty).
 */
const LlmExtractionEnvelope = z.object({
  deals: z.array(LlmExtractedDealSchema),
});
export type LlmExtractionEnvelope = z.infer<typeof LlmExtractionEnvelope>;

/**
 * Parse raw LLM output into typed deals at the trust boundary.
 *
 * NEVER trust raw LLM data (`code-style.md`): structurally invalid output raises
 * a typed `BoundaryValidationError` carrying the schema issues, rather than
 * letting malformed data leak into the domain. Accepts either a parsed object or
 * a JSON string.
 */
export function parseLlmDeals(raw: unknown): LlmExtractedDeal[] {
  const candidate = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  const result = LlmExtractionEnvelope.safeParse(candidate);

  if (!result.success) {
    throw new BoundaryValidationError(
      'LLM output failed schema validation.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data.deals;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new BoundaryValidationError('LLM output was not valid JSON.', [
      { path: '$', message: err instanceof Error ? err.message : 'unknown parse error' },
    ]);
  }
}
