import { describe, it, expect } from 'vitest';
import {
  NEUTRAL_RELIABILITY,
  PUBLISHED_FETCH_CAP,
  buildReliabilityIndex,
  capByPrimary,
  comparePublished,
  rankPublished,
  resolveReliability,
} from './published-ranking.js';
import { PUBLISHED_MAX_LIMIT, PUBLISHED_MAX_OFFSET } from './published-query.js';
import type { DealRecord } from './deal-record.js';

/**
 * Minimal DealRecord carrying ONLY the fields the ranking touches
 * (true_cost_monthly, verified_at, source_url, id). The ranker is pure over these.
 */
function deal(over: {
  id: string;
  source_url: string;
  true_cost_monthly?: number;
  verified_at?: string | null;
}): DealRecord {
  return {
    id: over.id,
    source_url: over.source_url,
    true_cost_monthly: over.true_cost_monthly ?? 10,
    verified_at: over.verified_at ?? null,
    // Padding to satisfy the type — irrelevant to ranking.
    schema_version: 3,
    service: 'svc',
    route_type: 'bundle',
    provider: 'prov',
    headline: 'h',
    price: { amount: 10, currency: 'EUR', billing: 'monthly' },
    country: 'DE',
    eligibility: {
      new_customer_only: null,
      residency_kyc: null,
      plan_tier_required: null,
      min_spend: null,
      stackable: null,
      conditions: [],
    },
    validity: { start: null, end: null, recheck_days: 3, conditions: [] },
    included_items: [],
    attributes: {},
    raw_conditions_text: '',
    evidence_id: '00000000-0000-4000-8000-0000000000ff',
    confidence: 1,
    grounding: [],
    unmapped_conditions: false,
    field_proposals: [],
    status: 'published',
    verified_by: null,
    affiliate_disclosure: true,
    published_at: null,
  } as DealRecord;
}

const fullQuery = (sort: 'cost_asc' | 'verified_desc') => ({
  filters: {},
  sort,
  limit: 100,
  offset: 0,
});

