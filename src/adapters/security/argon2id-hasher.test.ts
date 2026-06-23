import { describe, it, expect } from 'vitest';
import { Argon2idHasher } from './argon2id-hasher.js';
import { passwordHasherContract } from '../../../test/contracts/password-hasher-contract.js';
import { DUMMY_PASSWORD_HASH } from '../../domain/index.js';

// Fast-but-real Argon2id params for tests (lower memory than the production OWASP floor
// so the suite stays quick; still a genuine memory-hard hash, exercising the real SDK).
const TEST_PARAMS = { memoryCost: 4096, timeCost: 1, parallelism: 1 };
const STRONGER_PARAMS = { memoryCost: 8192, timeCost: 2, parallelism: 1 };

passwordHasherContract(
  'Argon2idHasher',
  () => new Argon2idHasher(TEST_PARAMS),
  () => new Argon2idHasher(STRONGER_PARAMS),
);

describe('Argon2idHasher — DUMMY_PASSWORD_HASH behavioural guard', () => {
  // The domain constant must be a usable Argon2id hash: verifying a wrong password
  // against it returns false but actually RUNS the hasher (the constant-time unknown-email
  // path). A hasher at the OWASP-floor params (which DUMMY_PASSWORD_HASH was generated at).
  const owasp = new Argon2idHasher({ memoryCost: 19456, timeCost: 2, parallelism: 1 });

  it('verifying any password against the dummy hash returns false (no real user matches it)', async () => {
    expect(await owasp.verify(DUMMY_PASSWORD_HASH, 'guess')).toBe(false);
    expect(await owasp.verify(DUMMY_PASSWORD_HASH, '')).toBe(false);
  });

  it('the dummy hash does not need rehashing at the OWASP-floor params it was generated at', () => {
    expect(owasp.needsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
