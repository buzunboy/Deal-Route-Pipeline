import { describe, it, expect } from 'vitest';
import type { Database } from '../../src/application/ports/index.js';
import { DealStatus, type DealRecord } from '../../src/domain/index.js';
import { makeLlmDeal } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import { randomUUID } from 'node:crypto';

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
