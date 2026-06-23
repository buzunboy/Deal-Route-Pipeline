import { hashRefreshToken } from '../shared/refresh-token-crypto.js';
import type { Database, Clock, Logger } from '../ports/index.js';

/**
 * `LogoutUseCase` (Auth/IAM) — end sessions.
 *
 * - `logout(refreshToken)` revokes the presented token's whole FAMILY (so the rotation
 *   lineage dies, not just the one row). IDEMPOTENT: an unknown / already-revoked token
 *   is a silent no-op — logout must never error-leak whether a token was valid.
 * - `logoutEverywhere(userId)` revokes every refresh family for the user AND bumps the
 *   user's `token_version`, so every outstanding ACCESS token 401s on its next pipeline
 *   request (the immediate global cut). Used by the admin "log out everywhere" action.
 */
export class LogoutUseCase {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async logout(refreshToken: string): Promise<void> {
    const stored = await this.db.refreshTokens.findByHash(hashRefreshToken(refreshToken));
    if (stored === null) return; // unknown token — silent no-op (no validity oracle)
    await this.db.refreshTokens.revokeFamily(stored.family_id, this.clock.nowIso());
    this.logger.info('logout', { family_id: stored.family_id });
  }

  async logoutEverywhere(userId: string): Promise<void> {
    await this.db.refreshTokens.revokeAllForUser(userId, this.clock.nowIso());
    await this.db.users.bumpTokenVersion(userId);
    this.logger.info('logout everywhere', { user_id: userId });
  }
}
