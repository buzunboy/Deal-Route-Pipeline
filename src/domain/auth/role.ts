import { z } from 'zod';

/**
 * A role — a named bundle of permissions (Auth/IAM). The actual key→role grants
 * live in `role_permissions` (DB data); this entity holds only the role's stable
 * identity. Permission-based RBAC: adding/retuning a role is a data change, not a
 * code change (OCP).
 *
 * `is_system` protects the built-in `admin`/`reviewer` roles — the
 * `ManageRolesUseCase` (Phase 3) refuses to delete or re-scope a system role, so
 * `admin` always means "all permissions". Declared on the entity so the invariant
 * lives with the data it guards.
 */
export const RoleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1), // 'admin' | 'reviewer' | custom
  description: z.string().default(''),
  is_system: z.boolean(),
});
export type Role = z.infer<typeof RoleSchema>;

/** The two built-in system role names, seeded by migration 0020. */
export const SYSTEM_ROLE_ADMIN = 'admin';
export const SYSTEM_ROLE_REVIEWER = 'reviewer';
