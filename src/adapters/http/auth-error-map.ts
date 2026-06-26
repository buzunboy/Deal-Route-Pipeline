import { type ServerResponse } from 'node:http';
import {
  InvalidCredentialsError,
  AccountDisabledError,
  AccountLockedError,
  RefreshTokenInvalidError,
  PermissionDeniedError,
  UnauthenticatedError,
  RoleNotFoundError,
  RoleInUseError,
  UserAlreadyExistsError,
  UserNotFoundError,
  LastAdminError,
} from '../../domain/index.js';
import { sendError } from './http-helpers.js';
import { isPoolTimeoutError } from '../db/postgres/db-resilience.js';

/**
 * Map a thrown auth/IAM `DomainError` to its HTTP status + a SAFE client message, or
 * return `false` if it isn't an auth error (so the caller's own `mapErrors` switch / the
 * generic-500 path takes over). Shared by `AuthApi` and the `ReviewApi` guard so the auth
 * statuses (401/403/409/429) are defined ONCE and can't drift between routers.
 *
 * Two anti-enumeration invariants enforced here:
 * - `InvalidCredentialsError` → a SINGLE generic 401 body, identical for unknown-email and
 *   wrong-password (never reveals which).
 * - `AccountLockedError` → 429 with a `Retry-After` derived from `locked_until` when known;
 *   the message is the same whether or not a concrete time exists.
 */
export function tryMapAuthError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof InvalidCredentialsError) {
    sendError(res, 401, 'invalid email or password');
    return true;
  }
  if (err instanceof RefreshTokenInvalidError) {
    // Covers RefreshReuseDetectedError too (a subclass) — a uniform 401 so a probe can't
    // tell "unknown" from "expired" from "reuse-revoked".
    sendError(res, 401, 'invalid or expired refresh token');
    return true;
  }
  if (err instanceof UnauthenticatedError) {
    sendError(res, 401, 'unauthorized');
    return true;
  }
  if (err instanceof AccountDisabledError) {
    sendError(res, 403, 'account is disabled');
    return true;
  }
  if (err instanceof PermissionDeniedError) {
    sendError(res, 403, 'forbidden');
    return true;
  }
  if (err instanceof AccountLockedError) {
    if (err.lockedUntil) {
      const seconds = Math.max(0, Math.ceil((err.lockedUntil.getTime() - Date.now()) / 1000));
      res.setHeader('retry-after', String(seconds));
    }
    sendError(res, 429, 'too many attempts; try again later');
    return true;
  }
  if (err instanceof UserAlreadyExistsError) {
    sendError(res, 409, 'a user already exists with that email');
    return true;
  }
  if (err instanceof LastAdminError) {
    // 409: refusing to remove the last admin — surface the clear, safe message so the
    // panel can tell the operator WHY the disable/demote was blocked.
    sendError(res, 409, err.message);
    return true;
  }
  if (err instanceof RoleInUseError) {
    sendError(res, 409, err.message);
    return true;
  }
  if (err instanceof RoleNotFoundError) {
    sendError(res, 404, 'role not found');
    return true;
  }
  if (err instanceof UserNotFoundError) {
    sendError(res, 404, 'user not found');
    return true;
  }
  // The DB pool couldn't hand out a connection in time (saturated / DB momentarily
  // unreachable). That's a transient UNAVAILABILITY, not a server bug — answer 503 with a
  // short Retry-After so the client (and the panel) can back off, instead of a generic 500
  // that reads as "the request is broken". Last branch: a real typed error wins above.
  if (isPoolTimeoutError(err)) {
    res.setHeader('retry-after', '1'); // back off ~1s before retrying
    sendError(res, 503, 'service temporarily unavailable; please retry');
    return true;
  }
  return false;
}
