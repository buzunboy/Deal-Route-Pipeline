import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MetricsUseCase } from './metrics.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FakeLogger, FixedClock } from '../../../test/fakes/fakes.js';
import { makeDealRecord } from '../../../test/factories/deal.js';
import type { CrawlRun, DealRecord } from '../../domain/index.js';

function run(sourceId: string, startedAt: string, costEur: number): CrawlRun {
  return {
    id: randomUUID(),
    source_id: sourceId,
    run_kind: 'crawl',
    status: 'succeeded',
    started_at: startedAt,
    finished_at: null,
    candidates_produced: 0,
    proposals_produced: 0,
    cost_eur: costEur,
    stopped_reason: null,
    error: null,
  };
}

describe('MetricsUseCase', () => {
  it('delegates to the repository and returns the rolled-up CostSummary', async () => {
    const db = new InMemoryDb();
    const useCase = new MetricsUseCase(db, new FixedClock(), new FakeLogger());
    const srcA = randomUUID();
    const srcB = randomUUID();
    await db.crawlRuns.insert(run(srcA, '2026-06-18T06:00:00.000Z', 1.0));
    await db.crawlRuns.insert(run(srcA, '2026-06-19T06:00:00.000Z', 2.0));
    await db.crawlRuns.insert(run(srcB, '2026-06-19T07:00:00.000Z', 0.5));

    const summary = await useCase.costSummary({});

    expect(summary.total_eur).toBe(3.5);
    expect(summary.run_count).toBe(3);
    expect(summary.per_day).toEqual([
      { day: '2026-06-18', cost_eur: 1.0, run_count: 1 },
      { day: '2026-06-19', cost_eur: 2.5, run_count: 2 },
    ]);
    expect(summary.per_source).toEqual([
      { source_id: srcA, cost_eur: 3.0, run_count: 2 },
      { source_id: srcB, cost_eur: 0.5, run_count: 1 },
    ]);
  });

  it('forwards the half-open window filter to the repository', async () => {
    const db = new InMemoryDb();
    const useCase = new MetricsUseCase(db, new FixedClock(), new FakeLogger());
    const src = randomUUID();
    await db.crawlRuns.insert(run(src, '2026-06-18T23:00:00.000Z', 5.0)); // before since → excluded
    await db.crawlRuns.insert(run(src, '2026-06-19T00:00:00.000Z', 1.0)); // == since → included
    await db.crawlRuns.insert(run(src, '2026-06-20T00:00:00.000Z', 9.0)); // == until → excluded

    const summary = await useCase.costSummary({
      since: new Date('2026-06-19T00:00:00.000Z'),
      until: new Date('2026-06-20T00:00:00.000Z'),
    });

    expect(summary.total_eur).toBe(1.0);
    expect(summary.run_count).toBe(1);
    expect(summary.per_source).toEqual([{ source_id: src, cost_eur: 1.0, run_count: 1 }]);
  });

  it('recentRuns returns newest-first runs and applies the default cap', async () => {
    const db = new InMemoryDb();
    const useCase = new MetricsUseCase(db, new FixedClock(), new FakeLogger());
    const src = randomUUID();
    await db.crawlRuns.insert(run(src, '2026-06-19T01:00:00.000Z', 1.0));
    await db.crawlRuns.insert(run(src, '2026-06-19T03:00:00.000Z', 2.0));
    await db.crawlRuns.insert(run(src, '2026-06-19T02:00:00.000Z', 0.5));

    const runs = await useCase.recentRuns({});
    expect(runs.map((r) => r.started_at)).toEqual([
      '2026-06-19T03:00:00.000Z',
      '2026-06-19T02:00:00.000Z',
      '2026-06-19T01:00:00.000Z',
    ]);
  });

  it('recentRuns honours an explicit limit', async () => {
    const db = new InMemoryDb();
    const useCase = new MetricsUseCase(db, new FixedClock(), new FakeLogger());
    const src = randomUUID();
    await db.crawlRuns.insert(run(src, '2026-06-19T01:00:00.000Z', 1.0));
    await db.crawlRuns.insert(run(src, '2026-06-19T02:00:00.000Z', 2.0));

    const runs = await useCase.recentRuns({ limit: 1 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.started_at).toBe('2026-06-19T02:00:00.000Z');
  });

  // ── ACR-6 throughputToday ───────────────────────────────────────────────────
  describe('throughputToday', () => {
    const NOW = new Date('2026-06-22T12:00:00.000Z');
    /** Insert an evidence row + a linked deal; return its id, for reviews to target. */
    async function seedDeal(
      db: InMemoryDb,
      capturedAt: string,
      status: DealRecord['status'] = 'published',
    ): Promise<string> {
      const evId = randomUUID();
      await db.evidence.insert({
        id: evId,
        source_url: 'https://x.de',
        screenshot_ref: 's',
        html_ref: 'h',
        terms_ref: 't',
        captured_at: capturedAt,
        content_hash: randomUUID(),
      });
      const deal = makeDealRecord({ evidence_id: evId, status });
      await db.deals.insert(deal);
      return deal.id;
    }
    const review = (dealId: string, action: 'approve' | 'reject' | 'edit', at: string) => ({
      id: randomUUID(),
      deal_id: dealId,
      action,
      approver: 'mara',
      reason: null,
      decided_at: at,
    });

    it('counts today (UTC) decisions and averages capture→decision latency in seconds', async () => {
      const db = new InMemoryDb();
      const useCase = new MetricsUseCase(db, new FixedClock(NOW), new FakeLogger());
      // Captured 1h before each decision → 3600s latency apiece.
      const d1 = await seedDeal(db, '2026-06-22T07:00:00.000Z');
      const d2 = await seedDeal(db, '2026-06-22T08:00:00.000Z');
      await db.reviews.insert(review(d1, 'approve', '2026-06-22T08:00:00.000Z')); // +3600s
      await db.reviews.insert(review(d2, 'reject', '2026-06-22T09:00:00.000Z')); // +3600s
      // Yesterday's decision must be excluded from today's counts + average.
      const dOld = await seedDeal(db, '2026-06-21T07:00:00.000Z');
      await db.reviews.insert(review(dOld, 'approve', '2026-06-21T08:00:00.000Z'));

      const out = await useCase.throughputToday();
      expect(out).toEqual({
        approved: 1,
        rejected: 1,
        edited: 0,
        avg_review_seconds: 3600,
      });
    });

    it('returns all-zero counts + null average for a day with no decisions', async () => {
      const db = new InMemoryDb();
      const useCase = new MetricsUseCase(db, new FixedClock(NOW), new FakeLogger());
      expect(await useCase.throughputToday()).toEqual({
        approved: 0,
        rejected: 0,
        edited: 0,
        avg_review_seconds: null,
      });
    });
  });

  // ── ACR-9 queueFreshness ────────────────────────────────────────────────────
  describe('queueFreshness', () => {
    const NOW = new Date('2026-06-22T12:00:00.000Z');
    async function seedPending(
      db: InMemoryDb,
      capturedAt: string,
      status: DealRecord['status'] = 'candidate',
    ): Promise<void> {
      const evId = randomUUID();
      await db.evidence.insert({
        id: evId,
        source_url: 'https://x.de',
        screenshot_ref: 's',
        html_ref: 'h',
        terms_ref: 't',
        captured_at: capturedAt,
        content_hash: randomUUID(),
      });
      await db.deals.insert(makeDealRecord({ evidence_id: evId, status }));
    }

    it('buckets the pending queue by age (<24h / 1-3d / >3d) excluding terminal deals', async () => {
      const db = new InMemoryDb();
      const useCase = new MetricsUseCase(db, new FixedClock(NOW), new FakeLogger());
      await seedPending(db, '2026-06-22T06:00:00.000Z'); // 6h → <24h
      await seedPending(db, '2026-06-21T00:00:00.000Z'); // ~36h → 1-3d
      await seedPending(db, '2026-06-18T00:00:00.000Z'); // ~4.5d → >3d
      await seedPending(db, '2026-06-18T00:00:00.000Z'); // another >3d
      // A published deal is NOT pending → must not affect the distribution.
      await seedPending(db, '2026-06-22T06:00:00.000Z', 'published');

      const bands = await useCase.queueFreshness();
      expect(bands).toEqual([
        { bucket: '<24h', percent: 25 },
        { bucket: '1-3d', percent: 25 },
        { bucket: '>3d', percent: 50 },
      ]);
    });

    it('returns all three bands at 0% for an empty queue', async () => {
      const db = new InMemoryDb();
      const useCase = new MetricsUseCase(db, new FixedClock(NOW), new FakeLogger());
      const bands = await useCase.queueFreshness();
      expect(bands.map((b) => b.percent)).toEqual([0, 0, 0]);
    });
  });

  // ── ACR-10 dashboardMetrics ─────────────────────────────────────────────────
  describe('dashboardMetrics', () => {
    const NOW = new Date('2026-06-22T12:00:00.000Z');

    it('rolls up KPIs, a dense 14-day cost series, and the confidence distribution', async () => {
      const db = new InMemoryDb();
      const useCase = new MetricsUseCase(db, new FixedClock(NOW), new FakeLogger());
      const src = randomUUID();
      // Crawl cost on two days inside the 14-day window (today + 3 days ago).
      await db.crawlRuns.insert(run(src, '2026-06-22T06:00:00.000Z', 12.0)); // today
      await db.crawlRuns.insert(run(src, '2026-06-19T06:00:00.000Z', 8.0));

      // Today's decisions: 2 approve, 1 reject → approval rate 67%, throughput 3.
      const evId = randomUUID();
      await db.evidence.insert({
        id: evId,
        source_url: 'https://x.de',
        screenshot_ref: 's',
        html_ref: 'h',
        terms_ref: 't',
        captured_at: '2026-06-22T06:00:00.000Z',
        content_hash: randomUUID(),
      });
      const dealId = makeDealRecord({ evidence_id: evId, status: 'published' }).id;
      await db.deals.insert(makeDealRecord({ id: dealId, evidence_id: evId, status: 'published' }));
      const rev = (action: 'approve' | 'reject', at: string) => ({
        id: randomUUID(),
        deal_id: dealId,
        action,
        approver: 'mara',
        reason: null,
        decided_at: at,
      });
      await db.reviews.insert(rev('approve', '2026-06-22T08:00:00.000Z'));
      await db.reviews.insert(rev('approve', '2026-06-22T09:00:00.000Z'));
      await db.reviews.insert(rev('reject', '2026-06-22T10:00:00.000Z'));

      // Pending queue confidences for the avg + distribution KPIs.
      for (const c of [0.9, 0.7, 0.5]) {
        await db.deals.insert(makeDealRecord({ status: 'candidate', confidence: c }));
      }

      const m = await useCase.dashboardMetrics();
      const kpi = (key: string) => m.kpis.find((k) => k.key === key)!;
      expect(kpi('crawl-cost').value).toBe('€12'); // today's crawl cost
      expect(kpi('throughput').value).toBe('3');
      expect(kpi('approval-rate').value).toBe('67%'); // 2/(2+1)
      expect(kpi('avg-confidence').value).toBe('0.70'); // (0.9+0.7+0.5)/3

      // Dense 14-day series, oldest→newest, ending today (06-22).
      expect(m.cost_per_day).toHaveLength(14);
      expect(m.cost_per_day.at(-1)).toEqual({ day: '22', cost: 12.0, highlight: true });
      const day19 = m.cost_per_day.find((b) => b.day === '19')!;
      expect(day19.cost).toBe(8.0);
      // A day with no crawl_runs row still appears with cost 0.
      const day20 = m.cost_per_day.find((b) => b.day === '20')!;
      expect(day20.cost).toBe(0);

      expect(m.confidence_distribution.reduce((a, b) => a + b.percent, 0)).toBe(100);
    });
  });
});
