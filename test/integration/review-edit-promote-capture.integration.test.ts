import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import { makeDealRecord, makeLlmDeal } from '../factories/deal.js';
import type { Container } from '../../src/composition/container.js';
import type { DealRecord, Evidence } from '../../src/domain/index.js';

/**
 * The four new admin review actions, end to end through the REAL composition root +
 * REAL Postgres (migration 0013 / schema v5 applied):
 *   1. PATCH edit a candidate → re-validate, tag human_edited, audit; approve
 *      publishes the EDITED record.
 *   2. promote a field proposal → a condition_vocabulary row + proposal resolved.
 *   3. complete a manual-capture task → an evidence-backed candidate (no auto-publish).
 *   4. listCandidates filters + paginates over real SQL.
 * Verifies the wiring + SQL round-trips a fake can't (status transitions, audit
 * rows, evidence + vocabulary rows actually written).
 */
const suite = hasDb ? describe : describe.skip;

// Deterministic doubles for the genuinely-external edges; these flows don't crawl.
const overrides = {
  fetcher: new ScriptedFetcher({}),
  llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [] }) }),
};

suite('review edit / promote / manual-capture (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  async function seedCandidate(over: Partial<DealRecord> = {}): Promise<DealRecord> {
    const ev: Evidence = {
      id: randomUUID(),
      source_url: 'https://www.telekom.de/magenta-tv',
      screenshot_ref: 's.png',
      html_ref: 'p.html',
      terms_ref: 't.txt',
      captured_at: '2026-06-19T00:00:00.000Z',
      content_hash: 'h',
    };
    await container.db.evidence.insert(ev);
    const deal = makeDealRecord({ evidence_id: ev.id, status: 'candidate', ...over });
    await container.db.deals.insert(deal);
    return deal;
  }

  it('PATCH edit → re-validate + human_edited + audit; approve publishes the edited record', async () => {
    container = makeContainer(overrides);
    const deal = await seedCandidate({ headline: 'before', human_edited: [] });

    const edited = await container.review.editCandidate(deal.id, 'alice', {
      headline: 'corrected via review',
      price: { amount: 120, currency: 'EUR', billing: 'annual' },
    });
    expect(edited.headline).toBe('corrected via review');
    expect(edited.true_cost_monthly).toBe(10); // 120/12, re-derived
    expect(edited.human_edited.sort()).toEqual(['headline', 'price']);
    expect(edited.status).toBe('candidate');

    // Persisted (round-trips through the schema on read).
    const reloaded = (await container.db.deals.getById(deal.id))!;
    expect(reloaded.headline).toBe('corrected via review');
    expect(reloaded.human_edited.sort()).toEqual(['headline', 'price']);

    // Audit row written with action 'edit'.
    const history = await container.review.listReviews(deal.id);
    expect(history.some((r) => r.action === 'edit' && r.approver === 'alice')).toBe(true);

    // Approve publishes the EDITED version.
    const published = await container.review.approve(deal.id, 'bob');
    expect(published.status).toBe('published');
    expect(published.headline).toBe('corrected via review');
    expect((await container.db.deals.getById(deal.id))!.status).toBe('published');
  });

  it('promote a field proposal → condition_vocabulary row + proposal resolved + audited via vocabulary read', async () => {
    container = makeContainer(overrides);
    await container.db.fieldProposals.upsertAndCount({
      suggested_key: 'requires_pet',
      label: 'Pet required',
      rationale: 'r',
      example_quote: 'q',
      first_seen_at: '2026-06-19T00:00:00.000Z',
      last_seen_at: '2026-06-19T00:00:00.000Z',
    });

    const entry = await container.review.promoteFieldProposal({
      approver: 'alice',
      suggestedKey: 'requires_pet',
      canonicalKey: 'requires_other_product',
      label: 'Requires another product',
      target: 'vocabulary',
    });
    expect(entry.key).toBe('requires_other_product');
    expect(entry.aliases).toContain('requires_pet');

    // The vocabulary row is in Postgres.
    const stored = await container.db.conditionVocabulary.getByKey('requires_other_product');
    expect(stored).not.toBeNull();
    expect(stored!.label).toBe('Requires another product');

    // The proposal is resolved out of the open queue.
    expect((await container.db.fieldProposals.getByKey('requires_pet'))!.status).toBe('promoted');
    expect(await container.review.listFieldProposals()).toHaveLength(0);
  });

  it('complete a manual-capture task → evidence-backed candidate (no auto-publish), task closed, audited', async () => {
    container = makeContainer(overrides);
    const taskId = randomUUID();
    await container.db.manualCapture.insert({
      id: taskId,
      source_id: null,
      source_url: 'https://blocked.example/offer',
      reason: 'captcha',
      created_at: '2026-06-19T00:00:00.000Z',
      status: 'open',
      note: null,
    });

    const candidate = await container.review.completeManualCapture(
      taskId,
      'alice',
      makeLlmDeal({ source_url: 'https://ignored.example' }),
      {
        sourceUrl: 'https://blocked.example/offer',
        screenshotRef: 'manual/s.png',
        htmlRef: 'manual/p.html',
        termsRef: 'manual/t.txt',
        termsText: 'Disney+ ist im Tarif enthalten für 10 EUR pro Monat.',
      },
    );

    // Never published; provenance pinned from the evidence.
    expect(['candidate', 'in_review']).toContain(candidate.status);
    expect(candidate.source_url).toBe('https://blocked.example/offer');
    expect(candidate.human_edited.length).toBeGreaterThan(0);

    // Candidate + evidence persisted and linked.
    const storedDeal = (await container.db.deals.getById(candidate.id))!;
    expect(storedDeal.evidence_id).toBe(candidate.evidence_id);
    const storedEv = await container.db.evidence.getById(candidate.evidence_id);
    expect(storedEv!.screenshot_ref).toBe('manual/s.png');

    // Task closed; audit row written.
    expect((await container.db.manualCapture.getById(taskId))!.status).toBe('done');
    const history = await container.review.listReviews(candidate.id);
    expect(history.some((r) => r.action === 'edit' && r.approver === 'alice')).toBe(true);

    // The new candidate then flows through normal review.
    const published = await container.review.approve(candidate.id, 'bob');
    expect(published.status).toBe('published');
  });

  it('listCandidates filters by status + confidence_max and paginates over real SQL', async () => {
    container = makeContainer(overrides);
    const svc = `svc-${randomUUID()}`;
    await seedCandidate({ service: svc, status: 'candidate', confidence: 0.3 });
    await seedCandidate({ service: svc, status: 'candidate', confidence: 0.9 });
    await seedCandidate({ service: svc, status: 'published', confidence: 0.5 });

    const low = await container.review.listCandidates({
      filters: { service: svc, confidenceMax: 0.5 },
    });
    expect(low).toHaveLength(1);
    expect(low[0]!.deal.confidence).toBe(0.3);

    const page = await container.review.listCandidates({
      filters: { service: svc },
      limit: 1,
      offset: 0,
    });
    expect(page).toHaveLength(1);
    expect(page[0]!.deal.confidence).toBe(0.3); // lowest-confidence first
  });

  it('candidateCounts aggregates deal counts + rejected_today over real SQL (ACR-5)', async () => {
    container = makeContainer(overrides);
    const before = await container.review.candidateCounts();

    await seedCandidate({
      status: 'candidate',
      route_type: 'bundle',
      confidence: 0.3,
      human_edited: ['price'],
    });
    await seedCandidate({ status: 'in_review', route_type: 'promo', confidence: 0.95 });
    await seedCandidate({ status: 'published', route_type: 'bundle', confidence: 0.1 }); // not pending

    // A reject decided "now" → counts under rejected_today (the real clock's UTC day).
    await container.db.reviews.insert({
      id: randomUUID(),
      deal_id: randomUUID(),
      action: 'reject',
      approver: 'r',
      reason: null,
      decided_at: new Date().toISOString(),
    });

    const after = await container.review.candidateCounts();
    expect(after.all_pending - before.all_pending).toBe(2);
    expect(after.low_confidence - before.low_confidence).toBe(1); // only the 0.3
    expect(after.human_edited - before.human_edited).toBe(1);
    expect(after.by_route.bundle - before.by_route.bundle).toBe(1); // published bundle excluded
    expect(after.by_route.promo - before.by_route.promo).toBe(1);
    expect(after.rejected_today - before.rejected_today).toBe(1);
  });

  it('adminPublished returns live + unpublished history newest-first over real SQL (ACR-10)', async () => {
    container = makeContainer(overrides);
    const before = await container.review.adminPublished();
    await seedCandidate({ status: 'published', published_at: '2026-06-10T00:00:00.000Z' });
    await seedCandidate({ status: 'expired', published_at: '2026-05-01T00:00:00.000Z' });
    await seedCandidate({ status: 'candidate' }); // excluded

    const after = await container.review.adminPublished({ limit: 200, offset: 0 });
    expect(after.total - before.total).toBe(2);
    // the two new rows are present, mapped + projected.
    const live = after.deals.find((d) => d.published_at === '2026-06-10T00:00:00.000Z');
    const unp = after.deals.find((d) => d.published_at === '2026-05-01T00:00:00.000Z');
    expect(live!.status).toBe('live');
    expect(unp!.status).toBe('unpublished');
    expect(live!.geo).toBeDefined();
    expect(live!.true_monthly).toBeDefined();
  });

  it('createManualCapture mints a done ad_hoc task + evidence-backed candidate (ACR-12)', async () => {
    container = makeContainer(overrides);
    const candidate = await container.review.createManualCapture('alice', makeLlmDeal(), {
      sourceUrl: 'https://blocked.example/offer',
      screenshotRef: 'manual/s.png',
      htmlRef: 'manual/p.html',
      termsRef: 'manual/t.txt',
      termsText: 'Disney+ ist im Tarif enthalten für 10 EUR pro Monat.',
    });
    // never published; persisted with evidence; whole record human-edited.
    expect(['candidate', 'in_review']).toContain(candidate.status);
    const reloaded = (await container.db.deals.getById(candidate.id))!;
    expect(reloaded.source_url).toBe('https://blocked.example/offer');
    expect(reloaded.human_edited.length).toBeGreaterThan(0);
    expect(await container.db.evidence.getById(candidate.evidence_id)).not.toBeNull();
    // the ad_hoc task is minted done → nothing left in the open queue.
    expect(await container.db.manualCapture.listOpen(50)).toHaveLength(0);
    // audit row written.
    const history = await container.review.listReviews(candidate.id);
    expect(history.some((r) => r.action === 'edit' && r.approver === 'alice')).toBe(true);
  });

  it('auditFeed projects approve/reject/edit rows newest-first over real SQL (ACR-7)', async () => {
    container = makeContainer(overrides);
    // Drive REAL review actions so the reviews audit rows are written by the use-case.
    const deal = await seedCandidate({ headline: 'before' });
    await container.review.editCandidate(deal.id, 'alice@dealroute', { headline: 'after' });
    await container.review.approve(deal.id, 'bob@dealroute');

    const feed = await container.review.auditFeed({ entityId: deal.id });
    // newest-first: approve (later) before edit (earlier); both scoped to the deal.
    expect(feed.map((e) => e.action)).toEqual(['approve', 'edit']);
    expect(feed.every((e) => e.entity_id === deal.id)).toBe(true);
    expect(feed.find((e) => e.action === 'approve')!.initials).toBe('BO');

    // actor filter narrows to one reviewer.
    const byAlice = await container.review.auditFeed({ actor: 'alice@dealroute' });
    expect(byAlice.every((e) => e.actor === 'alice@dealroute')).toBe(true);
    expect(byAlice.some((e) => e.entity_id === deal.id && e.action === 'edit')).toBe(true);
  });

  it('throughputToday counts today decisions + averages capture→decision latency over real SQL (ACR-6)', async () => {
    container = makeContainer(overrides);
    // A candidate captured well before its decision; a REAL approve drives the review
    // row (the use-case writes decided_at = now). The latency join is reviews→deals→evidence.
    const deal = await seedCandidate(); // evidence captured_at 2026-06-19 (years ago)
    await container.review.approve(deal.id, 'mara@dealroute');

    const out = await container.metrics.throughputToday();
    expect(out.approved).toBe(1);
    expect(out.rejected).toBe(0);
    expect(out.edited).toBe(0);
    // captured years before "now" → a large positive latency (proves the SQL join works).
    expect(out.avg_review_seconds).not.toBeNull();
    expect(out.avg_review_seconds!).toBeGreaterThan(0);
  });

  it('queueFreshness buckets the pending queue by evidence age over real SQL (ACR-9)', async () => {
    container = makeContainer(overrides);
    // Two pending candidates (evidence captured 2026-06-19, years ago → both >3d);
    // a published deal must not enter the distribution.
    await seedCandidate({ status: 'candidate' });
    await seedCandidate({ status: 'in_review' });
    await seedCandidate({ status: 'published' });

    const bands = await container.metrics.queueFreshness();
    expect(bands.map((b) => b.bucket)).toEqual(['<24h', '1-3d', '>3d']);
    expect(bands.reduce((a, b) => a + b.percent, 0)).toBe(100);
    // both pending candidates are years old → 100% in >3d (published excluded).
    expect(bands.find((b) => b.bucket === '>3d')!.percent).toBe(100);
  });

  it('dashboardMetrics rolls up KPIs + dense cost series + confidence dist over real SQL (ACR-10 Metrics)', async () => {
    container = makeContainer(overrides);
    // Pending candidates → avg-confidence KPI + the distribution.
    await seedCandidate({ status: 'candidate', confidence: 0.9 });
    await seedCandidate({ status: 'in_review', confidence: 0.5 });
    // A real approve → today's throughput + approval-rate KPIs.
    const decided = await seedCandidate({ confidence: 0.8 });
    await container.review.approve(decided.id, 'mara@dealroute');

    const m = await container.metrics.dashboardMetrics();
    expect(m.kpis.map((k) => k.key)).toEqual([
      'crawl-cost',
      'throughput',
      'approval-rate',
      'avg-confidence',
    ]);
    // Dense 14-day cost chart (zero-cost days included since no crawl_runs were logged).
    expect(m.cost_per_day).toHaveLength(14);
    expect(m.cost_per_day.every((b) => b.cost === 0)).toBe(true);
    // Three confidence bands summing to 100 over the real pending queue.
    expect(m.confidence_distribution.map((b) => b.level)).toEqual(['success', 'warning', 'danger']);
    expect(m.confidence_distribution.reduce((a, b) => a + b.percent, 0)).toBe(100);
  });
});
