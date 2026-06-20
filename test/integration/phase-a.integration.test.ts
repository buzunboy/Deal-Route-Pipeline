import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm, SequencedFakeLlm, FixedClock } from '../fakes/fakes.js';
import { makeLlmDeal } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Phase A end-to-end through the REAL composition root + REAL Postgres: seed a
 * source → crawl (fetch override → evidence → stub extraction → candidate
 * persisted) → review approve (status + audit row) → monitor (diff → re-queue).
 * Network/LLM are deterministic doubles; everything else is the real wiring.
 */
const PAGE = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.'; // matches the deal's grounding

const suite = hasDb ? describe : describe.skip;

suite('Phase A pipeline (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  it('crawl → candidate in Postgres, then approve → published + audit row', async () => {
    const source = makeSource({ url: 'https://www.telekom.de/magenta-disney' });
    container = makeContainer({
      fetcher: new ScriptedFetcher({ [source.url]: { text: PAGE, html: '<html></html>' } }),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    await container.db.sources.upsert(source);

    // CRAWL (Lane A): real use-case, real PostgresDb, real local-fs evidence store.
    const result = await container.crawlSource.execute({ sourceId: source.id });
    expect(result.candidates).toHaveLength(1);
    expect(result.evidence).not.toBeNull();

    // The candidate round-tripped through Postgres with its evidence link.
    const candidates = await container.db.deals.listByStatus('candidate', 10);
    expect(candidates).toHaveLength(1);
    const deal = candidates[0]!;
    expect(deal.service).toBe('Disney+');
    expect(deal.true_cost_monthly).toBe(10);
    const evidence = await container.db.evidence.getById(deal.evidence_id);
    expect(evidence).not.toBeNull();
    expect(evidence!.content_hash).toBeTruthy();

    // APPROVE: status flips in Postgres and an immutable review row is written.
    await container.review.approve(deal.id, 'reviewer@dealroute');
    expect((await container.db.deals.getById(deal.id))!.status).toBe('published');
    const history = await container.review.listReviews(deal.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: 'approve', approver: 'reviewer@dealroute' });
  });

  it('login-gated page routes to the manual-capture queue (no candidate)', async () => {
    const source = makeSource({ url: 'https://bank.example/members' });
    container = makeContainer({
      fetcher: new ScriptedFetcher({ [source.url]: { outcome: 'login_required', text: '' } }),
      llm: new RoleAwareFakeLlm({}),
    });
    await container.db.sources.upsert(source);

    const result = await container.crawlSource.execute({ sourceId: source.id });
    expect(result.routedToManualCapture).toBe(true);
    expect(await container.db.deals.listByStatus('candidate', 10)).toHaveLength(0);
    expect(await container.db.manualCapture.listOpen(10)).toHaveLength(1);
  });

  it('monitor detects a changed price/terms region and re-queues a fresh candidate', async () => {
    const source = makeSource({ url: 'https://www.telekom.de/magenta-disney' });
    const fetcher = new ScriptedFetcher({ [source.url]: { text: PAGE, html: '<html></html>' } });
    container = makeContainer({
      fetcher,
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    await container.db.sources.upsert(source);

    // First crawl establishes a candidate + its evidence hash.
    await container.crawlSource.execute({ sourceId: source.id });
    const first = (await container.db.deals.listByStatus('candidate', 10))[0]!;

    // The page content changes → monitor should diff, re-crawl, and queue a fresh
    // in_review candidate for the same route (price/terms changed).
    fetcher.setResultFor(source.url, { text: `${PAGE} Jetzt nur 8,99 € statt 10 €.` });
    const monitorResult = await container.monitor.execute({ sourceId: source.id });
    expect(monitorResult.change.kind).toBe('content_changed');

    const inReview = await container.db.deals.listByStatus('in_review', 10);
    expect(inReview).toHaveLength(1);
    expect(inReview[0]!.id).not.toBe(first.id); // a NEW candidate, original intact
    expect((await container.db.deals.getById(first.id))!.status).toBe('candidate');
  });

  it('monitor: an unreachable pass lowers reliability + backs off cadence (read back from Postgres)', async () => {
    const now = new Date('2026-06-19T00:00:00.000Z');
    const source = makeSource({
      url: 'https://gone.example/offer',
      reliability_score: 0.5,
      cadence_days: 3,
    });
    container = makeContainer({
      // No scripted page for this URL → ScriptedFetcher yields outcome:'error'.
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({}),
      clock: new FixedClock(now),
    });
    await container.db.sources.upsert(source);

    await container.monitor.execute({ sourceId: source.id });

    // The lowered reliability + backed-off next_due round-tripped through Postgres.
    const updated = await container.db.sources.getById(source.id);
    expect(updated!.reliability_score).toBeCloseTo(0.3, 10); // 0.5 - 0.2
    // backoffMultiplier(0.3) = 4 → 3 * 4 = 12 days out.
    const expectedDueMs = now.getTime() + 12 * 24 * 60 * 60 * 1000;
    expect(Date.parse(updated!.next_due!)).toBe(expectedDueMs);
  });

  it('monitor: a content-changed pass applies the re-crawl reliability ONCE (finally does not clobber)', async () => {
    // The trust-critical interaction a fake can't catch: the content_changed branch
    // re-crawls (which owns reliability + next_due via the SAME shared policy), and
    // the monitor's finally must NOT write a second, stale schedule on top. Driven
    // through the real Container + Postgres so the two writes' ordering is real.
    const now = new Date('2026-06-19T00:00:00.000Z');
    const source = makeSource({
      url: 'https://www.telekom.de/magenta-changed',
      reliability_score: 0.5,
      cadence_days: 3,
    });
    const fetcher = new ScriptedFetcher({ [source.url]: { text: PAGE, html: '<html></html>' } });
    container = makeContainer({
      fetcher,
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
      clock: new FixedClock(now),
    });
    await container.db.sources.upsert(source);

    // Establish a baseline candidate + evidence hash, then change the page content.
    await container.crawlSource.execute({ sourceId: source.id });
    fetcher.setResultFor(source.url, { text: `${PAGE} Jetzt nur 8,99 € statt 10 €.` });

    const monitorResult = await container.monitor.execute({ sourceId: source.id });
    expect(monitorResult.change.kind).toBe('content_changed');

    const updated = await container.db.sources.getById(source.id);
    // Two successful passes (initial crawl + re-crawl), each +0.05: 0.5 → 0.55 → 0.6.
    // If the monitor finally had ALSO applied success, it would be 0.65 — assert not.
    expect(updated!.reliability_score).toBeCloseTo(0.6, 10);
    // next_due is the re-crawl's back-off (backoffMultiplier(0.6)=3 → 9 days), applied
    // ONCE — not overwritten by a stale flat/duplicate schedule from the finally.
    const expectedDueMs = now.getTime() + 9 * 24 * 60 * 60 * 1000;
    expect(Date.parse(updated!.next_due!)).toBe(expectedDueMs);
  });

  it('extraction re-asks once on a first unparseable reply and persists the candidate (full Container + Postgres)', async () => {
    // The changed extract use-case end-to-end: the first LLM reply is junk (parse
    // fails past recovery), the second is valid → one bounded re-ask recovers the
    // page, the candidate lands in Postgres, and the run's logged cost reflects BOTH
    // billed calls (not just the first). A fake can't prove the persisted row + ledger.
    const source = makeSource({ url: 'https://www.telekom.de/magenta-retry' });
    const PER_CALL = 0.01;
    container = makeContainer({
      fetcher: new ScriptedFetcher({ [source.url]: { text: PAGE, html: '<html></html>' } }),
      // Junk first (unrecoverable), valid JSON second → exercises the single re-ask.
      llm: new SequencedFakeLlm(
        ['totally broken {not json', JSON.stringify({ deals: [makeLlmDeal()] })],
        PER_CALL,
      ),
    });
    await container.db.sources.upsert(source);

    const result = await container.crawlSource.execute({ sourceId: source.id });
    expect(result.candidates).toHaveLength(1);

    // The candidate round-tripped through Postgres.
    const candidates = await container.db.deals.listByStatus('candidate', 10);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.service).toBe('Disney+');

    // The run ledger charged BOTH the failed first call and the successful re-ask.
    const runs = await container.db.crawlRuns.recentRuns({ limit: 10 });
    const run = runs.find((r) => r.source_id === source.id);
    expect(run).toBeDefined();
    expect(run!.cost_eur).toBeCloseTo(PER_CALL * 2, 10);
  });

  it('approve sets + persists the EU-Omnibus disclosure fields (published_at + affiliate_disclosure)', async () => {
    // Step 2 end-to-end through real Postgres: a candidate has no published_at and
    // the default disclosure; after approve, both round-trip back from the DB.
    const source = makeSource({ url: 'https://www.telekom.de/magenta-disclosure' });
    container = makeContainer({
      fetcher: new ScriptedFetcher({ [source.url]: { text: PAGE, html: '<html></html>' } }),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    await container.db.sources.upsert(source);
    await container.crawlSource.execute({ sourceId: source.id });
    const candidate = (await container.db.deals.listByStatus('candidate', 10))[0]!;
    expect(candidate.published_at).toBeNull(); // not published yet
    expect(candidate.affiliate_disclosure).toBe(true); // safe default on the candidate

    // Reviewer publishes, explicitly setting disclosure=false (non-affiliate deal).
    await container.review.approve(candidate.id, 'reviewer@dealroute', {
      affiliateDisclosure: false,
    });

    const published = (await container.db.deals.getById(candidate.id))!;
    expect(published.status).toBe('published');
    expect(published.published_at).not.toBeNull(); // stamped at publish
    expect(published.affiliate_disclosure).toBe(false); // reviewer's value persisted (timestamptz + bool round-trip)
  });
});
