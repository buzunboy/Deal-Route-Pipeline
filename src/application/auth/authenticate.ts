import {
  buildAccessClaims,
  lockoutPolicy,
  DUMMY_PASSWORD_HASH,
  InvalidCredentialsError,
  AccountDisabledError,
  AccountLockedError,
  type User,
} from '../../domain/index.js';
import type { Database, PasswordHasher, TokenIssuer, Clock, Logger } from '../ports/index.js';
import { randomUUID } from 'node:crypto';
import { newRefreshToken, hashRefreshToken } from '../shared/refresh-token-crypto.js';

/** TTLs for the minted tokens (config `auth.ttls`). */
export interface AuthTtls {
  accessSeconds: number;
  refreshSeconds: number;
}

/** Lockout thresholds (config `auth.login`). */
export interface AuthLockoutConfig {
  maxFailedAttempts: number;
  lockoutSeconds: number;
}

/** JWT realm (config `auth.jwt`) — pinned into every minted claim set. */
export interface AuthClaimRealm {
  iss: string;
  aud: string;
}

/** Inputs to a login attempt. `userAgent`/`ip` are best-effort metadata only. */
export interface AuthenticateInput {
  email: string;
  password: string;
  userAgent?: string;
  ip?: string;
}

/**
 * The result of a successful authentication / refresh. The `refreshToken` is the RAW
 * opaque secret (returned exactly once — only its hash is stored); everything else is
 * safe to hand to the panel. Permissions are surfaced as a flat array so the panel
 * never has to decode the JWT.
 */
export interface AuthSession {
  accessToken: string;
  /** Absolute expiry of the access token (epoch ms) — the panel owns no TTL math. */
  accessTokenExpires: number;
  refreshToken: string;
  refreshTokenExpires: number;
  permissions: string[];
  user: { id: string; email: string; name: string; role: string };
}

/**
 * `AuthenticateUseCase` (Auth/IAM) — the single trust-critical login path. Verifies an
 * email+password, enforces lockout + status, mints an ES256 access JWT + an opaque
 * rotating refresh token (storing only the refresh HASH), and maintains the failed-login
 * counters. Constant-time even for an unknown email (verify against `DUMMY_PASSWORD_HASH`)
 * so login latency can't be turned into a user-enumeration oracle. Nothing here trusts a
 * body-supplied identity — the EMAIL the caller submits is the only identity input, and it
 * must match a real `active` user with the right password.
 */
export class AuthenticateUseCase {
  constructor(
    private readonly db: Database,
    private readonly hasher: PasswordHasher,
    private readonly tokenIssuer: TokenIssuer,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly ttls: AuthTtls,
    private readonly lockout: AuthLockoutConfig,
    private readonly realm: AuthClaimRealm,
  ) {}

