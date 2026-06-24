import {
  RoleSchema,
  Permission,
  permissionsForRole,
  validatePasswordPolicy,
  wouldRemoveLastHolder,
  wouldRoleEditRemoveLastHolder,
  CRITICAL_ADMIN_PERMISSIONS,
  DUMMY_PASSWORD_HASH,
  InvalidPatchError,
  InvalidCredentialsError,
  RoleNotFoundError,
  RoleInUseError,
  UserNotFoundError,
  LastAdminError,
  type Role,
  type User,
  type Permission as PermissionKey,
  type PasswordPolicy,
  type ActiveUserPermissions,
  type ActiveUserRole,
  type RolePermissionGrant,
} from '../../domain/index.js';
import type { Database, PasswordHasher, Clock, Logger } from '../ports/index.js';
import { randomUUID } from 'node:crypto';

/** A role with its resolved permission keys — the shape the `/api/roles` screen renders. */
export interface RoleView {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  permissions: PermissionKey[];
}

/** A user as the admin Users screen sees it (no hash; role NAME, not id; derived count). */
export interface UserView {
  id: string;
  name: string;
  email: string;
  role: string;
  status: User['status'];
  review_count: number;
}

/**
 * `ManageRolesUseCase` (Auth/IAM, Phase 3) — the runtime-editable RBAC + user-admin
 * surface. Every method takes a TOKEN-DERIVED `actor` (audit only; never a body value).
 *
 * Trust invariants enforced here (unit-tested):
 * - ANY `role_permissions` mutation (create / update-permissions / delete a role) bumps
 *   the GLOBAL `perm_version`, so a permission change is honoured before a live token
 *   expires (the per-request guard re-resolves on a mismatch).
 * - Any change to a user's effective permissions / login ability (role reassignment,
 *   disable, password reset) bumps THAT user's `token_version` (immediate revoke), and a
 *   disable also revokes the user's refresh tokens.
 * - A built-in `is_system` role can't be renamed, re-scoped, or deleted (so `admin` always
 *   means "all permissions").
 * - LAST-ADMIN LOCKOUT GUARD: you can never disable or demote the last active holder of a
 *   {@link CRITICAL_ADMIN_PERMISSIONS} key — that would lock the org out of its own IAM.
 */
export class ManageRolesUseCase {
  constructor(
    private readonly db: Database,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly passwordPolicy: PasswordPolicy,
  ) {}

  // ── Roles ──────────────────────────────────────────────────────────────────

