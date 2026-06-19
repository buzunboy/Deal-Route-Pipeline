import { randomUUID } from 'node:crypto';

/** Single source of new ids. Wrapped so it can be swapped/seeded in tests. */
export function newId(): string {
  return randomUUID();
}
