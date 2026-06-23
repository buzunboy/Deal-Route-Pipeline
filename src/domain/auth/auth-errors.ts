import { DomainError } from '../errors/errors.js';
import type { Permission } from './permission.js';

/**
 * Typed auth/IAM domain errors (Auth/IAM). Same pattern as `src/domain/errors/errors.ts`
 * (abstract `code`, contextual message, `instanceof`-distinguishable). The Phase-2
 * `mapErrors` HTTP switch translates each to the status documented below. Constructed
 * by the auth use-cases (Phase 3) and the per-request JWT guard (Phase 2); defined now
 * so the domain is complete and the pure rules can reference them.
 */

/**
 * Bad email/password. Maps to HTTP 401. The message is GENERIC for BOTH unknown-email
 * and wrong-password (anti-enumeration) — the always-run-hasher in `AuthenticateUseCase`
 * backs the timing side of this up. Never reveals which of the two failed.
 */
export class InvalidCredentialsError extends DomainError {
  readonly code = 'INVALID_CREDENTIALS';

  constructor() {
    super('Invalid email or password.');
  }
}

/** The account is `disabled`. Maps to HTTP 403. */
export class AccountDisabledError extends DomainError {
  readonly code = 'ACCOUNT_DISABLED';

  constructor() {
    super('This account is disabled.');
  }
}

/**
 * Too many failed logins — the account is temporarily locked. Maps to HTTP 429. When a
 * concrete `lockedUntil` is known the handler MAY set `Retry-After` from it; it is
 * NULLABLE so the unknown-email path (which has no row, hence no real lock time) can
 * still return the SAME 429 shape — lockout must not become an account-enumeration
 * oracle (see the anti-enumeration note in docs/KNOWN_ISSUES.md / the Phase-2 login
 * use-case). The generic message is identical regardless of `lockedUntil`.
 */
export class AccountLockedError extends DomainError {
  readonly code = 'ACCOUNT_LOCKED';

  constructor(readonly lockedUntil: Date | null = null) {
    super(
      'Too many failed attempts. Try again later.',
      lockedUntil ? { locked_until: lockedUntil.toISOString() } : undefined,
    );
  }
}

/**
 * A refresh token was not found, is expired, or was revoked. Maps to HTTP 401. The
 * generic base for the refresh-failure family so a single 401 catch still works.
 */
export class RefreshTokenInvalidError extends DomainError {
  // Typed `string` (not the literal) so `RefreshReuseDetectedError` can override it
  // with its own code while staying a subclass (a generic refresh-401 catch works).
  readonly code: string = 'REFRESH_INVALID';

  constructor(message = 'Refresh token is invalid or expired.') {
    super(message);
  }
}

/**
 * A rotated-out refresh token was presented (replay) ⇒ the whole family is revoked
 * (theft response). Maps to HTTP 401. A subclass of `RefreshTokenInvalidError` so a
 * generic refresh-401 catch still handles it.
 */
export class RefreshReuseDetectedError extends RefreshTokenInvalidError {
  override readonly code = 'REFRESH_REUSE';

  constructor() {
    super('Refresh token reuse detected; the session family was revoked.');
  }
}

/**
 * The authenticated identity lacks the permission a gated route requires. Maps to
 * HTTP 403. Carries the missing `Permission` (used by the Phase-2 route registry).
 */
export class PermissionDeniedError extends DomainError {
  readonly code = 'PERMISSION_DENIED';

  constructor(readonly required: Permission) {
    super(`Missing required permission: ${required}.`, { required });
  }
}

/** No / invalid token on a gated `/api/*` request. Maps to HTTP 401. */
export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';

  constructor() {
    super('Authentication required.');
  }
}

/** A referenced role does not exist. Maps to HTTP 404 (or 400 in provision). */
export class RoleNotFoundError extends DomainError {
  readonly code = 'ROLE_NOT_FOUND';

  constructor(readonly roleName: string) {
    super(`Role not found: ${roleName}`, { roleName });
  }
}

/**
 * Deleting/editing a role that is still assigned to users, or a built-in `is_system`
 * role. Maps to HTTP 409. (The plan's `SystemRoleError` folds into this — same status,
 * same "can't mutate this role" meaning.)
 */
export class RoleInUseError extends DomainError {
  readonly code = 'ROLE_IN_USE';

  constructor(
    readonly roleName: string,
    reason: string,
  ) {
    super(`Role "${roleName}" cannot be changed: ${reason}`, { roleName });
  }
}

/** A provision tried to create a user whose email already exists. Maps to HTTP 409. */
export class UserAlreadyExistsError extends DomainError {
  readonly code = 'USER_ALREADY_EXISTS';

  constructor(readonly email: string) {
    super(`A user already exists with email: ${email}`, { email });
  }
}

/** A referenced user does not exist (admin user-management). Maps to HTTP 404. */
export class UserNotFoundError extends DomainError {
  readonly code = 'USER_NOT_FOUND';

  constructor(readonly userId: string) {
    super(`User not found: ${userId}`, { userId });
  }
}

/**
 * The LAST-ADMIN LOCKOUT GUARD (Auth/IAM, Phase 3): refusing to disable or demote the LAST
 * active user who can still manage users/roles. Maps to HTTP 409 — the alternative is an
 * unrecoverable lockout where nobody can ever administer the org again. Carries the
 * critical `Permission` that would lose its last holder.
 */
export class LastAdminError extends DomainError {
  readonly code = 'LAST_ADMIN';

  constructor(readonly permission: Permission) {
    super(
      `Refused: this is the last active user who can "${permission}"; disabling or demoting them would lock everyone out of administration.`,
      { permission },
    );
  }
}
