import { describe, it, expect } from 'vitest';
import { ALL_PERMISSIONS, Permission, PERMISSION_LABELS } from './permission.js';

/**
 * Guards for the permission catalogue + its co-located label map. The
 * `satisfies Record<Permission, string>` clause is a COMPILE-time exhaustiveness
 * check; these runtime tests cover what `satisfies` cannot — a label being present
 * but empty, and the panel-enforced `system:foundations` key actually shipping in
 * the closed enum so admin auto-gets it and the Roles editor can grant it.
 */
describe('PERMISSION_LABELS', () => {
  it('has exactly one non-empty label for every permission key', () => {
    expect(Object.keys(PERMISSION_LABELS).sort()).toEqual([...ALL_PERMISSIONS].sort());
    for (const key of ALL_PERMISSIONS) {
      expect(PERMISSION_LABELS[key].trim().length).toBeGreaterThan(0);
    }
  });

  it('has no labels for keys outside the closed enum', () => {
    for (const key of Object.keys(PERMISSION_LABELS)) {
      expect(Permission.options).toContain(key);
    }
  });
});

describe('system:foundations (panel-enforced)', () => {
  it('is a member of the closed permission enum (so it is grantable + admin auto-gets it)', () => {
    expect(Permission.safeParse('system:foundations').success).toBe(true);
    expect(ALL_PERMISSIONS).toContain('system:foundations');
  });
});
