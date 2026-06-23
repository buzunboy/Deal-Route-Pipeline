import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';
import type { PasswordHasher } from '../../application/ports/index.js';

/** Argon2id cost parameters (from typed config — named, no magic numbers). */
export interface Argon2idParams {
  /** Memory cost in KiB (OWASP floor ≈ 19456 = 19 MiB). */
  memoryCost: number;
  /** Iterations (time cost). */
  timeCost: number;
  /** Degree of parallelism. */
  parallelism: number;
}

/**
 * Argon2id password hasher (`@node-rs/argon2` — prebuilt binaries, no node-gyp on Fly).
 * The ONLY place the Argon2 SDK is imported (DIP); business logic depends on the
 * `PasswordHasher` port. Memory/time/parallelism come from injected config.
 *
 * `verify` is constant-time-safe and NEVER throws: a malformed/garbage stored hash
 * returns `false` (not an exception), so the unknown-email login path — verifying a
 * submitted password against `DUMMY_PASSWORD_HASH` — costs the same as a real verify
 * and can't be distinguished by an exception. `needsRehash` flips when the stored
 * params lag the current config so a login can transparently upgrade the hash.
 */
export class Argon2idHasher implements PasswordHasher {
  constructor(private readonly params: Argon2idParams) {}

  async hash(plaintext: string): Promise<string> {
    return argon2Hash(plaintext, {
      algorithm: Algorithm.Argon2id,
      memoryCost: this.params.memoryCost,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
    });
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2Verify(hash, plaintext);
    } catch {
      // A malformed/garbage hash (or a non-Argon2 string) is a mismatch, not an error —
      // return false rather than leaking a parse failure through an exception. This
      // keeps the unknown-email path (verify against DUMMY_PASSWORD_HASH) timing-uniform.
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    const parsed = parseArgon2Params(hash);
    // A hash we can't parse (or that isn't argon2id) should be re-hashed on next login.
    if (parsed === null) return true;
    return (
      parsed.memoryCost !== this.params.memoryCost ||
      parsed.timeCost !== this.params.timeCost ||
      parsed.parallelism !== this.params.parallelism
    );
  }
}

/**
 * Parse the cost params out of an encoded Argon2id string
 * (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`), or null if it isn't a well-formed
 * argon2id hash. Pure string parsing — no SDK call (cheap, used by `needsRehash`).
 */
function parseArgon2Params(
  hash: string,
): { memoryCost: number; timeCost: number; parallelism: number } | null {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (m === null) return null;
  return {
    memoryCost: Number(m[1]),
    timeCost: Number(m[2]),
    parallelism: Number(m[3]),
  };
}
