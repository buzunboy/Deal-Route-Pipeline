import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
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
  ProvisionUserUseCase,
  ManageRolesUseCase,
} from '../../application/index.js';
import { loadConfig } from '../../config/index.js';
import { SYSTEM_ROLE_ADMIN_ID, SYSTEM_ROLE_REVIEWER_ID } from '../../domain/index.js';
import { InMemoryDb } from '../db/in-memory/in-memory-db.js';
import { FakeEvidenceStore } from '../../../test/fakes/fakes.js';
import { ConsoleLogger } from '../logger/console-logger.js';
import { JoseTokenIssuer } from '../security/jose-token-issuer.js';
import { tldtsSuffixOracle } from '../suffix/tldts-suffix-oracle.js';
import { FakePasswordHasher, FakeLogger } from '../../../test/fakes/fakes.js';
import type { Clock } from '../../application/ports/index.js';
import {
  makeTestTokenIssuerFactory,
  seedActiveUser,
  TEST_AUTH_TTLS,
  TEST_LOCKOUT,
  TEST_REALM,
} from '../../../test/fakes/auth-test-support.js';

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

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_PW = 'admin-password-123';
const REVIEWER_PW = 'reviewer-password-123';

/**
 * Phase-3 Users & Roles admin API on ReviewApi: provision/list/patch users (gated
 * `team:manage`), CRUD roles (gated `roles:manage`), the permission catalogue +
 * `/me`, plus the trust + adversarial paths: token-derived actor, privilege-escalation
 * attempts → 403, the last-admin guard → 409, and the boundary (malformed/missing/oversized).
 */
