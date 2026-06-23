import { describe, it, expect, beforeEach } from 'vitest';
import { ManageRolesUseCase } from './manage-roles.js';
import { InMemoryDb } from '../../adapters/db/in-memory/in-memory-db.js';
import {
  InvalidPatchError,
  InvalidCredentialsError,
  RoleNotFoundError,
  RoleInUseError,
  UserNotFoundError,
  LastAdminError,
  SYSTEM_ROLE_ADMIN_ID,
  SYSTEM_ROLE_REVIEWER_ID,
  type User,
} from '../../domain/index.js';
import { FakePasswordHasher, FakeLogger, FixedClock } from '../../../test/fakes/fakes.js';

const POLICY = { minLength: 12 };
const ACTOR = 'admin@dealroute.test';

// Stable UUIDs so assertions can reference users by a readable handle (UserSchema.id is a uuid).
const ID = {
  admin1: '10000000-0000-4000-8000-000000000001',
  admin2: '10000000-0000-4000-8000-000000000002',
  u1: '20000000-0000-4000-8000-000000000001',
  u2: '20000000-0000-4000-8000-000000000002',
  u3: '20000000-0000-4000-8000-000000000003',
  u4: '20000000-0000-4000-8000-000000000004',
  u5: '20000000-0000-4000-8000-000000000005',
  uAud: '20000000-0000-4000-8000-0000000000a0',
} as const;

