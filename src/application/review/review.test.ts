import { describe, it, expect, beforeEach } from 'vitest';
import { ReviewUseCase } from './review.js';
import { DealStatus, type DealRecord } from '../../domain/index.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FakeEvidenceStore, FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';
import { randomUUID } from 'node:crypto';

function makeCandidate(db: InMemoryDb, evidenceId: string): Promise<DealRecord> {
  const deal: DealRecord = {
    ...makeLlmDeal(),
    id: randomUUID(),
    schema_version: 1,
    true_cost_monthly: 10,
    evidence_id: evidenceId,
    status: DealStatus.enum.candidate,
    verified_by: null,
    verified_at: null,
  };
  return db.deals.insert(deal).then(() => deal);
}

describe('ReviewUseCase', () => {
  let db: InMemoryDb;
  let evidenceStore: FakeEvidenceStore;
  let uc: ReviewUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    evidenceStore = new FakeEvidenceStore();
    uc = new ReviewUseCase(db, evidenceStore, new FixedClock(), new FakeLogger());
  });

  it('lists candidates joined with their evidence', async () => {
    const ev = await evidenceStore.save({
      sourceUrl: 'https://x.de',
      screenshot: new Uint8Array(),
      html: '<html>',
      termsText: 't',
      capturedAt: '2026-06-19T00:00:00.000Z',
      contentHash: 'h',
    });
    await makeCandidate(db, ev.id);

    const views = await uc.listCandidates();
    expect(views).toHaveLength(1);
    expect(views[0]!.evidence!.id).toBe(ev.id);
  });

  it('approve → published, stamped with approver + timestamp', async () => {
    const deal = await makeCandidate(db, randomUUID());
    const updated = await uc.approve(deal.id, 'reviewer@dealroute');
    expect(updated.status).toBe('published');
    expect(updated.verified_by).toBe('reviewer@dealroute');
    expect(updated.verified_at).not.toBeNull();

    const stored = await db.deals.getById(deal.id);
    expect(stored!.status).toBe('published');
  });

  it('reject → rejected/archived', async () => {
    const deal = await makeCandidate(db, randomUUID());
    const updated = await uc.reject(deal.id, 'reviewer@dealroute', 'not a real bundle');
    expect(updated.status).toBe('rejected');
  });

  it('refuses to publish without an approver identity (no anonymous publish)', async () => {
    const deal = await makeCandidate(db, randomUUID());
    await expect(uc.approve(deal.id, '   ')).rejects.toThrow(/approver/);
    expect((await db.deals.getById(deal.id))!.status).toBe('candidate');
  });

  it('refuses to re-decide an already-published deal', async () => {
    const deal = await makeCandidate(db, randomUUID());
    await uc.approve(deal.id, 'reviewer');
    await expect(uc.approve(deal.id, 'reviewer')).rejects.toThrow(/not reviewable/);
  });
});
