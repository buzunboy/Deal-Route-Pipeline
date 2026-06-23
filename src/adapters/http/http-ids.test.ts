import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isUuid } from './http-ids.js';

describe('isUuid', () => {
  it('accepts a canonical UUID (any case)', () => {
    const id = randomUUID();
    expect(isUuid(id)).toBe(true);
    expect(isUuid(id.toUpperCase())).toBe(true);
  });

  it('rejects non-UUID strings (the malformed-:id case that would 500 at the DB)', () => {
    for (const bad of ['', 'abc', 'not-a-uuid', '123', `${randomUUID()}x`, ` ${randomUUID()}`]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});