describe('ReviewApi — Users & Roles admin (Phase 3)', () => {
  let makeIssuer: (clock: Clock) => JoseTokenIssuer;
  let clock: MovableClock;
  let db: InMemoryDb;
  let hasher: FakePasswordHasher;
  let issuer: JoseTokenIssuer;
  let login: AuthenticateUseCase;
  let api: ReviewApi;
  let base: string;

  beforeAll(async () => {
    makeIssuer = await makeTestTokenIssuerFactory();
  });

  beforeEach(async () => {
    clock = new MovableClock(new Date('2026-06-19T00:00:00.000Z'));
    db = new InMemoryDb();
    hasher = new FakePasswordHasher();
    issuer = makeIssuer(clock);
    const authorization = new AuthorizationUseCase(db);
    const policy = loadConfig({}).auth.passwordPolicy;
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
      new FakeEvidenceStore(),
      new ConsoleLogger('error'),
      {
        auth: {
          tokenIssuer: issuer,
          db,
          authorization,
          provisionUser: new ProvisionUserUseCase(db, hasher, clock, new FakeLogger(), policy),
          manageRoles: new ManageRolesUseCase(db, hasher, clock, new FakeLogger(), policy),
        },
      },
    );
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    base = `http://127.0.0.1:${(api['server'].address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  /** Seed + log in an admin (has team:manage + roles:manage). */
  async function adminToken(): Promise<string> {
    await seedActiveUser(db, hasher, {
      id: ADMIN_ID,
      email: 'admin@dealroute.de',
      password: ADMIN_PW,
      roleId: SYSTEM_ROLE_ADMIN_ID,
    });
    return (await login.authenticate({ email: 'admin@dealroute.de', password: ADMIN_PW }))
      .accessToken;
  }
  /** Seed + log in a reviewer (no team:manage / roles:manage). */
  async function reviewerToken(email = 'rita@dealroute.de', id?: string): Promise<string> {
    await seedActiveUser(db, hasher, {
      id,
      email,
      password: REVIEWER_PW,
      roleId: SYSTEM_ROLE_REVIEWER_ID,
    });
    return (await login.authenticate({ email, password: REVIEWER_PW })).accessToken;
  }
  function bearer(token: string): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  }
  const J = (status: number) => status; // readability

  // ── POST /api/users ──
  describe('POST /api/users', () => {
    it('admin provisions a user → 201; the user can then log in', async () => {
      const token = await adminToken();
      const res = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({
          name: 'Sam',
          email: 'sam@dealroute.de',
          role: 'reviewer',
          password: 'sam-password-123',
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { email: string; role: string };
      expect(body.email).toBe('sam@dealroute.de');
      expect(body.role).toBe('reviewer');
      // Sam can authenticate immediately.
      const session = await login.authenticate({
        email: 'sam@dealroute.de',
        password: 'sam-password-123',
      });
      expect(session.permissions).toContain('candidate:approve');
    });

    it('PRIVILEGE ESCALATION: a reviewer creating a user → 403', async () => {
      const token = await reviewerToken();
      const res = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({
          name: 'X',
          email: 'x@dealroute.de',
          role: 'admin',
          password: 'x-password-123',
        }),
      });
      expect(res.status).toBe(403);
      expect(await db.users.getByEmail('x@dealroute.de')).toBeNull();
    });

    it('no token → 401', async () => {
      const res = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'X',
          email: 'x@dealroute.de',
          role: 'reviewer',
          password: 'x-password-123',
        }),
      });
      expect(res.status).toBe(401);
    });

    it('duplicate email → 409', async () => {
      const token = await adminToken();
      const make = () =>
        fetch(`${base}/api/users`, {
          method: 'POST',
          headers: bearer(token),
          body: JSON.stringify({
            name: 'D',
            email: 'dup@dealroute.de',
            role: 'reviewer',
            password: 'dup-password-1',
          }),
        });
      expect((await make()).status).toBe(201);
      expect((await make()).status).toBe(409);
    });

    it('unknown role → 404', async () => {
      const token = await adminToken();
      const res = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({
          name: 'N',
          email: 'n@dealroute.de',
          role: 'wizard',
          password: 'n-password-123',
        }),
      });
      expect(res.status).toBe(404);
    });

    it('too-short password → 400 (never half-creates)', async () => {
      const token = await adminToken();
      const res = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({
          name: 'S',
          email: 's@dealroute.de',
          role: 'reviewer',
          password: 'short',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('missing fields → 400; malformed JSON → 400', async () => {
      const token = await adminToken();
      const missing = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ email: 'm@dealroute.de' }),
      });
      expect(missing.status).toBe(400);
      const malformed = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: bearer(token),
        body: '{not json',
      });
      expect(malformed.status).toBe(400);
    });
  });

  // ── GET /api/users ──
  describe('GET /api/users', () => {
    it('admin lists users (no hash leaked)', async () => {
      const token = await adminToken();
      const res = await fetch(`${base}/api/users`, { headers: bearer(token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: Record<string, unknown>[] };
      expect(body.users.length).toBeGreaterThanOrEqual(1);
      for (const u of body.users) expect(u).not.toHaveProperty('password_hash');
    });
    it('reviewer → 403', async () => {
      const token = await reviewerToken();
      expect((await fetch(`${base}/api/users`, { headers: bearer(token) })).status).toBe(J(403));
    });
  });

  // ── PATCH /api/users/:id ──
  describe('PATCH /api/users/:id', () => {
    it('admin changes a user role → 200 (token_version bumped)', async () => {
      const token = await adminToken();
      const ritaId = '55555555-5555-4555-8555-555555555555';
      await reviewerToken('rita@dealroute.de', ritaId);
      const res = await fetch(`${base}/api/users/${ritaId}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ role: 'admin' }),
      });
      expect(res.status).toBe(200);
      expect((await db.users.getById(ritaId))!.token_version).toBe(1);
    });

    it('a reviewer changing ANOTHER user → 403; their OWN name → 200', async () => {
      const ritaId = '55555555-5555-4555-8555-555555555555';
      const token = await reviewerToken('rita@dealroute.de', ritaId);
      // editing another user id is forbidden
      const other = await fetch(`${base}/api/users/${ADMIN_ID}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ name: 'hax' }),
      });
      expect(other.status).toBe(403);
      // editing their OWN name is allowed (self path)
      const self = await fetch(`${base}/api/users/${ritaId}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ name: 'Rita Renamed' }),
      });
      expect(self.status).toBe(200);
    });

    it('PRIVILEGE ESCALATION: a reviewer granting THEMSELF admin via status/role → 403', async () => {
      const ritaId = '55555555-5555-4555-8555-555555555555';
      const token = await reviewerToken('rita@dealroute.de', ritaId);
      const res = await fetch(`${base}/api/users/${ritaId}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ role: 'admin' }), // privileged sub-field on self → still needs team:manage
      });
      expect(res.status).toBe(403);
      expect((await db.users.getById(ritaId))!.role_id).toBe(SYSTEM_ROLE_REVIEWER_ID);
    });

    it('LAST-ADMIN GUARD: disabling the only admin → 409', async () => {
      const token = await adminToken();
      const res = await fetch(`${base}/api/users/${ADMIN_ID}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ status: 'disabled' }),
      });
      expect(res.status).toBe(409);
      expect((await db.users.getById(ADMIN_ID))!.status).toBe('active');
    });

    it('empty patch → 400', async () => {
      const token = await adminToken();
      const res = await fetch(`${base}/api/users/${ADMIN_ID}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('PARTIAL-APPLY GUARD: {status:disabled, password:short} → 400 and NOTHING applied', async () => {
      const token = await adminToken();
      const ritaId = '55555555-5555-4555-8555-555555555555';
      await reviewerToken('rita@dealroute.de', ritaId);
      const res = await fetch(`${base}/api/users/${ritaId}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ status: 'disabled', password: 'short' }),
      });
      expect(res.status).toBe(400);
      // The status change must NOT have applied despite the password failing after it.
      expect((await db.users.getById(ritaId))!.status).toBe('active');
      expect((await db.users.getById(ritaId))!.token_version).toBe(0);
    });
  });

  // ── Roles ──
  describe('roles CRUD', () => {
    it('admin creates → lists → patches → deletes a role', async () => {
      const token = await adminToken();
      const created = await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({
          name: 'auditor',
          description: 'ro',
          permissions: ['candidate:read'],
        }),
      });
      expect(created.status).toBe(201);

      const list = await fetch(`${base}/api/roles`, { headers: bearer(token) });
      const roles = ((await list.json()) as { roles: { name: string }[] }).roles;
      expect(roles.some((r) => r.name === 'auditor')).toBe(true);

      const patched = await fetch(`${base}/api/roles/auditor`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ permissions: ['candidate:read', 'sources:read'] }),
      });
      expect(patched.status).toBe(200);

      const deleted = await fetch(`${base}/api/roles/auditor`, {
        method: 'DELETE',
        headers: bearer(token),
      });
      expect(deleted.status).toBe(200);
      expect(await db.roles.getByName('auditor')).toBeNull();
    });

    it('PRIVILEGE ESCALATION: a reviewer creating a role → 403', async () => {
      const token = await reviewerToken();
      const res = await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ name: 'sneaky', permissions: ['roles:manage'] }),
      });
      expect(res.status).toBe(403);
    });

    it('unknown permission key → 400', async () => {
      const token = await adminToken();
      const res = await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ name: 'bad', permissions: ['totally:bogus'] }),
      });
      expect(res.status).toBe(400);
    });

    it('a role granting ONLY system:foundations is accepted (the Designer use-case)', async () => {
      const token = await adminToken();
      const res = await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({
          name: 'designer',
          description: 'Style-guide access only',
          permissions: ['system:foundations'],
        }),
      });
      expect(res.status).toBe(201);
      const perms = await db.rolePermissions.permissionsForRole(
        (await db.roles.getByName('designer'))!.id,
      );
      expect([...perms]).toEqual(['system:foundations']);
    });

    it('deleting a system role → 409', async () => {
      const token = await adminToken();
      const res = await fetch(`${base}/api/roles/admin`, {
        method: 'DELETE',
        headers: bearer(token),
      });
      expect(res.status).toBe(409);
    });

    it('LAST-ADMIN GUARD: editing out the critical perms of the sole admin-granting role → 409', async () => {
      const token = await adminToken();
      // Create a custom admin-granting role and move the only admin into it.
      await fetch(`${base}/api/roles`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ name: 'superadmin', permissions: ['roles:manage', 'team:manage'] }),
      });
      await fetch(`${base}/api/users/${ADMIN_ID}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ role: 'superadmin' }),
      });
      // The admin's old token is now revoked (role change bumped token_version) — re-login.
      const admin2 = (await login.authenticate({ email: 'admin@dealroute.de', password: ADMIN_PW }))
        .accessToken;
      // Editing superadmin's perms to drop the critical keys would lock everyone out → 409.
      const res = await fetch(`${base}/api/roles/superadmin`, {
        method: 'PATCH',
        headers: bearer(admin2),
        body: JSON.stringify({ permissions: ['candidate:read'] }),
      });
      expect(res.status).toBe(409);
    });
  });

  // ── Permissions ──
  describe('permissions', () => {
    it('GET /api/permissions (catalogue) — admin 200, reviewer 403', async () => {
      const adminTok = await adminToken();
      const cat = await fetch(`${base}/api/permissions`, { headers: bearer(adminTok) });
      expect(cat.status).toBe(200);
      const body = (await cat.json()) as { permissions: { key: string; label: string }[] };
      expect(body.permissions.some((p) => p.key === 'roles:manage')).toBe(true);
      // The panel-enforced system:foundations key is catalogued (so the Roles editor can
      // grant it) and carries its co-located label.
      const foundations = body.permissions.find((p) => p.key === 'system:foundations');
      expect(foundations?.label).toBe('Access the panel Foundations / style-guide screen');

      const revTok = await reviewerToken();
      expect((await fetch(`${base}/api/permissions`, { headers: bearer(revTok) })).status).toBe(
        403,
      );
    });

    it('GET /api/permissions/me — any authed user gets their own perms', async () => {
      const token = await reviewerToken();
      const res = await fetch(`${base}/api/permissions/me`, { headers: bearer(token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { permissions: string[]; role: string; email: string };
      expect(body.email).toBe('rita@dealroute.de');
      expect(body.role).toBe('reviewer');
      expect(body.permissions).toContain('candidate:approve');
      expect(body.permissions).not.toContain('roles:manage');
    });

    it('GET /api/permissions/me with NO token → 401', async () => {
      expect((await fetch(`${base}/api/permissions/me`)).status).toBe(401);
    });
  });

  // ── PATCH /api/profile — self-service password change (no team:manage) ──
  describe('PATCH /api/profile self-service password', () => {
    const RITA_ID = '55555555-5555-4555-8555-555555555555';

    it('HEADLINE: a reviewer changes their OWN password (correct current) → 200; old token 401s; new pw logs in', async () => {
      const token = await reviewerToken('rita@dealroute.de', RITA_ID);
      const res = await fetch(`${base}/api/profile`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ currentPassword: REVIEWER_PW, newPassword: 'rita-new-password-9' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { password_changed: boolean }).password_changed).toBe(true);
      // The change bumped token_version, so the OLD access token is now dead.
      const stale = await fetch(`${base}/api/candidates`, { headers: bearer(token) });
      expect(stale.status).toBe(401);
      // Logging in with the NEW password works; the OLD password no longer does.
      await expect(
        login.authenticate({ email: 'rita@dealroute.de', password: 'rita-new-password-9' }),
      ).resolves.toBeTruthy();
      await expect(
        login.authenticate({ email: 'rita@dealroute.de', password: REVIEWER_PW }),
      ).rejects.toBeTruthy();
    });

    it('WRONG current password → 401, password unchanged', async () => {
      const token = await reviewerToken('rita@dealroute.de', RITA_ID);
      const res = await fetch(`${base}/api/profile`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({
          currentPassword: 'not-my-password',
          newPassword: 'rita-new-password-9',
        }),
      });
      expect(res.status).toBe(401);
      // The original password still authenticates (unchanged).
      await expect(
        login.authenticate({ email: 'rita@dealroute.de', password: REVIEWER_PW }),
      ).resolves.toBeTruthy();
    });

    it('newPassword WITHOUT currentPassword → 400 (all-or-nothing)', async () => {
      const token = await reviewerToken('rita@dealroute.de', RITA_ID);
      const res = await fetch(`${base}/api/profile`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ newPassword: 'rita-new-password-9' }),
      });
      expect(res.status).toBe(400);
    });

    it('new password failing the policy → 400', async () => {
      const token = await reviewerToken('rita@dealroute.de', RITA_ID);
      const res = await fetch(`${base}/api/profile`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ currentPassword: REVIEWER_PW, newPassword: 'short' }),
      });
      expect(res.status).toBe(400);
    });

    it('the change is self-keyed by the TOKEN — a body actor/email cannot target another user', async () => {
      // rita sends admin's email as a body `approver`; it is IGNORED — the change applies to
      // rita (the token), never to admin. (There is no :id on /api/profile to target.)
      const token = await reviewerToken('rita@dealroute.de', RITA_ID);
      await adminToken(); // seed admin so we can prove its password is untouched
      const res = await fetch(`${base}/api/profile`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({
          approver: 'admin@dealroute.de',
          currentPassword: REVIEWER_PW,
          newPassword: 'rita-new-password-9',
        }),
      });
      expect(res.status).toBe(200);
      // admin's password is untouched; rita's changed.
      await expect(
        login.authenticate({ email: 'admin@dealroute.de', password: ADMIN_PW }),
      ).resolves.toBeTruthy();
      await expect(
        login.authenticate({ email: 'rita@dealroute.de', password: 'rita-new-password-9' }),
      ).resolves.toBeTruthy();
    });
  });
});
