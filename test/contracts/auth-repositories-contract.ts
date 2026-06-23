import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/application/ports/index.js';
import {
  SYSTEM_ROLE_ADMIN_ID,
  SYSTEM_ROLE_REVIEWER_ID,
  ALL_PERMISSIONS,
  REVIEWER_PERMISSIONS,
  type User,
  type StoredRefresh,
} from '../../src/domain/index.js';

/**
 * Shared contract suite for the Auth/IAM repositories (UserRepository, RoleRepository,
 * RolePermissionRepository, RefreshTokenRepository, AuthMetaRepository). The in-memory
 * adapter and the Postgres adapter both run it, guaranteeing substitutability (LSP). The
 * Postgres run is skipped when no DATABASE_URL_TEST is set.
 *
 * `makeDb` returns the adapter under test (fresh store for in-memory; a shared pool for
 * Postgres, with `reset` truncating between cases). BOTH adapters must arrive with the
 * SAME seeded baseline — the two system roles + their grants (the migration / the
 * InMemoryDb constructor) — which several cases assert directly (a drift guard).
 */
export function authRepositoriesContract(
  name: string,
  makeDb: () => Promise<Database> | Database,
  reset?: () => Promise<void>,
): void {
  function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: randomUUID(),
      name: 'Reviewer Rita',
      email: `rita-${randomUUID()}@dealroute.de`,
      role_id: SYSTEM_ROLE_REVIEWER_ID,
      status: 'active',
      auth_provider: 'password',
      google_sub: null,
      token_version: 0,
      created_at: '2026-06-19T00:00:00.000Z',
      ...overrides,
    };
  }

  function makeRefresh(overrides: Partial<StoredRefresh> = {}): StoredRefresh {
    return {
      id: randomUUID(),
      user_id: randomUUID(),
      token_hash: `hash-${randomUUID()}`,
      family_id: randomUUID(),
      issued_at: '2026-06-19T00:00:00.000Z',
      expires_at: '2026-06-26T00:00:00.000Z',
      revoked_at: null,
      replaced_by: null,
      user_agent: null,
      ip: null,
      ...overrides,
    };
  }

  describe(`Auth repositories contract: ${name}`, () => {
    if (reset) beforeEach(reset);

    // ── Seeded baseline (migration / in-memory ctor) ──
    it('arrives with the two seeded system roles', async () => {
      const db = await makeDb();
      const admin = await db.roles.getByName('admin');
      const reviewer = await db.roles.getByName('reviewer');
      expect(admin?.id).toBe(SYSTEM_ROLE_ADMIN_ID);
      expect(admin?.is_system).toBe(true);
      expect(reviewer?.id).toBe(SYSTEM_ROLE_REVIEWER_ID);
      expect(reviewer?.is_system).toBe(true);
    });

    it('seeds admin → all permissions and reviewer → the least-privilege bundle', async () => {
      const db = await makeDb();
      const adminPerms = await db.rolePermissions.permissionsForRole(SYSTEM_ROLE_ADMIN_ID);
      expect(adminPerms.sort()).toEqual([...ALL_PERMISSIONS].sort());
      const reviewerPerms = await db.rolePermissions.permissionsForRole(SYSTEM_ROLE_REVIEWER_ID);
      expect(reviewerPerms.sort()).toEqual([...REVIEWER_PERMISSIONS].sort());
    });

    // ── UserRepository ──
    it('user: insert → getByEmail / getById round-trip', async () => {
      const db = await makeDb();
      const u = makeUser();
      await db.users.insert(u, 'argon2-hash');
      const byEmail = await db.users.getByEmail(u.email);
      expect(byEmail).toEqual(u);
      const byId = await db.users.getById(u.id);
      expect(byId).toEqual(u);
    });

    it('user: the password hash is NEVER returned on the User entity', async () => {
      const db = await makeDb();
      const u = makeUser();
      await db.users.insert(u, 'super-secret-hash');
      const got = (await db.users.getByEmail(u.email)) as Record<string, unknown>;
      expect('password_hash' in got).toBe(false);
      expect('passwordHash' in got).toBe(false);
      // But the dedicated accessor returns it.
      expect(await db.users.getPasswordHashByEmail(u.email)).toBe('super-secret-hash');
    });

    it('user: getByEmail returns null for an unknown email', async () => {
      const db = await makeDb();
      expect(await db.users.getByEmail('nobody@nowhere.de')).toBeNull();
    });

    it('user: bumpTokenVersion is monotonic', async () => {
      const db = await makeDb();
      const u = makeUser({ token_version: 0 });
      await db.users.insert(u, null);
      expect(await db.users.bumpTokenVersion(u.id)).toBe(1);
      expect(await db.users.bumpTokenVersion(u.id)).toBe(2);
      expect((await db.users.getById(u.id))!.token_version).toBe(2);
    });

    it('user: setStatus / setRole persist', async () => {
      const db = await makeDb();
      const u = makeUser({ status: 'invited' });
      await db.users.insert(u, null);
      await db.users.setStatus(u.id, 'disabled');
      expect((await db.users.getById(u.id))!.status).toBe('disabled');
      await db.users.setRole(u.id, SYSTEM_ROLE_ADMIN_ID);
      expect((await db.users.getById(u.id))!.role_id).toBe(SYSTEM_ROLE_ADMIN_ID);
    });

    it('user: updatePasswordHash replaces the stored hash', async () => {
      const db = await makeDb();
      const u = makeUser();
      await db.users.insert(u, 'old-hash');
      await db.users.updatePasswordHash(u.id, 'new-hash');
      expect(await db.users.getPasswordHashByEmail(u.email)).toBe('new-hash');
    });

    it('user: failed-login counters round-trip; recordLogin resets them', async () => {
      const db = await makeDb();
      const u = makeUser();
      await db.users.insert(u, 'h');
      expect(await db.users.recordFailedLogin(u.id, '2026-06-19T00:01:00.000Z')).toBe(1);
      expect(await db.users.recordFailedLogin(u.id, '2026-06-19T00:02:00.000Z')).toBe(2);
      await db.users.setLockedUntil(u.id, '2026-06-19T00:30:00.000Z');
      let state = await db.users.getLoginState(u.id);
      expect(state).toEqual({ failedLoginCount: 2, lockedUntil: '2026-06-19T00:30:00.000Z' });
      await db.users.recordLogin(u.id, '2026-06-19T01:00:00.000Z');
      state = await db.users.getLoginState(u.id);
      expect(state).toEqual({ failedLoginCount: 0, lockedUntil: null });
    });

    it('user: list returns inserted users (name-ordered) without hashes', async () => {
      const db = await makeDb();
      await db.users.insert(makeUser({ name: 'Zara', email: `z-${randomUUID()}@d.de` }), 'h1');
      await db.users.insert(makeUser({ name: 'Aaron', email: `a-${randomUUID()}@d.de` }), 'h2');
      const list = await db.users.list();
      const names = list.map((u) => u.name);
      expect(names.indexOf('Aaron')).toBeLessThan(names.indexOf('Zara'));
      for (const u of list) expect('password_hash' in (u as Record<string, unknown>)).toBe(false);
    });

    // ── RoleRepository ──
    it('role: insert, getById/getByName, list, countUsers, delete', async () => {
      const db = await makeDb();
      const role = {
        id: randomUUID(),
        name: `editor-${randomUUID()}`,
        description: 'd',
        is_system: false,
      };
      await db.roles.insert(role);
      expect(await db.roles.getById(role.id)).toEqual(role);
      expect(await db.roles.getByName(role.name)).toEqual(role);
      expect(await db.roles.countUsers(role.id)).toBe(0);
      // update() replaces the mutable fields (name + description) by id.
      const renamed = { ...role, name: `${role.name}-v2`, description: 'updated' };
      await db.roles.update(renamed);
      expect(await db.roles.getById(role.id)).toEqual(renamed);
      // update() on an unknown id is a silent no-op (a 0-row UPDATE), not an error.
      await db.roles.update({ ...renamed, id: randomUUID() });
      expect(await db.roles.getById(role.id)).toEqual(renamed);

      // Defense-in-depth: a SYSTEM role keeps its name — update() can edit its description
      // but never RENAME it (both adapters enforce this regardless of the use-case guard).
      const admin = await db.roles.getByName('admin');
      expect(admin).not.toBeNull();
      await db.roles.update({ ...admin!, name: 'hijacked', description: 'desc edit' });
      const adminAfter = await db.roles.getByName('admin');
      expect(adminAfter?.name).toBe('admin'); // rename refused
      expect(adminAfter?.description).toBe('desc edit'); // description edit applied
      expect(await db.roles.getByName('hijacked')).toBeNull();
      // Assign a user to it → countUsers reflects the role-FK.
      const u = makeUser({ role_id: role.id });
      await db.users.insert(u, null);
      expect(await db.roles.countUsers(role.id)).toBe(1);
      // Delete is only safe when no users hold it (the use-case guards that) — here we
      // just verify the mechanism on an empty role.
      const empty = {
        id: randomUUID(),
        name: `tmp-${randomUUID()}`,
        description: '',
        is_system: false,
      };
      await db.roles.insert(empty);
      await db.roles.delete(empty.id);
      expect(await db.roles.getById(empty.id)).toBeNull();
    });

    // ── RolePermissionRepository ──
    it('rolePermissions: setForRole is a replace-set', async () => {
      const db = await makeDb();
      const role = {
        id: randomUUID(),
        name: `r-${randomUUID()}`,
        description: '',
        is_system: false,
      };
      await db.roles.insert(role);
      await db.rolePermissions.setForRole(role.id, ['candidate:read', 'candidate:approve']);
      expect((await db.rolePermissions.permissionsForRole(role.id)).sort()).toEqual([
        'candidate:approve',
        'candidate:read',
      ]);
      // Replace (not merge): the old set is gone.
      await db.rolePermissions.setForRole(role.id, ['settings:write']);
      expect(await db.rolePermissions.permissionsForRole(role.id)).toEqual(['settings:write']);
      // Empty set clears.
      await db.rolePermissions.setForRole(role.id, []);
      expect(await db.rolePermissions.permissionsForRole(role.id)).toEqual([]);
    });

    it('rolePermissions: list includes every grant across roles', async () => {
      const db = await makeDb();
      const grants = await db.rolePermissions.list();
      const adminGrants = grants.filter((g) => g.roleId === SYSTEM_ROLE_ADMIN_ID);
      expect(adminGrants.length).toBe(ALL_PERMISSIONS.length);
    });

    // ── RefreshTokenRepository ──
    // A refresh token belongs to a real user (Postgres enforces the user_id FK), so each
    // refresh case provisions a backing user first — keeping the suite LSP-valid on BOTH
    // adapters (the in-memory one doesn't enforce FKs, but the realistic shape matters).
    async function makeOwner(db: Database): Promise<string> {
      const u = makeUser();
      await db.users.insert(u, null);
      return u.id;
    }

    it('refresh: issue → findByHash round-trip', async () => {
      const db = await makeDb();
      const t = makeRefresh({ user_id: await makeOwner(db) });
      await db.refreshTokens.issue(t);
      expect(await db.refreshTokens.findByHash(t.token_hash)).toEqual(t);
      expect(await db.refreshTokens.findByHash('no-such-hash')).toBeNull();
    });

    it('refresh: rotate stamps revoked_at + replaced_by on the old row and keeps family_id', async () => {
      const db = await makeDb();
      const familyId = randomUUID();
      const userId = await makeOwner(db);
      const old = makeRefresh({ family_id: familyId, user_id: userId });
      await db.refreshTokens.issue(old);
      const next = makeRefresh({
        family_id: familyId,
        user_id: userId,
        issued_at: '2026-06-20T00:00:00.000Z',
        expires_at: '2026-06-27T00:00:00.000Z',
      });
      await db.refreshTokens.rotate(old.id, next);
      const rotatedOld = await db.refreshTokens.findByHash(old.token_hash);
      expect(rotatedOld!.revoked_at).not.toBeNull();
      expect(rotatedOld!.replaced_by).toBe(next.id);
      expect(rotatedOld!.family_id).toBe(familyId);
      const successor = await db.refreshTokens.findByHash(next.token_hash);
      expect(successor!.family_id).toBe(familyId);
      expect(successor!.revoked_at).toBeNull();
    });

    it('refresh: revokeFamily revokes every open row in the family only', async () => {
      const db = await makeDb();
      const userId = await makeOwner(db);
      const famA = randomUUID();
      const famB = randomUUID();
      const a1 = makeRefresh({ family_id: famA, user_id: userId });
      const a2 = makeRefresh({ family_id: famA, user_id: userId });
      const b1 = makeRefresh({ family_id: famB, user_id: userId });
      await db.refreshTokens.issue(a1);
      await db.refreshTokens.issue(a2);
      await db.refreshTokens.issue(b1);
      const n = await db.refreshTokens.revokeFamily(famA, '2026-06-21T00:00:00.000Z');
      expect(n).toBe(2);
      expect((await db.refreshTokens.findByHash(a1.token_hash))!.revoked_at).not.toBeNull();
      expect((await db.refreshTokens.findByHash(a2.token_hash))!.revoked_at).not.toBeNull();
      expect((await db.refreshTokens.findByHash(b1.token_hash))!.revoked_at).toBeNull();
    });

    it('refresh: revokeAllForUser revokes every open row for that user only', async () => {
      const db = await makeDb();
      const userA = await makeOwner(db);
      const userB = await makeOwner(db);
      await db.refreshTokens.issue(makeRefresh({ user_id: userA }));
      await db.refreshTokens.issue(makeRefresh({ user_id: userA }));
      const bTok = makeRefresh({ user_id: userB });
      await db.refreshTokens.issue(bTok);
      expect(await db.refreshTokens.revokeAllForUser(userA, '2026-06-21T00:00:00.000Z')).toBe(2);
      expect((await db.refreshTokens.findByHash(bTok.token_hash))!.revoked_at).toBeNull();
    });

    it('refresh: deleteExpired removes only rows past expires_at as of now', async () => {
      const db = await makeDb();
      const userId = await makeOwner(db);
      const expired = makeRefresh({ user_id: userId, expires_at: '2026-06-18T00:00:00.000Z' });
      const live = makeRefresh({ user_id: userId, expires_at: '2026-07-01T00:00:00.000Z' });
      await db.refreshTokens.issue(expired);
      await db.refreshTokens.issue(live);
      const n = await db.refreshTokens.deleteExpired(new Date('2026-06-19T00:00:00.000Z'));
      expect(n).toBe(1);
      expect(await db.refreshTokens.findByHash(expired.token_hash)).toBeNull();
      expect(await db.refreshTokens.findByHash(live.token_hash)).not.toBeNull();
    });

    // ── AuthMetaRepository ──
    it('authMeta: perm_version starts at 0 and bumps monotonically', async () => {
      const db = await makeDb();
      expect(await db.authMeta.getPermVersion()).toBe(0);
      expect(await db.authMeta.bumpPermVersion()).toBe(1);
      expect(await db.authMeta.bumpPermVersion()).toBe(2);
      expect(await db.authMeta.getPermVersion()).toBe(2);
    });
  });
}
