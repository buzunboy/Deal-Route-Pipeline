import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import { makeLlmDeal } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import { DealStatus, type DealRecord } from '../../src/domain/index.js';
import { toPublicDeal } from '../../src/adapters/http/public-dto.js';
import { tldtsSuffixOracle } from '../../src/adapters/suffix/tldts-suffix-oracle.js';
import type { Container } from '../../src/composition/container.js';

/**
 * P3 public read feed through the REAL composition root + REAL Postgres. Proves
 * the new `listPublished`/`countPublished` repo methods behave identically to the
 * in-memory adapter (the contract suite covers both, this adds the real-SQL round
 * trip the fake can't) AND that the DTO projection over a Postgres-read record
 * leaks nothing. Network/LLM are deterministic doubles; the DB is real Postgres.
 */
const PAGE = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.'; // matches the deal's grounding

const suite = hasDb ? describe : describe.skip;

suite('P3 public read feed (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  /** Insert a published deal straight into Postgres (read-path tests don't need a crawl). */
  async function insertPublished(overrides: Partial<DealRecord>): Promise<DealRecord> {
    const base: DealRecord = {
      ...makeLlmDeal(),
      id: randomUUID(),
      schema_version: 4,
      true_cost_monthly: 10,
      evidence_id: randomUUID(),
      source_registrable_domain: null,
      status: DealStatus.enum.published,
      verified_by: 'reviewer',
      verified_at: '2026-06-19T00:00:00.000Z',
      ...overrides,
    };
    // Pin source_registrable_domain from the (possibly-overridden) source_url via
    // the real PSL — exactly as extract pins it on a persisted record (Step 6) —
    // unless a test set it explicitly. This is what the reliability join reads.
    const deal: DealRecord =
      'source_registrable_domain' in overrides
        ? base
        : { ...base, source_registrable_domain: tldtsSuffixOracle(base.source_url) };
    await container.db.deals.insert(deal);
    return deal;
  }

  it('listPublished filters + sorts + paginates over real Postgres, published-only', async () => {
    container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    const service = `svc-${randomUUID()}`;
    // 3 published with distinct costs + 1 non-published (must be excluded).
    await insertPublished({ service, true_cost_monthly: 5 });
    await insertPublished({ service, true_cost_monthly: 25 });
    await insertPublished({ service, true_cost_monthly: 15 });
    await insertPublished({ service, true_cost_monthly: 1, status: DealStatus.enum.candidate });

    const count = await container.db.deals.countPublished({ service });
    expect(count).toBe(3); // the candidate is not counted

    // cost_asc, priceMax=20 → 5 then 15; the 25 and the candidate excluded.
    const page = await container.db.deals.listPublished({
      filters: { service, priceMax: 20 },
      sort: 'cost_asc',
      limit: 50,
      offset: 0,
    });
    expect(page.map((d) => d.true_cost_monthly)).toEqual([5, 15]);
    expect(page.every((d) => d.status === 'published')).toBe(true);

    // pagination is stable: limit 1 offset 1 over cost_asc → the 15 deal.
    const second = await container.db.deals.listPublished({
      filters: { service },
      sort: 'cost_asc',
      limit: 1,
      offset: 1,
    });
    expect(second.map((d) => d.true_cost_monthly)).toEqual([15]);
  });

  it('verified_desc orders by verified_at (timestamptz → ISO-Z) nulls last, matching in-memory', async () => {
    container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    const service = `svc-${randomUUID()}`;
    const older = await insertPublished({ service, verified_at: '2026-01-01T00:00:00.000Z' });
    const newer = await insertPublished({ service, verified_at: '2026-06-01T00:00:00.000Z' });
    const unverified = await insertPublished({ service, verified_at: null });

    const out = await container.db.deals.listPublished({
      filters: { service },
      sort: 'verified_desc',
      limit: 50,
      offset: 0,
    });
    expect(out.map((d) => d.id)).toEqual([newer.id, older.id, unverified.id]);
    // The Postgres mapper normalises timestamptz back to canonical ISO-Z.
    expect(out[0]!.verified_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('blends source reliability as an equal-cost tiebreaker over real Postgres (Step 3)', async () => {
    // Two published deals at the SAME cost from sources of differing reliability:
    // the more reliable source must rank first. Proves the deal→source
    // registrable-domain join + the shared ranker behave identically on real SQL.
    container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    await container.db.sources.upsert(
      makeSource({ url: 'https://high-rel.de', reliability_score: 0.9 }),
    );
    await container.db.sources.upsert(
      makeSource({ url: 'https://low-rel.de', reliability_score: 0.1 }),
    );
    const service = `svc-${randomUUID()}`;
    const hi = await insertPublished({
      id: '00000000-0000-4000-8000-0000000000a1',
      service,
      true_cost_monthly: 10,
      source_url: 'https://www.high-rel.de/offer', // subdomain folds to high-rel.de
    });
    const lo = await insertPublished({
      id: '00000000-0000-4000-8000-0000000000b1',
      service,
      true_cost_monthly: 10,
      source_url: 'https://low-rel.de/offer',
    });
    // A deal whose registrable domain matches no active source → neutral 0.5,
    // sorting between the high- and low-reliability deals.
    const mid = await insertPublished({
      id: '00000000-0000-4000-8000-0000000000c1',
      service,
      true_cost_monthly: 10,
      source_url: 'https://unknown-src.de/offer',
    });

    const out = await container.db.deals.listPublished({
      filters: { service },
      sort: 'cost_asc',
      limit: 50,
      offset: 0,
    });
    expect(out.map((d) => d.id)).toEqual([hi.id, mid.id, lo.id]);
    // The raw reliability never reaches the projection — order-only.
    const json = JSON.stringify(out.map((d) => toPublicDeal(d, { now: new Date() })));
    expect(json).not.toContain('reliability');
    expect(json).not.toContain('0.9');
    expect(json).not.toContain('0.1');
  });

  it('a genuinely-crawled, approved deal projects to a leak-free public DTO', async () => {
    const source = makeSource({ url: 'https://www.telekom.de/magenta-disney' });
    container = makeContainer({
      fetcher: new ScriptedFetcher({ [source.url]: { text: PAGE, html: '<html></html>' } }),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    await container.db.sources.upsert(source);
    await container.crawlSource.execute({ sourceId: source.id });
    const [candidate] = await container.db.deals.listByStatus('candidate', 10);
    await container.review.approve(candidate!.id, 'reviewer@dealroute');

    // Read it back through listPublished and project it.
    const [deal] = await container.db.deals.listPublished({
      filters: {},
      sort: 'cost_asc',
      limit: 10,
      offset: 0,
    });
    expect(deal!.id).toBe(candidate!.id);
    // Project with `now` = the deal's own verification instant so the freshness
    // band is deterministic regardless of the real crawl clock.
    const now = new Date(deal!.verified_at!);
    const dto = toPublicDeal(deal!, { now });
    // The projection over a Postgres-read record exposes no internal key.
    const json = JSON.stringify(dto);
    for (const forbidden of [
      'evidence_id',
      'confidence',
      'grounding',
      'verified_by',
      'status',
      'source_quote',
    ]) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
    expect(dto.trust).toBe('recent'); // verified_at == now → age 0 days
    expect(dto.verified_at).toBe(deal!.verified_at);
  });
});
