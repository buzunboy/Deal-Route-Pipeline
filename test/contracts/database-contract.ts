import { describe, it, expect } from 'vitest';
import type { Database } from '../../src/application/ports/index.js';
import { DealStatus, type DealRecord, type CrawlRun } from '../../src/domain/index.js';
import { makeLlmDeal } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import { randomUUID } from 'node:crypto';

/** A valid succeeded CrawlRun with a fixed started_at + cost, for cost-summary cases. */
function makeRun(sourceId: string, startedAt: string, costEur: number): CrawlRun {
  return {
    id: randomUUID(),
    source_id: sourceId,
    status: 'succeeded',
    started_at: startedAt,
    finished_at: null,
    candidates_produced: 0,
    cost_eur: costEur,
    error: null,
  };
}

function dealRecord(overrides: Partial<DealRecord> = {}): DealRecord {
  return {
    ...makeLlmDeal(),
    id: randomUUID(),
    schema_version: 1,
    true_cost_monthly: 10,
    evidence_id: randomUUID(),
    status: DealStatus.enum.candidate,
    verified_by: null,
    verified_at: null,
    ...overrides,
  };
}

/**
 * Shared contract suite for the Database port. The in-memory adapter and the
 * Postgres adapter both run it, guaranteeing substitutability (LSP). The Postgres
 * run is skipped automatically when no DATABASE_URL_TEST is configured (a
 * separate var from the runtime DATABASE_URL, since the suite mutates rows).
 */
