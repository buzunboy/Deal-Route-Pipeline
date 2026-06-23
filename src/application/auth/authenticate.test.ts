import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AuthenticateUseCase } from './authenticate.js';
import { AuthorizationUseCase } from './authorization.js';
import { InMemoryDb } from '../../adapters/db/in-memory/in-memory-db.js';
import { JoseTokenIssuer } from '../../adapters/security/jose-token-issuer.js';
import {
  InvalidCredentialsError,
  AccountDisabledError,
  AccountLockedError,
  SYSTEM_ROLE_REVIEWER_ID,
} from '../../domain/index.js';
import { FakePasswordHasher, FakeLogger } from '../../../test/fakes/fakes.js';
import {
  makeTestTokenIssuerFactory,
  seedActiveUser,
  TEST_AUTH_TTLS,
  TEST_LOCKOUT,
  TEST_REALM,
} from '../../../test/fakes/auth-test-support.js';
import type { Clock } from '../ports/index.js';

/** A settable clock so lockout-window boundaries can be crossed deterministically. */
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

describe('AuthenticateUseCase', () => {
  let makeIssuer: (clock: Clock) => JoseTokenIssuer;
  let db: InMemoryDb;
  let hasher: FakePasswordHasher;
  let clock: MovableClock;
  let uc: AuthenticateUseCase;

  beforeAll(async () => {
    makeIssuer = await makeTestTokenIssuerFactory();
  });

  beforeEach(() => {
    db = new InMemoryDb();
    hasher = new FakePasswordHasher();
    clock = new MovableClock(T0);
    const issuer = makeIssuer(clock);
    const authorization = new AuthorizationUseCase(db);
    uc = new AuthenticateUseCase(
      db,
      hasher,
      issuer,
      authorization,
      clock,
      new FakeLogger(),
      TEST_AUTH_TTLS,
      TEST_LOCKOUT,
      TEST_REALM,
    );
  });

  it('logs in with the right password → access + refresh tokens + perms', async () => {
    await seedActiveUser(db, hasher, { email: 'rita@dealroute.de', password: 'pw-correct' });
    const session = await uc.authenticate({ email: 'rita@dealroute.de', password: 'pw-correct' });

    expect(session.accessToken.split('.')).toHaveLength(3); // a JWS compact
    expect(session.refreshToken.length).toBeGreaterThan(20);
    expect(session.user.email).toBe('rita@dealroute.de');
    expect(session.user.role).toBe('reviewer');
    // Reviewer perms are surfaced as a flat sorted array.
    expect(session.permissions).toContain('candidate:approve');
    expect(session.permissions).toContain('evidence:read');
    expect([...session.permissions]).toEqual([...session.permissions].sort());

    // The access token verifies against the same issuer and carries the right identity.
    const issuer = makeIssuer(clock);
    const claims = await issuer.verifyAccess(session.accessToken);
    expect(claims.email).toBe('rita@dealroute.de');
    expect(claims.token_version).toBe(0);

    // The refresh token is stored ONLY as a hash — the raw value is never persisted.
    const { hashRefreshToken } = await import('../shared/refresh-token-crypto.js');
    const stored = await db.refreshTokens.findByHash(hashRefreshToken(session.refreshToken));
    expect(stored).not.toBeNull();
    expect(stored!.token_hash).not.toBe(session.refreshToken);
  });

  it('email is normalised (trim + lowercase) before lookup', async () => {
    await seedActiveUser(db, hasher, { email: 'rita@dealroute.de', password: 'pw' });
    const session = await uc.authenticate({ email: '  Rita@DealRoute.DE  ', password: 'pw' });
    expect(session.user.email).toBe('rita@dealroute.de');
  });

  it('unknown email → generic 401 (no enumeration), having run the hasher', async () => {
    let verifyCalls = 0;
    const counting = new FakePasswordHasher();
    const origVerify = counting.verify.bind(counting);
    counting.verify = async (h, p) => {
      verifyCalls += 1;
      return origVerify(h, p);
    };
    uc = new AuthenticateUseCase(
      db,
      counting,
      makeIssuer(clock),
      new AuthorizationUseCase(db),
      clock,
      new FakeLogger(),
      TEST_AUTH_TTLS,
      TEST_LOCKOUT,
      TEST_REALM,
    );
    await expect(
      uc.authenticate({ email: 'ghost@nowhere.de', password: 'whatever' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    // The dummy-hash verify ran exactly once — the constant-time anti-enumeration path.
    expect(verifyCalls).toBe(1);
  });

  it('wrong password → 401 and increments the failure counter', async () => {
    const { user } = await seedActiveUser(db, hasher, {
      email: 'rita@dealroute.de',
      password: 'right',
    });
    await expect(
      uc.authenticate({ email: 'rita@dealroute.de', password: 'wrong' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    const state = await db.users.getLoginState(user.id);
    expect(state!.failedLoginCount).toBe(1);
  });

  it('a disabled user is rejected 403 even with the right password', async () => {
    await seedActiveUser(db, hasher, {
      email: 'gone@dealroute.de',
      password: 'right',
      status: 'disabled',
    });
    await expect(
      uc.authenticate({ email: 'gone@dealroute.de', password: 'right' }),
    ).rejects.toBeInstanceOf(AccountDisabledError);
  });

  it('locks after maxFailedAttempts and returns AccountLockedError thereafter', async () => {
    await seedActiveUser(db, hasher, { email: 'rita@dealroute.de', password: 'right' });
    // Five wrong attempts reach the threshold (maxFailedAttempts = 5).
    for (let i = 0; i < TEST_LOCKOUT.maxFailedAttempts; i++) {
      await expect(
        uc.authenticate({ email: 'rita@dealroute.de', password: 'wrong' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }
    // The next attempt — even with the RIGHT password — is locked (429), not authenticated.
    await expect(
      uc.authenticate({ email: 'rita@dealroute.de', password: 'right' }),
    ).rejects.toBeInstanceOf(AccountLockedError);
  });

  it('auto-unlocks once the lockout window elapses (boundary)', async () => {
    await seedActiveUser(db, hasher, { email: 'rita@dealroute.de', password: 'right' });
    for (let i = 0; i < TEST_LOCKOUT.maxFailedAttempts; i++) {
      await uc.authenticate({ email: 'rita@dealroute.de', password: 'wrong' }).catch(() => {});
    }
    // Still locked one second before the window elapses.
    clock.set(new Date(T0.getTime() + (TEST_LOCKOUT.lockoutSeconds - 1) * 1000));
    await expect(
      uc.authenticate({ email: 'rita@dealroute.de', password: 'right' }),
    ).rejects.toBeInstanceOf(AccountLockedError);
    // At exactly lockedUntil the lock has lifted — the right password now logs in.
    clock.set(new Date(T0.getTime() + TEST_LOCKOUT.lockoutSeconds * 1000));
    const session = await uc.authenticate({ email: 'rita@dealroute.de', password: 'right' });
    expect(session.user.email).toBe('rita@dealroute.de');
  });

  it('a successful login clears the failure counter', async () => {
    const { user } = await seedActiveUser(db, hasher, {
      email: 'rita@dealroute.de',
      password: 'right',
    });
    await uc.authenticate({ email: 'rita@dealroute.de', password: 'wrong' }).catch(() => {});
    expect((await db.users.getLoginState(user.id))!.failedLoginCount).toBe(1);
    await uc.authenticate({ email: 'rita@dealroute.de', password: 'right' });
    expect((await db.users.getLoginState(user.id))!.failedLoginCount).toBe(0);
  });

  it('a user with no password hash can never log in (uniform 401)', async () => {
    // Insert a user with a NULL hash directly (e.g. an SSO-only / never-set account).
    await db.users.insert(
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'No Password',
        email: 'sso@dealroute.de',
        role_id: SYSTEM_ROLE_REVIEWER_ID,
        status: 'active',
        auth_provider: 'password',
        google_sub: null,
        token_version: 0,
        created_at: '2026-06-01T00:00:00.000Z',
      },
      null,
    );
    await expect(
      uc.authenticate({ email: 'sso@dealroute.de', password: 'anything' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('transparently rehashes when the stored hash params lag, without bumping token_version', async () => {
    // Seed with an OLD-param hash (v1); the use-case runs with a v2 hasher.
    const oldHasher = new FakePasswordHasher(1);
    const { user } = await seedActiveUser(db, oldHasher, {
      email: 'rita@dealroute.de',
      password: 'pw',
    });
    const oldHash = await db.users.getPasswordHashByEmail('rita@dealroute.de');
    const newHasher = new FakePasswordHasher(2);
    uc = new AuthenticateUseCase(
      db,
      newHasher,
      makeIssuer(clock),
      new AuthorizationUseCase(db),
      clock,
      new FakeLogger(),
      TEST_AUTH_TTLS,
      TEST_LOCKOUT,
      TEST_REALM,
    );
    await uc.authenticate({ email: 'rita@dealroute.de', password: 'pw' });
    const rehashed = await db.users.getPasswordHashByEmail('rita@dealroute.de');
    expect(rehashed).not.toBe(oldHash);
    expect(newHasher.needsRehash(rehashed!)).toBe(false);
    // Same credential ⇒ token_version unchanged (no forced logout).
    expect((await db.users.getById(user.id))!.token_version).toBe(0);
  });
});
