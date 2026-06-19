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
 * run is skipped automatically when no DATABASE_URL is configured.
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

      await db.deals.updateStatus(deal.id, DealStatus.enum.published, 'reviewer', '2026-06-19T00:00:00Z');
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

    it('changes: insert does not throw', async () => {
      const db = await makeDb();
      await db.changes.insert({
        id: randomUUID(),
        deal_id: null,
        source_id: randomUUID(),
        kind: 'unchanged',
        previous_hash: 'a',
        current_hash: 'a',
        detected_at: '2026-06-19T00:00:00.000Z',
      });
    });
  });
}
