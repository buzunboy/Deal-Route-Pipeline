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
    screenshot: new Uint8Array([137, 80, 78, 71]),
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

  // ── Prereq A: a redirecting source must still match (expire) its own deals ──
  // The configured source.url redirects to a different finalUrl; deals pin
  // source_url = finalUrl. Without resolved_url tracking, monitor's source-scoped
  // expiry keys off source.url and never matches → published deals never expire.

  it('expires a REDIRECTING source’s published deals (keyed by finalUrl) via resolved_url', async () => {
    const configuredUrl = 'https://src.de/offer';
    const finalUrl = 'https://www.final.de/offer'; // post-redirect; deals are keyed here
    // First pass: a successful fetch (resolves to finalUrl) records resolved_url.
    const fetcher = new FakeFetcher({ text: PAGE_TEXT, finalUrl });
    const env = build(fetcher);
    const redirecting = makeSource({ url: configuredUrl, resolved_url: null });
    await env.db.sources.upsert(redirecting);
    // The deal is pinned to the finalUrl (as CandidateSink does in production).
    const deal = await seedPublishedDeal(env.db, env.evidenceStore, finalUrl, sha256(PAGE_TEXT));

    // Pass 1 (content matches): records resolved_url = finalUrl, no expiry.
    await env.monitor.execute({ sourceId: redirecting.id });
    const afterPass1 = await env.db.sources.getById(redirecting.id);
    expect(afterPass1!.resolved_url).toBe(finalUrl);
    expect((await env.db.deals.getById(deal.id))!.status).toBe('published');

    // Now the page disappears → two consecutive disappearances must expire the deal,
    // matching on resolved_url (finalUrl) — NOT the configured source.url.
    fetcher.setResult({ outcome: 'error', text: '' });
    await env.monitor.execute({ sourceId: redirecting.id }); // 1st disappearance: debounced
    expect((await env.db.deals.getById(deal.id))!.status).toBe('published');
    const second = await env.monitor.execute({ sourceId: redirecting.id }); // 2nd: expires
    expect(second.expired).toBe(1);
    expect((await env.db.deals.getById(deal.id))!.status).toBe('expired');
  });

  it('falls back to source.url for expiry when resolved_url is still null (non-redirecting / first-seen)', async () => {
    // A source that doesn't redirect (finalUrl === url) and whose resolved_url is
    // null still expires correctly via the source.url fallback.
    const fetcher = new FakeFetcher({ outcome: 'error', text: '' });
    const env = build(fetcher);
    const src = makeSource({ resolved_url: null });
    await env.db.sources.upsert(src);
    const deal = await seedPublishedDeal(env.db, env.evidenceStore, src.url, sha256(PAGE_TEXT));

    await env.monitor.execute({ sourceId: src.id }); // 1st: debounced
    const second = await env.monitor.execute({ sourceId: src.id }); // 2nd: expires
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

  // ── Reliability / cadence on the monitor path (plan §7) ──────────────────────

  it('lowers reliability and backs off cadence on an unreachable pass', async () => {
    // reliabilityAfter(0.5, false) = 0.3 → backoffMultiplier(0.3) = 4 → 3*4 = 12 days.
    const fetcher = new FakeFetcher({ outcome: 'error', text: '' });
    const env = build(fetcher); // source.reliability_score = 0.5, cadence_days = 3
    await env.db.sources.upsert(source);
    await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    await env.monitor.execute({ sourceId: source.id });

    const updated = await env.db.sources.getById(source.id);
    expect(updated!.reliability_score).toBeCloseTo(0.3, 10);
    const expectedDueMs = env.clock.now().getTime() + 12 * 24 * 60 * 60 * 1000;
    expect(Date.parse(updated!.next_due!)).toBe(expectedDueMs);
  });

  it('raises reliability on a successful unchanged pass', async () => {
    // reliabilityAfter(0.5, true) = 0.55.
    const fetcher = new FakeFetcher({ text: PAGE_TEXT });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    await env.monitor.execute({ sourceId: source.id });

    const updated = await env.db.sources.getById(source.id);
    expect(updated!.reliability_score).toBeCloseTo(0.55, 10);
  });

  it('a blocked pass does NOT change reliability (manual-capture route, not a failure)', async () => {
    const fetcher = new FakeFetcher({ outcome: 'blocked', text: '' });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    await env.monitor.execute({ sourceId: source.id });

    const updated = await env.db.sources.getById(source.id);
    // Reliability unchanged at the seeded 0.5; schedule still advanced off the
    // back-off curve at that reliability (backoffMultiplier(0.5)=3 → 9 days).
    expect(updated!.reliability_score).toBe(0.5);
    const expectedDueMs = env.clock.now().getTime() + 9 * 24 * 60 * 60 * 1000;
    expect(Date.parse(updated!.next_due!)).toBe(expectedDueMs);
  });

  it('flags a source that falls below the reliability threshold on repeated failures', async () => {
    // 0.5 → 0.3 → 0.1 (< RELIABILITY_FLAG_THRESHOLD 0.3) after two failures.
    const fetcher = new FakeFetcher({ outcome: 'error', text: '' });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256(PAGE_TEXT));

    await env.monitor.execute({ sourceId: source.id });
    await env.monitor.execute({ sourceId: source.id });

    const updated = await env.db.sources.getById(source.id);
    expect(updated!.reliability_score).toBeCloseTo(0.1, 10);
    expect(updated!.reliability_score).toBeLessThan(0.3); // below the flag threshold
  });

  it('does not clobber the re-crawl back-off next_due on a content-changed pass', async () => {
    // content_changed → CrawlSource re-crawls (a SUCCESS re-fetch here), which owns
    // reliability + next_due. The monitor finally must NOT overwrite that with a
    // stale, separately-computed schedule. Reliability ends at the re-crawl's value
    // (0.5 → 0.55), and next_due matches the re-crawl's back-off, applied ONCE.
    const fetcher = new FakeFetcher({ text: PAGE_TEXT + ' Jetzt 6 Monate gratis!' });
    const env = build(fetcher);
    await env.db.sources.upsert(source);
    await seedPublishedDeal(env.db, env.evidenceStore, source.url, sha256('OLD CONTENT'));

    const result = await env.monitor.execute({ sourceId: source.id });
    expect(result.reQueued).toBe(true);

    const updated = await env.db.sources.getById(source.id);
    // The re-crawl applied success once: 0.5 → 0.55 (NOT 0.6, which a double-apply
    // by the monitor finally would produce).
    expect(updated!.reliability_score).toBeCloseTo(0.55, 10);
    // next_due is the re-crawl's back-off schedule: backoffMultiplier(0.55)=3 → 9 days.
    const expectedDueMs = env.clock.now().getTime() + 9 * 24 * 60 * 60 * 1000;
    expect(Date.parse(updated!.next_due!)).toBe(expectedDueMs);
  });
});
