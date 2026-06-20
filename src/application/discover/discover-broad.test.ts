import { describe, it, expect } from 'vitest';
import { DiscoverBroadUseCase } from './discover-broad.js';
import { ExtractUseCase } from '../extract/extract.js';
import { SEED_VOCABULARY, DomainDenylist } from '../../domain/index.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FakeLlm, FakeEvidenceStore, FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';
import { makeSource } from '../../../test/factories/source.js';
import type {
  BrowserAgent,
  AgentBudget,
  AgentRunResult,
  FetchResult,
  FetchedPage,
  ProposedSource,
} from '../ports/index.js';

const BUDGET: AgentBudget = { maxSteps: 50, maxSeconds: 300, maxCostEur: 1.0 };

function okPage(url: string, text = 'Disney+ im Bundle bei diesem Anbieter'): FetchedPage {
  const fetched: FetchResult = {
    outcome: 'ok',
    url,
    finalUrl: url,
    text,
    html: `<html>${text}</html>`,
    screenshot: new Uint8Array([1, 2, 3]),
  };
  return { sourceUrl: url, fetched };
}

function blockedPage(url: string): FetchedPage {
  return {
    sourceUrl: url,
    fetched: {
      outcome: 'login_required',
      url,
      finalUrl: url,
      text: '',
      html: '',
      screenshot: new Uint8Array(),
    },
  };
}

/** A BrowserAgent that returns scripted results, keyed by query (or a default). */
class FakeAgent implements BrowserAgent {
  public readonly queries: string[] = [];
  constructor(
    private readonly byQuery: Record<string, Partial<AgentRunResult>>,
    private readonly fallback: Partial<AgentRunResult> = {},
  ) {}
  async run(query: string, _budget: AgentBudget): Promise<AgentRunResult> {
    this.queries.push(query);
    const r = this.byQuery[query] ?? this.fallback;
    return {
      pages: r.pages ?? [],
      proposedSources: r.proposedSources ?? [],
      stepsUsed: r.stepsUsed ?? r.pages?.length ?? 0,
      costEur: r.costEur ?? 0,
      stoppedReason: r.stoppedReason ?? 'completed',
    };
  }
}

function build(
  agent: BrowserAgent,
  denylist = new DomainDenylist([]),
  llmJson = JSON.stringify({ deals: [makeLlmDeal({ service: 'Disney+' })] }),
) {
  const db = new InMemoryDb();
  const evidence = new FakeEvidenceStore();
  const clock = new FixedClock();
  const logger = new FakeLogger();
  // Distinct service per deal so each page yields a distinct dedupe key.
  const llm = new FakeLlm(llmJson);
  const extract = new ExtractUseCase(llm, logger);
  const uc = new DiscoverBroadUseCase(
    agent,
    evidence,
    db,
    extract,
    clock,
    logger,
    SEED_VOCABULARY,
    denylist,
  );
  return { uc, db, evidence };
}

async function seedCatalog(db: InMemoryDb): Promise<void> {
  await db.catalog.upsert({
    service: 'Disney+',
    category: 'streaming',
    provider_url: 'https://www.disneyplus.com',
    country: 'DE',
  });
}

