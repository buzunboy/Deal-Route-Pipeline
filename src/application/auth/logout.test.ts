import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AuthenticateUseCase } from './authenticate.js';
import { LogoutUseCase } from './logout.js';
import { AuthorizationUseCase } from './authorization.js';
import { InMemoryDb } from '../../adapters/db/in-memory/in-memory-db.js';
import type { JoseTokenIssuer } from '../../adapters/security/jose-token-issuer.js';
import type { Clock } from '../ports/index.js';
import { FakePasswordHasher, FakeLogger } from '../../../test/fakes/fakes.js';
import {
  makeTestTokenIssuerFactory,
  seedActiveUser,
  TEST_AUTH_TTLS,
  TEST_LOCKOUT,
  TEST_REALM,
} from '../../../test/fakes/auth-test-support.js';
import { hashRefreshToken } from '../shared/refresh-token-crypto.js';
import { FixedClock } from '../../../test/fakes/fakes.js';

describe('LogoutUseCase', () => {
  let makeIssuer: (clock: Clock) => JoseTokenIssuer;
  let db: InMemoryDb;
  let hasher: FakePasswordHasher;
  let clock: FixedClock;
  let login: AuthenticateUseCase;
  let logout: LogoutUseCase;

  beforeAll(async () => {
    makeIssuer = await makeTestTokenIssuerFactory();
  });

  beforeEach(async () => {
    db = new InMemoryDb();
    hasher = new FakePasswordHasher();
    clock = new FixedClock(new Date('2026-06-19T00:00:00.000Z'));
    login = new AuthenticateUseCase(
      db,
      hasher,
      makeIssuer(clock),
      new AuthorizationUseCase(db),
      clock,
      new FakeLogger(),
      TEST_AUTH_TTLS,
      TEST_LOCKOUT,
      TEST_REALM,
    );
    logout = new LogoutUseCase(db, clock, new FakeLogger());
    await seedActiveUser(db, hasher, { email: 'rita@dealroute.de', password: 'pw' });
  });

  it('logout revokes the presented token family', async () => {
    const session = await login.authenticate({ email: 'rita@dealroute.de', password: 'pw' });
    await logout.logout(session.refreshToken);
    const row = await db.refreshTokens.findByHash(hashRefreshToken(session.refreshToken));
    expect(row!.revoked_at).not.toBeNull();
  });

  it('logout is idempotent on an unknown token (no error, no leak)', async () => {
    await expect(logout.logout('never-issued')).resolves.toBeUndefined();
  });

  it('logoutEverywhere revokes all refreshes AND bumps token_version', async () => {
    const s1 = await login.authenticate({ email: 'rita@dealroute.de', password: 'pw' });
    await login.authenticate({ email: 'rita@dealroute.de', password: 'pw' }); // a 2nd session
    const user = await db.users.getByEmail('rita@dealroute.de');
    expect(user!.token_version).toBe(0);

    await logout.logoutEverywhere(user!.id);

    expect((await db.users.getById(user!.id))!.token_version).toBe(1);
    // Both sessions' refresh rows are revoked.
    const r1 = await db.refreshTokens.findByHash(hashRefreshToken(s1.refreshToken));
    expect(r1!.revoked_at).not.toBeNull();
  });
});
