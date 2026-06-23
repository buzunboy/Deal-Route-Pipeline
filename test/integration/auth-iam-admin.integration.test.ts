import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import { ReviewApi } from '../../src/adapters/http/review-api.js';
import { AuthApi } from '../../src/adapters/http/auth-api.js';
import { SYSTEM_ROLE_ADMIN_ID, UserSchema } from '../../src/domain/index.js';
import { makeDealRecord } from '../factories/deal.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Auth/IAM Phase 3 (Users & Roles admin API) end-to-end through the REAL composition root +
 * REAL Postgres + the REAL Auth/Review HTTP routers over a socket. This is the wiring + SQL
 * round-trip a fake can't prove: a real admin provisions a real user via `POST /api/users`,
 * that user logs in and is enforced by role on a cross-call, a new role + reassignment bumps
 * `perm_version`, disable revokes immediately, and the last-admin guard refuses the lockout —
 * the headline self-service loop the acceptance proof mirrors with curl.
 */
const suite = hasDb ? describe : describe.skip;

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

suite('Auth/IAM Phase 3 admin (Container + Postgres + HTTP)', () => {
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
      AUTH_JWT_KID: 'it-key-3',
      AUTH_ACCESS_TTL_SECONDS: '900',
    });
    await container.init();
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

  /** Seed ONE admin (real hasher) and return its access token + id. */
  async function seedAdmin(): Promise<{ token: string; id: string }> {
    const id = '99999999-9999-4999-8999-999999999999';
    const user = UserSchema.parse({
      id,
      name: 'Admin Ada',
      email: 'ada@dealroute.de',
      role_id: SYSTEM_ROLE_ADMIN_ID,
      status: 'active',
      auth_provider: 'password',
      google_sub: null,
      token_version: 0,
      created_at: container.clock.nowIso(),
    });
    await container.db.users.insert(user, await container.passwordHasher.hash('admin-password-1'));
    const token = (await login('ada@dealroute.de', 'admin-password-1')).accessToken;
    return { token, id };
  }

  async function login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; permissions: string[] }> {
    const res = await fetch(`${authBase}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { accessToken: string; permissions: string[] };
  }
  const bearer = (t: string): Record<string, string> => ({
    'content-type': 'application/json',
    authorization: `Bearer ${t}`,
  });

  it('the full self-service loop: provision → login-as → role-enforced → reassign → disable', async () => {
    await boot();
    const { token: adminToken } = await seedAdmin();

    // 2. admin provisions reviewer "sam" → 201.
    const create = await fetch(`${reviewBase}/api/users`, {
      method: 'POST',
      headers: bearer(adminToken),
      body: JSON.stringify({
        name: 'Sam',
        email: 'sam@dealroute.de',
        role: 'reviewer',
        password: 'sam-password-123',
      }),
    });
    expect(create.status).toBe(201);

    // 3. login AS sam → token carrying the reviewer bundle.
    const sam = await login('sam@dealroute.de', 'sam-password-123');
    expect(sam.permissions).toContain('candidate:approve');
    expect(sam.permissions).not.toContain('team:manage');

    // 4. sam approves a candidate → 200, reviews.approver == sam.
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
    const approve = await fetch(`${reviewBase}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: bearer(sam.accessToken),
      body: JSON.stringify({}),
    });
    expect(approve.status).toBe(200);
    const reviews = await container.db.reviews.listForDeal(deal.id, 10);
    expect(reviews[0]!.approver).toBe('sam@dealroute.de');

    // 5. sam hits a team:manage route (POST /api/users) → 403.
    const escalate = await fetch(`${reviewBase}/api/users`, {
      method: 'POST',
      headers: bearer(sam.accessToken),
      body: JSON.stringify({
        name: 'Mallory',
        email: 'm@dealroute.de',
        role: 'admin',
        password: 'm-password-123',
      }),
    });
    expect(escalate.status).toBe(403);

    // 6. admin creates a read-only role "auditor", then reassigns sam → perm_version bumps.
    const permBefore = await container.db.authMeta.getPermVersion();
    const roleRes = await fetch(`${reviewBase}/api/roles`, {
      method: 'POST',
      headers: bearer(adminToken),
      body: JSON.stringify({
        name: 'auditor',
        description: 'read only',
        permissions: ['candidate:read'],
      }),
    });
    expect(roleRes.status).toBe(201);
    const sammy = await container.db.users.getByEmail('sam@dealroute.de');
    const patch = await fetch(`${reviewBase}/api/users/${sammy!.id}`, {
      method: 'PATCH',
      headers: bearer(adminToken),
      body: JSON.stringify({ role: 'auditor' }),
    });
    expect(patch.status).toBe(200);
    expect(await container.db.authMeta.getPermVersion()).toBeGreaterThan(permBefore);

    // 7. The reassignment BUMPED sam's token_version, so the OLD token is immediately dead
    //    (a stronger revoke than waiting out the token window). Sam re-logs-in and the FRESH
    //    token carries the auditor bundle: can read, can NOT approve (auditor lacks approve).
    const staleAfterReassign = await fetch(`${reviewBase}/api/candidates`, {
      headers: bearer(sam.accessToken),
    });
    expect(staleAfterReassign.status).toBe(401); // old token revoked on role change

    const samAuditor = await login('sam@dealroute.de', 'sam-password-123');
    expect(samAuditor.permissions).toContain('candidate:read');
    expect(samAuditor.permissions).not.toContain('candidate:approve');
    const stillReads = await fetch(`${reviewBase}/api/candidates`, {
      headers: bearer(samAuditor.accessToken),
    });
    expect(stillReads.status).toBe(200);
    const deal2 = makeDealRecord({ evidence_id: ev.id, status: 'candidate' });
    await container.db.deals.insert(deal2);
    const cantApprove = await fetch(`${reviewBase}/api/candidates/${deal2.id}/approve`, {
      method: 'POST',
      headers: bearer(samAuditor.accessToken),
      body: JSON.stringify({}),
    });
    expect(cantApprove.status).toBe(403);

    // 8. admin disables sam → sam's still-unexpired (auditor) token → 401 (immediate revoke).
    const disable = await fetch(`${reviewBase}/api/users/${sammy!.id}`, {
      method: 'PATCH',
      headers: bearer(adminToken),
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(disable.status).toBe(200);
    const afterDisable = await fetch(`${reviewBase}/api/candidates`, {
      headers: bearer(samAuditor.accessToken),
    });
    expect(afterDisable.status).toBe(401);
  });

  it('self-service password change: reviewer changes own pw → old token 401s → new pw logs in', async () => {
    await boot();
    const { token: adminToken } = await seedAdmin();
    // admin provisions sam, sam logs in
    const create = await fetch(`${reviewBase}/api/users`, {
      method: 'POST',
      headers: bearer(adminToken),
      body: JSON.stringify({
        name: 'Sam',
        email: 'sam@dealroute.de',
        role: 'reviewer',
        password: 'sam-password-123',
      }),
    });
    expect(create.status).toBe(201);
    const sam = await login('sam@dealroute.de', 'sam-password-123');

    // sam changes their OWN password (correct current) via PATCH /api/profile — no team:manage.
    const change = await fetch(`${reviewBase}/api/profile`, {
      method: 'PATCH',
      headers: bearer(sam.accessToken),
      body: JSON.stringify({
        currentPassword: 'sam-password-123',
        newPassword: 'sam-new-password-9',
      }),
    });
    expect(change.status).toBe(200);

    // The old access token is now dead (token_version bumped) ...
    const stale = await fetch(`${reviewBase}/api/candidates`, { headers: bearer(sam.accessToken) });
    expect(stale.status).toBe(401);
    // ... and the NEW password logs in (the old one no longer does).
    const relogin = await fetch(`${authBase}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sam@dealroute.de', password: 'sam-new-password-9' }),
    });
    expect(relogin.status).toBe(200);
    const oldPw = await fetch(`${authBase}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sam@dealroute.de', password: 'sam-password-123' }),
    });
    expect(oldPw.status).toBe(401);

    // A WRONG current password → 401, password unchanged.
    const sam2 = await login('sam@dealroute.de', 'sam-new-password-9');
    const wrong = await fetch(`${reviewBase}/api/profile`, {
      method: 'PATCH',
      headers: bearer(sam2.accessToken),
      body: JSON.stringify({ currentPassword: 'not-it', newPassword: 'whatever-12345' }),
    });
    expect(wrong.status).toBe(401);
  });

  it('LAST-ADMIN GUARD: disabling the only admin → 409 (over real Postgres)', async () => {
    await boot();
    const { token: adminToken, id: adminId } = await seedAdmin();
    const res = await fetch(`${reviewBase}/api/users/${adminId}`, {
      method: 'PATCH',
      headers: bearer(adminToken),
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(res.status).toBe(409);
    expect((await container.db.users.getById(adminId))!.status).toBe('active');
  });
});
