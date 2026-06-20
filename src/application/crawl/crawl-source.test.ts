import { describe, it, expect, beforeEach } from 'vitest';
import { CrawlSourceUseCase } from './crawl-source.js';
import { ExtractUseCase } from '../extract/extract.js';
import { SEED_VOCABULARY, dedupeKey } from '../../domain/index.js';
import { dealToRow } from '../../adapters/db/postgres/mappers.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import {
  FakeFetcher,
  FakeLlm,
  FakeEvidenceStore,
  FixedClock,
  FakeLogger,
  FakeAlerter,
} from '../../../test/fakes/fakes.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';
import { makeSource } from '../../../test/factories/source.js';
import { tldtsSuffixOracle } from '../../adapters/suffix/tldts-suffix-oracle.js';

const PAGE_TEXT = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.';

function build(opts: { fetcher?: FakeFetcher; llmJson?: string } = {}) {
  const db = new InMemoryDb();
  const fetcher = opts.fetcher ?? new FakeFetcher({ text: PAGE_TEXT });
  const llm = new FakeLlm(opts.llmJson ?? JSON.stringify({ deals: [makeLlmDeal()] }));
  const evidence = new FakeEvidenceStore();
  const clock = new FixedClock();
  const logger = new FakeLogger();
  const extract = new ExtractUseCase(llm, logger, tldtsSuffixOracle);
  const alerter = new FakeAlerter();
  const uc = new CrawlSourceUseCase(
    fetcher,
    evidence,
    db,
    extract,
    clock,
    logger,
    SEED_VOCABULARY,
    'TestAgent/0.1',
    30000,
    alerter,
  );
  return { uc, db, evidence, fetcher, alerter };
}