  /** Every role + its resolved permission set (the panel role editor / `GET /api/roles`). */
  async listRoles(): Promise<RoleView[]> {
    const [roles, grants] = await Promise.all([
      this.db.roles.list(),
      this.db.rolePermissions.list(),
    ]);
    const grantRows: RolePermissionGrant[] = grants.map((g) => ({
      role_id: g.roleId,
      permission_key: g.permissionKey,
    }));
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      is_system: r.is_system,
      permissions: [...permissionsForRole(r.id, grantRows)].sort(),
    }));
  }

  /**
   * Create a custom role with a permission set. Validates every key against the closed
   * `Permission` enum (a bad key ⇒ 400, never a silent un-gated grant), refuses a
   * duplicate name, then inserts the role + its grants and BUMPS `perm_version`.
   */
  async createRole(input: {
    actor: string;
    name: string;
    description?: string;
    permissions: string[];
  }): Promise<RoleView> {
    const name = input.name.trim();
    if (name === '') throw new InvalidPatchError('role name is required', ['name']);
    const permissions = this.validatePermissionKeys(input.permissions);

    if ((await this.db.roles.getByName(name)) !== null) {
      throw new RoleInUseError(name, 'a role with that name already exists');
    }
    const role: Role = RoleSchema.parse({
      id: randomUUID(),
      name,
      description: input.description?.trim() ?? '',
      is_system: false,
    });
    await this.db.roles.insert(role);
    await this.db.rolePermissions.setForRole(role.id, permissions);
    await this.db.authMeta.bumpPermVersion();
    this.logger.info('role created', { actor: input.actor, role: name, permissions });
    return { ...role, permissions: [...permissions].sort() };
  }

  /**
   * Update a role's description and/or permission set (by NAME). A `is_system` role's
   * PERMISSION SET is immutable (so `admin` stays "all"); its description may still be
   * edited. Any permission-set change BUMPS `perm_version`.
   */
  async updateRole(input: {
    actor: string;
    roleName: string;
    description?: string;
    permissions?: string[];
  }): Promise<RoleView> {
    const role = await this.db.roles.getByName(input.roleName.trim());
    if (role === null) throw new RoleNotFoundError(input.roleName);

    if (input.permissions !== undefined && role.is_system) {
      throw new RoleInUseError(role.name, 'a built-in system role’s permissions cannot be changed');
    }

    // Apply the description change (allowed even for system roles).
    if (input.description !== undefined) {
      await this.db.roles.update({ ...role, description: input.description.trim() });
    }

    let permsBumped = false;
    if (input.permissions !== undefined) {
      const permissions = this.validatePermissionKeys(input.permissions);
      // Last-admin guard, THIRD lever: a permission-set edit strips a permission from EVERY
      // active user in this role at once. For each critical permission the role is LOSING,
      // refuse if no active user OUTSIDE this role would still hold it (custom roles may
      // grant the critical perms, so the seeded `admin` role isn't the only protection).
      await this.assertRoleEditNotLastAdmin(role.id, new Set(permissions));
      await this.db.rolePermissions.setForRole(role.id, permissions);
      await this.db.authMeta.bumpPermVersion();
      permsBumped = true;
    }
    this.logger.info('role updated', {
      actor: input.actor,
      role: role.name,
      permissions_changed: permsBumped,
    });
    return this.roleView(role.id);
  }

  /**
   * Delete a custom role. Refuses a built-in `is_system` role and a role still assigned to
   * any user (both ⇒ 409). On success removes the role + its grants and BUMPS `perm_version`.
   */
  async deleteRole(input: { actor: string; roleName: string }): Promise<void> {
    const role = await this.db.roles.getByName(input.roleName.trim());
    if (role === null) throw new RoleNotFoundError(input.roleName);
    if (role.is_system) {
      throw new RoleInUseError(role.name, 'a built-in system role cannot be deleted');
    }
    const userCount = await this.db.roles.countUsers(role.id);
    if (userCount > 0) {
      throw new RoleInUseError(role.name, `still assigned to ${userCount} user(s)`);
    }
    await this.db.rolePermissions.setForRole(role.id, []); // clear grants (FK hygiene)
    await this.db.roles.delete(role.id);
    await this.db.authMeta.bumpPermVersion();
    this.logger.info('role deleted', { actor: input.actor, role: role.name });
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  /** Every user (no hash; role NAME; review_count derived from the reviews log). */
  async listUsers(): Promise<UserView[]> {
    const [users, roles, counts] = await Promise.all([
      this.db.users.list(),
      this.db.roles.list(),
      this.db.reviews.countByApprover(),
    ]);
    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: roleName.get(u.role_id) ?? '',
      status: u.status,
      review_count: counts.get(u.email) ?? 0,
    }));
  }

  /**
   * Apply a multi-field admin user patch (role / status / password) ATOMICALLY-ish: validate
   * EVERYTHING up front (user + role exist, password meets policy, the last-admin guard for
   * the combined end-state) BEFORE any write, so a later invalid field can never leave an
   * earlier one half-applied (there's no DB transaction across these repo calls, and a
   * role/status change has side-effects — token_version bump + refresh revoke — that must
   * not fire for a patch that ends up rejected). The `name` field is handled by the caller
   * (the self-or-admin profile path) AFTER this returns the (re-loaded) target. Returns the
   * target user so the caller can resolve its email for the name edit.
   */
  async updateUser(input: {
    actor: string;
    userId: string;
    role?: string;
    status?: 'active' | 'disabled';
    password?: string;
  }): Promise<User> {
    const user = await this.requireUser(input.userId);

    // ── Pre-flight validation (no writes yet) ──
    const role = input.role !== undefined ? await this.requireRole(input.role) : null;
    if (input.password !== undefined) {
      const policy = validatePasswordPolicy(input.password, this.passwordPolicy);
      if (!policy.ok) throw new InvalidPatchError(policy.reason, ['password']);
    }
    // The last-admin guard reasons over the COMBINED end-state of this patch (a disable wins
    // over a role change for "still active"; otherwise the new role's perms apply).
    if (input.status === 'disabled') {
      await this.assertNotLastAdmin(user.id, { stillActive: false, withPerms: new Set() });
    } else if (role !== null && role.id !== user.role_id) {
      const newPerms = new Set(await this.db.rolePermissions.permissionsForRole(role.id));
      await this.assertNotLastAdmin(user.id, { stillActive: true, withPerms: newPerms });
    }

    // ── Apply (all inputs already validated) ──
    let touched = false;
    if (role !== null && role.id !== user.role_id) {
      await this.db.users.setRole(user.id, role.id);
      touched = true;
    }
    if (input.status !== undefined && input.status !== user.status) {
      await this.db.users.setStatus(user.id, input.status);
      if (input.status === 'disabled') {
        await this.db.refreshTokens.revokeAllForUser(user.id, this.clock.nowIso());
      }
      touched = true;
    }
    if (input.password !== undefined) {
      await this.db.users.updatePasswordHash(user.id, await this.hasher.hash(input.password));
      touched = true;
    }
    // A single token_version bump covers all of role/status/password (their perms or login
    // ability changed ⇒ any live token must re-mint) — never bumped on a no-op patch.
    if (touched) await this.db.users.bumpTokenVersion(user.id);
    this.logger.info('user updated', {
      actor: input.actor,
      user: user.email,
      role: role?.name,
      status: input.status,
      password_changed: input.password !== undefined,
    });
    return user;
  }

  /**
   * Reassign a user to a different role. Validates the role exists; guards the last-admin
   * lockout (a demotion that would strip the last critical-permission holder is refused);
   * then sets the role and BUMPS that user's `token_version` (their perms changed ⇒ any
   * live token must re-mint).
   */
  async assignRoleToUser(input: {
    actor: string;
    userId: string;
    roleName: string;
  }): Promise<void> {
    const user = await this.requireUser(input.userId);
    const role = await this.db.roles.getByName(input.roleName.trim());
    if (role === null) throw new RoleNotFoundError(input.roleName);
    if (user.role_id === role.id) return; // no-op: already in that role

    // Last-admin guard: model the post-change permissions of the target (their NEW role's
    // perms) and check no critical permission loses its last active holder.
    const newPerms = new Set(await this.db.rolePermissions.permissionsForRole(role.id));
    await this.assertNotLastAdmin(input.userId, { stillActive: true, withPerms: newPerms });

    await this.db.users.setRole(user.id, role.id);
    await this.db.users.bumpTokenVersion(user.id);
    this.logger.info('user role assigned', {
      actor: input.actor,
      user: user.email,
      role: role.name,
    });
  }

  /**
   * Enable/disable a user. Disabling guards the last-admin lockout, BUMPS `token_version`
   * (the still-unexpired access token 401s on the next request) and REVOKES the user's
   * refresh tokens (they can't refresh back in). Re-enabling just flips the status +
   * bumps the version (a clean re-mint).
   */
  async setUserStatus(input: {
    actor: string;
    userId: string;
    status: 'active' | 'disabled';
  }): Promise<void> {
    const user = await this.requireUser(input.userId);
    if (user.status === input.status) return; // no-op

    if (input.status === 'disabled') {
      // A disabled user stops being active ⇒ stops holding any permission.
      await this.assertNotLastAdmin(input.userId, { stillActive: false, withPerms: new Set() });
    }

    await this.db.users.setStatus(user.id, input.status);
    await this.db.users.bumpTokenVersion(user.id);
    if (input.status === 'disabled') {
      await this.db.refreshTokens.revokeAllForUser(user.id, this.clock.nowIso());
    }
    this.logger.info('user status changed', {
      actor: input.actor,
      user: user.email,
      status: input.status,
    });
  }

  /**
   * Admin password reset for a user. Validates the policy, re-hashes, and BUMPS
   * `token_version` ("log out everywhere on password change"). Does NOT need the current
   * password (admin authority). A disabled user can be reset but stays disabled.
   */
  async changePassword(input: {
    actor: string;
    userId: string;
    newPassword: string;
  }): Promise<void> {
    const user = await this.requireUser(input.userId);
    const policy = validatePasswordPolicy(input.newPassword, this.passwordPolicy);
    if (!policy.ok) throw new InvalidPatchError(policy.reason, ['password']);
    await this.db.users.updatePasswordHash(user.id, await this.hasher.hash(input.newPassword));
    await this.db.users.bumpTokenVersion(user.id);
    this.logger.info('user password reset', { actor: input.actor, user: user.email });
  }

  /**
   * SELF-SERVICE password change (Auth/IAM Phase 3). The caller changes THEIR OWN password,
   * keyed on `actor` (the token-derived email — never a body value). The authorization here
   * is the CURRENT-PASSWORD proof, NOT a permission: unlike the admin {@link changePassword},
   * this REQUIRES the existing password and verifies it before re-hashing — so no `team:manage`
   * is needed, but a session can't silently re-credential an account it merely holds a token for.
   *
   * Trust paths: a wrong `currentPassword` → `InvalidCredentialsError` (401), password unchanged
   * (the verify is constant-time even when no hash is stored — same anti-enumeration shape as
   * login); the `newPassword` runs the SAME `validatePasswordPolicy` as provisioning; on success
   * the hash is replaced and `token_version` bumped (logging out every other live session).
   */
  async changeOwnPassword(input: {
    actor: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<void> {
    const email = input.actor.trim().toLowerCase();
    const user = await this.db.users.getByEmail(email);
    const storedHash = user !== null ? await this.db.users.getPasswordHashByEmail(email) : null;

    // Verify the CURRENT password (constant-time even when the user/hash is absent — verify
    // against the dummy hash so a missing actor can't be told apart by timing), THEN apply
    // the new-password policy. A failed current-password check is a generic 401.
    const currentOk =
      storedHash !== null
        ? await this.hasher.verify(storedHash, input.currentPassword)
        : (await this.hasher.verify(DUMMY_PASSWORD_HASH, input.currentPassword), false);
    if (user === null || !currentOk) throw new InvalidCredentialsError();

    const policy = validatePasswordPolicy(input.newPassword, this.passwordPolicy);
    if (!policy.ok) throw new InvalidPatchError(policy.reason, ['newPassword']);

    await this.db.users.updatePasswordHash(user.id, await this.hasher.hash(input.newPassword));
    await this.db.users.bumpTokenVersion(user.id); // log out every other live session
    this.logger.info('user changed own password', { actor: email });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async requireUser(userId: string): Promise<User> {
    const user = await this.db.users.getById(userId);
    if (user === null) throw new UserNotFoundError(userId);
    return user;
  }

  private async requireRole(roleName: string): Promise<Role> {
    const role = await this.db.roles.getByName(roleName.trim());
    if (role === null) throw new RoleNotFoundError(roleName);
    return role;
  }

  /** Validate + dedupe a list of permission keys against the closed enum (bad key ⇒ 400). */
  private validatePermissionKeys(keys: string[]): PermissionKey[] {
    const out = new Set<PermissionKey>();
    for (const raw of keys) {
      const parsed = Permission.safeParse(raw);
      if (!parsed.success)
        throw new InvalidPatchError(`unknown permission key: ${raw}`, ['permissions']);
      out.add(parsed.data);
    }
    return [...out];
  }

  /**
   * The last-admin lockout guard. For every {@link CRITICAL_ADMIN_PERMISSIONS} key the
   * target would LOSE under the proposed change (disable ⇒ loses all; demote ⇒ loses keys
   * absent from the new role), refuse if the target is the last active holder of it.
   *
   * The pure {@link wouldRemoveLastHolder} reasons over the BEFORE state (active users with
   * their CURRENT effective perms): if it is the sole holder of a key it's about to lose,
   * the change empties that permission — an unrecoverable lockout.
   */
  private async assertNotLastAdmin(
    targetUserId: string,
    proposed: { stillActive: boolean; withPerms: ReadonlySet<PermissionKey> },
  ): Promise<void> {
    const [users, grants] = await Promise.all([
      this.db.users.list(),
      this.db.rolePermissions.list(),
    ]);
    const grantRows: RolePermissionGrant[] = grants.map((g) => ({
      role_id: g.roleId,
      permission_key: g.permissionKey,
    }));

    // The BEFORE view the pure rule reasons over: every active user with their CURRENT perms.
    const beforeActive: ActiveUserPermissions[] = users
      .filter((u) => u.status === 'active')
      .map((u) => ({ userId: u.id, perms: permissionsForRole(u.role_id, grantRows) }));

    const target = beforeActive.find((u) => u.userId === targetUserId);
    if (target === undefined) return; // target already inactive — nothing it holds to lose

    for (const perm of CRITICAL_ADMIN_PERMISSIONS) {
      // The target loses `perm` iff it holds it today AND won't after the change.
      const losesIt =
        target.perms.has(perm) && (!proposed.stillActive || !proposed.withPerms.has(perm));
      if (losesIt && wouldRemoveLastHolder(beforeActive, targetUserId, perm)) {
        throw new LastAdminError(perm);
      }
    }
  }

  /**
   * The last-admin guard's THIRD lever: a role permission-set edit. For each critical
   * permission the role is LOSING (granted today, absent from the new set), refuse if no
   * active user OUTSIDE this role would still hold it — the edit would strip it from every
   * active user in the role at once, an unrecoverable lockout. Reasons over the BEFORE state
   * via the pure {@link wouldRoleEditRemoveLastHolder}.
   */
  private async assertRoleEditNotLastAdmin(
    roleId: string,
    newPerms: ReadonlySet<PermissionKey>,
  ): Promise<void> {
    const [users, grants] = await Promise.all([
      this.db.users.list(),
      this.db.rolePermissions.list(),
    ]);
    const grantRows: RolePermissionGrant[] = grants.map((g) => ({
      role_id: g.roleId,
      permission_key: g.permissionKey,
    }));
    const beforeActive: ActiveUserRole[] = users
      .filter((u) => u.status === 'active')
      .map((u) => ({
        userId: u.id,
        roleId: u.role_id,
        perms: permissionsForRole(u.role_id, grantRows),
      }));

    const currentRolePerms = new Set(await this.db.rolePermissions.permissionsForRole(roleId));
    for (const perm of CRITICAL_ADMIN_PERMISSIONS) {
      // Only a critical perm the role grants TODAY but loses under the new set can lock out.
      const losesIt = currentRolePerms.has(perm) && !newPerms.has(perm);
      if (losesIt && wouldRoleEditRemoveLastHolder(beforeActive, roleId, perm)) {
        throw new LastAdminError(perm);
      }
    }
  }

  private async roleView(roleId: string): Promise<RoleView> {
    const role = await this.db.roles.getById(roleId);
    if (role === null) throw new RoleNotFoundError(roleId);
    const permissions = await this.db.rolePermissions.permissionsForRole(roleId);
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      is_system: role.is_system,
      permissions: [...permissions].sort(),
    };
  }
}
