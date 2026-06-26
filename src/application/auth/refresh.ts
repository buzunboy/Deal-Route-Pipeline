import {
  buildAccessClaims,
  validateRefreshRotation,
  RefreshTokenInvalidError,
  RefreshReuseDetectedError,
  AccountDisabledError,
  type StoredRefresh,
} from '../../domain/index.js';
import type { Database, TokenIssuer, Clock, Logger } from '../ports/index.js';
import { randomUUID } from 'node:crypto';
import { newRefreshToken, hashRefreshToken } from '../shared/refresh-token-crypto.js';
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
 * in. A racing replay of a just-rotated token (two tabs / a retry / a StrictMode double-
 * fire) is recognised as `concurrent`: a fresh member is minted into the same family
 * instead of revoking it, so benign concurrency can't force a logout. The decision
 * (`ok`/`concurrent`/`expired`/`reuse`/`unknown`) is the pure `validateRefreshRotation`
 * rule; this use-case wires the DB effects around it.
 */
export class RefreshUseCase {
  constructor(
    private readonly db: Database,
    private readonly tokenIssuer: TokenIssuer,
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

    // verdict === 'ok' or 'concurrent' — `stored` is the row to mint a successor from.
    // For 'concurrent' the row is already rotated-out within the grace window (a racing
    // tab/retry presented the same valid token); we issue a fresh family member rather
    // than revoke, so legitimate concurrency can't force a logout. `stored` itself stays
    // revoked — we don't re-stamp it.
    const current = stored!;
    const user = await this.db.users.getById(current.user_id);
    if (user === null || user.status !== 'active') {
      // A disabled/deleted user can't refresh back in — revoke the family and 403/401.
      await this.db.refreshTokens.revokeFamily(current.family_id, now.toISOString());
      throw new AccountDisabledError();
    }

    // 'ok' → atomically rotate (stamp the predecessor + insert the successor). 'concurrent'
    // → the row is already rotated-out within the grace window (a racing tab/retry beat this
    // one); we don't re-stamp it, we just INSERT a fresh family member so the racing caller
    // gets a working session instead of a forced logout. The live successor stays untouched.
    const concurrent = verdict === 'concurrent';
    const session = await this.mintFamilyMember(current, user, now, input, (successor) =>
      concurrent
        ? this.db.refreshTokens.issue(successor)
        : this.db.refreshTokens.rotate(current.id, successor),
    );
    this.logger.info('token refreshed', { email: user.email, concurrent });
    return session;
  }

  /**
   * Build a fresh access token + a new refresh row in `current`'s family, persist it via
   * `persist`, and return the session. Perms + perm_version are RE-RESOLVED from the DB so
   * a mid-token role/permission change is honoured on the next access token. The reads are
   * coalesced into ONE connection checkout (the auth path is the pool's heaviest consumer).
   */
  private async mintFamilyMember(
    current: StoredRefresh,
    user: NonNullable<Awaited<ReturnType<Database['users']['getById']>>>,
    now: Date,
    meta: { userAgent?: string; ip?: string },
    persist: (successor: StoredRefresh) => Promise<void>,
  ): Promise<AuthSession> {
    const { permissions, roleName, permVersion } = await this.db.claimInputsForRole(user.role_id);
    const perms = new Set(permissions);
    const claims = buildAccessClaims({
      user,
      perms,
      roleName,
      permVersion,
      now,
      ttlSeconds: this.ttls.accessSeconds,
      jti: randomUUID(),
      iss: this.realm.iss,
      aud: this.realm.aud,
    });
    const accessToken = await this.tokenIssuer.signAccess(claims);

    const rawRefresh = newRefreshToken();
    const refreshExpiresAt = new Date(now.getTime() + this.ttls.refreshSeconds * 1000);
    const successor: StoredRefresh = {
      id: randomUUID(),
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
    await persist(successor);

    return {
      accessToken,
      accessTokenExpires: claims.exp * 1000,
      refreshToken: rawRefresh,
      refreshTokenExpires: refreshExpiresAt.getTime(),
      permissions: [...perms].sort(),
      user: { id: user.id, email: user.email, name: user.name, role: roleName },
    };
  }
}
