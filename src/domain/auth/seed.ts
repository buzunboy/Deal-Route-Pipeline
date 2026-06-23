import { ALL_PERMISSIONS, type Permission } from './permission.js';
import { SYSTEM_ROLE_ADMIN, SYSTEM_ROLE_REVIEWER } from './role.js';

/**
 * The canonical auth seed (Auth/IAM) — the SAME baseline the SQL migrations 0020–0023
 * install into Postgres, expressed once here so the in-memory adapter seeds an identical
 * baseline (LSP) without a migration runner. The fixed system-role ids MATCH the
 * migration's `INSERT … VALUES` so both adapters key roles identically; an integration
 * test asserts the migrated Postgres rows equal these constants (drift guard).
 *
 * `admin` → every permission (derived from ALL_PERMISSIONS, so a new key auto-extends it).
 * `reviewer` → the least-privilege review bundle (read + approve/reject/edit +
 * manual-capture + evidence:read).
 */
export const SYSTEM_ROLE_ADMIN_ID = '00000000-0000-4000-a000-0000000000a1';
export const SYSTEM_ROLE_REVIEWER_ID = '00000000-0000-4000-a000-0000000000a2';

export interface SeedRole {
  id: string;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

/** The reviewer least-privilege permission bundle (matches migration 0022's reviewer seed). */
export const REVIEWER_PERMISSIONS: readonly Permission[] = Object.freeze([
  'candidate:read',
  'candidate:approve',
  'candidate:reject',
  'candidate:edit',
  'sources:read',
  'settings:read',
  'team:read',
  'manual-capture:write',
  'evidence:read',
]);

/** The two built-in system roles + their grants (the migration 0020/0022 seed). */
export const SYSTEM_ROLES: readonly SeedRole[] = Object.freeze([
  {
    id: SYSTEM_ROLE_ADMIN_ID,
    name: SYSTEM_ROLE_ADMIN,
    description: 'Full administrative access — all permissions.',
    permissions: ALL_PERMISSIONS,
  },
  {
    id: SYSTEM_ROLE_REVIEWER_ID,
    name: SYSTEM_ROLE_REVIEWER,
    description: 'Reviews candidates: read, approve, reject, edit, manual capture.',
    permissions: REVIEWER_PERMISSIONS,
  },
]);
