import type { LlmExtractedDeal } from '../../src/domain/index.js';

/**
 * Build a valid baseline LlmExtractedDeal for tests. Override any field via the
 * partial. Keeps test cases focused on the one property under test.
 */
export function makeLlmDeal(overrides: Partial<LlmExtractedDeal> = {}): LlmExtractedDeal {
  return {
    service: 'Disney+',
    route_type: 'bundle',
    provider: 'Telekom MagentaTV',
    headline: 'Disney+ included in MagentaTV SmartStream',
    price: { amount: 10, currency: 'EUR', billing: 'monthly' },
    country: 'DE',
    eligibility: {
      new_customer_only: false,
      residency_kyc: false,
      plan_tier_required: 'MagentaTV',
      min_spend: null,
      stackable: true,
      conditions: [],
    },
    validity: {
      start: '2026-01-01',
      end: null,
      recheck_days: 3,
      conditions: [],
    },
    included_items: ['Disney+ Standard'],
    attributes: {},
    raw_conditions_text: 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.',
    source_url: 'https://www.telekom.de/magenta-tv',
    confidence: 0.9,
    grounding: [
      { field: 'price', quote: 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.' },
      { field: 'eligibility', quote: 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.' },
      { field: 'validity', quote: 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.' },
    ],
    unmapped_conditions: false,
    field_proposals: [],
    ...overrides,
  };
}
