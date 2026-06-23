import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { AuthApi } from './auth-api.js';
import {
  AuthenticateUseCase,
  RefreshUseCase,
  LogoutUseCase,
  AuthorizationUseCase,
} from '../../application/index.js';
import { JoseTokenIssuer } from '../security/jose-token-issuer.js';
import { InMemoryDb } from '../db/in-memory/in-memory-db.js';
import { FakePasswordHasher, FakeLogger } from '../../../test/fakes/fakes.js';
import {
  makeTestTokenIssuerFactory,
  seedActiveUser,
  TEST_AUTH_TTLS,
  TEST_LOCKOUT,
  TEST_REALM,
  TEST_KID,
} from '../../../test/fakes/auth-test-support.js';
import { FixedClock } from '../../../test/fakes/fakes.js';

/** Drives the real AuthApi over a real socket end-to-end. */
describe('AuthApi (HTTP integration)', () => {
  let makeIssuer: (clock: FixedClock) => JoseTokenIssuer;
  let db: InMemoryDb;
  let hasher: FakePasswordHasher;
  let api: AuthApi;
  let base: string;

  beforeAll(async () => {
    makeIssuer = (await makeTestTokenIssuerFactory()) as (c: FixedClock) => JoseTokenIssuer;
  });

  beforeEach(async () => {
    db = new InMemoryDb();
    hasher = new FakePasswordHasher();
    const clock = new FixedClock(new Date('2026-06-19T00:00:00.000Z'));
    const issuer = makeIssuer(clock);
    const authorization = new AuthorizationUseCase(db);
    const login = new AuthenticateUseCase(
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
    const refresh = new RefreshUseCase(
      db,
      issuer,
      authorization,
      clock,
      new FakeLogger(),
      TEST_AUTH_TTLS,
      TEST_REALM,
    );
    const logout = new LogoutUseCase(db, clock, new FakeLogger());
    api = new AuthApi(login, refresh, logout, issuer, new FakeLogger());
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    const port = (api['server'].address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    await seedActiveUser(db, hasher, { email: 'rita@dealroute.de', password: 'pw-correct' });
  });

  async function post(path: string, body: unknown, raw?: string): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    });
  }

  describe('POST /auth/login', () => {
    it('correct credentials → 200 + access + refresh + permissions', async () => {
      const res = await post('/auth/login', { email: 'rita@dealroute.de', password: 'pw-correct' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(typeof json.accessToken).toBe('string');
      expect(typeof json.refreshToken).toBe('string');
      expect(Array.isArray(json.permissions)).toBe(true);
      expect((json.user as { email: string }).email).toBe('rita@dealroute.de');
    });

    it('wrong password → 401 with a GENERIC message (no enumeration)', async () => {
      const res = await post('/auth/login', { email: 'rita@dealroute.de', password: 'WRONG' });
      expect(res.status).toBe(401);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe('invalid email or password');
    });

    it('unknown email → the SAME 401 generic message as a wrong password', async () => {
      const res = await post('/auth/login', { email: 'ghost@nowhere.de', password: 'x' });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe('invalid email or password');
    });

    it('a disabled user → 403', async () => {
      await seedActiveUser(db, hasher, {
        id: '33333333-3333-4333-8333-333333333333',
        email: 'gone@dealroute.de',
        password: 'pw',
        status: 'disabled',
      });
      const res = await post('/auth/login', { email: 'gone@dealroute.de', password: 'pw' });
      expect(res.status).toBe(403);
    });

    it('lockout → 429 with a Retry-After header', async () => {
      for (let i = 0; i < TEST_LOCKOUT.maxFailedAttempts; i++) {
        await post('/auth/login', { email: 'rita@dealroute.de', password: 'WRONG' });
      }
      const res = await post('/auth/login', { email: 'rita@dealroute.de', password: 'pw-correct' });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).not.toBeNull();
    });

    it('missing fields → 400', async () => {
      expect((await post('/auth/login', { email: 'rita@dealroute.de' })).status).toBe(400);
      expect((await post('/auth/login', { password: 'pw' })).status).toBe(400);
      expect((await post('/auth/login', { email: 'not-an-email', password: 'pw' })).status).toBe(
        400,
      );
    });

    it('malformed JSON → 400', async () => {
      const res = await post('/auth/login', undefined, '{ not json');
      expect(res.status).toBe(400);
    });

    it('oversized body → 413', async () => {
      const huge = JSON.stringify({ email: 'rita@dealroute.de', password: 'p'.repeat(70 * 1024) });
      const res = await post('/auth/login', undefined, huge);
      expect(res.status).toBe(413);
    });

    it('the response never contains a password hash', async () => {
      const res = await post('/auth/login', { email: 'rita@dealroute.de', password: 'pw-correct' });
      const text = await res.text();
      expect(text).not.toMatch(/fakehash|password_hash|passwordHash/);
    });
  });

  describe('POST /auth/refresh', () => {
    async function loginRefreshToken(): Promise<string> {
      const res = await post('/auth/login', { email: 'rita@dealroute.de', password: 'pw-correct' });
      return ((await res.json()) as { refreshToken: string }).refreshToken;
    }

    it('a valid refresh token → 200 with a rotated pair', async () => {
      const first = await loginRefreshToken();
      const res = await post('/auth/refresh', { refreshToken: first });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { refreshToken: string; accessToken: string };
      expect(json.refreshToken).not.toBe(first);
      expect(typeof json.accessToken).toBe('string');
    });

    it('an unknown refresh token → 401', async () => {
      const res = await post('/auth/refresh', { refreshToken: 'never-issued' });
      expect(res.status).toBe(401);
    });

    it('REUSE of a rotated-out token → 401 (family revoked)', async () => {
      const first = await loginRefreshToken();
      await post('/auth/refresh', { refreshToken: first }); // rotates `first` out
      const reuse = await post('/auth/refresh', { refreshToken: first });
      expect(reuse.status).toBe(401);
    });

    it('missing refreshToken → 400', async () => {
      expect((await post('/auth/refresh', {})).status).toBe(400);
    });
  });

  describe('POST /auth/logout', () => {
    it('a valid token → 204 and the family is revoked', async () => {
      const login = await post('/auth/login', {
        email: 'rita@dealroute.de',
        password: 'pw-correct',
      });
      const { refreshToken } = (await login.json()) as { refreshToken: string };
      const res = await post('/auth/logout', { refreshToken });
      expect(res.status).toBe(204);
      // A subsequent refresh of the logged-out token fails.
      expect((await post('/auth/refresh', { refreshToken })).status).toBe(401);
    });

    it('an unknown token still → 204 (idempotent; no validity oracle)', async () => {
      const res = await post('/auth/logout', { refreshToken: 'never-issued' });
      expect(res.status).toBe(204);
    });

    it('missing refreshToken → 400', async () => {
      expect((await post('/auth/logout', {})).status).toBe(400);
    });
  });

  describe('GET /.well-known/jwks.json', () => {
    it('serves the ES256 public key (public-only, with kid + cache header)', async () => {
      const res = await fetch(`${base}/.well-known/jwks.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('max-age=300');
      const json = (await res.json()) as { keys: Record<string, unknown>[] };
      expect(json.keys.length).toBeGreaterThanOrEqual(1);
      const key = json.keys.find((k) => k.kid === TEST_KID)!;
      expect(key.kty).toBe('EC');
      expect(key.crv).toBe('P-256');
      expect(key.alg).toBe('ES256');
      expect('d' in key).toBe(false); // never leaks the private scalar
    });
  });

  it('unknown path → 404', async () => {
    const res = await fetch(`${base}/auth/nope`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
