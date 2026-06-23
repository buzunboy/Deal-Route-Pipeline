import { randomBytes, createHash } from 'node:crypto';

/**
 * Refresh-token crypto helpers (Auth/IAM). A refresh token is an OPAQUE random secret
 * — never a JWT — so it carries no claims a leak could exploit; its only meaning is
 * "matches a stored hash". We store ONLY the SHA-256 hash (`hashRefreshToken`), so a DB
 * leak yields nothing usable, and the raw token is returned to the caller exactly once
 * (at login / rotation). 32 random bytes (base64url) is comfortably past the ≥256-bit
 * floor the plan pins. No vendor SDK — `node:crypto` only — so this stays in the
 * application layer (the decision is pure; only the randomness/hashing is I/O-free crypto).
 */

/** Number of random bytes in an opaque refresh token (≥32 ⇒ ≥256 bits of entropy). */
const REFRESH_TOKEN_BYTES = 32;

/** Mint a fresh opaque refresh token (URL-safe; returned to the caller exactly once). */
export function newRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * The SHA-256 hex of a refresh token — the ONLY form persisted (`refresh_tokens.token_hash`)
 * and the lookup key on `findByHash`. Deterministic, so the same raw token always resolves
 * to the same row; one-way, so the stored value can't be turned back into a usable token.
 */
export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
