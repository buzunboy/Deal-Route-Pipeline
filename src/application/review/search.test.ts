import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ReviewUseCase } from './review.js';
import type { Permission, ManualCaptureTask, User } from '../../domain/index.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { makeSource } from '../../../test/factories/source.js';
import { makeDealRecord as makeDeal } from '../../../test/factories/deal.js';
import { tldtsSuffixOracle } from '../../adapters/suffix/tldts-suffix-oracle.js';

const perms = (...keys: Permission[]) => new Set<Permission>(keys);

function makeUser(over: Partial<User> & Pick<User, 'id' | 'email' | 'name'>): User {
  return {
    role_id: randomUUID(),
    status: 'active',
    auth_provider: 'password',
    google_sub: null,
    token_version: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function makeCapture(
  over: Partial<ManualCaptureTask> & Pick<ManualCaptureTask, 'source_url'>,
): ManualCaptureTask {
  return {
    id: randomUUID(),
    source_id: null,
    reason: 'captcha',
    created_at: '2026-06-01T00:00:00.000Z',
    status: 'open',
    note: null,
    ...over,
  };
}

describe('ReviewUseCase.search (unified search)', () => {
  let db: InMemoryDb;
  let uc: ReviewUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    uc = new ReviewUseCase(db, new FixedClock(), new FakeLogger(), tldtsSuffixOracle);
  });

  it('short query (<2 chars after trim) returns no results and never hits the DB', async () => {
    await db.deals.insert(makeDeal({ status: 'candidate', service: 'Apple TV+' }));
    const out = await uc.search({ q: ' a ', permissions: perms() });
    expect(out).toEqual({});
  });

  it('case-insensitive substring (ILIKE) matches a candidate by service/provider', async () => {
    await db.deals.insert(
      makeDeal({ status: 'candidate', service: 'Apple TV+', provider: 'Apple', country: 'DE' }),
    );
    await db.deals.insert(
      makeDeal({ status: 'in_review', service: 'Spotify', provider: 'Spotify', country: 'DE' }),
    );

    const out = await uc.search({ q: 'appl', permissions: perms() });
    expect(out.candidates).toEqual([
      { id: expect.any(String), title: 'Apple TV+', subtitle: 'Apple · DE' },
    ]);
  });

  it('users category: included for a caller WITH team:manage, ABSENT without it', async () => {
    await db.users.insert(
      makeUser({ id: randomUUID(), name: 'Jane Reviewer', email: 'jane@deal-route.com' }),
      null,
    );

    const withPerm = await uc.search({ q: 'jane', permissions: perms('team:manage') });
    expect(withPerm.users).toEqual([
      { id: expect.any(String), title: 'Jane Reviewer', subtitle: 'jane@deal-route.com' },
    ]);

    const withoutPerm = await uc.search({ q: 'jane', permissions: perms() });
    expect(withoutPerm).not.toHaveProperty('users');
  });

  it('explicit ?resource=users for an under-permissioned caller yields {} (no users key)', async () => {
    await db.users.insert(
      makeUser({ id: randomUUID(), name: 'Jane', email: 'jane@deal-route.com' }),
      null,
    );
    const out = await uc.search({ q: 'jane', resource: 'users', permissions: perms() });
    expect(out).toEqual({});
  });

  it('projects sources, captures and published per the contract', async () => {
    await db.sources.upsert(
      makeSource({
        url: 'https://apple.com',
        registrable_domain: 'apple.com',
        tier: 1,
        status: 'pending',
      }),
    );
    await db.manualCapture.insert(
      makeCapture({ source_url: 'https://apple.com/tv', reason: 'captcha' }),
    );
    await db.deals.insert(
      makeDeal({ status: 'published', service: 'Apple Music', provider: 'Apple', country: 'DE' }),
    );

    const out = await uc.search({ q: 'apple', permissions: perms() });
    expect(out.sources).toEqual([
      { id: expect.any(String), title: 'apple.com', subtitle: 'Tier 1 · pending' },
    ]);
    expect(out.captures).toEqual([
      { id: expect.any(String), title: 'https://apple.com/tv', subtitle: 'captcha · open' },
    ]);
    expect(out.published).toEqual([
      { id: expect.any(String), title: 'Apple Music', subtitle: 'Apple · DE' },
    ]);
  });

  it('respects the per-category limit', async () => {
    for (let i = 0; i < 8; i++) {
      await db.deals.insert(
        makeDeal({ status: 'candidate', service: `Apple ${i}`, provider: 'Apple', country: 'DE' }),
      );
    }
    const out = await uc.search({ q: 'apple', limit: 3, permissions: perms() });
    expect(out.candidates).toHaveLength(3);
  });
});
