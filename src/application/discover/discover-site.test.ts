import { describe, it, expect } from 'vitest';
import { DiscoverSiteUseCase } from './discover-site.js';
import { ExtractUseCase } from '../extract/extract.js';
import { SEED_VOCABULARY } from '../../domain/index.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import {
  ScriptedFetcher,
  FakeLlm,
  FakeEvidenceStore,
  FixedClock,
  FakeLogger,
} from '../../../test/fakes/fakes.js';
import type { FetchResult } from '../../application/ports/index.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';
import { makeSource } from '../../../test/factories/source.js';
import { tldtsSuffixOracle } from '../../adapters/suffix/tldts-suffix-oracle.js';

const LISTING = 'https://www.mydealz.de/gruppe/spotify';
const DEAL_A = 'https://www.mydealz.de/deals/aaa';
const DEAL_B = 'https://www.mydealz.de/deals/bbb';
const OFF_DOMAIN = 'https://www.reddit.com/r/deals';
const ALLOWLISTED = 'https://www.spotify.com/de/premium/'; // an active registered source

const BUDGET = { maxSteps: 50, maxSeconds: 300, maxCostEur: 1.0 };

function dealJson(service: string): string {
  // Distinct service ⇒ distinct dedupe key, so each deal page yields a new candidate.
  return JSON.stringify({ deals: [makeLlmDeal({ service })] });
}

function build(pages: Record<string, Partial<FetchResult> & { text?: string }>) {
  const db = new InMemoryDb();
  const fetcher = new ScriptedFetcher(pages);
  const llm = new FakeLlm(dealJson('Disney+'));
  const evidence = new FakeEvidenceStore();
  const clock = new FixedClock();
  const logger = new FakeLogger();
  const extract = new ExtractUseCase(llm, logger, tldtsSuffixOracle);
  const uc = new DiscoverSiteUseCase(
    fetcher,
    evidence,
    db,
    extract,
    clock,
    logger,
    SEED_VOCABULARY,
    'TestAgent/0.1',
    30000,
    tldtsSuffixOracle,
  );
  return { uc, db, fetcher, evidence, llm };
}

