import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { ReviewApi } from './review-api.js';
import {
  ReviewUseCase,
  SourceReviewUseCase,
  TeamUseCase,
  AlertsUseCase,
  MetricsUseCase,
  SettingsUseCase,
  AuthenticateUseCase,
  AuthorizationUseCase,
} from '../../application/index.js';
import { loadConfig } from '../../config/index.js';
import {
  type DealRecord,
  SYSTEM_ROLE_ADMIN_ID,
  SYSTEM_ROLE_REVIEWER_ID,
} from '../../domain/index.js';
import { InMemoryDb } from '../db/in-memory/in-memory-db.js';
import { LocalFsEvidenceStore } from '../evidence-store/local-fs-evidence-store.js';
import { ConsoleLogger } from '../logger/console-logger.js';
import { JoseTokenIssuer } from '../security/jose-token-issuer.js';
import { tldtsSuffixOracle } from '../suffix/tldts-suffix-oracle.js';
import { makeDealRecord } from '../../../test/factories/deal.js';
import { FakePasswordHasher, FakeLogger } from '../../../test/fakes/fakes.js';
import type { Clock } from '../../application/ports/index.js';

/** A settable clock so token-expiry / TTL boundaries can be crossed in a test. */
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
import {
  makeTestTokenIssuerFactory,
  seedActiveUser,
  TEST_AUTH_TTLS,
  TEST_LOCKOUT,
  TEST_REALM,
  TEST_ISS,
  TEST_AUD,
} from '../../../test/fakes/auth-test-support.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Phase-2 JWT guard + dual-accept on ReviewApi: identity is proven from the verified
 * token (not the body), reads now require a token, the route registry enforces per-write
 * permissions, immediate revocation works, and the legacy static token still authenticates
 * during the dual-accept window. These are the trust-critical + adversarial guard paths.
 */