  async authenticate(input: AuthenticateInput): Promise<AuthSession> {
    const email = input.email.trim().toLowerCase();
    const user = await this.db.users.getByEmail(email);

    // Unknown email: run a real verify against the dummy hash (discarding the result) so
    // the wall-clock cost matches a real login, then fail with the SAME generic 401 — no
    // "no such user" leak, no timing leak.
    if (user === null) {
      await this.hasher.verify(DUMMY_PASSWORD_HASH, input.password);
      throw new InvalidCredentialsError();
    }

    // Lockout is checked BEFORE the password compare and BEFORE the disabled check, so a
    // locked account returns 429 (with a Retry-After the handler derives from lockedUntil)
    // regardless of whether this particular attempt's password is right. The stored
    // `locked_until` is the authoritative lock-EXPIRY (the pure `lockoutPolicy` already
    // computed it on the failing attempt); the read path just compares it to `now`, using
    // the SAME boundary semantics as the policy (`now >= lockedUntil` ⇒ lifted/auto-unlock).
    const loginState = await this.db.users.getLoginState(user.id);
    const lockedUntil = loginState?.lockedUntil ? new Date(loginState.lockedUntil) : null;
    if (lockedUntil !== null && this.clock.now().getTime() < lockedUntil.getTime()) {
      throw new AccountLockedError(lockedUntil);
    }

    if (user.status !== 'active') throw new AccountDisabledError();

    const storedHash = await this.db.users.getPasswordHashByEmail(email);
    // A user with no password hash (e.g. SSO-only, or never set) can never log in by
    // password — verify against the dummy hash to keep timing uniform, then 401.
    const ok =
      storedHash !== null
        ? await this.hasher.verify(storedHash, input.password)
        : (await this.hasher.verify(DUMMY_PASSWORD_HASH, input.password), false);

    if (!ok) {
      await this.recordFailure(user.id);
      throw new InvalidCredentialsError();
    }

    // Success: clear the failure counters + stamp last_login_at, and transparently
    // upgrade the hash if its cost params lag the current config (same credential, so
    // NO token_version bump).
    await this.db.users.recordLogin(user.id, this.clock.nowIso());
    if (storedHash !== null && this.hasher.needsRehash(storedHash)) {
      try {
        await this.db.users.updatePasswordHash(user.id, await this.hasher.hash(input.password));
      } catch (err) {
        // A best-effort rehash must never fail an otherwise-valid login.
        this.logger.warn('password rehash failed (login still succeeds)', {
          email,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const session = await this.mintSession(user, input);
    this.logger.info('login succeeded', { email });
    return session;
  }

  /**
   * Mint an access JWT + a refresh token for an already-authenticated user. Shared with
   * `RefreshUseCase` so the claim set + refresh-row shape are identical on login and
   * rotation. `familyId` defaults to a new lineage (login); refresh passes the existing
   * family so the rotation chain stays linked.
   */
  async mintSession(
    user: User,
    meta: { userAgent?: string; ip?: string },
    familyId: string = randomUUID(),
  ): Promise<AuthSession> {
    // Coalesce the three claim-minting reads (perms + role name + perm_version) into ONE
    // connection checkout — the auth path is the pool's heaviest consumer. `user` is already
    // in hand, so we key off `user.role_id` (no redundant users.getById that the old
    // `permissionsForUser(user.id)` did). Deny-by-default semantics are preserved by the port.
    const { permissions, roleName, permVersion } = await this.db.claimInputsForRole(user.role_id);
    const perms = new Set(permissions);
    const now = this.clock.now();
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
    const refreshIssuedAt = now;
    const refreshExpiresAt = new Date(now.getTime() + this.ttls.refreshSeconds * 1000);
    await this.db.refreshTokens.issue({
      id: randomUUID(),
      user_id: user.id,
      token_hash: hashRefreshToken(rawRefresh),
      family_id: familyId,
      issued_at: refreshIssuedAt.toISOString(),
      expires_at: refreshExpiresAt.toISOString(),
      revoked_at: null,
      replaced_by: null,
      user_agent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    });

    return {
      accessToken,
      accessTokenExpires: claims.exp * 1000,
      refreshToken: rawRefresh,
      refreshTokenExpires: refreshExpiresAt.getTime(),
      permissions: [...perms].sort(),
      user: { id: user.id, email: user.email, name: user.name, role: roleName },
    };
  }

  /** Increment the failure counter and, when the threshold is crossed, stamp locked_until. */
  private async recordFailure(userId: string): Promise<void> {
    const now = this.clock.now();
    const newCount = await this.db.users.recordFailedLogin(userId, now.toISOString());
    const decision = lockoutPolicy(newCount, now, now, {
      maxFailedAttempts: this.lockout.maxFailedAttempts,
      lockoutSeconds: this.lockout.lockoutSeconds,
    });
    // `lockoutPolicy` with lastFailedAt=now returns locked=true exactly when the new count
    // is at/above the threshold — so we persist locked_until precisely at the boundary.
    await this.db.users.setLockedUntil(userId, decision.lockedUntil?.toISOString() ?? null);
  }
}
