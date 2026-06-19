import { describe, it, expect, beforeEach } from 'vitest';
import { MonitorSourceUseCase } from './monitor-source.js';
import { CrawlSourceUseCase } from '../crawl/crawl-source.js';
import { ExtractUseCase } from '../extract/extract.js';
import { DealStatus, SEED_VOCABULARY, type DealRecord } from '../../domain/index.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import {
  FakeFetcher,
  FakeLlm,
  FakeEvidenceStore,
  FixedClock,
  FakeLogger,
  sha256,
} from '../../../test/fakes/fakes.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';
import { makeSource } from '../../../test/factories/source.js';
import { randomUUID } from 'node:crypto';

const PAGE_TEXT = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.';

function build(fetcher: FakeFetcher) {
  const db = new InMemoryDb();
  const llm = new FakeLlm(JSON.stringify({ deals: [makeLlmDeal()] }));
  const evidenceStore = new FakeEvidenceStore();
  const clock = new FixedClock();
  const logger = new FakeLogger();
  const extract = new ExtractUseCase(llm, logger);
  const crawl = new CrawlSourceUseCase(
    fetcher,
    evidenceStore,
    db,
    extract,
    clock,
    logger,
    SEED_VOCABULARY,
    'TestAgent/0.1',
    30000,
  );
  const monitor = new MonitorSourceUseCase(
    fetcher,
    db,
    crawl,
    clock,
    logger,
    'TestAgent/0.1',
    30000,
  );
  return { db, monitor, evidenceStore, clock };
}

async function seedPublishedDeal(
  db: InMemoryDb,
  evidenceStore: FakeEvidenceStore,
  sourceUrl: string,
  contentHash: string,
): Promise<DealRecord> {
  const ev = await evidenceStore.save({
    sourceUrl,
    screenshot: new Uint8Array(),
    html: '<html>',
    termsText: PAGE_TEXT,
    capturedAt: '2026-06-19T00:00:00.000Z',
    contentHash,
  });
  await db.evidence.insert(ev);
  const deal: DealRecord = {
    ...makeLlmDeal({ source_url: sourceUrl }),
    id: randomUUID(),
    schema_version: 1,
    true_cost_monthly: 10,
    evidence_id: ev.id,
    status: DealStatus.enum.published,
    verified_by: 'reviewer',
    verified_at: '2026-06-19T00:00:00.000Z',
  };
  await db.deals.insert(deal);
  return deal;
}

describe('MonitorSourceUseCase', () => {
  let source: ReturnType<typeof makeSource>;

  beforeEach(() => {
    source = makeSource();
  });

  it('detects no change when content hash matches', async () => {
    const fetcher = new FakeFetcher({ text: PAGE_TEXT });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    const result = await env.monitor.execute({ sourceId: source.id });
    expect(result.change.kind).toBe('unchanged');
    expect(result.reQueued).toBe(false);
  });

  it('re-queues on a content change and keeps the old evidence', async () => {
    const fetcher = new FakeFetcher({ text: PAGE_TEXT + ' Jetzt 6 Monate gratis!' });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    const oldEvidenceCount = env.evidenceStore.saved.length;
    await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256('OLD CONTENT'));

    const result = await env.monitor.execute({ sourceId: source.id });
    expect(result.change.kind).toBe('content_changed');
    expect(result.reQueued).toBe(true);
    // Old evidence is still present (a new bundle was added, not overwritten).
    expect(env.evidenceStore.saved.length).toBeGreaterThan(oldEvidenceCount + 1);
  });

  it('advances next_due on an unchanged pass so the source is not perpetually due', async () => {
    const fetcher = new FakeFetcher({ text: PAGE_TEXT });
    const env = build(fetcher);
    await env.db.sources.upsert(source); // next_due starts null → "due now"
    await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    await env.monitor.execute({ sourceId: source.id });

    const updated = await env.db.sources.getById(source.id);
    expect(updated!.next_due).not.toBeNull();
    // next_due is in the future (cadence_days ahead of the fixed clock).
    expect(Date.parse(updated!.next_due!)).toBeGreaterThan(env.clock.now().getTime());
    expect(updated!.last_seen).not.toBeNull();
  });

  it('a repository failure records an `error` change (not disappeared) and never expires', async () => {
    const fetcher = new FakeFetcher({ text: PAGE_TEXT });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    const deal = await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    // Make the diff-baseline lookup throw (an infra blip), on every pass.
    env.db.deals.listBySourceUrl = async () => {
      throw new Error('connection terminated unexpectedly');
    };

    const r1 = await env.monitor.execute({ sourceId: source.id });
    const r2 = await env.monitor.execute({ sourceId: source.id });
    expect(r1.change.kind).toBe('error');
    expect(r2.change.kind).toBe('error');
    expect(r1.expired).toBe(0);
    expect(r2.expired).toBe(0);
    // Two consecutive infra errors must NOT trip the disappearance debounce.
    expect((await env.db.deals.getById(deal.id))!.status).toBe('published');
  });

  it('does NOT expire on a single transient failure (debounced)', async () => {
    const fetcher = new FakeFetcher({ outcome: 'error', text: '' });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    const deal = await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    const result = await env.monitor.execute({ sourceId: source.id });
    expect(result.change.kind).toBe('disappeared');
    expect(result.expired).toBe(0);
    // A single transient error must never retract a verified deal.
    expect((await env.db.deals.getById(deal.id))!.status).toBe('published');
  });

  it('auto-expires only after N consecutive disappearances', async () => {
    const fetcher = new FakeFetcher({ outcome: 'error', text: '' });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    const deal = await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    await env.monitor.execute({ sourceId: source.id }); // 1st: debounced
    expect((await env.db.deals.getById(deal.id))!.status).toBe('published');

    const second = await env.monitor.execute({ sourceId: source.id }); // 2nd: expires
    expect(second.expired).toBe(1);
    expect((await env.db.deals.getById(deal.id))!.status).toBe('expired');
  });

  it('routes a blocked page to manual capture without expiring published deals', async () => {
    const fetcher = new FakeFetcher({ outcome: 'blocked', text: '' });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    const deal = await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    const result = await env.monitor.execute({ sourceId: source.id });
    expect(result.change.kind).toBe('blocked');
    expect(result.routedToManualCapture).toBe(true);
    expect(result.expired).toBe(0);
    expect((await env.db.deals.getById(deal.id))!.status).toBe('published');
    expect(await env.db.manualCapture.listOpen(10)).toHaveLength(1);
  });
});
