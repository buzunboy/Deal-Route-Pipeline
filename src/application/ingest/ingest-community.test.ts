import { describe, it, expect } from 'vitest';
import { IngestCommunityUseCase } from './ingest-community.js';
import { ExtractUseCase } from '../extract/extract.js';
import { SEED_VOCABULARY } from '../../domain/index.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import {
  ScriptedFetcher,
  RoleAwareFakeLlm,
  FakeFeedReader,
  FakeEvidenceStore,
  FixedClock,
  FakeLogger,
} from '../../../test/fakes/fakes.js';
import type { FeedItem } from '../ports/index.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';
import { makeSource } from '../../../test/factories/source.js';

const FEED_URL = 'https://www.mydealz.de/rss';
const DEAL_LINK = 'https://www.telekom.de/magenta-disney';
const PHONE_LINK = 'https://www.mydealz.de/deals/phone';
const BUDGET = { maxSteps: 50, maxSeconds: 300, maxCostEur: 1.0 };

const RELEVANT = JSON.stringify({
  relevant: true,
  service: 'Disney+',
  reason: 'subscription bundle',
});
const IRRELEVANT = JSON.stringify({ relevant: false, service: null, reason: 'a phone, not a sub' });

function feedItem(over: Partial<FeedItem>): FeedItem {
  return {
    title: 't',
    link: DEAL_LINK,
    summary: 'Disney+ inklusive gratis',
    publishedAt: null,
    ...over,
  };
}

function build(opts: {
  items: FeedItem[];
  triage?: string;
  pages?: Record<
    string,
    { html?: string; text?: string; outcome?: 'ok' | 'blocked' | 'robots_disallowed' | 'error' }
  >;
}) {
  const db = new InMemoryDb();
  const feeds = new FakeFeedReader({ [FEED_URL]: opts.items });
  const llm = new RoleAwareFakeLlm({
    discovery: opts.triage ?? RELEVANT,
    extraction: JSON.stringify({ deals: [makeLlmDeal()] }),
  });
  const fetcher = new ScriptedFetcher(
    opts.pages ?? { [DEAL_LINK]: { text: 'Disney+ im Tarif enthalten.', html: '<html></html>' } },
  );
  const evidence = new FakeEvidenceStore();
  const clock = new FixedClock();
  const logger = new FakeLogger();
  const extract = new ExtractUseCase(llm, logger);
  const uc = new IngestCommunityUseCase(
    fetcher,
    feeds,
    llm,
    evidence,
    db,
    extract,
    clock,
    logger,
    SEED_VOCABULARY,
    'TestAgent/0.1',
    30000,
  );
  return { uc, db, fetcher, evidence };
}

async function seedCommunitySource(db: InMemoryDb): Promise<string> {
  const source = makeSource({ url: FEED_URL, type: 'community', tier: 3 });
  await db.sources.upsert(source);
  // Catalog drives the cheap pre-filter; seed the matched service.
  await db.catalog.upsert({
    service: 'Disney+',
    category: 'streaming',
    provider_url: 'https://www.disneyplus.com/de-de',
    country: 'DE',
  });
  return source.id;
}

describe('IngestCommunityUseCase', () => {
  it('triages a relevant lead, extracts a candidate, and proposes the merchant domain', async () => {
    const env = build({ items: [feedItem({})] });
    const sourceId = await seedCommunitySource(env.db);

    const result = await env.uc.execute({ sourceId, maxItems: 50, budget: BUDGET });

    expect(result.itemsRelevant).toBe(1);
    expect(result.candidatesFound).toBe(1);
    expect(env.fetcher.fetched).toContain(DEAL_LINK);
    // telekom.de is a novel domain here → proposed for approval.
    expect(result.proposedSources.map((p) => p.url)).toContain(DEAL_LINK);
    const pending = await env.db.sources.listByStatus('pending_approval');
    expect(pending).toHaveLength(1);
    // Candidate persisted to the review queue (not published).
    const queued =
      (await env.db.deals.listByStatus('candidate', 10)).length +
      (await env.db.deals.listByStatus('in_review', 10)).length;
    expect(queued).toBe(1);
  });

  it('drops an irrelevant lead via triage — no fetch, no candidate', async () => {
    const env = build({
      items: [
        feedItem({ link: PHONE_LINK, title: 'Disney+ Handy', summary: 'Disney+ gratis Handy' }),
      ],
      triage: IRRELEVANT,
      pages: { [PHONE_LINK]: { text: 'a phone' } },
    });
    const sourceId = await seedCommunitySource(env.db);

    const result = await env.uc.execute({ sourceId, maxItems: 50, budget: BUDGET });
    expect(result.itemsTriaged).toBe(1);
    expect(result.itemsRelevant).toBe(0);
    expect(result.candidatesFound).toBe(0);
    expect(env.fetcher.fetched).not.toContain(PHONE_LINK);
  });

  it('skips obvious non-matches with the cheap pre-filter (no triage LLM call)', async () => {
    const env = build({
      items: [feedItem({ title: 'Cheap TV', summary: 'A television, 50% off' })],
    });
    const sourceId = await seedCommunitySource(env.db);

    const result = await env.uc.execute({ sourceId, maxItems: 50, budget: BUDGET });
    // No catalog service mentioned → never triaged.
    expect(result.itemsTriaged).toBe(0);
    expect(result.candidatesFound).toBe(0);
  });

  it('stops at the item cap', async () => {
    const env = build({
      items: [
        feedItem({ link: DEAL_LINK }),
        feedItem({ link: 'https://x.de/2', summary: 'Disney+ gratis' }),
      ],
      pages: {
        [DEAL_LINK]: { text: 'Disney+' },
        'https://x.de/2': { text: 'Disney+' },
      },
    });
    const sourceId = await seedCommunitySource(env.db);

    const result = await env.uc.execute({ sourceId, maxItems: 1, budget: BUDGET });
    expect(result.stoppedReason).toBe('item_cap');
  });

  it('routes a blocked lead page to manual capture', async () => {
    const env = build({
      items: [feedItem({})],
      pages: { [DEAL_LINK]: { outcome: 'blocked', text: '' } },
    });
    const sourceId = await seedCommunitySource(env.db);

    const result = await env.uc.execute({ sourceId, maxItems: 50, budget: BUDGET });
    expect(result.routedToManualCapture).toBe(1);
    expect(await env.db.manualCapture.listOpen(10)).toHaveLength(1);
  });

  it('dry-run writes nothing', async () => {
    const env = build({ items: [feedItem({})] });
    const sourceId = await seedCommunitySource(env.db);

    const result = await env.uc.execute({ sourceId, maxItems: 50, budget: BUDGET, dryRun: true });
    expect(result.candidatesFound).toBe(1); // it still extracts…
    // …but persists nothing.
    expect(await env.db.deals.listByStatus('candidate', 10)).toHaveLength(0);
    expect(await env.db.deals.listByStatus('in_review', 10)).toHaveLength(0);
    expect(await env.db.sources.listByStatus('pending_approval')).toHaveLength(0);
    expect(env.evidence.saved).toHaveLength(0);
  });
});
