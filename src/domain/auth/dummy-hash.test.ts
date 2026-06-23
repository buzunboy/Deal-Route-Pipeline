import { describe, it, expect } from 'vitest';
import { DUMMY_PASSWORD_HASH } from './dummy-hash.js';

/**
 * Structural guard on the embedded dummy hash. The behavioural guarantee (a wrong
 * password verifies false against it, and verifying COSTS a real Argon2 round) lives
 * in the `Argon2idHasher` adapter contract — that's where the SDK is available. Here
 * we only assert the literal is a well-formed Argon2id encoded string whose cost
 * params match the config defaults, so a careless edit (truncation, wrong algorithm,
 * drifted params) fails loudly in the fast unit tier.
 */
describe('DUMMY_PASSWORD_HASH', () => {
  it('is a well-formed Argon2id encoded string', () => {
    expect(DUMMY_PASSWORD_HASH.startsWith('$argon2id$')).toBe(true);
    // $argon2id$ v=19 $ m=..,t=..,p=.. $ <salt> $ <hash>
    const parts = DUMMY_PASSWORD_HASH.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[1]).toBe('argon2id');
    expect(parts[2]).toBe('v=19');
    // salt + hash segments are non-empty base64.
    expect(parts[4]!.length).toBeGreaterThan(0);
    expect(parts[5]!.length).toBeGreaterThan(0);
  });

  it('pins the OWASP-floor cost params that match the config defaults', () => {
    // Drift guard: if AUTH_ARGON2_* defaults change, regenerate this constant.
    expect(DUMMY_PASSWORD_HASH).toContain('$m=19456,t=2,p=1$');
  });
});
