/**
 * Best-effort per-call cost estimation (EUR) for cost logging (guardrails). Rates
 * are configurable data, not load-bearing billing — they exist so each run logs
 * an approximate cost. Update as provider pricing changes; unknown models fall
 * back to a conservative default.
 */

interface Rate {
  /** EUR per 1M input tokens. */
  inPerM: number;
  /** EUR per 1M output tokens. */
  outPerM: number;
}

const DEFAULT_RATE: Rate = { inPerM: 5, outPerM: 15 };

/** Substring-keyed rate table (model ids vary by suffix/date). */
const RATES: { match: string; rate: Rate }[] = [
  { match: 'haiku', rate: { inPerM: 0.8, outPerM: 4 } },
  { match: 'sonnet', rate: { inPerM: 3, outPerM: 15 } },
  { match: 'opus', rate: { inPerM: 15, outPerM: 75 } },
  { match: 'gpt-4o-mini', rate: { inPerM: 0.15, outPerM: 0.6 } },
  { match: 'gpt-4o', rate: { inPerM: 2.5, outPerM: 10 } },
];

export function estimateCostEur(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATES.find((r) => model.toLowerCase().includes(r.match))?.rate ?? DEFAULT_RATE;
  const cost = (inputTokens / 1_000_000) * rate.inPerM + (outputTokens / 1_000_000) * rate.outPerM;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
