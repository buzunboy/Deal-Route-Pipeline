/**
 * PasswordHasher port (Auth/IAM). The domain/use-cases program to THIS; the concrete
 * memory-hard hasher (`Argon2idHasher`, `@node-rs/argon2`) is injected from the one
 * composition root (DIP) — no hashing SDK reaches a use-case. A trivial fake passes the
 * same contract suite for substitutability (LSP). All methods are constant-time-safe:
 * `verify` does not short-circuit on a length/format mismatch and returns `false` rather
 * than throwing on garbage, so the unknown-email path (verify against `DUMMY_PASSWORD_HASH`)
 * costs the same as a real verify.
 */
export interface PasswordHasher {
  /** Hash a plaintext into an encoded Argon2id string (salt + params inline). */
  hash(plaintext: string): Promise<string>;
  /** Constant-time verify; `false` on mismatch OR malformed/garbage hash (never throws). */
  verify(hash: string, plaintext: string): Promise<boolean>;
  /** True when the stored hash's params lag the current config (transparent rehash on login). */
  needsRehash(hash: string): boolean;
}