export function databaseContract(name: string, makeDb: () => Promise<Database> | Database): void {
  describe(`Database contract: ${name}`, () => {
    it('sources: upsert, getById, listDue honours next_due and active status', async () => {
      const db = await makeDb();
      const due = makeSource({ status: 'active', next_due: '2020-01-01T00:00:00.000Z' });
      const future = makeSource({ status: 'active', next_due: '2999-01-01T00:00:00.000Z' });
      const disabled = makeSource({ status: 'disabled', next_due: null });
      await db.sources.upsert(due);
      await db.sources.upsert(future);
      await db.sources.upsert(disabled);

      const dueList = await db.sources.listDue(new Date('2026-06-19T00:00:00.000Z'), 10);
      const ids = dueList.map((s) => s.id);
      expect(ids).toContain(due.id);
      expect(ids).not.toContain(future.id);
      expect(ids).not.toContain(disabled.id);
    });

    it('deals: insert, getById, listByStatus, updateStatus', async () => {
      const db = await makeDb();
      const deal = dealRecord();
      await db.deals.insert(deal);
      expect((await db.deals.getById(deal.id))!.service).toBe(deal.service);
      expect(await db.deals.listByStatus(DealStatus.enum.candidate, 10)).toHaveLength(1);

      await db.deals.updateStatus(
        deal.id,
        DealStatus.enum.published,
        'reviewer',
        '2026-06-19T00:00:00Z',
      );
      expect((await db.deals.getById(deal.id))!.status).toBe('published');
      expect((await db.deals.getById(deal.id))!.verified_by).toBe('reviewer');
    });

    it('deals: findByDedupeKey ignores rejected and matches the canonical key', async () => {
      const db = await makeDb();
      const deal = dealRecord();
      await db.deals.insert(deal);
      const { dedupeKey } = await import('../../src/domain/index.js');
      const found = await db.deals.findByDedupeKey(dedupeKey(deal));
      expect(found!.id).toBe(deal.id);

      await db.deals.updateStatus(deal.id, DealStatus.enum.rejected, 'r', 't');
      expect(await db.deals.findByDedupeKey(dedupeKey(deal))).toBeNull();
    });

    it('deals: listBySourceUrl is source-scoped + status-filtered', async () => {
      const db = await makeDb();
      const a = dealRecord({ source_url: 'https://a.de/x', status: DealStatus.enum.published });
      const b = dealRecord({ source_url: 'https://b.de/y', status: DealStatus.enum.published });
      const aCand = dealRecord({ source_url: 'https://a.de/x', status: DealStatus.enum.candidate });
      await db.deals.insert(a);
      await db.deals.insert(b);
      await db.deals.insert(aCand);

      const pub = await db.deals.listBySourceUrl('https://a.de/x', [DealStatus.enum.published], 10);
      expect(pub.map((d) => d.id)).toEqual([a.id]); // only a.de + published

      const both = await db.deals.listBySourceUrl(
        'https://a.de/x',
        [DealStatus.enum.published, DealStatus.enum.candidate],
        10,
      );
      expect(both.map((d) => d.id).sort()).toEqual([a.id, aCand.id].sort());
    });

    it('deals: expirePublishedBySourceUrl expires only that source’s published deals', async () => {
      const db = await makeDb();
      const a1 = dealRecord({ source_url: 'https://a.de/x', status: DealStatus.enum.published });
      const a2 = dealRecord({ source_url: 'https://a.de/x', status: DealStatus.enum.candidate });
      const b1 = dealRecord({ source_url: 'https://b.de/y', status: DealStatus.enum.published });
      await db.deals.insert(a1);
      await db.deals.insert(a2);
      await db.deals.insert(b1);

      const n = await db.deals.expirePublishedBySourceUrl('https://a.de/x', '2026-06-19T00:00:00Z');
      expect(n).toBe(1);
      expect((await db.deals.getById(a1.id))!.status).toBe('expired');
      expect((await db.deals.getById(a2.id))!.status).toBe('candidate'); // not published → untouched
      expect((await db.deals.getById(b1.id))!.status).toBe('published'); // other source → untouched
    });

    it('deals: findActiveByDedupeKeyAndHash matches a queued candidate by its evidence hash', async () => {
      const db = await makeDb();
      const { dedupeKey } = await import('../../src/domain/index.js');
      const ev = {
        id: randomUUID(),
        source_url: 'https://x.de',
        screenshot_ref: 's',
        html_ref: 'h',
        terms_ref: 't',
        captured_at: '2026-06-19T00:00:00.000Z',
        content_hash: 'HASH_A',
      };
      await db.evidence.insert(ev);
      const deal = dealRecord({ evidence_id: ev.id, status: DealStatus.enum.candidate });
      await db.deals.insert(deal);
      const key = dedupeKey(deal);

      expect((await db.deals.findActiveByDedupeKeyAndHash(key, 'HASH_A'))!.id).toBe(deal.id);
      expect(await db.deals.findActiveByDedupeKeyAndHash(key, 'OTHER_HASH')).toBeNull();
    });

    it('evidence: insert + getById; unknown id returns null', async () => {
      const db = await makeDb();
      const ev = {
        id: randomUUID(),
        source_url: 'https://x.de',
        screenshot_ref: 's',
        html_ref: 'h',
        terms_ref: 't',
        captured_at: '2026-06-19T00:00:00.000Z',
        content_hash: 'abc',
      };
      await db.evidence.insert(ev);
      expect((await db.evidence.getById(ev.id))!.content_hash).toBe('abc');
      expect(await db.evidence.getById(randomUUID())).toBeNull();
    });

    it('manualCapture: insert + listOpen', async () => {
      const db = await makeDb();
      await db.manualCapture.insert({
        id: randomUUID(),
        source_id: randomUUID(),
        source_url: 'https://x.de',
        reason: 'login_required',
        created_at: '2026-06-19T00:00:00.000Z',
        status: 'open',
        note: null,
      });
      expect(await db.manualCapture.listOpen(10)).toHaveLength(1);
    });

    it('fieldProposals: upsertAndCount increments on repeat', async () => {
      const db = await makeDb();
      const base = {
        suggested_key: 'requires_pet',
        label: 'Pet required',
        rationale: 'r',
        example_quote: 'q',
        first_seen_at: '2026-06-19T00:00:00.000Z',
        last_seen_at: '2026-06-19T00:00:00.000Z',
      };
      await db.fieldProposals.upsertAndCount(base);
      await db.fieldProposals.upsertAndCount(base);
      const proposals = await db.fieldProposals.listOpen(10);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.count).toBe(2);
    });

    it('fieldProposals: a later sighting preserves first_seen_at and advances last_seen_at', async () => {
      // The upsert is a single SQL statement (count = count + 1); first_seen_at is
      // set only on the insert branch, so a concurrent/repeat sighting must never
      // overwrite it — it is the "recurring since" signal the promotion loop reads.
      const db = await makeDb();
      const base = {
        suggested_key: 'requires_pet',
        label: 'Pet required',
        rationale: 'r',
        example_quote: 'q',
        first_seen_at: '2026-06-19T00:00:00.000Z',
        last_seen_at: '2026-06-19T00:00:00.000Z',
      };
      await db.fieldProposals.upsertAndCount(base);
      await db.fieldProposals.upsertAndCount({
        ...base,
        // A later sighting carries a newer last_seen and a (wrongly) newer
        // first_seen — the store must keep the ORIGINAL first_seen_at.
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_seen_at: '2026-07-01T00:00:00.000Z',
      });
      const proposals = await db.fieldProposals.listOpen(10);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.count).toBe(2);
      // Compare by instant, not by exact text: Postgres returns a timestamptz as
      // `2026-06-19 00:00:00+00` (space/offset), the in-memory store echoes the ISO
      // input — both denote the same moment, which is what the invariant is about.
      expect(new Date(proposals[0]!.first_seen_at).toISOString()).toBe('2026-06-19T00:00:00.000Z');
      expect(new Date(proposals[0]!.last_seen_at).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });

    it('deals: findByDedupeKey returns the highest-confidence match (canonical)', async () => {
      const db = await makeDb();
      const { dedupeKey } = await import('../../src/domain/index.js');
      const low = dealRecord({ confidence: 0.4 });
      const high = dealRecord({ ...sameRoute(low), confidence: 0.9 });
      await db.deals.insert(low);
      await db.deals.insert(high);
      // Both share a dedupe key; the canonical (highest-confidence) one must win,
      // regardless of insertion order — so the two adapters don't diverge here.
      const found = await db.deals.findByDedupeKey(dedupeKey(low));
      expect(found!.id).toBe(high.id);
    });

    it('changes: insert + recentForSource returns newest-first, scoped to the source', async () => {
      const db = await makeDb();
      const sourceId = randomUUID();
      const other = randomUUID();
      await db.changes.insert(makeChange(sourceId, 'unchanged', '2026-06-17T00:00:00.000Z'));
      await db.changes.insert(makeChange(sourceId, 'disappeared', '2026-06-19T00:00:00.000Z'));
      await db.changes.insert(makeChange(other, 'blocked', '2026-06-20T00:00:00.000Z'));

      const recent = await db.changes.recentForSource(sourceId, 10);
      expect(recent.map((c) => c.kind)).toEqual(['disappeared', 'unchanged']);
      expect(recent.every((c) => c.source_id === sourceId)).toBe(true);
    });

    it('reviews: insert + listForDeal returns newest-first, scoped to the deal', async () => {
      const db = await makeDb();
      const dealId = randomUUID();
      const other = randomUUID();
      await db.reviews.insert({
        id: randomUUID(),
        deal_id: dealId,
        action: 'reject',
        approver: 'r1',
        reason: 'not a bundle',
        decided_at: '2026-06-17T00:00:00.000Z',
      });
      await db.reviews.insert({
        id: randomUUID(),
        deal_id: dealId,
        action: 'approve',
        approver: 'r2',
        reason: null,
        decided_at: '2026-06-19T00:00:00.000Z',
      });
      await db.reviews.insert({
        id: randomUUID(),
        deal_id: other,
        action: 'approve',
        approver: 'r3',
        reason: null,
        decided_at: '2026-06-20T00:00:00.000Z',
      });

      const history = await db.reviews.listForDeal(dealId, 10);
      expect(history.map((r) => r.action)).toEqual(['approve', 'reject']);
      expect(history.every((r) => r.deal_id === dealId)).toBe(true);
      expect(history[1]!.reason).toBe('not a bundle');
    });

    it('sourceReviews: insert + listForSource returns newest-first, scoped to the source', async () => {
      const db = await makeDb();
      const sourceId = randomUUID();
      const other = randomUUID();
      await db.sourceReviews.insert({
        id: randomUUID(),
        source_id: sourceId,
        action: 'reject',
        approver: 's1',
        reason: 'parked',
        decided_at: '2026-06-17T00:00:00.000Z',
      });
      await db.sourceReviews.insert({
        id: randomUUID(),
        source_id: sourceId,
        action: 'approve',
        approver: 's2',
        reason: null,
        decided_at: '2026-06-19T00:00:00.000Z',
      });
      await db.sourceReviews.insert({
        id: randomUUID(),
        source_id: other,
        action: 'approve',
        approver: 's3',
        reason: null,
        decided_at: '2026-06-20T00:00:00.000Z',
      });

      const history = await db.sourceReviews.listForSource(sourceId, 10);
      expect(history.map((r) => r.action)).toEqual(['approve', 'reject']);
      expect(history.every((r) => r.source_id === sourceId)).toBe(true);
      expect(history[1]!.reason).toBe('parked');
    });

    // crawlRuns.costSummary — the shared Postgres DB persists rows ACROSS cases, so
    // each case scopes its assertions to its own randomUUID() source_ids and bounds
    // the window to its own far-out timestamps. We assert per_source for our own ids
    // and never on the global total/run_count, so other cases' rows can't pollute.
    describe('crawlRuns.costSummary', () => {
      it('(a) empty window → zeros + empty arrays, never throws', async () => {
        const db = await makeDb();
        // A window in a deserted far-future range no other case writes into.
        const summary = await db.crawlRuns.costSummary({
          since: new Date('2400-01-01T00:00:00.000Z'),
          until: new Date('2400-01-02T00:00:00.000Z'),
        });
        expect(summary).toEqual({ total_eur: 0, run_count: 0, per_day: [], per_source: [] });
      });

      it('(b) rolls up across UTC days + sources: per_day asc, per_source cost-desc', async () => {
        const db = await makeDb();
        const srcA = randomUUID();
        const srcB = randomUUID();
        // Dedicated 2-day window in 2200 so the shared DB can't pollute these ids.
        const since = new Date('2200-03-01T00:00:00.000Z');
        const until = new Date('2200-03-03T00:00:00.000Z');
        // Day 1 (03-01): srcA 1.00 + 2.00, srcB 0.50  → day cost 3.50, 3 runs
        // Day 2 (03-02): srcA 0.25, srcB 4.00         → day cost 4.25, 2 runs
        await db.crawlRuns.insert(makeRun(srcA, '2200-03-01T06:00:00.000Z', 1.0));
        await db.crawlRuns.insert(makeRun(srcA, '2200-03-01T18:00:00.000Z', 2.0));
        await db.crawlRuns.insert(makeRun(srcB, '2200-03-01T09:00:00.000Z', 0.5));
        await db.crawlRuns.insert(makeRun(srcA, '2200-03-02T01:00:00.000Z', 0.25));
        await db.crawlRuns.insert(makeRun(srcB, '2200-03-02T23:00:00.000Z', 4.0));

        const summary = await db.crawlRuns.costSummary({ since, until });

        expect(summary.total_eur).toBe(7.75);
        expect(summary.run_count).toBe(5);
        // per_day ascending by day, UTC bucketed.
        expect(summary.per_day).toEqual([
          { day: '2200-03-01', cost_eur: 3.5, run_count: 3 },
          { day: '2200-03-02', cost_eur: 4.25, run_count: 2 },
        ]);
        // per_source descending by cost: srcB total 4.50 > srcA total 3.25.
        expect(summary.per_source).toEqual([
          { source_id: srcB, cost_eur: 4.5, run_count: 2 },
          { source_id: srcA, cost_eur: 3.25, run_count: 3 },
        ]);
      });

      it('(b2) per_source ties break by source_id ascending', async () => {
        const db = await makeDb();
        // Two sources with the SAME total cost; the deterministic tiebreak is
        // source_id ascending. Pick ids with a known lexical order.
        const lo = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
        const hi = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(-12)}`;
        const since = new Date('2201-01-01T00:00:00.000Z');
        const until = new Date('2201-01-02T00:00:00.000Z');
        await db.crawlRuns.insert(makeRun(hi, '2201-01-01T05:00:00.000Z', 1.0));
        await db.crawlRuns.insert(makeRun(lo, '2201-01-01T06:00:00.000Z', 1.0));

        const summary = await db.crawlRuns.costSummary({ since, until });
        expect(summary.per_source.map((s) => s.source_id)).toEqual([lo, hi]);
      });

      it('(c) half-open window: started_at === until excluded, === since included', async () => {
        const db = await makeDb();
        const src = randomUUID();
        const since = new Date('2202-05-10T00:00:00.000Z');
        const until = new Date('2202-05-11T00:00:00.000Z');
        // exactly at since → INCLUDED; exactly at until → EXCLUDED; just inside → INCLUDED.
        await db.crawlRuns.insert(makeRun(src, '2202-05-10T00:00:00.000Z', 1.0)); // == since
        await db.crawlRuns.insert(makeRun(src, '2202-05-10T12:00:00.000Z', 2.0)); // inside
        await db.crawlRuns.insert(makeRun(src, '2202-05-11T00:00:00.000Z', 9.0)); // == until

        const summary = await db.crawlRuns.costSummary({ since, until });
        // The 9.00 run at the exclusive upper bound must NOT be counted.
        expect(summary.per_source).toEqual([{ source_id: src, cost_eur: 3.0, run_count: 2 }]);
        expect(summary.total_eur).toBe(3.0);
        expect(summary.run_count).toBe(2);
      });

      it('(d) rounding: 7 runs of 0.001 sum and round to 0.01 cents identically', async () => {
        const db = await makeDb();
        const src = randomUUID();
        const since = new Date('2203-07-01T00:00:00.000Z');
        const until = new Date('2203-07-02T00:00:00.000Z');
        for (let i = 0; i < 7; i++) {
          await db.crawlRuns.insert(makeRun(src, `2203-07-01T0${i}:00:00.000Z`, 0.001));
        }
        const summary = await db.crawlRuns.costSummary({ since, until });
        expect(summary.per_source).toEqual([{ source_id: src, cost_eur: 0.01, run_count: 7 }]);
        expect(summary.per_day).toEqual([{ day: '2203-07-01', cost_eur: 0.01, run_count: 7 }]);
        expect(summary.total_eur).toBe(0.01);
      });

      it('(e) order-sensitive multiset rounds identically + order-independently', async () => {
        // Regression guard for float-add order divergence between adapters: the raw
        // floats {0.005, 0.01, 0.02} sum to 0.035 OR 0.034999999999999996 depending
        // on fold order, which under "sum raw then round" gives €0.04 vs €0.03 — a
        // 1-cent disagreement for the SAME rows. With the micro-euro integer-sum
        // convention the answer is €0.04 regardless of order, in BOTH adapters.
        const db = await makeDb();
        const srcA = randomUUID();
        const srcB = randomUUID();
        const since = new Date('2300-09-01T00:00:00.000Z');
        const until = new Date('2300-09-02T00:00:00.000Z');
        const multiset = [0.005, 0.01, 0.02];
        // srcA inserts the multiset in one order...
        for (let i = 0; i < multiset.length; i++) {
          await db.crawlRuns.insert(makeRun(srcA, `2300-09-01T0${i}:00:00.000Z`, multiset[i]!));
        }
        // ...srcB inserts the SAME multiset reversed, proving order-independence
        // within a single query (Postgres scan/agg order is not insertion order).
        const reversed = [...multiset].reverse();
        for (let i = 0; i < reversed.length; i++) {
          await db.crawlRuns.insert(makeRun(srcB, `2300-09-01T1${i}:00:00.000Z`, reversed[i]!));
        }

        const summary = await db.crawlRuns.costSummary({ since, until });
        // Both sources roll up to the SAME rounded cents (€0.04), tie-broken by
        // source_id ascending. Assert exact values so a regression in either
        // adapter's convention is caught.
        const [lo, hi] = [srcA, srcB].sort((a, b) => a.localeCompare(b));
        expect(summary.per_source).toEqual([
          { source_id: lo, cost_eur: 0.04, run_count: 3 },
          { source_id: hi, cost_eur: 0.04, run_count: 3 },
        ]);
        // Both multisets land on the same UTC day → one bucket of €0.07 (0.04+0.04
        // computed from the exact micro sum, not by adding the rounded per-source €).
        expect(summary.per_day).toEqual([{ day: '2300-09-01', cost_eur: 0.07, run_count: 6 }]);
        expect(summary.total_eur).toBe(0.07);
        expect(summary.run_count).toBe(6);
      });
    });
  });
}

/** Copy the canonical-key fields (service/provider/route_type/country) of a deal. */
function sameRoute(d: DealRecord): Partial<DealRecord> {
  return {
    service: d.service,
    provider: d.provider,
    route_type: d.route_type,
    country: d.country,
  };
}

function makeChange(
  sourceId: string,
  kind: 'unchanged' | 'disappeared' | 'blocked' | 'content_changed',
  detectedAt: string,
) {
  return {
    id: randomUUID(),
    deal_id: null,
    source_id: sourceId,
    kind,
    previous_hash: null,
    current_hash: null,
    detected_at: detectedAt,
  };
}
