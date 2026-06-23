import { Permission } from './permission.js';

/**
 * Pure admin-management rules (Auth/IAM, Phase 3). No I/O — the `ManageRolesUseCase`
 * gathers the inputs from the repos and feeds them here, so the decisions are
 * table-driven unit-tested in isolation. Two trust-critical surfaces:
 *   1. the password-policy floor (rejects too-short admin-set/reset passwords);
 *   2. the LAST-ADMIN LOCKOUT GUARD (you can never disable or demote the last
 *      account that can still manage users/roles — otherwise an admin can lock the
 *      whole org out of its own IAM, with no way back in).
 */

/**
 * The permissions whose LAST active holder must never be removed. Losing every
 * `roles:manage` holder means nobody can ever edit RBAC again; losing every
 * `team:manage` holder means nobody can ever create/disable a user again. Either is
 * an unrecoverable lockout, so the guard protects both. Frozen — the closed set.
 */
export const CRITICAL_ADMIN_PERMISSIONS: readonly Permission[] = Object.freeze([
  'roles:manage',
  'team:manage',
]);

/** Minimum length for an admin-set initial / reset password (config-driven floor). */
export interface PasswordPolicy {
  minLength: number;
}

/** The outcome of validating a candidate password against the policy. */
export type PasswordPolicyResult = { ok: true } | { ok: false; reason: string };

/**
 * Validate a candidate password against the policy. Pure — the only rule today is a
 * length floor (no composition rules: NIST/OWASP guidance favours length over
 * character-class theatre, and Argon2id + lockout + rate-limiting carry the brute-force
 * defence). A password shorter than `minLength` is rejected with a SAFE, non-leaking
 * reason the HTTP layer surfaces as a 400.
 */
export function validatePasswordPolicy(
  password: string,
  policy: PasswordPolicy,
): PasswordPolicyResult {
  if (password.length < policy.minLength) {
    return { ok: false, reason: `password must be at least ${policy.minLength} characters` };
  }
  return { ok: true };
}

/**
 * One active user's effective permission set — the minimal shape the last-admin guard
 * needs (identity + what they can do). The use-case builds this list from
 * `users.list()` (active only) joined to each user's resolved permissions.
 */
export interface ActiveUserPermissions {
  userId: string;
  perms: ReadonlySet<Permission>;
}

/** An active user plus the role they hold — for the role-edit lockout lever. */
export interface ActiveUserRole {
  userId: string;
  roleId: string;
  perms: ReadonlySet<Permission>;
}

/**
 * Would removing `targetUserId`'s `permission` leave NO active user holding it? Pure.
 *
 * `activeUsers` is the set of currently-active users with their effective permissions
 * (the target INCLUDED, reflecting their permissions BEFORE the proposed change). The
 * guard counts the OTHER active users who still hold `permission`; if none do, the
 * target is the last holder and the change is refused. A target who doesn't hold the
 * permission in the first place can never be the last holder ⇒ allowed (false).
 *
 * Used for both levers that can strip a critical permission from a user:
 *   - DISABLE (the target stops being active ⇒ stops counting), and
 *   - DEMOTE / reassign to a role lacking `permission`.
 * The use-case calls this for every {@link CRITICAL_ADMIN_PERMISSIONS} key the target
 * currently holds, before applying the mutation.
 */
export function wouldRemoveLastHolder(
  activeUsers: ReadonlyArray<ActiveUserPermissions>,
  targetUserId: string,
  permission: Permission,
): boolean {
  const target = activeUsers.find((u) => u.userId === targetUserId);
  // The target must currently hold the permission AND be active to be "a holder" at all.
  if (target === undefined || !target.perms.has(permission)) return false;
  const otherHolders = activeUsers.some(
    (u) => u.userId !== targetUserId && u.perms.has(permission),
  );
  return !otherHolders;
}

/**
 * Would editing role `roleId`'s permission set — REMOVING `permission` from it — leave NO
 * active user holding `permission`? Pure. The THIRD lockout lever (besides disable and
 * demote): a role-permission edit strips the permission from EVERY active user in that role
 * at once, so it must be guarded too.
 *
 * `activeUsers` is the set of currently-active users with their role + current effective
 * perms (the BEFORE state). After the edit, the only remaining holders of `permission` are
 * active users in a DIFFERENT role who hold it. If there are none — and at least one active
 * user in this role currently holds it (so the edit actually removes a live grant) — the
 * edit empties the permission ⇒ refuse. A role no active user holds, or a `permission` no
 * one in the role has, can't be the last holder ⇒ allowed (false).
 */
export function wouldRoleEditRemoveLastHolder(
  activeUsers: ReadonlyArray<ActiveUserRole>,
  roleId: string,
  permission: Permission,
): boolean {
  const inRoleHoldsIt = activeUsers.some((u) => u.roleId === roleId && u.perms.has(permission));
  if (!inRoleHoldsIt) return false; // the role grants nobody this perm; nothing to lose
  const holdersOutsideRole = activeUsers.some(
    (u) => u.roleId !== roleId && u.perms.has(permission),
  );
  return !holdersOutsideRole;
}
