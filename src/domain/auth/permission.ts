import { z } from 'zod';

/**
 * Fine-grained permission keys (Auth/IAM — pipeline-as-IdP). Roles are named
 * BUNDLES of these (DB data in `role_permissions`); pages and APIs require a
 * PERMISSION, never a role name — so adding a role is data, not code (OCP).
 *
 * A `z.enum` so a typo in a guard is a COMPILE error, not a silent un-gated route.
 * The keys are seeded into the `permissions` table (migration 0021) so the panel UI
 * can enumerate them without the enum shipping to the client. The comment after each
 * key is the canonical route→permission mapping the Phase-2 registry reproduces.
 */
export const Permission = z.enum([
  'candidate:read', // GET /api/candidates*, /reviews, /counts, /freshness
  'candidate:approve', // POST /api/candidates/:id/approve
  'candidate:reject', // POST /api/candidates/:id/reject
  'candidate:edit', // PATCH /api/candidates/:id
  'sources:read', // GET /api/sources*, /pending, /reviews
  'sources:write', // POST /api/sources
  'sources:review', // POST /api/sources/:id/approve|reject
  'settings:read', // GET /api/settings
  'settings:write', // PATCH /api/settings/:key
  'team:read', // GET /api/team
  'team:manage', // POST /api/team→/api/users, PATCH /api/users/:id
  'roles:manage', // GET/POST/PATCH/DELETE /api/roles, GET /api/permissions
  'alerts:manage', // POST /api/alerts/:id/acknowledge|resolve
  'field-proposals:promote', // POST /api/field-proposals/:key/promote
  'manual-capture:write', // POST /api/manual-capture-tasks(/:id/complete)
  'evidence:read', // GET /api/evidence/:id/:artifact (the one gated GET today)
]);
export type Permission = z.infer<typeof Permission>;

/**
 * All permission keys — used to seed the `permissions` table and to grant the
 * system `admin` role every permission. Frozen so a caller can't mutate the closed
 * universe of keys at runtime.
 */
export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze([...Permission.options]);
