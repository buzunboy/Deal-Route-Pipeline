import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AuthenticateUseCase } from './authenticate.js';
import { RefreshUseCase } from './refresh.js';
import { InMemoryDb } from '../../adapters/db/in-memory/in-memory-db.js';
import { JoseTokenIssuer } from '../../adapters/security/jose-token-issuer.js';
import {
  RefreshTokenInvalidError,
  RefreshReuseDetectedError,
  AccountDisabledError,
} from '../../domain/index.js';
import { FakePasswordHasher, FakeLogger } from '../../../test/fakes/fakes.js';
import {
  makeTestTokenIssuerFactory,
  seedActiveUser,
  TEST_AUTH_TTLS,
  TEST_LOCKOUT,
  TEST_REALM,
} from '../../../test/fakes/auth-test-support.js';
import { hashRefreshToken } from '../shared/refresh-token-crypto.js';
import type { Clock } from '../ports/index.js';

class MovableClock implements Clock {
  constructor(private d: Date) {}
  set(d: Date): void {
    this.d = d;
  }
  now(): Date {
    return this.d;
  }
  nowIso(): string {
    return this.d.toISOString();
  }
}

const T0 = new Date('2026-06-19T00:00:00.000Z');

describe('RefreshUseCase', () => {
  let makeIssuer: (clock: Clock) => JoseTokenIssuer;
  let db: InMemoryDb;
  let hasher: FakePasswordHasher;
  let clock: MovableClock;
  let login: AuthenticateUseCase;
  let refresh: RefreshUseCase;

  beforeAll(async () => {
    makeIssuer = await makeTestTokenIssuerFactory();
  });

  beforeEach(async () => {
    db = new InMemoryDb();
    hasher = new FakePasswordHasher();
    clock = new MovableClock(T0);
    const issuer = makeIssuer(clock);
    login = new AuthenticateUseCase(
      db,
      hasher,
      issuer,
      clock,
      new FakeLogger(),
      TEST_AUTH_TTLS,
      TEST_LOCKOUT,
      TEST_REALM,
    );
    refresh = new RefreshUseCase(db, issuer, clock, new FakeLogger(), TEST_AUTH_TTLS, TEST_REALM);
    await seedActiveUser(db, hasher, { email: 'rita@dealroute.de', password: 'pw' });
  });

  async function loginOnce(): Promise<{ accessToken: string; refreshToken: string }> {
    const s = await login.authenticate({ email: 'rita@dealroute.de', password: 'pw' });
    return { accessToken: s.accessToken, refreshToken: s.refreshToken };
  }

  it('a fresh refresh rotates the token (new pair; old revoked)', async () => {
    const { refreshToken: first } = await loginOnce();
    const session = await refresh.refresh({ refreshToken: first });
    expect(session.refreshToken).not.toBe(first);
    // The presented token is now revoked.
    const old = await db.refreshTokens.findByHash(hashRefreshToken(first));
    expect(old!.revoked_at).not.toBeNull();
    expect(old!.replaced_by).not.toBeNull();
    // The successor is current and in the SAME family.
    const next = await db.refreshTokens.findByHash(hashRefreshToken(session.refreshToken));
    expect(next!.revoked_at).toBeNull();
    expect(next!.family_id).toBe(old!.family_id);
  });

  it('an unknown refresh token → 401', async () => {
    await expect(refresh.refresh({ refreshToken: 'never-issued' })).rejects.toBeInstanceOf(
      RefreshTokenInvalidError,
    );
  });

  it('an expired refresh token → 401', async () => {
    const { refreshToken } = await loginOnce();
    clock.set(new Date(T0.getTime() + (TEST_AUTH_TTLS.refreshSeconds + 1) * 1000));
    await expect(refresh.refresh({ refreshToken })).rejects.toBeInstanceOf(
      RefreshTokenInvalidError,
    );
  });

  it('a concurrent replay WITHIN the grace window re-issues without revoking the family', async () => {
    const { refreshToken: first } = await loginOnce();
    const second = await refresh.refresh({ refreshToken: first }); // first rotated out at T0
    // A racing request replays `first` ~1s later (within the 10s grace) — a benign concurrent
    // refresh, not theft. It gets a fresh working session, the family survives.
    clock.set(new Date(T0.getTime() + 1000));
    const racing = await refresh.refresh({ refreshToken: first });
    expect(racing.refreshToken).not.toBe(first);
    expect(racing.refreshToken).not.toBe(second.refreshToken);
    // The legitimate successor is still usable: the family was NOT revoked.
    const third = await refresh.refresh({ refreshToken: second.refreshToken });
    expect(third.accessToken).toBeTruthy();
  });

  it('a LATE replay of a rotated-out token (past the grace window) revokes the whole family', async () => {
    const { refreshToken: first } = await loginOnce();
    const second = await refresh.refresh({ refreshToken: first }); // first rotated out at T0
    // Replaying `first` well past the grace window is theft → family-revoke + 401.
    clock.set(new Date(T0.getTime() + 60_000));
    await expect(refresh.refresh({ refreshToken: first })).rejects.toBeInstanceOf(
      RefreshReuseDetectedError,
    );
    // The whole family is dead: even the (previously valid) successor now fails.
    await expect(refresh.refresh({ refreshToken: second.refreshToken })).rejects.toBeInstanceOf(
      RefreshTokenInvalidError,
    );
  });

  it('a user disabled mid-session cannot refresh (family revoked)', async () => {
    const { refreshToken } = await loginOnce();
    const user = await db.users.getByEmail('rita@dealroute.de');
    await db.users.setStatus(user!.id, 'disabled');
    await expect(refresh.refresh({ refreshToken })).rejects.toBeInstanceOf(AccountDisabledError);
    // The family is revoked, so a later re-enable doesn't resurrect the old token.
    await db.users.setStatus(user!.id, 'active');
    await expect(refresh.refresh({ refreshToken })).rejects.toBeTruthy();
  });

  it('the rotated access token re-resolves perms on a perm_version change', async () => {
    const { refreshToken } = await loginOnce();
    // Bump the global perm_version (simulating a role-permission edit).
    await db.authMeta.bumpPermVersion();
    const session = await refresh.refresh({ refreshToken });
    const claims = await makeIssuer(clock).verifyAccess(session.accessToken);
    expect(claims.perm_version).toBe(1);
  });
});
