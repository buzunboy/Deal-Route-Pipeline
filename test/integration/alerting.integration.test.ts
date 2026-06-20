import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm, FakeAlerter } from '../fakes/fakes.js';
import { makeLlmDeal } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Step 5 — observability. Through the REAL composition root + REAL Postgres, prove
 * the alerter (injected as a recording fake at the one composition seam) actually
 * FIRES at the wired warn points: a crawl that drives a source's reliability below
 * the flag threshold, and the daily-budget guard reaching its ceiling. Network/LLM
 * are deterministic doubles; the DB is real Postgres. (The Noop/Webhook adapters
 * are unit + contract tested; this covers the end-to-end wiring a fake can't.)
 */
const suite = hasDb ? describe : describe.skip;

suite('Alerting wiring (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  it('fires a source_reliability_low alert when a failing crawl drops a source below threshold', async () => {
    const alerter = new FakeAlerter();
    // No scripted page for this URL → ScriptedFetcher yields outcome:'error' → the
    // crawl fails and lowers reliability. Start at 0.4 so one failure → 0.2 (< 0.3).
    const source = makeSource({ url: 'https://flaky.de/offer', reliability_score: 0.4 });
    container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
      alerting: alerter,
    });
    await container.db.sources.upsert(source);

    await container.crawlSource.execute({ sourceId: source.id });

    // Reliability dropped below threshold in Postgres AND the alert fired.
    expect((await container.db.sources.getById(source.id))!.reliability_score).toBeLessThan(0.3);
    expect(alerter.events).toHaveLength(1);
    expect(alerter.events[0]!.kind).toBe('source_reliability_low');
    expect(alerter.events[0]!.context.source_id).toBe(source.id);
  });

  it('fires a daily_budget_reached alert when the guard hits its ceiling (reading real spend)', async () => {
    const alerter = new FakeAlerter();
    container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({}),
      alerting: alerter,
    });
    // Log a discover run today that meets/exceeds the configured daily ceiling, so the
    // guard reads spend-so-far-today from the real crawl_runs ledger and trips.
    const ceiling = container.config.agent.dailyBudgetEur;
    await container.db.crawlRuns.insert({
      id: randomUUID(),
      source_id: null,
      run_kind: 'discover_broad',
      status: 'succeeded',
      started_at: container.clock.nowIso(),
      finished_at: container.clock.nowIso(),
      candidates_produced: 0,
      proposals_produced: 0,
      cost_eur: ceiling, // meets the ceiling → guard not ok
      stopped_reason: 'completed',
      error: null,
    });

    const check = await container.dailyBudgetGuard.check();
    expect(check.ok).toBe(false);
    expect(alerter.events).toHaveLength(1);
    expect(alerter.events[0]!.kind).toBe('daily_budget_reached');
  });
});
