import { z } from 'zod';
import { BoundaryValidationError } from '../errors/index.js';

/**
 * The triage LLM's verdict on a community feed item (Lane B). Parsed at the
 * boundary like all LLM output — never trusted raw. `relevant` gates whether we
 * spend a fetch+extract on the lead; `service` is the matched catalog service.
 */
export const TriageResultSchema = z.object({
  relevant: z.boolean(),
  service: z.string().nullable().default(null),
  reason: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

/** Parse raw triage LLM output into a typed result (throws on bad shape). */
export function parseTriageResult(raw: unknown): TriageResult {
  const candidate = typeof raw === 'string' ? safeJson(raw) : raw;
  const result = TriageResultSchema.safeParse(candidate);
  if (!result.success) {
    throw new BoundaryValidationError(
      'Triage output failed schema validation.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new BoundaryValidationError('Triage output was not valid JSON.', [
      { path: '$', message: err instanceof Error ? err.message : 'parse error' },
    ]);
  }
}