describe('DiscoverSiteUseCase', () => {
  it('follows same-site links, extracts candidates, and proposes novel domains', async () => {
    const env = build({
      [LISTING]: {
        html: `<a href="${DEAL_A}">A</a><a href="${DEAL_B}">B</a><a href="${OFF_DOMAIN}">reddit</a>`,
      },
      [DEAL_A]: { html: '<a href="/deals/aaa">self</a>', text: 'deal A text' },
      [DEAL_B]: { html: '', text: 'deal B text' },
    });

    const result = await env.uc.execute({ startUrl: LISTING, maxPages: 50, budget: BUDGET });

    // Visited the listing + both same-site deal pages, never the off-domain link.
    expect(env.fetcher.fetched).toContain(DEAL_A);
    expect(env.fetcher.fetched).toContain(DEAL_B);
    expect(env.fetcher.fetched).not.toContain(OFF_DOMAIN);
    expect(result.pagesFetched).toBe(3);

    // The novel domain was proposed, not followed.
    expect(result.proposedSources.map((p) => p.url)).toContain(OFF_DOMAIN);

    // Proposed source persisted as a pending_approval, discovered, tier-4 source.
    const pending = await env.db.sources.listByStatus('pending_approval');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.type).toBe('discovered');
    expect(pending[0]!.tier).toBe(4);
  });

  it('follows an already-active allowlisted domain but still proposes truly-novel ones', async () => {
    const env = build({
      [LISTING]: { html: `<a href="${ALLOWLISTED}">spotify</a><a href="${OFF_DOMAIN}">reddit</a>` },
      [ALLOWLISTED]: { html: '', text: 'spotify premium text' },
    });
    // Register spotify.com as an active source → its domain is allowlisted.
    await env.db.sources.upsert(makeSource({ url: ALLOWLISTED, status: 'active' }));

    const result = await env.uc.execute({ startUrl: LISTING, maxPages: 50, budget: BUDGET });

    expect(env.fetcher.fetched).toContain(ALLOWLISTED); // followed (allowlisted)
    expect(env.fetcher.fetched).not.toContain(OFF_DOMAIN); // proposed, not followed
    expect(result.proposedSources.map((p) => p.url)).toContain(OFF_DOMAIN);
  });

  it('a same-site URL that REDIRECTS off-domain is proposed, not extracted/persisted', async () => {
    // The start URL itself redirects (finalUrl) to an off-allowlist domain on the
    // very first fetch — so the ONLY page seen resolves off-domain.
    const env = build({
      [LISTING]: { finalUrl: 'https://tracker.evil/landing', text: 'Disney+ gratis', html: '' },
    });
    const result = await env.uc.execute({ startUrl: LISTING, maxPages: 50, budget: BUDGET });

    // Nothing extracted from the off-domain final URL…
    expect(result.candidatesFound).toBe(0);
    // …and the off-domain landing is recorded as a proposed source for approval.
    expect(result.proposedSources.map((p) => p.url)).toContain('https://tracker.evil/landing');
  });

  it('stops at the page cap', async () => {
    const env = build({
      [LISTING]: { html: `<a href="${DEAL_A}">A</a><a href="${DEAL_B}">B</a>` },
      [DEAL_A]: { html: '', text: 'a' },
      [DEAL_B]: { html: '', text: 'b' },
    });
    const result = await env.uc.execute({ startUrl: LISTING, maxPages: 1, budget: BUDGET });
    expect(result.pagesFetched).toBe(1);
    expect(result.stoppedReason).toBe('page_cap');
  });

  it('stops at the cost cap', async () => {
    // Each fetched page costs €0.001 (FakeLlm); a €0.0015 cap allows ~1 extraction.
    const env = build({
      [LISTING]: { html: `<a href="${DEAL_A}">A</a><a href="${DEAL_B}">B</a>` },
      [DEAL_A]: { html: '', text: 'a' },
      [DEAL_B]: { html: '', text: 'b' },
    });
    const result = await env.uc.execute({
      startUrl: LISTING,
      maxPages: 50,
      budget: { ...BUDGET, maxCostEur: 0.0015 },
    });
    expect(result.stoppedReason).toBe('cost_cap');
    expect(result.pagesFetched).toBeLessThan(3);
  });

  it('routes a CAPTCHA page to manual capture without crawling further from it', async () => {
    // Best-effort-read: captcha is the one wall still diverted (no offer content in a
    // challenge body). Login walls / soft blocks now come back `ok` and are extracted.
    const env = build({
      [LISTING]: { outcome: 'captcha', html: '', text: '' },
    });
    const result = await env.uc.execute({ startUrl: LISTING, maxPages: 50, budget: BUDGET });
    expect(result.routedToManualCapture).toBe(1);
    expect(result.candidatesFound).toBe(0);
    expect(await env.db.manualCapture.listOpen(10)).toHaveLength(1);
    // Discovery tasks have no registered source row.
    expect((await env.db.manualCapture.listOpen(10))[0]!.source_id).toBeNull();
  });

  it('skips a robots-disallowed page silently (no manual capture, no failure) — RESPECT_ROBOTS_TXT=true path', async () => {
    const env = build({
      [LISTING]: { html: `<a href="${DEAL_A}">A</a>` },
      [DEAL_A]: { outcome: 'robots_disallowed', html: '', text: '' },
    });
    const result = await env.uc.execute({ startUrl: LISTING, maxPages: 50, budget: BUDGET });
    expect(result.routedToManualCapture).toBe(0);
    expect(result.failedPages).toBe(0);
    expect(await env.db.manualCapture.listOpen(10)).toHaveLength(0);
  });

  it('does not re-propose a domain already registered (e.g. pending_approval)', async () => {
    const env = build({
      [LISTING]: { html: `<a href="${OFF_DOMAIN}">reddit</a>` },
    });
    // reddit.com is already a pending_approval source → must not be proposed again.
    await env.db.sources.upsert(makeSource({ url: OFF_DOMAIN, status: 'pending_approval' }));

    await env.uc.execute({ startUrl: LISTING, maxPages: 50, budget: BUDGET });
    const pending = await env.db.sources.listByStatus('pending_approval');
    // Still exactly the one we seeded — no duplicate written.
    expect(pending.filter((s) => s.url === OFF_DOMAIN)).toHaveLength(1);
  });

  it('persists candidates by default but writes nothing in dry-run', async () => {
    const pages = {
      [LISTING]: { html: `<a href="${DEAL_A}">A</a>` },
      [DEAL_A]: { html: '', text: 'deal A' },
    };

    const dry = build(pages);
    const dryResult = await dry.uc.execute({
      startUrl: LISTING,
      maxPages: 50,
      budget: BUDGET,
      dryRun: true,
    });
    expect(dryResult.candidatesFound).toBeGreaterThan(0);
    expect(await dry.db.deals.listByStatus('candidate', 10)).toHaveLength(0);
    expect(await dry.db.deals.listByStatus('in_review', 10)).toHaveLength(0);
    expect(dry.evidence.saved).toHaveLength(0); // dry-run writes nothing, not even evidence

    const wet = build(pages);
    await wet.uc.execute({ startUrl: LISTING, maxPages: 50, budget: BUDGET });
    const persisted =
      (await wet.db.deals.listByStatus('candidate', 10)).length +
      (await wet.db.deals.listByStatus('in_review', 10)).length;
    expect(persisted).toBeGreaterThan(0);
  });

  it('records a discover crawl_runs row with kind/null-source/candidates/proposals/stop-reason', async () => {
    const env = build({
      [LISTING]: { html: `<a href="${DEAL_A}">A</a><a href="${OFF_DOMAIN}">reddit</a>` },
      [DEAL_A]: { html: '', text: 'deal A text' },
    });

    const result = await env.uc.execute({ startUrl: LISTING, maxPages: 50, budget: BUDGET });

    const runs = await env.db.crawlRuns.recentRuns({ limit: 10 });
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.run_kind).toBe('discover');
    expect(run.source_id).toBeNull();
    expect(run.status).toBe('succeeded');
    expect(run.candidates_produced).toBe(result.candidatesFound);
    expect(run.proposals_produced).toBe(result.proposedSources.length);
    expect(run.stopped_reason).toBe(result.stoppedReason);
  });

  it('records daily_budget_cap (not cost_cap) when a daily-clamped run hits its cost cap', async () => {
    // Two same-site deal pages; FakeLlm costs €0.001/extraction. A clamped €0.0005
    // cap is below one extraction, so after the first page the loop-top guard trips
    // on cost. With dailyClamped=true that stop is recorded as daily_budget_cap.
    const env = build({
      [LISTING]: { html: `<a href="${DEAL_A}">A</a><a href="${DEAL_B}">B</a>` },
      [DEAL_A]: { html: '', text: 'deal A' },
      [DEAL_B]: { html: '', text: 'deal B' },
    });
    const result = await env.uc.execute({
      startUrl: LISTING,
      maxPages: 50,
      budget: { maxSteps: 50, maxSeconds: 300, maxCostEur: 0.0005 },
      dailyClamped: true,
    });
    // The result object keeps the lane-level reason…
    expect(result.stoppedReason).toBe('cost_cap');
    // …but the ledger records the daily ceiling as the binding constraint.
    const runs = await env.db.crawlRuns.recentRuns({ limit: 10 });
    expect(runs[0]!.stopped_reason).toBe('daily_budget_cap');
  });

  it('writes NO crawl_runs row in dry-run', async () => {
    const env = build({
      [LISTING]: { html: `<a href="${DEAL_A}">A</a>` },
      [DEAL_A]: { html: '', text: 'deal A' },
    });
    await env.uc.execute({ startUrl: LISTING, maxPages: 50, budget: BUDGET, dryRun: true });
    expect(await env.db.crawlRuns.recentRuns({ limit: 10 })).toHaveLength(0);
  });

  it('bounds the frontier: a huge in-domain link set never queues more than the headroom', async () => {
    // A listing page linking to 100 same-site deal pages, with maxPages=2. Only a
    // couple are fetched; the frontier is bounded at maxPages * headroom (=10), so
    // the queue can't grow to 100. We assert via the stop-reason + fetch count.
    const links = Array.from(
      { length: 100 },
      (_, i) => `<a href="https://www.mydealz.de/deals/d${i}">d${i}</a>`,
    ).join('');
    const pages: Record<string, Partial<FetchResult> & { text?: string }> = {
      [LISTING]: { html: links },
    };
    for (let i = 0; i < 100; i++) {
      pages[`https://www.mydealz.de/deals/d${i}`] = { html: '', text: `deal ${i}` };
    }
    const env = build(pages);
    const result = await env.uc.execute({
      startUrl: LISTING,
      maxPages: 2,
      budget: { maxSteps: 2, maxSeconds: 300, maxCostEur: 1.0 },
    });
    // Stopped at the page cap after fetching exactly maxPages pages.
    expect(result.stoppedReason).toBe('page_cap');
    expect(result.pagesFetched).toBe(2);
  });
});
