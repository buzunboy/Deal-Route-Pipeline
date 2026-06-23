import {
  permissionsForRole,
  type Permission,
  type RolePermissionGrant,
} from '../../domain/index.js';
import type { Database } from '../ports/index.js';

/**
 * Resolve a user's effective permission set from their role → `role_permissions`
 * (Auth/IAM). The SINGLE source of truth for "what can this user do", reused by
 * claim-minting (login/refresh), by the per-request guard on a `perm_version`
 * mismatch, and (Phase 3) by `GET /api/permissions/me`. So the guard and the
 * claim-minter never diverge, both go through this.
 *
 * Deny-by-default: a missing user or a role with no grants yields an EMPTY set.
 * No caching beyond the call — `perm_version` is the staleness lever, not a TTL here.
 */
export class AuthorizationUseCase {
  constructor(private readonly db: Database) {}

  /** The effective permission `Set` for a user (empty when the user/role is unknown). */
  async permissionsForUser(userId: string): Promise<Set<Permission>> {
    const user = await this.db.users.getById(userId);
    if (user === null) return new Set<Permission>();
    // Reuse the pure rule so the projection is the SAME one the unit tests pin.
    const grants = await this.db.rolePermissions.permissionsForRole(user.role_id);
    const rows: RolePermissionGrant[] = grants.map((permission_key) => ({
      role_id: user.role_id,
      permission_key,
    }));
    return permissionsForRole(user.role_id, rows);
  }
}
