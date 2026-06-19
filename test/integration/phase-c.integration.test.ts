import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { FakeLlm } from '../fakes/fakes.js';
import { makeLlmDeal } from '../factories/deal.js';
import type { Container } from '../../src/composition/container.js';
import type {
  BrowserAgent,
  AgentBudget,
  AgentRunResult,
  FetchResult,
} from '../../src/application/ports/index.js';

/**
 * Phase C (Tier-4 agentic broad discovery, C-1) end-to-end through the REAL
 * composition root + REAL Postgres: a scripted BrowserAgent (override) yields
 * fetched pages + novel domains → extract (LLM override) + capture evidence →
 * candidate persisted `in_review`/`candidate` (NEVER published) → novel domain
 * persisted `pending_approval` (NEVER auto-crawled) → a `discover_broad`
 * crawl_runs row with cost + stop-reason. Network/LLM are deterministic doubles.
 */
const DEAL_PAGE = 'https://www.telekom.de/magenta-disney';
const PAGE = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.';

function okPage(url: string): FetchResult {
  return {
    outcome: 'ok',
    url,
    finalUrl: url,
    text: PAGE,
    html: `<html>${PAGE}</html>`,
    screenshot: new Uint8Array([137, 80, 78, 71]),
  };
}

/** Scripted agent: returns the same result for any query. */
class ScriptedAgent implements BrowserAgent {
  constructor(private readonly result: Partial<AgentRunResult>) {}
  async run(_query: string, _budget: AgentBudget): Promise<AgentRunResult> {
    return {
      pages: this.result.pages ?? [],
      proposedSources: this.result.proposedSources ?? [],
      stepsUsed: this.result.stepsUsed ?? this.result.pages?.length ?? 0,
      costEur: this.result.costEur ?? 0.01,
      stoppedReason: this.result.stoppedReason ?? 'completed',
    };
  }
}

const suite = hasDb ? describe : describe.skip;

suite('Phase C broad discovery (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  async function seedCatalog(c: Container): Promise<void> {
    await c.db.catalog.upsert({
      service: 'Disney+',
      category: 'streaming',
      provider_url: 'https://www.disneyplus.com/de-de',
      country: 'DE',
    });
  }

  it('agent pages → candidate (in_review/candidate) + pending_approval domain + run row', async () => {
    container = makeContainer({
      browserAgent: new ScriptedAgent({
        pages: [{ sourceUrl: DEAL_PAGE, fetched: okPage(DEAL_PAGE) }],
        proposedSources: [{ url: DEAL_PAGE, rationale: 'surfaced by broad discovery' }],
        costEur: 0.02,
      }),
      llm: new FakeLlm(JSON.stringify({ deals: [makeLlmDeal()] })),
    });
    await seedCatalog(container);

    const result = await container.discoverBroad.execute({
      query: 'Disney+ im Bundle',
      maxQueries: 1,
      budget: { maxSteps: 10, maxSeconds: 60, maxCostEur: 1 },
    });

    expect(result.candidatesFound).toBeGreaterThan(0);

    // Candidate persisted, NEVER published.
    const inReview = await container.db.deals.listByStatus('in_review', 100);
    const candidate = await container.db.deals.listByStatus('candidate', 100);
    expect(inReview.length + candidate.length).toBeGreaterThan(0);
    expect(await container.db.deals.listByStatus('published', 100)).toHaveLength(0);

    // Novel domain persisted pending_approval, tier 4, type discovered.
    const pending = await container.db.sources.listByStatus('pending_approval');
    expect(pending.some((s) => s.url.includes('telekom.de'))).toBe(true);
    expect(pending.every((s) => s.tier === 4 && s.type === 'discovered')).toBe(true);
    // It is NOT active (never auto-crawled).
    const active = await container.db.sources.listByStatus('active');
    expect(active.some((s) => s.url.includes('telekom.de'))).toBe(false);

    // A discover_broad run row with cost + stop reason.
    const runs = await container.db.crawlRuns.recentRuns({ limit: 10 });
    const broad = runs.find((r) => r.run_kind === 'discover_broad');
    expect(broad).toBeDefined();
    expect(broad!.status).toBe('succeeded');
    expect(broad!.cost_eur).toBeGreaterThan(0);
    expect(broad!.candidates_produced).toBeGreaterThan(0);
    expect(broad!.proposals_produced).toBeGreaterThan(0);
    expect(broad!.stopped_reason).toBe('completed');
  });

  it('the daily budget guard stops a batch once the ceiling is reached', async () => {
    // A tiny ceiling; first run logs cost, the guard then refuses the next run.
    container = makeContainer(
      {
        browserAgent: new ScriptedAgent({
          pages: [{ sourceUrl: DEAL_PAGE, fetched: okPage(DEAL_PAGE) }],
          costEur: 0.5,
        }),
        llm: new FakeLlm(JSON.stringify({ deals: [makeLlmDeal()] })),
      },
      { DAILY_BUDGET_EUR: '0.40' },
    );
    await seedCatalog(container);

    // First run spends ~0.5 (agent) + extraction, exceeding the 0.40 ceiling.
    await container.discoverBroad.execute({
      query: 'q1',
      maxQueries: 1,
      budget: { maxSteps: 10, maxSeconds: 60, maxCostEur: 1 },
    });

    // The guard now reports the day exhausted — the CLI uses this to stop the batch.
    const check = await container.dailyBudgetGuard.check();
    expect(check.ok).toBe(false);
    expect(check.spentTodayEur).toBeGreaterThanOrEqual(0.4);
  });
});