function makeUser(over: Partial<User> & Pick<User, 'id' | 'email' | 'role_id'>): User {
  return {
    name: 'User',
    status: 'active',
    auth_provider: 'password',
    google_sub: null,
    token_version: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

describe('ManageRolesUseCase', () => {
  let db: InMemoryDb;
  let hasher: FakePasswordHasher;
  let useCase: ManageRolesUseCase;

  beforeEach(async () => {
    db = new InMemoryDb();
    hasher = new FakePasswordHasher();
    useCase = new ManageRolesUseCase(db, hasher, new FixedClock(), new FakeLogger(), POLICY);
    // Two admins by default so the last-admin guard isn't tripped incidentally.
    await db.users.insert(
      makeUser({ id: ID.admin1, email: 'admin1@x.test', role_id: SYSTEM_ROLE_ADMIN_ID }),
      await hasher.hash('admin1-password'),
    );
  });

  // ── createRole ──
  describe('createRole', () => {
    it('creates a custom role + grants and bumps perm_version', async () => {
      const before = await db.authMeta.getPermVersion();
      const role = await useCase.createRole({
        actor: ACTOR,
        name: 'auditor',
        description: 'read only',
        permissions: ['candidate:read', 'sources:read'],
      });
      expect(role.name).toBe('auditor');
      expect(role.is_system).toBe(false);
      expect(role.permissions.sort()).toEqual(['candidate:read', 'sources:read']);
      expect(await db.authMeta.getPermVersion()).toBe(before + 1);
    });

    it('rejects an unknown permission key (no silent un-gated grant)', async () => {
      await expect(
        useCase.createRole({
          actor: ACTOR,
          name: 'x',
          permissions: ['candidate:read', 'bogus:key'],
        }),
      ).rejects.toBeInstanceOf(InvalidPatchError);
    });

    it('rejects a duplicate role name', async () => {
      await expect(
        useCase.createRole({ actor: ACTOR, name: 'admin', permissions: [] }),
      ).rejects.toBeInstanceOf(RoleInUseError);
    });
  });

  // ── updateRole ──
  describe('updateRole', () => {
    it('replaces a custom role’s permission set and bumps perm_version', async () => {
      await useCase.createRole({ actor: ACTOR, name: 'auditor', permissions: ['candidate:read'] });
      const before = await db.authMeta.getPermVersion();
      const view = await useCase.updateRole({
        actor: ACTOR,
        roleName: 'auditor',
        permissions: ['candidate:read', 'team:read'],
      });
      expect(view.permissions.sort()).toEqual(['candidate:read', 'team:read']);
      expect(await db.authMeta.getPermVersion()).toBe(before + 1);
    });

    it('edits a system role’s description but REFUSES its permission set', async () => {
      // description-only edit on a system role is allowed
      const view = await useCase.updateRole({
        actor: ACTOR,
        roleName: 'admin',
        description: 'the boss',
      });
      expect(view.description).toBe('the boss');
      // a permission-set edit on a system role is blocked
      await expect(
        useCase.updateRole({ actor: ACTOR, roleName: 'admin', permissions: ['candidate:read'] }),
      ).rejects.toBeInstanceOf(RoleInUseError);
    });

    it('404s an unknown role', async () => {
      await expect(
        useCase.updateRole({ actor: ACTOR, roleName: 'ghost', description: 'x' }),
      ).rejects.toBeInstanceOf(RoleNotFoundError);
    });

    it('LAST-ADMIN GUARD: editing out the critical perms of the ONLY admin-granting role → 409', async () => {
      // Move all administration into a CUSTOM role that grants the critical perms (so the
      // seeded `admin` role is no longer the only protector), leaving NO admin role behind.
      await useCase.createRole({
        actor: ACTOR,
        name: 'superadmin',
        permissions: ['roles:manage', 'team:manage', 'candidate:read'],
      });
      await useCase.assignRoleToUser({ actor: ACTOR, userId: ID.admin1, roleName: 'superadmin' });
      // Now editing superadmin's perms to drop the critical keys would lock everyone out.
      await expect(
        useCase.updateRole({
          actor: ACTOR,
          roleName: 'superadmin',
          permissions: ['candidate:read'],
        }),
      ).rejects.toBeInstanceOf(LastAdminError);
      // The grant set is unchanged (the edit was refused before setForRole).
      const view = await useCase.listRoles();
      const superadmin = view.find((r) => r.name === 'superadmin');
      expect(superadmin?.permissions).toContain('roles:manage');
    });

    it('allows editing out a role’s critical perms when ANOTHER active role still grants them', async () => {
      // admin1 stays in the seeded `admin` role (which grants the critical perms), so a
      // custom role losing them is safe.
      await useCase.createRole({
        actor: ACTOR,
        name: 'helper',
        permissions: ['team:manage', 'candidate:read'],
      });
      await db.users.insert(
        makeUser({
          id: ID.u2,
          email: 'helper@x.test',
          role_id: (await db.roles.getByName('helper'))!.id,
        }),
        null,
      );
      // admin1 (role admin) still holds team:manage ⇒ editing it out of helper is allowed.
      const view = await useCase.updateRole({
        actor: ACTOR,
        roleName: 'helper',
        permissions: ['candidate:read'],
      });
      expect(view.permissions).toEqual(['candidate:read']);
    });
  });

  // ── deleteRole ──
  describe('deleteRole', () => {
    it('deletes an empty custom role and bumps perm_version', async () => {
      await useCase.createRole({ actor: ACTOR, name: 'auditor', permissions: ['candidate:read'] });
      const before = await db.authMeta.getPermVersion();
      await useCase.deleteRole({ actor: ACTOR, roleName: 'auditor' });
      expect(await db.roles.getByName('auditor')).toBeNull();
      expect(await db.authMeta.getPermVersion()).toBe(before + 1);
    });

    it('refuses to delete a built-in system role (409)', async () => {
      await expect(useCase.deleteRole({ actor: ACTOR, roleName: 'admin' })).rejects.toBeInstanceOf(
        RoleInUseError,
      );
    });

    it('refuses to delete a role still assigned to a user (409)', async () => {
      await useCase.createRole({ actor: ACTOR, name: 'auditor', permissions: ['candidate:read'] });
      const auditor = await db.roles.getByName('auditor');
      await db.users.insert(
        makeUser({ id: ID.uAud, email: 'aud@x.test', role_id: auditor!.id }),
        null,
      );
      await expect(
        useCase.deleteRole({ actor: ACTOR, roleName: 'auditor' }),
      ).rejects.toBeInstanceOf(RoleInUseError);
    });
  });

  // ── assignRoleToUser ──
  describe('assignRoleToUser', () => {
    it('reassigns a user and bumps their token_version', async () => {
      await db.users.insert(
        makeUser({ id: ID.u1, email: 'rev@x.test', role_id: SYSTEM_ROLE_REVIEWER_ID }),
        null,
      );
      await useCase.createRole({ actor: ACTOR, name: 'auditor', permissions: ['candidate:read'] });
      const auditor = await db.roles.getByName('auditor');
      await useCase.assignRoleToUser({ actor: ACTOR, userId: ID.u1, roleName: 'auditor' });
      const after = await db.users.getById(ID.u1);
      expect(after!.role_id).toBe(auditor!.id);
      expect(after!.token_version).toBe(1);
    });

    it('404s an unknown user / unknown role', async () => {
      await expect(
        useCase.assignRoleToUser({ actor: ACTOR, userId: 'ghost', roleName: 'reviewer' }),
      ).rejects.toBeInstanceOf(UserNotFoundError);
      await db.users.insert(
        makeUser({ id: ID.u2, email: 'b@x.test', role_id: SYSTEM_ROLE_REVIEWER_ID }),
        null,
      );
      await expect(
        useCase.assignRoleToUser({ actor: ACTOR, userId: ID.u2, roleName: 'ghost' }),
      ).rejects.toBeInstanceOf(RoleNotFoundError);
    });

    it('LAST-ADMIN GUARD: refuses to demote the only admin', async () => {
      // Only admin-1 holds roles:manage/team:manage; demoting to reviewer would empty both.
      await expect(
        useCase.assignRoleToUser({ actor: ACTOR, userId: ID.admin1, roleName: 'reviewer' }),
      ).rejects.toBeInstanceOf(LastAdminError);
      // unchanged
      expect((await db.users.getById(ID.admin1))!.role_id).toBe(SYSTEM_ROLE_ADMIN_ID);
      expect((await db.users.getById(ID.admin1))!.token_version).toBe(0);
    });

    it('allows demoting an admin when ANOTHER admin remains', async () => {
      await db.users.insert(
        makeUser({ id: ID.admin2, email: 'admin2@x.test', role_id: SYSTEM_ROLE_ADMIN_ID }),
        null,
      );
      await useCase.assignRoleToUser({ actor: ACTOR, userId: ID.admin1, roleName: 'reviewer' });
      expect((await db.users.getById(ID.admin1))!.role_id).toBe(SYSTEM_ROLE_REVIEWER_ID);
    });
  });

  // ── setUserStatus ──
  describe('setUserStatus', () => {
    it('disables a user: bumps token_version and revokes refresh tokens', async () => {
      await db.users.insert(
        makeUser({ id: ID.u3, email: 'rev3@x.test', role_id: SYSTEM_ROLE_REVIEWER_ID }),
        null,
      );
      await db.refreshTokens.issue({
        id: 'rt-1',
        user_id: ID.u3,
        token_hash: 'h',
        family_id: 'f-1',
        issued_at: '2026-06-19T00:00:00.000Z',
        expires_at: '2026-07-19T00:00:00.000Z',
        revoked_at: null,
        replaced_by: null,
        user_agent: null,
        ip: null,
      });
      await useCase.setUserStatus({ actor: ACTOR, userId: ID.u3, status: 'disabled' });
      const after = await db.users.getById(ID.u3);
      expect(after!.status).toBe('disabled');
      expect(after!.token_version).toBe(1);
      expect((await db.refreshTokens.findByHash('h'))!.revoked_at).not.toBeNull();
    });

    it('LAST-ADMIN GUARD: refuses to disable the only admin', async () => {
      await expect(
        useCase.setUserStatus({ actor: ACTOR, userId: ID.admin1, status: 'disabled' }),
      ).rejects.toBeInstanceOf(LastAdminError);
      expect((await db.users.getById(ID.admin1))!.status).toBe('active');
    });

    it('allows disabling an admin when another admin is active', async () => {
      await db.users.insert(
        makeUser({ id: ID.admin2, email: 'admin2@x.test', role_id: SYSTEM_ROLE_ADMIN_ID }),
        null,
      );
      await useCase.setUserStatus({ actor: ACTOR, userId: ID.admin1, status: 'disabled' });
      expect((await db.users.getById(ID.admin1))!.status).toBe('disabled');
    });

    it('does NOT count a DISABLED second admin as a holder (still last active admin)', async () => {
      await db.users.insert(
        makeUser({
          id: ID.admin2,
          email: 'admin2@x.test',
          role_id: SYSTEM_ROLE_ADMIN_ID,
          status: 'disabled',
        }),
        null,
      );
      await expect(
        useCase.setUserStatus({ actor: ACTOR, userId: ID.admin1, status: 'disabled' }),
      ).rejects.toBeInstanceOf(LastAdminError);
    });
  });

  // ── changePassword ──
  describe('changePassword', () => {
    it('re-hashes and bumps token_version', async () => {
      await db.users.insert(
        makeUser({ id: ID.u4, email: 'rev4@x.test', role_id: SYSTEM_ROLE_REVIEWER_ID }),
        await hasher.hash('old-password-1'),
      );
      await useCase.changePassword({
        actor: ACTOR,
        userId: ID.u4,
        newPassword: 'new-password-123',
      });
      const hash = await db.users.getPasswordHashByEmail('rev4@x.test');
      expect(await hasher.verify(hash!, 'new-password-123')).toBe(true);
      expect((await db.users.getById(ID.u4))!.token_version).toBe(1);
    });

    it('rejects a too-short password', async () => {
      await db.users.insert(
        makeUser({ id: ID.u5, email: 'rev5@x.test', role_id: SYSTEM_ROLE_REVIEWER_ID }),
        null,
      );
      await expect(
        useCase.changePassword({ actor: ACTOR, userId: ID.u5, newPassword: 'short' }),
      ).rejects.toBeInstanceOf(InvalidPatchError);
    });
  });

  // ── changeOwnPassword (self-service) ──
  describe('changeOwnPassword', () => {
    beforeEach(async () => {
      await db.users.insert(
        makeUser({ id: ID.u4, email: 'self@x.test', role_id: SYSTEM_ROLE_REVIEWER_ID }),
        await hasher.hash('current-password-1'),
      );
    });

    it('changes the password with the CORRECT current password + bumps token_version', async () => {
      await useCase.changeOwnPassword({
        actor: 'self@x.test',
        currentPassword: 'current-password-1',
        newPassword: 'new-password-456',
      });
      const hash = await db.users.getPasswordHashByEmail('self@x.test');
      expect(await hasher.verify(hash!, 'new-password-456')).toBe(true);
      expect((await db.users.getById(ID.u4))!.token_version).toBe(1); // logs out other sessions
    });

    it('WRONG current password → 401 (InvalidCredentialsError), password unchanged', async () => {
      await expect(
        useCase.changeOwnPassword({
          actor: 'self@x.test',
          currentPassword: 'wrong-password',
          newPassword: 'new-password-456',
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
      const hash = await db.users.getPasswordHashByEmail('self@x.test');
      expect(await hasher.verify(hash!, 'current-password-1')).toBe(true); // unchanged
      expect((await db.users.getById(ID.u4))!.token_version).toBe(0); // not bumped
    });

    it('a NEW password failing the policy → 400 (after the current-password check)', async () => {
      await expect(
        useCase.changeOwnPassword({
          actor: 'self@x.test',
          currentPassword: 'current-password-1',
          newPassword: 'short',
        }),
      ).rejects.toBeInstanceOf(InvalidPatchError);
    });

    it('an unknown actor → 401 (constant-time; no user-enumeration leak)', async () => {
      await expect(
        useCase.changeOwnPassword({
          actor: 'ghost@x.test',
          currentPassword: 'anything',
          newPassword: 'new-password-456',
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });
  });

  // ── updateUser (multi-field, atomic-ish) ──
  describe('updateUser', () => {
    it('applies role + status + password together and single-bumps token_version', async () => {
      await db.users.insert(
        makeUser({ id: ID.u4, email: 'multi@x.test', role_id: SYSTEM_ROLE_REVIEWER_ID }),
        await hasher.hash('old-password-1'),
      );
      await db.users.insert(
        makeUser({ id: ID.admin2, email: 'admin2@x.test', role_id: SYSTEM_ROLE_ADMIN_ID }),
        null,
      );
      await useCase.updateUser({
        actor: ACTOR,
        userId: ID.u4,
        role: 'admin',
        password: 'new-password-123',
      });
      const after = await db.users.getById(ID.u4);
      expect(after!.role_id).toBe(SYSTEM_ROLE_ADMIN_ID);
      expect(after!.token_version).toBe(1); // ONE bump for the whole patch
      const hash = await db.users.getPasswordHashByEmail('multi@x.test');
      expect(await hasher.verify(hash!, 'new-password-123')).toBe(true);
    });

    it('PARTIAL-APPLY GUARD: a status change + an invalid password applies NOTHING', async () => {
      await db.users.insert(
        makeUser({ id: ID.u5, email: 'partial@x.test', role_id: SYSTEM_ROLE_REVIEWER_ID }),
        await hasher.hash('old-password-1'),
      );
      await db.refreshTokens.issue({
        id: 'rt-partial',
        user_id: ID.u5,
        token_hash: 'hp',
        family_id: 'f',
        issued_at: '2026-06-19T00:00:00.000Z',
        expires_at: '2026-07-19T00:00:00.000Z',
        revoked_at: null,
        replaced_by: null,
        user_agent: null,
        ip: null,
      });
      await expect(
        useCase.updateUser({ actor: ACTOR, userId: ID.u5, status: 'disabled', password: 'short' }),
      ).rejects.toBeInstanceOf(InvalidPatchError);
      // Nothing applied: still active, token_version untouched, refresh NOT revoked, pw intact.
      const after = await db.users.getById(ID.u5);
      expect(after!.status).toBe('active');
      expect(after!.token_version).toBe(0);
      expect((await db.refreshTokens.findByHash('hp'))!.revoked_at).toBeNull();
      expect(
        await hasher.verify(
          (await db.users.getPasswordHashByEmail('partial@x.test'))!,
          'old-password-1',
        ),
      ).toBe(true);
    });

    it('a role-not-found in a combined patch rejects before any write', async () => {
      await db.users.insert(
        makeUser({ id: ID.u1, email: 'rnf@x.test', role_id: SYSTEM_ROLE_REVIEWER_ID }),
        null,
      );
      await expect(
        useCase.updateUser({ actor: ACTOR, userId: ID.u1, role: 'ghost', status: 'disabled' }),
      ).rejects.toBeInstanceOf(RoleNotFoundError);
      expect((await db.users.getById(ID.u1))!.status).toBe('active');
    });
  });

  // ── listRoles / listUsers ──
  it('listRoles returns system roles with their resolved permissions', async () => {
    const roles = await useCase.listRoles();
    const admin = roles.find((r) => r.name === 'admin');
    expect(admin?.is_system).toBe(true);
    expect(admin?.permissions).toContain('roles:manage');
  });

  it('listUsers projects role NAME + omits the hash', async () => {
    const users = await useCase.listUsers();
    const admin = users.find((u) => u.email === 'admin1@x.test');
    expect(admin?.role).toBe('admin');
    expect(admin).not.toHaveProperty('password_hash');
  });
});
