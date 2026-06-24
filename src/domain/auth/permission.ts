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
  // PANEL-ENFORCED ONLY — no pipeline /api route guards this key. It exists so the
  // admin panel can gate its read-only Foundations / style-guide screen and so the
  // key is grantable in the Roles editor; the pipeline never checks it on a request.
  // admin auto-gets it via ALL_PERMISSIONS; reviewer deliberately does not.
  'system:foundations', // (panel) GET /foundations — the living style guide
]);
export type Permission = z.infer<typeof Permission>;

/**
 * All permission keys — used to seed the `permissions` table and to grant the
 * system `admin` role every permission. Frozen so a caller can't mutate the closed
 * universe of keys at runtime.
 */
export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze([...Permission.options]);

/**
 * Canonical human label per permission — the co-located source of truth for the
 * catalogue the panel role editor renders. `satisfies Record<Permission, string>`
 * makes this EXHAUSTIVE at compile time: adding a `Permission` enum member without a
 * label here (or a label for a removed key) is a TYPE error. So a new permission is
 * a two-line edit in THIS file — the enum member + its label — both compiler-forced.
 * `GET /api/permissions` derives `{key,label}` from this; the SQL seed mirrors it.
 */
export const PERMISSION_LABELS = {
  'candidate:read': 'View the review queue',
  'candidate:approve': 'Approve candidates',
  'candidate:reject': 'Reject candidates',
  'candidate:edit': 'Edit candidate fields',
  'sources:read': 'View sources',
  'sources:write': 'Add sources',
  'sources:review': 'Approve / reject proposed sources',
  'settings:read': 'View settings',
  'settings:write': 'Change settings',
  'team:read': 'View users / team',
  'team:manage': 'Manage users (create / edit / disable)',
  'roles:manage': 'Manage roles & permissions',
  'alerts:manage': 'Acknowledge / resolve alerts',
  'field-proposals:promote': 'Promote field proposals into the vocabulary',
  'manual-capture:write': 'Complete / create manual-capture tasks',
  'evidence:read': 'Fetch evidence artifacts',
  'system:foundations': 'Access the panel Foundations / style-guide screen',
} as const satisfies Record<Permission, string>;
