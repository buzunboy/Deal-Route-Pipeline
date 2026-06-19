import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
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
});
