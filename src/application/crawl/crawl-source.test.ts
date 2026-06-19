import { describe, it, expect, beforeEach } from 'vitest';
import { CrawlSourceUseCase } from './crawl-source.js';
import { ExtractUseCase } from '../extract/extract.js';
import { SEED_VOCABULARY } from '../../domain/index.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import {
  FakeFetcher,
  FakeLlm,
  FakeEvidenceStore,
  FixedClock,
  FakeLogger,
} from '../../../test/fakes/fakes.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';
import { makeSource } from '../../../test/factories/source.js';

const PAGE_TEXT = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.';

function build(opts: { fetcher?: FakeFetcher; llmJson?: string } = {}) {
  const db = new InMemoryDb();
  const fetcher = opts.fetcher ?? new FakeFetcher({ text: PAGE_TEXT });
  const llm = new FakeLlm(opts.llmJson ?? JSON.stringify({ deals: [makeLlmDeal()] }));
  const evidence = new FakeEvidenceStore();
  const clock = new FixedClock();
  const logger = new FakeLogger();
  const extract = new ExtractUseCase(llm, logger);
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
  );
  return { uc, db, evidence, fetcher };
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
