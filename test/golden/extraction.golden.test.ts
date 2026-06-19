import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import TurndownService from 'turndown';
import { ExtractUseCase, type ExtractedCandidate } from '../../src/application/index.js';
import { SEED_VOCABULARY } from '../../src/domain/index.js';
import { StubLlm } from '../../src/adapters/llm/stub-llm.js';
import { FakeLogger } from '../fakes/fakes.js';

/**
 * Golden-file extraction test. Saved HTML fixture → (markdown via the same
 * turndown the fetcher uses) → StubLlm returns the saved llm-response.json →
 * the REAL extract use-case validates it. Asserts typed-core fields, grounding
 * presence + truthfulness (no hallucinated values), conditions mapped to the
 * vocabulary, and confidence. Add a fixture whenever a real page breaks
 * extraction (`testing.md`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../fixtures/golden');

function loadFixture(name: string): { pageText: string; responseFile: string } {
  const dir = join(FIXTURES, name);
  const html = readFileSync(join(dir, 'page.html'), 'utf8');
  const pageText = new TurndownService().turndown(html);
  return { pageText, responseFile: join(dir, 'llm-response.json') };
}

async function extract(name: string): Promise<ExtractedCandidate[]> {
  const { pageText, responseFile } = loadFixture(name);
  process.env.STUB_LLM_RESPONSE_FILE = responseFile;
  try {
    const uc = new ExtractUseCase(new StubLlm(), new FakeLogger());
    const result = await uc.execute({
      pageText,
      sourceUrl: 'https://www.telekom.de/magenta-tv',
      targetService: 'Disney+',
      vocabulary: SEED_VOCABULARY,
    });
    return result.candidates;
  } finally {
    delete process.env.STUB_LLM_RESPONSE_FILE;
  }
}

describe('golden: telekom-magenta-disney', () => {
  it('extracts one valid Disney+ bundle candidate', async () => {
    const candidates = await extract('telekom-magenta-disney');
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.deal.service).toBe('Disney+');
    expect(c.deal.route_type).toBe('bundle');
    expect(c.deal.price.amount).toBe(10);
    expect(c.deal.price.currency).toBe('EUR');
    expect(c.trueCostMonthly).toBe(10);
    expect(c.deal.eligibility.new_customer_only).toBe(true);
  });

  it('maps long-tail conditions to the vocabulary (no invented columns)', async () => {
    const c = (await extract('telekom-magenta-disney'))[0]!;
    const keys = [...c.deal.eligibility.conditions, ...c.deal.validity.conditions].map(
      (cond) => cond.key,
    );
    expect(keys).toContain('requires_other_product');
    expect(keys).toContain('min_contract_term');
    expect(keys).toContain('with_ads');
    expect(c.deal.unmapped_conditions).toBe(false);
    expect(c.fieldProposals).toHaveLength(0);
  });

  it('has truthful grounding for every key field (no hallucination)', async () => {
    const c = (await extract('telekom-magenta-disney'))[0]!;
    expect(c.failures.filter((f) => f.rule === 'grounding_quote_in_source')).toHaveLength(0);
    expect(c.failures.filter((f) => f.rule === 'grounding_present')).toHaveLength(0);
  });

  it('passes the review gate with calibrated confidence', async () => {
    const c = (await extract('telekom-magenta-disney'))[0]!;
    expect(c.failures).toHaveLength(0);
    expect(c.adjustedConfidence).toBeGreaterThan(0.7);
    expect(c.mustReview).toBe(false);
  });
});
