import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import { ReviewApi } from '../../src/adapters/http/review-api.js';
import { AuthApi } from '../../src/adapters/http/auth-api.js';
import { REVIEW_TEST_PAGE } from '../../src/adapters/http/test-page.js';
import { SYSTEM_ROLE_REVIEWER_ID, UserSchema } from '../../src/domain/index.js';
import { makeDealRecord } from '../factories/deal.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Auth/IAM Phase 2 end-to-end through the REAL composition root + REAL Postgres + the REAL
 * AuthApi/ReviewApi over a socket: login → access token → gated write → the recorded
 * `approver` is the TOKEN's email (not a body value) → disable the user → the same
 * still-unexpired token 401s (immediate revocation) → refresh-after-disable fails. This is
 * the wiring + SQL round-trip a unit test with fakes can't prove (real users/roles/
 * refresh_tokens/reviews tables, the real Argon2 hasher, the real jose verifier).
 */
const suite = hasDb ? describe : describe.skip;

// One real ES256 keypair for the whole file — fed to the Container via AUTH_JWT_* env so
// the real JoseTokenIssuer signs/verifies (not a fake), exercising the boot key-parse path.
let pkcs8Pem: string;

beforeAll(async () => {
  if (!hasDb) return;
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  pkcs8Pem = await exportPKCS8(privateKey);
});

const overrides = {
  fetcher: new ScriptedFetcher({}),
  llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [] }) }),
};

suite('Auth/IAM Phase 2 flow (Container + Postgres + HTTP)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  let reviewApi: ReviewApi;
  let authApi: AuthApi;
  let reviewBase: string;
  let authBase: string;

  async function boot(): Promise<void> {
    container = makeContainer(overrides, {
      AUTH_JWT_PRIVATE_KEY: pkcs8Pem,
      AUTH_JWT_KID: 'it-key-1',
      // A short, deterministic access TTL keeps the test fast while still real.
      AUTH_ACCESS_TTL_SECONDS: '900',
      REVIEW_API_TOKEN: 'legacy-it-token',
    });
    await container.init(); // parses the signing key (fails loudly if malformed)
    reviewApi = new ReviewApi(
      container.review,
      container.sourceReview,
      container.team,
      container.alerts,
      container.metrics,
      container.settings,
      container.evidenceStore,
      container.logger,
      {
        staticPageHtml: REVIEW_TEST_PAGE,
        authToken: container.config.reviewApi.authToken,
        auth: {
          tokenIssuer: container.tokenIssuer,
          db: container.db,
          authorization: container.authorization,
          provisionUser: container.provisionUser,
          manageRoles: container.manageRoles,
        },
      },
    );
    authApi = new AuthApi(
      container.authenticateUser,
      container.refreshSession,
      container.logoutSession,
      container.tokenIssuer,
      container.logger,
    );
    await reviewApi.listen(0);
    await authApi.listen(0);
    // @ts-expect-error reach into the server for the assigned port
    reviewBase = `http://127.0.0.1:${(reviewApi['server'].address() as AddressInfo).port}`;
    // @ts-expect-error reach into the server for the assigned port
    authBase = `http://127.0.0.1:${(authApi['server'].address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await reviewApi?.close();
    await authApi?.close();
    await container?.shutdown();
  });

  /** Provision a reviewer through the real hasher + UserRepository (like `seed-user`). */
  async function seedReviewer(email: string, password: string): Promise<string> {
    const user = UserSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Reviewer Rita',
      email,
      role_id: SYSTEM_ROLE_REVIEWER_ID,
      status: 'active',
      auth_provider: 'password',
      google_sub: null,
      token_version: 0,
      created_at: container.clock.nowIso(),
    });
    await container.db.users.insert(user, await container.passwordHasher.hash(password));
    return user.id;
  }

  it('login → gated write → approver-from-token → disable → 401 → refresh-after-disable fails', async () => {
    await boot();
    const userId = await seedReviewer('rita@dealroute.de', 'a-strong-password');

    // 1. Login (correct password) → tokens.
    const loginRes = await fetch(`${authBase}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'rita@dealroute.de', password: 'a-strong-password' }),
    });
    expect(loginRes.status).toBe(200);
    const session = (await loginRes.json()) as {
      accessToken: string;
      refreshToken: string;
      permissions: string[];
    };
    expect(session.permissions).toContain('candidate:approve');

    // 2. A gated write WITH the token → 200, and the reviews row's approver is the TOKEN
    //    email (a forged body approver is ignored).
    const ev = await container.evidenceStore.save({
      sourceUrl: 'https://x.de',
      screenshot: new Uint8Array([1]),
      html: '<html>',
      termsText: 't',
      capturedAt: '2026-06-19T00:00:00.000Z',
      contentHash: 'h',
    });
    await container.db.evidence.insert(ev);
    const deal = makeDealRecord({ evidence_id: ev.id, status: 'candidate' });
    await container.db.deals.insert(deal);

    const approveRes = await fetch(`${reviewBase}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({ approver: 'forged@evil.com' }),
    });
    expect(approveRes.status).toBe(200);
    const reviews = await container.db.reviews.listForDeal(deal.id, 10);
    expect(reviews[0]!.approver).toBe('rita@dealroute.de'); // token email, NOT the body
    expect((await container.db.deals.getById(deal.id))!.status).toBe('published');

    // 3. A read with NO token → 401 (reads now require auth).
    expect((await fetch(`${reviewBase}/api/candidates`)).status).toBe(401);

    // 4. Disable the user (bump token_version) → the SAME still-unexpired token 401s.
    await container.db.users.bumpTokenVersion(userId);
    const afterDisable = await fetch(`${reviewBase}/api/candidates`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(afterDisable.status).toBe(401); // immediate revocation

    // 5. Refresh after disable also fails (status-flip path): set status disabled too.
    await container.db.users.setStatus(userId, 'disabled');
    const refreshRes = await fetch(`${authBase}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    expect(refreshRes.status).toBe(403); // AccountDisabledError
  });

  it('refresh rotates, and replaying a rotated-out token revokes the family (401)', async () => {
    await boot();
    await seedReviewer('rita@dealroute.de', 'a-strong-password');
    const login = await (
      await fetch(`${authBase}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'rita@dealroute.de', password: 'a-strong-password' }),
      })
    ).json();
    const first = (login as { refreshToken: string }).refreshToken;

    const rotated = await fetch(`${authBase}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: first }),
    });
    expect(rotated.status).toBe(200);

    // Replay the rotated-out token → reuse-detection 401.
    const reuse = await fetch(`${authBase}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: first }),
    });
    expect(reuse.status).toBe(401);
  });

  it('the legacy static token still authorises a write during dual-accept', async () => {
    await boot();
    const ev = await container.evidenceStore.save({
      sourceUrl: 'https://x.de',
      screenshot: new Uint8Array([1]),
      html: '<html>',
      termsText: 't',
      capturedAt: '2026-06-19T00:00:00.000Z',
      contentHash: 'h',
    });
    await container.db.evidence.insert(ev);
    const deal = makeDealRecord({ evidence_id: ev.id, status: 'candidate' });
    await container.db.deals.insert(deal);

    const res = await fetch(`${reviewBase}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer legacy-it-token' },
      body: JSON.stringify({ approver: 'human@dealroute.de' }),
    });
    expect(res.status).toBe(200);
    const reviews = await container.db.reviews.listForDeal(deal.id, 10);
    // Legacy path records the BODY approver — never a synthetic 'legacy-token@system'.
    expect(reviews[0]!.approver).toBe('human@dealroute.de');
  });
});