describe('CrawlSourceUseCase', () => {
  let env: ReturnType<typeof build>;
  let sourceId: string;

  beforeEach(async () => {
    env = build();
    const source = makeSource();
    sourceId = source.id;
    await env.db.sources.upsert(source);
  });

  it('captures evidence and lands a candidate (status=candidate, never published)', async () => {
    const result = await env.uc.execute({ sourceId });
    expect(result.candidates).toHaveLength(1);
    expect(env.evidence.saved).toHaveLength(1);

    const candidates = await env.db.deals.listByStatus('candidate', 10);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe('candidate');
    expect(candidates[0]!.evidence_id).toBe(env.evidence.saved[0]!.id);
    expect(candidates[0]!.true_cost_monthly).toBe(10);
  });

  it('links every candidate to evidence captured BEFORE it (evidence-required invariant)', async () => {
    await env.uc.execute({ sourceId });
    const deal = (await env.db.deals.listByStatus('candidate', 10))[0]!;
    const evidence = await env.evidence.get(deal.evidence_id);
    expect(evidence).not.toBeNull();
    expect(evidence!.screenshot_ref).toMatch(/screenshot/);
  });

  it('routes a login-gated page to manual capture and writes NO candidate', async () => {
    env = build({ fetcher: new FakeFetcher({ outcome: 'login_required' }) });
    const source = makeSource();
    await env.db.sources.upsert(source);

    const result = await env.uc.execute({ sourceId: source.id });
    expect(result.routedToManualCapture).toBe(true);

    const tasks = await env.db.manualCapture.listOpen(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.reason).toBe('login_required');
    expect(await env.db.deals.listByStatus('candidate', 10)).toHaveLength(0);
  });

  it('refuses to crawl a non-active source (pending_approval / rejected) — never auto-bypasses the human gate', async () => {
    for (const status of ['pending_approval', 'rejected'] as const) {
      env = build();
      const src = makeSource({ status });
      await env.db.sources.upsert(src);
      const result = await env.uc.execute({ sourceId: src.id });
      expect(result.run.status).toBe('skipped');
      expect(result.candidates).toHaveLength(0);
      expect(result.evidence).toBeNull();
      // No evidence captured, no candidate written for an unapproved/rejected source.
      expect(env.evidence.saved).toHaveLength(0);
      expect(await env.db.deals.listByStatus('candidate', 10)).toHaveLength(0);
    }
  });

  it('dedupes: a second crawl of identical content does not double-insert', async () => {
    await env.uc.execute({ sourceId });
    await env.uc.execute({ sourceId });
    expect(await env.db.deals.listByStatus('candidate', 10)).toHaveLength(1);
  });

  it('cross-domain redirect: one provenance URL across extract+evidence+persist — dedupes on re-crawl', async () => {
    // The configured source URL redirects to a DIFFERENT registrable domain (the
    // page actually lives elsewhere). Extraction, the evidence bundle, and the
    // persisted record must all agree on ONE provenance URL — `fetched.finalUrl`,
    // the post-redirect location — exactly as the discover/ingest lanes do. If
    // extract derived its dedupe key from `source.url` while the persisted key is
    // recomputed from the (finalUrl-pinned) `source_url`, the now domain-folding
    // dedupe key would diverge and a re-crawl would fail to collapse. Pinning one
    // URL keeps extract-time and persist-time keys identical.
    const SOURCE_URL = 'https://www.telekom.de/magenta-disney';
    const FINAL_URL = 'https://offers.magenta-redirect.example/disney'; // different registrable domain
    const fetcher = new FakeFetcher({ text: PAGE_TEXT, finalUrl: FINAL_URL });
    env = build({ fetcher });
    const source = makeSource({ url: SOURCE_URL });
    await env.db.sources.upsert(source);

    // (a) Two crawls of identical content collapse to a single record.
    await env.uc.execute({ sourceId: source.id });
    await env.uc.execute({ sourceId: source.id });
    const candidates = await env.db.deals.listByStatus('candidate', 10);
    expect(candidates).toHaveLength(1);

    const persisted = candidates[0]!;
    // Provenance is pinned to the post-redirect URL, not the configured source URL,
    // and matches the evidence bundle (one chain).
    expect(persisted.source_url).toBe(FINAL_URL);
    const ev = await env.db.evidence.getById(persisted.evidence_id);
    expect(ev!.source_url).toBe(FINAL_URL);

    // (b) The persisted dedupe key (the one the postgres mapper writes from the
    // stored record) equals the key recomputed from the deal's own `source_url`,
    // so extract-time and persist-time keys agree. Because the split-by-source key
    // folds the registrable domain, it folds the POST-REDIRECT domain (finalUrl),
    // NOT the configured source.url's — which is exactly why aligning extract to
    // finalUrl matters: deriving the key from source.url would have produced a
    // DIFFERENT key that never matched its own persisted row.
    // The persisted key is recomputed from the PINNED source_registrable_domain
    // (Step 6), which is the eTLD+1 of the post-redirect finalUrl.
    expect(dealToRow(persisted).dedupeKey).toBe(
      dedupeKey(persisted, persisted.source_registrable_domain),
    );
    expect(dealToRow(persisted).dedupeKey).toBe(dedupeKey(persisted, tldtsSuffixOracle(FINAL_URL)));
    expect(dedupeKey(persisted, tldtsSuffixOracle(SOURCE_URL))).not.toBe(
      dedupeKey(persisted, tldtsSuffixOracle(FINAL_URL)),
    );
  });

  it('changed content on the same route → fresh in_review candidate, original untouched', async () => {
    // First crawl: a clean candidate for the route.
    await env.uc.execute({ sourceId });
    const first = (await env.db.deals.listByStatus('candidate', 10))[0]!;

    // Second crawl: same route (dedupe key unchanged) but the page text changed,
    // so the new evidence content_hash differs → a re-review candidate is queued.
    env.fetcher.setResult({ text: PAGE_TEXT + ' Jetzt mit neuem Preis: 12,00 €/Monat.' });
    await env.uc.execute({ sourceId });

    // The original candidate is left intact (not mutated/removed)…
    const stillThere = await env.db.deals.getById(first.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.status).toBe('candidate');
    // …and a SEPARATE fresh candidate is queued for re-review (forced in_review).
    const inReview = await env.db.deals.listByStatus('in_review', 10);
    expect(inReview).toHaveLength(1);
    expect(inReview[0]!.id).not.toBe(first.id);
    // The fresh candidate links the NEW evidence bundle (not the stale one).
    expect(inReview[0]!.evidence_id).not.toBe(first.evidence_id);
  });

  it('pins persisted source_url to the FETCHED url, ignoring an LLM-supplied URL', async () => {
    // The model emits a wrong/hallucinated source_url; it must NOT be trusted —
    // the stored URL must match the page the evidence was captured from, or the
    // reviewer verifies against the wrong page and monitoring can't find the deal.
    const deal = makeLlmDeal({ source_url: 'https://evil-competitor.example/not-the-page' });
    env = build({ llmJson: JSON.stringify({ deals: [deal] }) });
    const source = makeSource({ url: 'https://www.telekom.de/magenta-disney' });
    await env.db.sources.upsert(source);

    await env.uc.execute({ sourceId: source.id });
    const persisted = (await env.db.deals.listByStatus('candidate', 10))[0]!;
    expect(persisted.source_url).toBe('https://www.telekom.de/magenta-disney');
    expect(persisted.source_url).not.toContain('evil-competitor');
    // And it matches the evidence bundle's source_url (one provenance chain).
    const ev = await env.db.evidence.getById(persisted.evidence_id);
    expect(ev!.source_url).toBe(persisted.source_url);
  });

  it('re-crawling identical content twice never queues a duplicate candidate (idempotent)', async () => {
    await env.uc.execute({ sourceId });
    await env.uc.execute({ sourceId });
    await env.uc.execute({ sourceId });
    const total =
      (await env.db.deals.listByStatus('candidate', 10)).length +
      (await env.db.deals.listByStatus('in_review', 10)).length;
    expect(total).toBe(1);
  });

  it('a cross-domain-redirecting source still dedupes on re-crawl (extract key uses finalUrl)', async () => {
    // Trust-critical (split-by-source): the dedupe key folds in the registrable
    // domain of the SOURCE. The configured source.url redirects to a DIFFERENT
    // domain, so the extract-time key MUST use fetched.finalUrl (the URL evidence
    // pins as source_url) — not source.url — or the second crawl's lookup misses
    // its own prior row and inserts a duplicate. Regression for the Lane-A
    // key-consistency bug the adversarial verify pass caught.
    const fetcher = new FakeFetcher({
      text: PAGE_TEXT,
      finalUrl: 'https://www.telekom.de/magenta-disney', // post-redirect, different domain
    });
    const localEnv = build({ fetcher });
    const source = makeSource({ url: 'https://magenta-tv.de/disney' }); // configured (pre-redirect)
    await localEnv.db.sources.upsert(source);

    await localEnv.uc.execute({ sourceId: source.id });
    await localEnv.uc.execute({ sourceId: source.id });

    const total =
      (await localEnv.db.deals.listByStatus('candidate', 10)).length +
      (await localEnv.db.deals.listByStatus('in_review', 10)).length;
    expect(total).toBe(1); // deduped — would be 2 if extract used source.url
    // And the persisted key's source segment is the final (redirected) domain.
    const persisted = (await localEnv.db.deals.listByStatus('candidate', 10))[0]!;
    expect(persisted.source_url).toBe('https://www.telekom.de/magenta-disney');
  });

  it('records field proposals for unknown conditions', async () => {
    const deal = makeLlmDeal({
      validity: {
        start: '2026-01-01',
        end: null,
        recheck_days: 3,
        conditions: [
          { key: 'requires_moon_phase', label: 'Full moon only', source_quote: PAGE_TEXT },
        ],
      },
    });
    env = build({ llmJson: JSON.stringify({ deals: [deal] }) });
    const source = makeSource();
    await env.db.sources.upsert(source);

    await env.uc.execute({ sourceId: source.id });
    const proposals = await env.db.fieldProposals.listOpen(10);
    expect(proposals.some((p) => p.suggested_key === 'requires_moon_phase')).toBe(true);
  });

  it('dry-run writes nothing to the DB', async () => {
    const result = await env.uc.execute({ sourceId, dryRun: true });
    expect(result.candidates).toHaveLength(1);
    expect(await env.db.deals.listByStatus('candidate', 10)).toHaveLength(0);
    expect(await env.db.manualCapture.listOpen(10)).toHaveLength(0);
  });

  it('contains a fetch error: failed run, lowered reliability, NO evidence/candidate, never throws', async () => {
    env = build({ fetcher: new FakeFetcher({ outcome: 'error', error: 'boom', text: '' }) });
    const source = makeSource({ reliability_score: 0.5 });
    await env.db.sources.upsert(source);

    const result = await env.uc.execute({ sourceId: source.id });
    expect(result.run.status).toBe('failed');
    expect(result.candidates).toHaveLength(0);
    expect(result.evidence).toBeNull();
    // Evidence-required invariant: an error fetch never persists empty evidence.
    expect(env.evidence.saved).toHaveLength(0);
    expect(await env.db.deals.listByStatus('candidate', 10)).toHaveLength(0);
    // Reliability was lowered by the failure.
    expect((await env.db.sources.getById(source.id))!.reliability_score).toBeLessThan(0.5);
  });

  // Prereq A: a successful crawl pins the POST-REDIRECT finalUrl onto the source's
  // resolved_url, so monitor can match deals (keyed by source_url=finalUrl) later.
  it('records resolved_url = the post-redirect finalUrl on a successful crawl', async () => {
    const finalUrl = 'https://www.telekom.de/magenta-final';
    env = build({ fetcher: new FakeFetcher({ text: PAGE_TEXT, finalUrl }) });
    const source = makeSource({ url: 'https://telekom.de/redirects', resolved_url: null });
    await env.db.sources.upsert(source);

    await env.uc.execute({ sourceId: source.id });

    expect((await env.db.sources.getById(source.id))!.resolved_url).toBe(finalUrl);
  });

  it('does NOT change resolved_url on a failed crawl (a failed pass saw no final URL)', async () => {
    env = build({ fetcher: new FakeFetcher({ outcome: 'error', error: 'boom', text: '' }) });
    const source = makeSource({ resolved_url: 'https://prior.de/r' });
    await env.db.sources.upsert(source);

    await env.uc.execute({ sourceId: source.id });

    expect((await env.db.sources.getById(source.id))!.resolved_url).toBe('https://prior.de/r');
  });

  // Step 5: a failing crawl that drops reliability below the flag threshold emits a
  // source_reliability_low alert alongside the warn (best-effort, never crashes).
  it('emits a source_reliability_low alert when reliability falls below threshold', async () => {
    env = build({ fetcher: new FakeFetcher({ outcome: 'error', error: 'boom', text: '' }) });
    // 0.4 → fail → 0.2 (< 0.3 threshold) → reliabilityLow fires.
    const source = makeSource({ reliability_score: 0.4, url: 'https://flaky.de/x' });
    await env.db.sources.upsert(source);

    await env.uc.execute({ sourceId: source.id });

    expect(env.alerter.events).toHaveLength(1);
    expect(env.alerter.events[0]!.kind).toBe('source_reliability_low');
    expect(env.alerter.events[0]!.dedupe_key).toBe(`source_reliability_low:${source.id}`);
  });

  it('does NOT alert when reliability stays at/above threshold', async () => {
    // 0.9 → fail → 0.7 (>= 0.3) → no alert.
    const flaky = build({
      fetcher: new FakeFetcher({ outcome: 'error', error: 'boom', text: '' }),
    });
    const source = makeSource({ reliability_score: 0.9 });
    await flaky.db.sources.upsert(source);
    await flaky.uc.execute({ sourceId: source.id });
    expect(flaky.alerter.events).toHaveLength(0);
  });

  it('reliability decides cadence: a flaky source is scheduled further out than a healthy one', async () => {
    // A successful crawl of a high-reliability source → tight cadence (≈base).
    const healthy = makeSource({ reliability_score: 0.95, cadence_days: 3, next_due: null });
    await env.db.sources.upsert(healthy);
    await env.uc.execute({ sourceId: healthy.id });
    const healthyDue = (await env.db.sources.getById(healthy.id))!.next_due!;

    // A failing crawl drops a marginal source below the flag threshold → it backs
    // off (longer next_due) so we stop hammering an unreliable origin.
    const flaky = build({
      fetcher: new FakeFetcher({ outcome: 'error', error: 'boom', text: '' }),
    });
    const flakySource = makeSource({ reliability_score: 0.5, cadence_days: 3, next_due: null });
    await flaky.db.sources.upsert(flakySource);
    await flaky.uc.execute({ sourceId: flakySource.id });
    const flakyDue = (await flaky.db.sources.getById(flakySource.id))!.next_due!;

    // FixedClock = 2026-06-19; reliability 0.95 → 1x cadence (3d) = 2026-06-22.
    expect(healthyDue).toBe('2026-06-22T00:00:00.000Z');
    // reliability 0.5 → fail → 0.3 → multiplier round(1 + 0.7*4)=4 → 12d = 2026-07-01.
    expect(flakyDue).toBe('2026-07-01T00:00:00.000Z');
    expect(new Date(flakyDue).getTime()).toBeGreaterThan(new Date(healthyDue).getTime());
  });

  it('flags a low-confidence extraction as in_review (must-review triage signal)', async () => {
    // A hallucinated grounding quote forces must-review.
    const deal = makeLlmDeal({
      grounding: [
        { field: 'price', quote: 'This deal is free forever, no conditions whatsoever.' },
        { field: 'eligibility', quote: PAGE_TEXT },
        { field: 'validity', quote: PAGE_TEXT },
      ],
    });
    env = build({ llmJson: JSON.stringify({ deals: [deal] }) });
    const source = makeSource();
    await env.db.sources.upsert(source);

    await env.uc.execute({ sourceId: source.id });
    expect(await env.db.deals.listByStatus('candidate', 10)).toHaveLength(0);
    expect(await env.db.deals.listByStatus('in_review', 10)).toHaveLength(1);
  });
});
