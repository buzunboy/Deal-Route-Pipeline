import { describe, it, expect } from 'vitest';
import type { PasswordHasher } from '../../src/application/ports/index.js';

/**
 * Shared contract suite for the PasswordHasher port. Every implementation (the real
 * `Argon2idHasher` + any fake) must pass it, so they are substitutable behind the port
 * (LSP, `testing.md`: adapter contract tests). The trust-critical guarantees: a correct
 * password verifies, a wrong/tampered one does NOT, `verify` NEVER throws on garbage
 * (returns false — the constant-time unknown-email path depends on this), and
 * `needsRehash` flips when the stored params lag the current config.
 *
 * `makeHasher` returns the hasher at the CURRENT params; `makeWeakerHasher` (optional)
 * returns one configured with DIFFERENT params, to exercise `needsRehash`.
 */
export function passwordHasherContract(
  name: string,
  makeHasher: () => PasswordHasher | Promise<PasswordHasher>,
  makeWeakerHasher?: () => PasswordHasher | Promise<PasswordHasher>,
): void {
  describe(`PasswordHasher contract: ${name}`, () => {
    it('hash then verify(correct) → true (round-trip)', async () => {
      const hasher = await makeHasher();
      const hash = await hasher.hash('correct horse battery staple');
      expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
    });

    it('verify(wrong password) → false', async () => {
      const hasher = await makeHasher();
      const hash = await hasher.hash('the-right-one');
      expect(await hasher.verify(hash, 'the-wrong-one')).toBe(false);
    });

    it('verify against a tampered hash → false (never throws)', async () => {
      const hasher = await makeHasher();
      const hash = await hasher.hash('secret');
      const tampered = hash.slice(0, -3) + 'AAA';
      expect(await hasher.verify(tampered, 'secret')).toBe(false);
    });

    it('verify against a garbage/non-hash string → false (never throws)', async () => {
      const hasher = await makeHasher();
      // The unknown-email login path verifies against a constant — a malformed stored
      // value must be a quiet `false`, not an exception that would leak via timing.
      expect(await hasher.verify('not-a-hash', 'whatever')).toBe(false);
      expect(await hasher.verify('', 'whatever')).toBe(false);
    });

    it('distinct salts: hashing the same password twice yields different encodings', async () => {
      const hasher = await makeHasher();
      const a = await hasher.hash('same-password');
      const b = await hasher.hash('same-password');
      expect(a).not.toBe(b);
      expect(await hasher.verify(a, 'same-password')).toBe(true);
      expect(await hasher.verify(b, 'same-password')).toBe(true);
    });

    it('needsRehash is false for a hash made at the current params', async () => {
      const hasher = await makeHasher();
      const hash = await hasher.hash('pw');
      expect(hasher.needsRehash(hash)).toBe(false);
    });

    it('needsRehash is true for an unparseable hash', async () => {
      const hasher = await makeHasher();
      expect(hasher.needsRehash('not-an-argon2-hash')).toBe(true);
    });

    if (makeWeakerHasher) {
      it('needsRehash flips when the stored params differ from the current config', async () => {
        const weaker = await makeWeakerHasher();
        const current = await makeHasher();
        // A hash made by the weaker (different-param) config should be flagged for rehash
        // by the current-config hasher.
        const weakHash = await weaker.hash('pw');
        expect(current.needsRehash(weakHash)).toBe(true);
        // And the current hasher's own hash is not flagged by itself.
        expect(current.needsRehash(await current.hash('pw'))).toBe(false);
      });
    }
  });
}
