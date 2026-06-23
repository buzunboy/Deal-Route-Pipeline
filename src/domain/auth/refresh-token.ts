import { z } from 'zod';

/**
 * A stored refresh-token row (Auth/IAM, `refresh_tokens` table — migration 0023).
 * The opaque token itself is NEVER stored — only its SHA-256 hash (`token_hash`),
 * so a DB leak yields nothing usable. `family_id` links a rotation lineage: every
 * rotation issues a successor under the SAME family, so presenting a rotated-out
 * member ⇒ reuse-detection ⇒ revoke the whole family.
 *
 * A row is "current" when `revoked_at === null` AND `replaced_by === null`; a
 * rotation stamps both on the predecessor and inserts the successor. `RefreshReuse`
 * is "a row already revoked/replaced was presented again".
 */
export const StoredRefreshSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  /** SHA-256 hex of the opaque token (never the token itself). */
  token_hash: z.string().min(1),
  /** Rotation lineage — shared across a family for reuse-detection. */
  family_id: z.string().uuid(),
  issued_at: z.string().min(1), // ISO-8601
  expires_at: z.string().min(1), // ISO-8601
  /** Set when this row is rotated out or revoked; null while current. */
  revoked_at: z.string().nullable().default(null),
  /** The rotation successor's id; null until rotated. */
  replaced_by: z.string().uuid().nullable().default(null),
  user_agent: z.string().nullable().default(null),
  ip: z.string().nullable().default(null),
});
export type StoredRefresh = z.infer<typeof StoredRefreshSchema>;