describe('buildReliabilityIndex', () => {
  it('keys by registrable domain (folds subdomain/path/scheme differences)', () => {
    const idx = buildReliabilityIndex([
      { url: 'https://www.telekom.de/magenta', reliability_score: 0.8 },
    ]);
    // A deal scraped at any path/subdomain of the same registrable domain resolves.
    expect(idx.get('telekom.de')).toBe(0.8);
  });

  it('on a registrable-domain collision keeps the MAX score', () => {
    const idx = buildReliabilityIndex([
      { url: 'https://shop.telekom.de/a', reliability_score: 0.3 },
      { url: 'https://www.telekom.de/b', reliability_score: 0.9 },
      { url: 'https://telekom.de/c', reliability_score: 0.6 },
    ]);
    expect(idx.get('telekom.de')).toBe(0.9);
  });

  it('skips an unparseable source url (no null key)', () => {
    const idx = buildReliabilityIndex([
      { url: 'not a url', reliability_score: 0.9 },
      { url: 'https://valid.de', reliability_score: 0.4 },
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get('valid.de')).toBe(0.4);
  });
});

describe('resolveReliability', () => {
  const idx = buildReliabilityIndex([
    { url: 'https://www.telekom.de', reliability_score: 0.8 },
    { url: 'https://distrusted.de', reliability_score: 0 },
  ]);

  it('resolves a matching registrable domain', () => {
    expect(resolveReliability('https://www.telekom.de/deep/path?x=1', idx)).toBe(0.8);
  });

  it('PRESERVES a real score of 0 (a distrusted domain never floats to neutral)', () => {
    expect(resolveReliability('https://distrusted.de/x', idx)).toBe(0);
  });

  it('falls back to neutral 0.5 for a domain with no active source', () => {
    expect(resolveReliability('https://unknown.de', idx)).toBe(NEUTRAL_RELIABILITY);
  });

  it('falls back to neutral 0.5 for an unparseable source url', () => {
    expect(resolveReliability('::::not-a-url', idx)).toBe(NEUTRAL_RELIABILITY);
  });
});

describe('comparePublished — cost_asc', () => {
  const idx = buildReliabilityIndex([
    { url: 'https://high.de', reliability_score: 0.9 },
    { url: 'https://low.de', reliability_score: 0.1 },
  ]);

  it('orders by true_cost_monthly primarily', () => {
    const ds = [
      deal({ id: 'a', source_url: 'https://low.de', true_cost_monthly: 20 }),
      deal({ id: 'b', source_url: 'https://high.de', true_cost_monthly: 5 }),
    ];
    ds.sort(comparePublished('cost_asc', idx));
    expect(ds.map((d) => d.id)).toEqual(['b', 'a']); // cheaper first, despite lower reliability
  });

  it('on EQUAL cost, the more reliable source ranks first (the tiebreaker)', () => {
    const ds = [
      deal({ id: 'lo', source_url: 'https://low.de', true_cost_monthly: 10 }),
      deal({ id: 'hi', source_url: 'https://high.de', true_cost_monthly: 10 }),
    ];
    ds.sort(comparePublished('cost_asc', idx));
    expect(ds.map((d) => d.id)).toEqual(['hi', 'lo']);
  });

  it('on equal cost AND equal reliability, falls through to id ascending', () => {
    const ds = [
      deal({ id: 'y', source_url: 'https://high.de', true_cost_monthly: 10 }),
      deal({ id: 'x', source_url: 'https://high.de', true_cost_monthly: 10 }),
    ];
    ds.sort(comparePublished('cost_asc', idx));
    expect(ds.map((d) => d.id)).toEqual(['x', 'y']);
  });

  it('a deal with no resolvable source ranks as neutral 0.5 (between high and low)', () => {
    const ds = [
      deal({ id: 'lo', source_url: 'https://low.de', true_cost_monthly: 10 }), // 0.1
      deal({ id: 'neutral', source_url: 'https://unknown.de', true_cost_monthly: 10 }), // 0.5
      deal({ id: 'hi', source_url: 'https://high.de', true_cost_monthly: 10 }), // 0.9
    ];
    ds.sort(comparePublished('cost_asc', idx));
    expect(ds.map((d) => d.id)).toEqual(['hi', 'neutral', 'lo']);
  });
});

describe('comparePublished — verified_desc', () => {
  const idx = buildReliabilityIndex([
    { url: 'https://high.de', reliability_score: 0.9 },
    { url: 'https://low.de', reliability_score: 0.1 },
  ]);

  it('orders by verified_at newest-first, nulls last, primarily', () => {
    const ds = [
      deal({ id: 'null', source_url: 'https://high.de', verified_at: null }),
      deal({ id: 'old', source_url: 'https://high.de', verified_at: '2026-01-01T00:00:00.000Z' }),
      deal({ id: 'new', source_url: 'https://low.de', verified_at: '2026-06-01T00:00:00.000Z' }),
    ];
    ds.sort(comparePublished('verified_desc', idx));
    expect(ds.map((d) => d.id)).toEqual(['new', 'old', 'null']);
  });

  it('on EQUAL verified_at, the more reliable source ranks first', () => {
    const when = '2026-06-01T00:00:00.000Z';
    const ds = [
      deal({ id: 'lo', source_url: 'https://low.de', verified_at: when }),
      deal({ id: 'hi', source_url: 'https://high.de', verified_at: when }),
    ];
    ds.sort(comparePublished('verified_desc', idx));
    expect(ds.map((d) => d.id)).toEqual(['hi', 'lo']);
  });

  it('on equal verified_at AND equal reliability, falls through to id ascending', () => {
    const when = '2026-06-01T00:00:00.000Z';
    const ds = [
      deal({ id: 'b', source_url: 'https://high.de', verified_at: when }),
      deal({ id: 'a', source_url: 'https://high.de', verified_at: when }),
    ];
    ds.sort(comparePublished('verified_desc', idx));
    expect(ds.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('two null-verified deals tiebreak on reliability then id', () => {
    const ds = [
      deal({ id: 'lo', source_url: 'https://low.de', verified_at: null }),
      deal({ id: 'hi', source_url: 'https://high.de', verified_at: null }),
    ];
    ds.sort(comparePublished('verified_desc', idx));
    expect(ds.map((d) => d.id)).toEqual(['hi', 'lo']);
  });
});

describe('rankPublished — sort + paginate', () => {
  const idx = buildReliabilityIndex([
    { url: 'https://high.de', reliability_score: 0.9 },
    { url: 'https://low.de', reliability_score: 0.1 },
  ]);
  // Five equal-cost deals so reliability + id fully decide the order.
  const ds = [
    deal({ id: 'd-low-2', source_url: 'https://low.de', true_cost_monthly: 10 }),
    deal({ id: 'd-high-1', source_url: 'https://high.de', true_cost_monthly: 10 }),
    deal({ id: 'd-low-1', source_url: 'https://low.de', true_cost_monthly: 10 }),
    deal({ id: 'd-high-2', source_url: 'https://high.de', true_cost_monthly: 10 }),
    deal({ id: 'd-mid', source_url: 'https://unknown.de', true_cost_monthly: 10 }), // 0.5
  ];
  // Expected full order: high (id asc), mid, low (id asc).
  const expectedOrder = ['d-high-1', 'd-high-2', 'd-mid', 'd-low-1', 'd-low-2'];

  it('produces the full reliability-tiebroken order', () => {
    const out = rankPublished(ds, idx, fullQuery('cost_asc'));
    expect(out.map((d) => d.id)).toEqual(expectedOrder);
  });

  it('paginates stably over that order without gaps/repeats', () => {
    const page = (offset: number, limit: number) =>
      rankPublished(ds, idx, { filters: {}, sort: 'cost_asc', limit, offset }).map((d) => d.id);
    expect(page(0, 2)).toEqual(expectedOrder.slice(0, 2));
    expect(page(2, 2)).toEqual(expectedOrder.slice(2, 4));
    expect(page(4, 2)).toEqual(expectedOrder.slice(4));
    const all = [...page(0, 2), ...page(2, 2), ...page(4, 2)];
    expect(new Set(all).size).toBe(5);
  });

  it('returns cloned deals (caller cannot mutate ranked output into source state)', () => {
    const out = rankPublished(ds, idx, fullQuery('cost_asc'));
    expect(out[0]).not.toBe(ds.find((d) => d.id === out[0]!.id));
  });
});

describe('capByPrimary — deterministic bounded fetch', () => {
  it('caps at PUBLISHED_FETCH_CAP and equals PUBLISHED_MAX_OFFSET + PUBLISHED_MAX_LIMIT', () => {
    expect(PUBLISHED_FETCH_CAP).toBe(PUBLISHED_MAX_OFFSET + PUBLISHED_MAX_LIMIT);
    // Build cap+5 equal-cost deals with ascending ids; cap must take the lowest ids.
    const many = Array.from({ length: PUBLISHED_FETCH_CAP + 5 }, (_, i) =>
      deal({
        id: `id-${String(i).padStart(6, '0')}`,
        source_url: 'https://x.de',
        true_cost_monthly: 10,
      }),
    );
    const capped = capByPrimary(many, 'cost_asc');
    expect(capped).toHaveLength(PUBLISHED_FETCH_CAP);
    // The deepest reachable page still lands within the cap.
    const lastReachable = capped[PUBLISHED_MAX_OFFSET + PUBLISHED_MAX_LIMIT - 1];
    expect(lastReachable).toBeDefined();
    expect(capped[0]!.id).toBe('id-000000'); // primary order: id ascending on equal cost
  });

  it('orders by the primary key only (no reliability) before capping', () => {
    // capByPrimary must NOT consider reliability — it's the fetch order, not final.
    const ds = [
      deal({ id: 'expensive', source_url: 'https://x.de', true_cost_monthly: 99 }),
      deal({ id: 'cheap', source_url: 'https://x.de', true_cost_monthly: 1 }),
    ];
    expect(capByPrimary(ds, 'cost_asc').map((d) => d.id)).toEqual(['cheap', 'expensive']);
  });

  it('limit cap is bounded and small — a page can never exceed PUBLISHED_MAX_LIMIT', () => {
    expect(PUBLISHED_MAX_LIMIT).toBeLessThanOrEqual(100);
  });
});
