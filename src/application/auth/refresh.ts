import {
  buildAccessClaims,
  validateRefreshRotation,
  RefreshTokenInvalidError,
  RefreshReuseDetectedError,
  AccountDisabledError,
  type StoredRefresh,
} from '../../domain/index.js';
import type { Database, TokenIssuer, Clock, Logger } from '../ports/index.js';
import { newId } from '../shared/id.js';
import { newRefreshToken, hashRefreshToken } from '../shared/refresh-token-crypto.js';
import { AuthorizationUseCase } from './authorization.js';
import type { AuthSession, AuthTtls, AuthClaimRealm } from './authenticate.js';

/** Inputs to a refresh. `userAgent`/`ip` are best-effort metadata for the new row. */
export interface RefreshInput {
  refreshToken: string;
  userAgent?: string;
  ip?: string;
}

/**
 * `RefreshUseCase` (Auth/IAM) — the rotating-refresh + reuse-detection core. Each refresh
 * REVOKES the presented token and issues a successor in the SAME family, so a stolen-then-
 * rotated token, when replayed, is recognised as a revoked family member and the WHOLE
 * family is revoked (theft response → every session in that lineage dies). It also
 * re-checks `status` + `token_version`, so a user disabled mid-session can't refresh back
 * in. The decision (`ok`/`expired`/`reuse`/`unknown`) is the pure `validateRefreshRotation`
 * rule; this use-case wires the DB effects around it.
 */
export class RefreshUseCase {
  constructor(
    private readonly db: Database,
    private readonly tokenIssuer: TokenIssuer,
    private readonly authorization: AuthorizationUseCase,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly ttls: AuthTtls,
    private readonly realm: AuthClaimRealm,
  ) {}

  async refresh(input: RefreshInput): Promise<AuthSession> {
    const now = this.clock.now();
    const presentedHash = hashRefreshToken(input.refreshToken);
    const stored = await this.db.refreshTokens.findByHash(presentedHash);

    const verdict = validateRefreshRotation(stored, now);
    if (verdict === 'unknown' || verdict === 'expired') {
      throw new RefreshTokenInvalidError();
    }
    if (verdict === 'reuse') {
      // A rotated-out token was replayed → kill the whole lineage (theft response).
      await this.db.refreshTokens.revokeFamily(stored!.family_id, now.toISOString());
      this.logger.warn('refresh reuse detected; family revoked', { family_id: stored!.family_id });
      throw new RefreshReuseDetectedError();
    }

    // verdict === 'ok' — `stored` is a current, unexpired row.
    const current = stored!;
    const user = await this.db.users.getById(current.user_id);
    if (user === null || user.status !== 'active') {
      // A disabled/deleted user can't refresh back in — revoke the family and 403/401.
      await this.db.refreshTokens.revokeFamily(current.family_id, now.toISOString());
      throw new AccountDisabledError();
    }

    // Mint the new pair, rotating the old row (same family) atomically.
    const session = await this.rotate(current, user, now, input);
    this.logger.info('token refreshed', { email: user.email });
    return session;
  }

  /**
   * Build the successor refresh row + a fresh access token, then atomically rotate (stamp
   * the predecessor `revoked_at`/`replaced_by` and insert the successor). Perms +
   * perm_version are RE-RESOLVED from the DB so a mid-token role/permission change is
   * honoured on the next access token.
   */
  private async rotate(
    current: StoredRefresh,
    user: NonNullable<Awaited<ReturnType<Database['users']['getById']>>>,
    now: Date,
    meta: { userAgent?: string; ip?: string },
  ): Promise<AuthSession> {
    const perms = await this.authorization.permissionsForUser(user.id);
    const permVersion = await this.db.authMeta.getPermVersion();
    const role = await this.db.roles.getById(user.role_id);
    const claims = buildAccessClaims({
      user,
      perms,
      roleName: role?.name ?? '',
      permVersion,
      now,
      ttlSeconds: this.ttls.accessSeconds,
      jti: newId(),
      iss: this.realm.iss,
      aud: this.realm.aud,
    });
    const accessToken = await this.tokenIssuer.signAccess(claims);

    const rawRefresh = newRefreshToken();
    const refreshExpiresAt = new Date(now.getTime() + this.ttls.refreshSeconds * 1000);
    const successor: StoredRefresh = {
      id: newId(),
      user_id: user.id,
      token_hash: hashRefreshToken(rawRefresh),
      family_id: current.family_id, // SAME lineage
      issued_at: now.toISOString(),
      expires_at: refreshExpiresAt.toISOString(),
      revoked_at: null,
      replaced_by: null,
      user_agent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    };
    await this.db.refreshTokens.rotate(current.id, successor);

    return {
      accessToken,
      accessTokenExpires: claims.exp * 1000,
      refreshToken: rawRefresh,
      refreshTokenExpires: refreshExpiresAt.getTime(),
      permissions: [...perms].sort(),
      user: { id: user.id, email: user.email, name: user.name, role: role?.name ?? '' },
    };
  }
}
