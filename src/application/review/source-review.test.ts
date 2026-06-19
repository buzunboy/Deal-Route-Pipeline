import { describe, it, expect, beforeEach } from 'vitest';
import { SourceReviewUseCase } from './source-review.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { makeSource } from '../../../test/factories/source.js';
import {
  SourceNotFoundError,
  SourceNotReviewableError,
  MissingApproverError,
} from '../../domain/index.js';
import { randomUUID } from 'node:crypto';

describe('SourceReviewUseCase (source-promotion loop)', () => {
  let db: InMemoryDb;
  let uc: SourceReviewUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    uc = new SourceReviewUseCase(db, new FixedClock(), new FakeLogger());
  });

  async function seedPending() {
    const src = makeSource({
      status: 'pending_approval',
      type: 'discovered',
      tier: 4,
      next_due: '2030-01-01T00:00:00Z',
    });
    await db.sources.upsert(src);
    return src;
  }

  it('lists only pending sources', async () => {
    await seedPending();
    await db.sources.upsert(makeSource({ status: 'active' }));
    const pending = await uc.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe('pending_approval');
  });

  it('approve → active, due now, with an audit row', async () => {
    const src = await seedPending();
    const updated = await uc.approveSource(src.id, 'curator@dealroute');
    expect(updated.status).toBe('active');
    expect(updated.next_due).toBeNull(); // due now
    expect(updated.tier).toBe(4); // tier preserved
    expect((await db.sources.getById(src.id))!.status).toBe('active');

    const history = await uc.listReviews(src.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: 'approve', approver: 'curator@dealroute' });
  });

  it('reject → rejected, with the reason in the audit row', async () => {
    const src = await seedPending();
    const updated = await uc.rejectSource(src.id, 'curator', 'parked domain, no offers');
    expect(updated.status).toBe('rejected');
    const history = await uc.listReviews(src.id);
    expect(history[0]).toMatchObject({ action: 'reject', reason: 'parked domain, no offers' });
  });

  it('refuses to promote without an approver identity', async () => {
    const src = await seedPending();
    await expect(uc.approveSource(src.id, '  ')).rejects.toBeInstanceOf(MissingApproverError);
    expect((await db.sources.getById(src.id))!.status).toBe('pending_approval');
  });

  it('refuses to act on a non-pending source (already active)', async () => {
    const src = makeSource({ status: 'active' });
    await db.sources.upsert(src);
    await expect(uc.approveSource(src.id, 'curator')).rejects.toBeInstanceOf(
      SourceNotReviewableError,
    );
  });

  it('throws SourceNotFoundError for an unknown id', async () => {
    await expect(uc.approveSource(randomUUID(), 'curator')).rejects.toBeInstanceOf(
      SourceNotFoundError,
    );
  });
});