describe('ReviewApi — JWT guard + dual-accept (Phase 2)', () => {
  let makeIssuer: (clock: Clock) => JoseTokenIssuer;
  let clock: MovableClock;
  let db: InMemoryDb;
  let hasher: FakePasswordHasher;
  let issuer: JoseTokenIssuer;
  let login: AuthenticateUseCase;
  let api: ReviewApi;
  let base: string;
  let evidenceStore: LocalFsEvidenceStore;

  const LEGACY_TOKEN = 'legacy-static-secret';

  beforeAll(async () => {
    makeIssuer = await makeTestTokenIssuerFactory();
  });

  async function seedCandidate(overrides: Partial<DealRecord> = {}): Promise<DealRecord> {
    const ev = await evidenceStore.save({
      sourceUrl: 'https://x.de',
      screenshot: new Uint8Array([1]),
      html: '<html>',
      termsText: 't',
      capturedAt: '2026-06-19T00:00:00.000Z',
      contentHash: 'h',
    });
    await db.evidence.insert(ev);
    const deal = makeDealRecord({ evidence_id: ev.id, status: 'candidate', ...overrides });
    await db.deals.insert(deal);
    return deal;
  }

  beforeEach(async () => {
    clock = new MovableClock(new Date('2026-06-19T00:00:00.000Z'));
    db = new InMemoryDb();
    hasher = new FakePasswordHasher();
    issuer = makeIssuer(clock);
    evidenceStore = new LocalFsEvidenceStore(mkdtempSync(join(tmpdir(), 'ev-auth-')));
    const authorization = new AuthorizationUseCase(db);
    login = new AuthenticateUseCase(
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
    api = new ReviewApi(
      new ReviewUseCase(db, clock, new ConsoleLogger('error'), tldtsSuffixOracle),
      new SourceReviewUseCase(db, clock, new ConsoleLogger('error'), tldtsSuffixOracle, 'DE'),
      new TeamUseCase(db, clock, new ConsoleLogger('error')),
      new AlertsUseCase(db, clock, new ConsoleLogger('error')),
      new MetricsUseCase(db, clock, new ConsoleLogger('error')),
      new SettingsUseCase(db, loadConfig({}), clock, new ConsoleLogger('error')),
      evidenceStore,
      new ConsoleLogger('error'),
      {
        staticPageHtml: '<html>page</html>',
        authToken: LEGACY_TOKEN, // dual-accept: legacy static token stays valid
        auth: { tokenIssuer: issuer, db, authorization },
      },
    );
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    base = `http://127.0.0.1:${(api['server'].address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  /** Log in a seeded user and return its access token. */
  async function accessTokenFor(
    email: string,
    roleId: string = SYSTEM_ROLE_REVIEWER_ID,
    id?: string,
  ): Promise<string> {
    await seedActiveUser(db, hasher, { id, email, password: 'pw', roleId });
    const session = await login.authenticate({ email, password: 'pw' });
    return session.accessToken;
  }

  function bearer(token: string): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  }

  describe('reads now require a valid token', () => {
    it('GET /api/candidates with NO token → 401 (was open before)', async () => {
      expect((await fetch(`${base}/api/candidates`)).status).toBe(401);
    });

    it('GET /api/candidates with a valid JWT → 200', async () => {
      const token = await accessTokenFor('rita@dealroute.de');
      const res = await fetch(`${base}/api/candidates`, { headers: bearer(token) });
      expect(res.status).toBe(200);
    });

    it('GET /api/health stays open (liveness)', async () => {
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
    });
  });

  describe('approver is derived from the token, NOT the body', () => {
    it('approve records the TOKEN email as approver, ignoring a forged body approver', async () => {
      const deal = await seedCandidate();
      const token = await accessTokenFor('rita@dealroute.de');
      const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ approver: 'attacker@evil.com' }), // body approver is IGNORED
      });
      expect(res.status).toBe(200);
      const reviews = await db.reviews.listForDeal(deal.id, 10);
      expect(reviews[0]!.approver).toBe('rita@dealroute.de');
      expect(reviews.some((r) => r.approver === 'attacker@evil.com')).toBe(false);
    });
  });

  describe('route → permission registry', () => {
    it('a reviewer (no team:manage) cannot POST /api/team → 403', async () => {
      const token = await accessTokenFor('rita@dealroute.de', SYSTEM_ROLE_REVIEWER_ID);
      const res = await fetch(`${base}/api/team`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ approver: 'x', name: 'New', email: 'new@dealroute.de' }),
      });
      expect(res.status).toBe(403);
    });

    it('an admin (has team:manage) CAN POST /api/team → 201', async () => {
      const token = await accessTokenFor(
        'admin@dealroute.de',
        SYSTEM_ROLE_ADMIN_ID,
        '44444444-4444-4444-8444-444444444444',
      );
      const res = await fetch(`${base}/api/team`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ approver: 'x', name: 'New', email: 'new@dealroute.de' }),
      });
      expect(res.status).toBe(201);
    });

    it('a reviewer CAN approve a candidate (has candidate:approve) → 200', async () => {
      const deal = await seedCandidate();
      const token = await accessTokenFor('rita@dealroute.de');
      const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('immediate revocation (token_version)', () => {
    it('a still-unexpired token dies after the user is disabled', async () => {
      const deal = await seedCandidate();
      const token = await accessTokenFor('rita@dealroute.de');
      // The token works now…
      expect(
        (
          await fetch(`${base}/api/candidates/${deal.id}/approve`, {
            method: 'POST',
            headers: bearer(token),
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(200);
      // …disable the user (status flip) — the same token now 401s on the next call.
      const user = await db.users.getByEmail('rita@dealroute.de');
      await db.users.setStatus(user!.id, 'disabled');
      const after = await fetch(`${base}/api/candidates`, { headers: bearer(token) });
      expect(after.status).toBe(401);
    });

    it('a token_version bump (logout-everywhere) invalidates the old token', async () => {
      const token = await accessTokenFor('rita@dealroute.de');
      const user = await db.users.getByEmail('rita@dealroute.de');
      await db.users.bumpTokenVersion(user!.id); // claims.token_version (0) ≠ user (1)
      expect((await fetch(`${base}/api/candidates`, { headers: bearer(token) })).status).toBe(401);
    });
  });

  describe('dual-accept: the legacy static token still works', () => {
    it('the legacy bearer authorises a read', async () => {
      expect(
        (await fetch(`${base}/api/candidates`, { headers: bearer(LEGACY_TOKEN) })).status,
      ).toBe(200);
    });

    it('the legacy bearer authorises a write, recording the BODY approver (no synthetic actor)', async () => {
      const deal = await seedCandidate();
      const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
        method: 'POST',
        headers: bearer(LEGACY_TOKEN),
        body: JSON.stringify({ approver: 'human@dealroute.de' }),
      });
      expect(res.status).toBe(200);
      const reviews = await db.reviews.listForDeal(deal.id, 10);
      // The legacy path uses the BODY approver — and never a synthetic 'legacy-token@system'.
      expect(reviews[0]!.approver).toBe('human@dealroute.de');
      expect(reviews.some((r) => r.approver.includes('legacy-token@system'))).toBe(false);
    });
  });

  describe('adversarial JWT rejection (all → 401, generic)', () => {
    it('a tampered token (flipped byte) → 401', async () => {
      const token = await accessTokenFor('rita@dealroute.de');
      const tampered = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      expect((await fetch(`${base}/api/candidates`, { headers: bearer(tampered) })).status).toBe(
        401,
      );
    });

    it('an expired token → 401', async () => {
      const token = await accessTokenFor('rita@dealroute.de');
      // Advance the API's clock past the access TTL.
      clock.set(new Date(clock.now().getTime() + (TEST_AUTH_TTLS.accessSeconds + 60) * 1000));
      expect((await fetch(`${base}/api/candidates`, { headers: bearer(token) })).status).toBe(401);
    });

    it('an alg:none token → 401', async () => {
      await seedActiveUser(db, hasher, { email: 'rita@dealroute.de', password: 'pw' });
      const user = await db.users.getByEmail('rita@dealroute.de');
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: TEST_ISS,
          aud: TEST_AUD,
          sub: user!.id,
          email: 'rita@dealroute.de',
          name: 'Rita',
          role: 'admin',
          perms: ['team:manage'],
          token_version: 0,
          perm_version: 0,
          iat: 1,
          exp: 9999999999,
          jti: 'x',
        }),
      ).toString('base64url');
      const noneToken = `${header}.${payload}.`;
      expect((await fetch(`${base}/api/candidates`, { headers: bearer(noneToken) })).status).toBe(
        401,
      );
    });

    it('a token from a DIFFERENT issuer key (forged HS256 with the wrong secret) → 401', async () => {
      await seedActiveUser(db, hasher, { email: 'rita@dealroute.de', password: 'pw' });
      const forged = await new SignJWT({
        email: 'rita@dealroute.de',
        name: 'Rita',
        role: 'admin',
        perms: ['team:manage'],
        token_version: 0,
        perm_version: 0,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(TEST_ISS)
        .setAudience(TEST_AUD)
        .setSubject('11111111-1111-4111-8111-111111111111')
        .setIssuedAt(1)
        .setExpirationTime(9999999999)
        .setJti('forged')
        .sign(new TextEncoder().encode('attacker-guessed-secret'));
      expect((await fetch(`${base}/api/candidates`, { headers: bearer(forged) })).status).toBe(401);
    });

    it('the 401 body is uniform regardless of WHY (no token vs bad token)', async () => {
      const noToken = await (await fetch(`${base}/api/candidates`)).json();
      const badToken = await (
        await fetch(`${base}/api/candidates`, { headers: bearer('garbage.token.here') })
      ).json();
      expect(noToken).toEqual({ error: 'unauthorized' });
      expect(badToken).toEqual({ error: 'unauthorized' });
    });
  });
});
