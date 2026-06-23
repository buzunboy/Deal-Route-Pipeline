import { Permission } from './permission.js';
import type { AccessClaims } from './access-claims.js';
import type { StoredRefresh } from './refresh-token.js';
import type { User } from './user.js';

/**
 * Pure auth rules (Auth/IAM). No I/O, no vendor SDK, clock injected where time
 * matters — the trust-critical decision surface, table-driven unit-tested. The
 * adapters (`Argon2idHasher`, `JoseTokenIssuer`) and use-cases call these; the
 * actual hashing/signing/DB lives behind ports, the DECISIONS live here.
 */

/** A `(role_id, permission_key)` grant row, as `role_permissions` stores it. */
export interface RolePermissionGrant {
  role_id: string;
  permission_key: Permission;
}

/**
 * Resolve the effective permission SET for one role from the `role_permissions`
 * grants. Deny-by-default: a role with no grant rows yields an empty set. Idempotent,
 * order-independent, and deduped (a `Set`), so the claim-minter and the per-request
 * guard never diverge. `admin`'s "all permissions" is data (the seed grants every
 * key) — this rule has no role-name special-casing (OCP).
 */
export function permissionsForRole(
  roleId: string,
  grants: ReadonlyArray<RolePermissionGrant>,
): Set<Permission> {
  const perms = new Set<Permission>();
  for (const g of grants) {
    if (g.role_id === roleId) perms.add(g.permission_key);
  }
  return perms;
}

/**
 * The single membership chokepoint the Phase-2 route registry calls — NEVER matches
 * on a role name. Pure, total over the closed `Permission` universe.
 */
export function hasPermission(perms: ReadonlySet<Permission>, required: Permission): boolean {
  return perms.has(required);
}

/** Lockout thresholds (config-driven; named, no magic numbers). */
export interface LockoutConfig {
  /** Failed attempts at/above which the account locks. */
  maxFailedAttempts: number;
  /** How long a lock lasts from the last failed attempt. */
  lockoutSeconds: number;
}

/** The lockout decision for an account, given its failure counters + the current time. */
export interface LockoutDecision {
  locked: boolean;
  /** When the lock lifts (null when not locked). */
  lockedUntil: Date | null;
}

/**
 * Pure brute-force gate (no I/O, clock-injected). Below the threshold ⇒ not locked.
 * At/above the threshold ⇒ locked until `lastFailedAt + lockoutSeconds`; a window
 * that has fully elapsed ⇒ not locked (auto-unlock). The window edge is INCLUSIVE of
 * the boundary instant: at exactly `lastFailedAt + lockoutSeconds` the lock has lifted
 * (a caller at the boundary is allowed through). Feeds `AccountLockedError` +
 * the `failed_login_count`/`locked_until` user columns.
 */
export function lockoutPolicy(
  failedCount: number,
  lastFailedAt: Date | null,
  now: Date,
  config: LockoutConfig,
): LockoutDecision {
  if (failedCount < config.maxFailedAttempts || lastFailedAt === null) {
    return { locked: false, lockedUntil: null };
  }
  const lockedUntil = new Date(lastFailedAt.getTime() + config.lockoutSeconds * 1000);
  // Boundary instant counts as elapsed: locked only while strictly before lockedUntil.
  if (now.getTime() >= lockedUntil.getTime()) {
    return { locked: false, lockedUntil: null };
  }
  return { locked: true, lockedUntil };
}

/** Inputs to mint the access-token claim set (everything time/identity related). */
export interface BuildAccessClaimsInput {
  user: User;
  perms: ReadonlySet<Permission>;
  roleName: string;
  permVersion: number;
  now: Date;
  ttlSeconds: number;
  jti: string;
  iss: string;
  aud: string;
}

/**
 * Build the EXACT `AccessClaims` the IdP signs — pure (no signing; that is the
 * `TokenIssuer`'s job). Guarantees: `exp === iat + ttlSeconds`; `iat`/`exp` are whole
 * epoch SECONDS (JWT convention); `perms` is deterministically sorted so token tests
 * are stable; `token_version`/`perm_version` copied through; `iss`/`aud` injected from
 * config (never hard-coded). NEVER includes `password_hash` or any secret — the `User`
 * entity it reads doesn't carry one.
 */
export function buildAccessClaims(input: BuildAccessClaimsInput): AccessClaims {
  const iat = Math.floor(input.now.getTime() / 1000);
  return {
    iss: input.iss,
    aud: input.aud,
    sub: input.user.id,
    email: input.user.email,
    name: input.user.name,
    role: input.roleName,
    perms: [...input.perms].sort() as Permission[],
    token_version: input.user.token_version,
    perm_version: input.permVersion,
    iat,
    exp: iat + input.ttlSeconds,
    jti: input.jti,
  };
}

/** The outcome of evaluating a presented refresh token against its stored row. */
export type RefreshRotationVerdict = 'ok' | 'expired' | 'reuse' | 'unknown';

/**
 * The pure heart of rotating-refresh + reuse-detection. The hash lookup already
 * happened (the adapter does the constant-time compare); this decides the verdict:
 * - `unknown` — no stored row (the hash matched nothing) ⇒ invalid (401).
 * - `reuse`   — the row exists but is already revoked/replaced (a rotated-out token
 *               was replayed) ⇒ the use-case revokes the whole `family_id` (401).
 *               Checked BEFORE `expired` so a replayed-but-expired token still trips
 *               theft-response, not a benign expiry.
 * - `expired` — current row, but `now >= expires_at` ⇒ invalid (401).
 * - `ok`      — current (not revoked/replaced) and unexpired ⇒ rotate + issue successor.
 */
export function validateRefreshRotation(
  stored: StoredRefresh | null,
  now: Date,
): RefreshRotationVerdict {
  if (stored === null) return 'unknown';
  if (stored.revoked_at !== null || stored.replaced_by !== null) return 'reuse';
  if (now.getTime() >= Date.parse(stored.expires_at)) return 'expired';
  return 'ok';
}