describe('DiscoverBroadUseCase', () => {
  it('runs queries, extracts candidates, proposes novel domains, writes a run row', async () => {
    const agent = new FakeAgent(
      {},
      {
        pages: [okPage('https://telekom.de/disney')],
        proposedSources: [{ url: 'https://telekom.de/disney', rationale: 'found' }],
      },
    );
    const { uc, db, evidence } = build(agent);
    await seedCatalog(db);

    const result = await uc.execute({ maxQueries: 2, budget: BUDGET });

    expect(result.queriesRun).toBeGreaterThan(0);
    expect(result.candidatesFound).toBeGreaterThan(0);
    expect(result.proposedSources.length).toBeGreaterThan(0);
    expect(result.stoppedReason).toBe('completed');

    // Candidate persisted as candidate/in_review — NEVER published.
    const queued = [
      ...(await db.deals.listByStatus('in_review', 100)),
      ...(await db.deals.listByStatus('candidate', 100)),
    ];
    expect(queued.length).toBeGreaterThan(0);
    expect(await db.deals.listByStatus('published', 100)).toHaveLength(0);

    // Novel domain persisted pending_approval (never active / auto-crawled).
    const pending = await db.sources.listByStatus('pending_approval');
    expect(pending.some((s) => s.url.includes('telekom.de'))).toBe(true);
    expect(pending.every((s) => s.tier === 4 && s.type === 'discovered')).toBe(true);

    // Evidence captured before the candidate.
    expect(evidence.saved.length).toBeGreaterThan(0);

    // A discover_broad run row exists with cost + stop-reason.
    const runs = await db.crawlRuns.recentRuns({ limit: 10 });
    const broad = runs.find((r) => r.run_kind === 'discover_broad');
    expect(broad).toBeDefined();
    expect(broad!.status).toBe('succeeded');
    expect(broad!.stopped_reason).toBe('completed');
  });

  it('uses an explicit query verbatim (single query) when provided', async () => {
    const agent = new FakeAgent({ 'my custom query': { pages: [okPage('https://x.de/a')] } });
    const { uc, db } = build(agent);
    await seedCatalog(db);
    const result = await uc.execute({ query: 'my custom query', maxQueries: 50, budget: BUDGET });
    expect(result.queriesRun).toBe(1);
    expect((agent as FakeAgent).queries).toEqual(['my custom query']);
  });

  it('runs no queries when the catalog is empty (and no explicit query)', async () => {
    const agent = new FakeAgent({});
    const { uc } = build(agent);
    const result = await uc.execute({ maxQueries: 10, budget: BUDGET });
    expect(result.queriesRun).toBe(0);
    expect(result.candidatesFound).toBe(0);
  });

  it('routes a blocked page to manual capture instead of extracting it', async () => {
    const agent = new FakeAgent({}, { pages: [blockedPage('https://wall.de/login')] });
    const { uc, db } = build(agent);
    await seedCatalog(db);
    const result = await uc.execute({ query: 'q', maxQueries: 1, budget: BUDGET });
    expect(result.routedToManualCapture).toBe(1);
    expect(result.candidatesFound).toBe(0);
    expect(await db.manualCapture.listOpen()).toHaveLength(1);
  });

  it('drops a deny-listed page (never fetched-deeper, never extracted)', async () => {
    const agent = new FakeAgent({}, { pages: [okPage('https://facebook.com/some-deal')] });
    const { uc, db } = build(agent, new DomainDenylist(['facebook.com']));
    await seedCatalog(db);
    const result = await uc.execute({ query: 'q', maxQueries: 1, budget: BUDGET });
    expect(result.candidatesFound).toBe(0);
    expect(result.pagesFetched).toBe(0); // deny-listed page not counted/handled
  });

  it('never proposes a deny-listed novel domain', async () => {
    const agent = new FakeAgent(
      {},
      {
        pages: [],
        proposedSources: [
          { url: 'https://facebook.com/x', rationale: 'noise' },
          { url: 'https://telekom.de/disney', rationale: 'good' },
        ],
      },
    );
    const { uc, db } = build(agent, new DomainDenylist(['facebook.com']));
    await seedCatalog(db);
    const result = await uc.execute({ query: 'q', maxQueries: 1, budget: BUDGET });
    const domains = result.proposedSources.map((p: ProposedSource) => p.url);
    expect(domains.some((u) => u.includes('telekom.de'))).toBe(true);
    expect(domains.some((u) => u.includes('facebook.com'))).toBe(false);
    const pending = await db.sources.listByStatus('pending_approval');
    expect(pending.some((s) => s.url.includes('facebook.com'))).toBe(false);
  });

  it('excludes an already-known domain from the RETURNED proposals (matches what persists)', async () => {
    const agent = new FakeAgent(
      {},
      {
        pages: [],
        proposedSources: [
          { url: 'https://telekom.de/disney', rationale: 'already registered' },
          { url: 'https://newsite.de/x', rationale: 'genuinely novel' },
        ],
      },
    );
    const { uc, db } = build(agent);
    await seedCatalog(db);
    // telekom.de is already an active source — it must NOT be re-proposed.
    await db.sources.upsert(makeSource({ url: 'https://www.telekom.de/x', status: 'active' }));

    const result = await uc.execute({ query: 'q', maxQueries: 1, budget: BUDGET });
    const urls = result.proposedSources.map((p) => p.url);
    expect(urls.some((u) => u.includes('newsite.de'))).toBe(true);
    expect(urls.some((u) => u.includes('telekom.de'))).toBe(false);
    // The returned count matches what landed pending_approval.
    const pending = await db.sources.listByStatus('pending_approval');
    expect(pending.map((s) => s.url).some((u) => u.includes('telekom.de'))).toBe(false);
    expect(pending.map((s) => s.url).some((u) => u.includes('newsite.de'))).toBe(true);
  });

  it('counts the cost of a FAILED extraction toward the run budget (no silent cost leak)', async () => {
    // Malformed LLM output → the boundary rejects it AFTER the (paid) call. The
    // run must still see that cost, or open-web pages could burn budget unseen.
    const agent = new FakeAgent(
      {},
      { pages: [okPage('https://a.de/1'), okPage('https://b.de/2')], stepsUsed: 2 },
    );
    const { uc, db } = build(agent, new DomainDenylist([]), 'not json at all');
    await seedCatalog(db);

    const result = await uc.execute({ query: 'q', maxQueries: 1, budget: BUDGET });

    // Both pages failed to extract, but each still cost money — it's accounted.
    expect(result.candidatesFound).toBe(0);
    expect(result.failedPages).toBe(2);
    expect(result.costEur).toBeGreaterThan(0);
    // The run-row cost reflects the failed-extraction spend (feeds the daily guard).
    const runs = await db.crawlRuns.recentRuns({ limit: 10 });
    expect(runs.find((r) => r.run_kind === 'discover_broad')!.cost_eur).toBeGreaterThan(0);
  });

  it('a failed-extraction cost can trip the per-run cost cap (stops the run)', async () => {
    // Many pages, each a paid-then-failed extraction (0.001 ea); a tiny cap stops it.
    const pages = Array.from({ length: 10 }, (_, i) => okPage(`https://e${i}.de/x`));
    const agent = new FakeAgent({}, { pages, stepsUsed: 10 });
    const { uc } = build(agent, new DomainDenylist([]), 'not json at all');
    // maxCostEur small enough that a few failed extractions exhaust it.
    const result = await uc.execute({
      query: 'q',
      maxQueries: 1,
      budget: { maxSteps: 100, maxSeconds: 300, maxCostEur: 0.0025 },
    });
    expect(result.stoppedReason).toBe('cost_cap');
    // It stopped before extracting all 10 (the cap bit on failed-extraction cost).
    expect(result.failedPages).toBeLessThan(10);
  });

  it('dry-run writes nothing (no deals, no sources, no run row, no evidence)', async () => {
    const agent = new FakeAgent(
      {},
      {
        pages: [okPage('https://telekom.de/disney')],
        proposedSources: [{ url: 'https://telekom.de/disney', rationale: 'found' }],
      },
    );
    const { uc, db, evidence } = build(agent);
    await seedCatalog(db);
    const result = await uc.execute({ query: 'q', maxQueries: 1, budget: BUDGET, dryRun: true });

    expect(result.candidatesFound).toBeGreaterThan(0); // counted in-memory
    expect(await db.deals.listByStatus('in_review', 100)).toHaveLength(0);
    expect(await db.deals.listByStatus('candidate', 100)).toHaveLength(0);
    expect(await db.sources.listByStatus('pending_approval')).toHaveLength(0);
    expect(evidence.saved).toHaveLength(0);
    const runs = await db.crawlRuns.recentRuns({ limit: 10 });
    expect(runs.find((r) => r.run_kind === 'discover_broad')).toBeUndefined();
  });

  it('stops at the step budget across queries', async () => {
    // Each query reports 2 steps used; maxSteps=3 → after the 1st query (2 steps),
    // the 2nd query starts (2<3) and pushes total to 4, then the 3rd is blocked.
    const agent = new FakeAgent({}, { pages: [okPage('https://a.de/1')], stepsUsed: 2 });
    const { uc, db } = build(agent);
    await seedCatalog(db);
    const result = await uc.execute({
      query: undefined,
      maxQueries: 10,
      budget: { ...BUDGET, maxSteps: 3 },
    });
    expect(result.stoppedReason).toBe('step_cap');
  });

  it('records daily_budget_cap (result AND ledger) when a cost-cap stop was daily-clamped', async () => {
    const agent = new FakeAgent({}, { pages: [], costEur: 2, stoppedReason: 'cost_cap' });
    const { uc, db } = build(agent);
    await seedCatalog(db);
    const result = await uc.execute({
      query: 'q',
      maxQueries: 10,
      budget: { ...BUDGET, maxCostEur: 1 },
      dailyClamped: true,
    });
    // The returned result and the ledger AGREE — the CLI prints the returned reason.
    expect(result.stoppedReason).toBe('daily_budget_cap');
    const runs = await db.crawlRuns.recentRuns({ limit: 10 });
    const broad = runs.find((r) => r.run_kind === 'discover_broad');
    expect(broad!.stopped_reason).toBe('daily_budget_cap');
  });

  it('a cost-cap stop WITHOUT a daily clamp stays cost_cap (not daily_budget_cap)', async () => {
    const agent = new FakeAgent({}, { pages: [], costEur: 2, stoppedReason: 'cost_cap' });
    const { uc, db } = build(agent);
    await seedCatalog(db);
    const result = await uc.execute({
      query: 'q',
      maxQueries: 10,
      budget: { ...BUDGET, maxCostEur: 1 },
    });
    expect(result.stoppedReason).toBe('cost_cap');
    const runs = await db.crawlRuns.recentRuns({ limit: 10 });
    expect(runs.find((r) => r.run_kind === 'discover_broad')!.stopped_reason).toBe('cost_cap');
  });

  it('builds provider-token queries from active provider/bundler sources', async () => {
    const agent = new FakeAgent({});
    const { uc, db } = build(agent);
    await seedCatalog(db);
    await db.sources.upsert(
      makeSource({ url: 'https://www.telekom.de/x', type: 'provider', status: 'active' }),
    );
    await uc.execute({ maxQueries: 50, budget: BUDGET });
    // Some issued query mentions the provider token derived from telekom.de.
    expect((agent as FakeAgent).queries.some((q) => q.toLowerCase().includes('telekom'))).toBe(
      true,
    );
  });
});
