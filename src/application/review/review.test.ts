import { describe, it, expect, beforeEach } from 'vitest';
import { ReviewUseCase } from './review.js';
import { DealStatus, type DealRecord } from '../../domain/index.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';
import { randomUUID } from 'node:crypto';
import type { Evidence } from '../../domain/index.js';

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
  let uc: ReviewUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    uc = new ReviewUseCase(db, new FixedClock(), new FakeLogger());
  });

  it('lists candidates joined with their evidence', async () => {
    const ev: Evidence = {
      id: randomUUID(),
      source_url: 'https://x.de',
      screenshot_ref: 's',
      html_ref: 'h',
      terms_ref: 't',
      captured_at: '2026-06-19T00:00:00.000Z',
      content_hash: 'h',
    };
    await db.evidence.insert(ev);
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

  it('approve sets published_at (distinct from verified_at) + persists it', async () => {
    const deal = await makeCandidate(db, randomUUID());
    const updated = await uc.approve(deal.id, 'reviewer@dealroute');
    expect(updated.published_at).not.toBeNull();
    expect(updated.published_at).toBe(updated.verified_at); // both = the approve instant
    const stored = await db.deals.getById(deal.id);
    expect(stored!.published_at).not.toBeNull();
  });

  it('approve sets affiliate_disclosure from the reviewer when supplied', async () => {
    const deal = await makeCandidate(db, randomUUID());
    const updated = await uc.approve(deal.id, 'reviewer@dealroute', { affiliateDisclosure: false });
    expect(updated.affiliate_disclosure).toBe(false);
    expect((await db.deals.getById(deal.id))!.affiliate_disclosure).toBe(false);
  });

  it('DEFAULTS affiliate_disclosure=true (over-disclose) + warns when the reviewer omits it', async () => {
    const logger = new FakeLogger();
    const ucWarn = new ReviewUseCase(db, new FixedClock(), logger);
    const deal = await makeCandidate(db, randomUUID());
    const updated = await ucWarn.approve(deal.id, 'reviewer@dealroute'); // no disclosure supplied
    expect(updated.affiliate_disclosure).toBe(true); // safe default — never under-disclose
    expect(
      logger.entries.some((e) => e.level === 'warn' && /affiliate_disclosure/i.test(e.msg)),
    ).toBe(true);
  });

  it('reject → rejected/archived', async () => {
    const deal = await makeCandidate(db, randomUUID());
    const updated = await uc.reject(deal.id, 'reviewer@dealroute', 'not a real bundle');
    expect(updated.status).toBe('rejected');
  });

  it('writes an immutable review audit row on approve and reject', async () => {
    const approved = await makeCandidate(db, randomUUID());
    await uc.approve(approved.id, 'alice');
    const aHistory = await uc.listReviews(approved.id);
    expect(aHistory).toHaveLength(1);
    expect(aHistory[0]).toMatchObject({ action: 'approve', approver: 'alice', reason: null });

    const rejected = await makeCandidate(db, randomUUID());
    await uc.reject(rejected.id, 'bob', 'duplicate of an existing route');
    const rHistory = await uc.listReviews(rejected.id);
    expect(rHistory).toHaveLength(1);
    expect(rHistory[0]).toMatchObject({
      action: 'reject',
      approver: 'bob',
      reason: 'duplicate of an existing route',
    });
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
