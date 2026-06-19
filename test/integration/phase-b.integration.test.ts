import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm, FakeFeedReader } from '../fakes/fakes.js';
import { makeLlmDeal } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Phase B (Tier-3 community ingestion) end-to-end through the REAL composition
 * root + REAL Postgres: catalog + community source seeded → read feed (override)
 * → triage (LLM override) → fetch + extract the relevant lead (overrides) →
 * candidate persisted in Postgres → novel merchant domain proposed as a
 * pending_approval source. Network/LLM/feed are deterministic doubles.
 */
const FEED = 'https://www.mydealz.de/rss';
const DEAL_PAGE = 'https://www.telekom.de/magenta-disney';
const PAGE = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.'; // matches the deal's grounding

const suite = hasDb ? describe : describe.skip;

suite('Phase B community ingestion (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  async function seed(c: Container): Promise<string> {
    const source = makeSource({ url: FEED, type: 'community', tier: 3 });
    await c.db.sources.upsert(source);
    await c.db.catalog.upsert({
      service: 'Disney+',
      category: 'streaming',
      provider_url: 'https://www.disneyplus.com/de-de',
      country: 'DE',
    });
    return source.id;
  }

  it('feed → triage → extract relevant lead → candidate + proposed merchant source', async () => {
    container = makeContainer({
      feedReader: new FakeFeedReader({
        [FEED]: [
          {
            title: 'Disney+ gratis bei Telekom',
            link: DEAL_PAGE,
            summary: 'Disney+ inklusive gratis',
            publishedAt: null,
          },
          {
            title: 'Cheap TV',
            link: 'https://x.de/tv',
            summary: 'a television 50% off',
            publishedAt: null,
          },
        ],
      }),
      llm: new RoleAwareFakeLlm({
        discovery: JSON.stringify({ relevant: true, service: 'Disney+', reason: 'bundle' }),
        extraction: JSON.stringify({ deals: [makeLlmDeal()] }),
      }),
      fetcher: new ScriptedFetcher({ [DEAL_PAGE]: { text: PAGE, html: '<html></html>' } }),
    });
    const sourceId = await seed(container);

    const result = await container.ingestCommunity.execute({
      sourceId,
      maxItems: 20,
      budget: { maxSteps: 20, maxSeconds: 300, maxCostEur: 1 },
    });

    // Cheap pre-filter dropped the TV item; the Disney+ lead was triaged + extracted.
    expect(result.itemsRead).toBe(2);
    expect(result.itemsRelevant).toBe(1);
    expect(result.candidatesFound).toBe(1);

    // Candidate landed in Postgres.
    const queued =
      (await container.db.deals.listByStatus('candidate', 10)).length +
      (await container.db.deals.listByStatus('in_review', 10)).length;
    expect(queued).toBe(1);

    // The novel merchant domain was proposed (pending_approval), never crawled.
    const pending = await container.db.sources.listByStatus('pending_approval');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.type).toBe('discovered');
  });

  it('an irrelevant lead is dropped at triage — no fetch, no candidate', async () => {
    const fetcher = new ScriptedFetcher({});
    container = makeContainer({
      feedReader: new FakeFeedReader({
        [FEED]: [
          {
            title: 'Disney+ Handy Deal',
            link: 'https://x.de/phone',
            summary: 'Disney+ gratis Handy',
            publishedAt: null,
          },
        ],
      }),
      llm: new RoleAwareFakeLlm({
        discovery: JSON.stringify({ relevant: false, service: null, reason: 'a phone' }),
      }),
      fetcher,
    });
    const sourceId = await seed(container);

    const result = await container.ingestCommunity.execute({
      sourceId,
      maxItems: 20,
      budget: { maxSteps: 20, maxSeconds: 300, maxCostEur: 1 },
    });
    expect(result.itemsRelevant).toBe(0);
    expect(result.candidatesFound).toBe(0);
    expect(fetcher.fetched).not.toContain('https://x.de/phone');
    expect(await container.db.deals.listByStatus('candidate', 10)).toHaveLength(0);
  });
});
