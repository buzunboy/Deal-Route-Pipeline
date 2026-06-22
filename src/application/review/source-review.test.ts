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
import { tldtsSuffixOracle } from '../../adapters/suffix/tldts-suffix-oracle.js';
import { randomUUID } from 'node:crypto';

describe('SourceReviewUseCase (source-promotion loop)', () => {
  let db: InMemoryDb;
  let uc: SourceReviewUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    uc = new SourceReviewUseCase(db, new FixedClock(), new FakeLogger(), tldtsSuffixOracle, 'DE');
  });

  async function seedPending() {
    const src = makeSource({
      url: 'https://pending.de',
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
    // Distinct url — a different source (url is the natural key); without this it
    // would overwrite the pending row instead of adding a second, active source.
    await db.sources.upsert(makeSource({ url: 'https://active.de', status: 'active' }));
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

  // ── listRegistry + createSource (ACR-10 sources registry) ─────────────────
  describe('listRegistry', () => {
    it('lists active + disabled (not pending/rejected), projected + status-mapped', async () => {
      await db.sources.upsert(
        makeSource({ url: 'https://active.de', status: 'active', reliability_score: 0.9 }),
      );
      await db.sources.upsert(
        makeSource({ url: 'https://flaky.de', status: 'active', reliability_score: 0.2 }),
      );
      await db.sources.upsert(makeSource({ url: 'https://off.de', status: 'disabled' }));
      await db.sources.upsert(
        makeSource({ url: 'https://pending.de', status: 'pending_approval' }),
      );
      await db.sources.upsert(makeSource({ url: 'https://nope.de', status: 'rejected' }));

      const registry = await uc.listRegistry();
      const byDomain = Object.fromEntries(registry.map((r) => [r.domain, r]));
      // pending + rejected are excluded.
      expect(registry.map((r) => r.domain).sort()).toEqual(['active.de', 'flaky.de', 'off.de']);
      // status mapping: active+high → active; active+low → degraded; disabled → disabled.
      expect(byDomain['active.de']!.status).toBe('active');
      expect(byDomain['flaky.de']!.status).toBe('degraded');
      expect(byDomain['off.de']!.status).toBe('disabled');
      // kind is capitalised.
      expect(byDomain['active.de']!.kind).toBe(
        byDomain['active.de']!.kind[0]!.toUpperCase() + byDomain['active.de']!.kind.slice(1),
      );
    });
  });

  describe('createSource', () => {
    it('registers an active source, pins registrable_domain, defaults country to the market', async () => {
      const source = await uc.createSource({
        approver: 'curator',
        domain: 'netflix.com',
        kind: 'Provider',
        tier: 1,
      });
      expect(source.status).toBe('active');
      expect(source.url).toBe('https://netflix.com/');
      expect(source.type).toBe('provider');
      expect(source.country).toBe('DE'); // default market
      expect(source.registrable_domain).toBe('netflix.com'); // pinned via the real PSL
      expect(source.next_due).toBeNull();
      // it appears in the registry now.
      const registry = await uc.listRegistry();
      expect(registry.some((r) => r.domain === 'netflix.com')).toBe(true);
    });

    it('rejects an unsupported kind, a bad tier, and a missing approver', async () => {
      await expect(
        uc.createSource({ approver: 'c', domain: 'bank.de', kind: 'Bank', tier: 1 }),
      ).rejects.toThrow(/kind/i);
      await expect(
        uc.createSource({ approver: 'c', domain: 'x.de', kind: 'provider', tier: 9 }),
      ).rejects.toThrow(/tier/i);
      await expect(
        uc.createSource({ approver: '  ', domain: 'x.de', kind: 'provider', tier: 1 }),
      ).rejects.toThrow(/approver/i);
    });

    it('rejects a non-URL domain and an out-of-market country', async () => {
      await expect(
        uc.createSource({ approver: 'c', domain: 'not a url', kind: 'provider', tier: 1 }),
      ).rejects.toThrow(/domain/i);
      await expect(
        uc.createSource({
          approver: 'c',
          domain: 'x.de',
          kind: 'provider',
          tier: 1,
          country: 'US',
        }),
      ).rejects.toThrow(/country|market/i);
    });
  });
});
