import { describe, it, expect } from 'vitest';
import { ExtractUseCase } from './extract.js';
import { SEED_VOCABULARY } from '../../domain/index.js';
import { FakeLlm, FakeLogger } from '../../../test/fakes/fakes.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';

const PAGE_TEXT = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.';

function runExtract(json: string) {
  const llm = new FakeLlm(json);
  const uc = new ExtractUseCase(llm, new FakeLogger());
  return uc.execute({
    pageText: PAGE_TEXT,
    sourceUrl: 'https://www.telekom.de/magenta-tv',
    targetService: 'Disney+',
    vocabulary: SEED_VOCABULARY,
  });
}

describe('ExtractUseCase', () => {
  it('produces a validated candidate with true-cost and dedupe key', async () => {
    const json = JSON.stringify({ deals: [makeLlmDeal()] });
    const result = await runExtract(json);
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c.trueCostMonthly).toBe(10);
    expect(c.dedupeKey).toContain('disney plus');
    expect(c.schemaVersion).toBe(1);
    expect(result.costEur).toBeGreaterThan(0);
  });

  it('returns no candidates for an empty page (a page may hold no offers)', async () => {
    const result = await runExtract(JSON.stringify({ deals: [] }));
    expect(result.candidates).toHaveLength(0);
  });

  it('forces must-review when a grounding quote is hallucinated', async () => {
    const deal = makeLlmDeal({
      grounding: [
        { field: 'price', quote: 'This offer is free forever with no conditions.' },
        { field: 'eligibility', quote: PAGE_TEXT },
        { field: 'validity', quote: PAGE_TEXT },
      ],
    });
    const result = await runExtract(JSON.stringify({ deals: [deal] }));
    const c = result.candidates[0]!;
    expect(c.mustReview).toBe(true);
    expect(c.failures.some((f) => f.rule === 'grounding_quote_in_source')).toBe(true);
    expect(c.adjustedConfidence).toBeLessThan(deal.confidence);
  });

  it('maps an unknown condition to a field proposal (never invents a column)', async () => {
    const deal = makeLlmDeal({
      eligibility: {
        new_customer_only: false,
        residency_kyc: false,
        plan_tier_required: 'MagentaTV',
        min_spend: null,
        stackable: true,
        conditions: [
          { key: 'requires_pet_ownership', label: 'Must own a pet', source_quote: PAGE_TEXT },
        ],
      },
    });
    const result = await runExtract(JSON.stringify({ deals: [deal] }));
    const c = result.candidates[0]!;
    expect(c.deal.unmapped_conditions).toBe(true);
    expect(c.deal.eligibility.conditions[0]!.key).toBe('other');
    expect(c.fieldProposals.some((p) => p.suggested_key === 'requires_pet_ownership')).toBe(true);
  });

  it('rejects malformed LLM output at the boundary', async () => {
    await expect(runExtract('not json at all')).rejects.toThrow();
  });
});
