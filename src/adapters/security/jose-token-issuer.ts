import { SignJWT, jwtVerify, importPKCS8, importJWK, exportJWK, type JWK } from 'jose';
import { AccessClaimsSchema, type AccessClaims } from '../../domain/index.js';
import type {
  TokenIssuer,
  JsonWebKeySet,
  PublicJwk,
  Clock,
} from '../../application/ports/index.js';

/** What jose's key-import functions return — a WebCrypto key (or raw bytes for symmetric). */
type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

/** ES256 — the one signing algorithm; pinned on both sign and verify (alg-confusion-safe). */
const ALG = 'ES256';

/** Key material config (from typed config `config.auth.jwt`). */
export interface JoseKeyConfig {
  /** ES256 private key, PEM (PKCS8) or JWK JSON string. Unset ⇒ signing disabled. */
  privateKey?: string;
  /** Key id stamped in the JWS header + JWKS. Required alongside `privateKey`. */
  kid?: string;
  /** Optional overlap key for rotation (verify-old / sign-new). PEM or JWK. */
  nextPrivateKey?: string;
  /** Key id for the rotation overlap key. */
  nextKid?: string;
  iss: string;
  aud: string;
  /** Allowed clock skew on `exp`/`nbf` in seconds (a few seconds avoids spurious 401s). */
  clockToleranceSeconds: number;
}

/** A loaded ES256 keypair slot (private for signing, public JWK for JWKS). */
interface LoadedKey {
  kid: string;
  privateKey: ImportedKey;
  publicJwk: JWK;
}

/**
 * `jose`-backed ES256 token issuer (Auth/IAM). The ONLY place the JWT library is
 * imported (DIP); the use-cases + the per-request guard depend on the `TokenIssuer`
 * port. Signs with the primary key (`kid`); verify resolves the key BY the token's
 * `kid` (so a token signed with the previous, still-published key keeps verifying
 * during a rotation overlap) and PINS `algorithms: ['ES256']` + `issuer`/`audience` —
 * a `none`/HS256 token, wrong iss/aud, expiry, or tampered signature all throw.
 *
 * Keys load lazily, memoized, on first use; `ensureReady()` lets the composition
 * root's `init()` parse them once at boot and FAIL LOUDLY on a malformed key (never
 * silently disabling auth). The injected `Clock` drives `iat`/`exp` so token tests
 * are deterministic. The verified payload is re-parsed through `AccessClaimsSchema`
 * (boundary validation — a token missing a required claim is rejected).
 */
export class JoseTokenIssuer implements TokenIssuer {
  private loaded: Promise<{ primary: LoadedKey; all: LoadedKey[] }> | null = null;

  constructor(
    private readonly config: JoseKeyConfig,
    private readonly clock: Clock,
  ) {}

  /** Parse keys once and cache. Call from the composition root's `init()` to fail-fast. */
  async ensureReady(): Promise<void> {
    await this.keys();
  }

  currentKid(): string {
    if (!this.config.kid) {
      throw new Error('TokenIssuer: AUTH_JWT_KID is not configured (signing disabled).');
    }
    return this.config.kid;
  }

  async signAccess(claims: AccessClaims): Promise<string> {
    const { primary } = await this.keys();
    // Re-validate the claims at the boundary so a malformed claim set never gets signed.
    const valid = AccessClaimsSchema.parse(claims);
    return (
      new SignJWT({
        email: valid.email,
        name: valid.name,
        role: valid.role,
        perms: valid.perms,
        token_version: valid.token_version,
        perm_version: valid.perm_version,
      })
        .setProtectedHeader({ alg: ALG, kid: primary.kid })
        // iss/aud come from the (already config-injected) claim set; verify pins the SAME
        // config values, so a token minted under the wrong realm fails its own verify (the
        // TokenIssuer contract exercises exactly that wrong-iss / wrong-aud rejection path).
        .setIssuer(valid.iss)
        .setAudience(valid.aud)
        .setSubject(valid.sub)
        .setIssuedAt(valid.iat)
        .setExpirationTime(valid.exp)
        .setJti(valid.jti)
        .sign(primary.privateKey)
    );
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { all } = await this.keys();
    // Resolve the verification key by the token's `kid` — pins ES256 and checks
    // iss/aud/exp. A bad alg (none/HS256), wrong iss/aud, expiry, or tampered sig throws.
    const { payload } = await jwtVerify(
      token,
      async (header) => {
        const match = all.find((k) => k.kid === header.kid);
        if (!match) throw new Error(`unknown kid: ${header.kid ?? '<none>'}`);
        return importJWK(match.publicJwk, ALG);
      },
      {
        algorithms: [ALG],
        issuer: this.config.iss,
        audience: this.config.aud,
        clockTolerance: this.config.clockToleranceSeconds,
        // Verify `exp`/`nbf` against the INJECTED clock (not the wall clock), so the
        // expiry check is deterministic in tests and consistent with the clock used to
        // mint `iat`/`exp`. Production injects SystemClock, so this is real time there.
        currentDate: this.clock.now(),
      },
    );
    // Re-assemble the closed claim set and boundary-validate it (rejects a token that
    // verified but is missing a required claim — never trust a raw decode).
    return AccessClaimsSchema.parse({
      iss: payload.iss,
      aud: payload.aud,
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      perms: payload.perms,
      token_version: payload.token_version,
      perm_version: payload.perm_version,
      iat: payload.iat,
      exp: payload.exp,
      jti: payload.jti,
    });
  }

  async jwks(): Promise<JsonWebKeySet> {
    const { all } = await this.keys();
    // Public-only key material. exportJWK on a public key yields no `d`; we also stamp
    // the standard JWKS fields (use=sig, alg, kid) so a generic verifier can resolve.
    return {
      keys: all.map((k) => ({ ...k.publicJwk, kid: k.kid, alg: ALG, use: 'sig' }) as PublicJwk),
    };
  }

  /** Lazily parse + memoize the key slots; throws loudly on a missing/malformed key. */
  private keys(): Promise<{ primary: LoadedKey; all: LoadedKey[] }> {
    if (this.loaded === null) this.loaded = this.loadKeys();
    return this.loaded;
  }

  private async loadKeys(): Promise<{ primary: LoadedKey; all: LoadedKey[] }> {
    if (!this.config.privateKey || !this.config.kid) {
      throw new Error(
        'TokenIssuer: AUTH_JWT_PRIVATE_KEY and AUTH_JWT_KID are required to sign/verify tokens.',
      );
    }
    const primary = await loadKeySlot(this.config.privateKey, this.config.kid);
    const all = [primary];
    if (this.config.nextPrivateKey) {
      if (!this.config.nextKid) {
        throw new Error('TokenIssuer: AUTH_JWT_PRIVATE_KEY_NEXT requires AUTH_JWT_KID_NEXT.');
      }
      all.push(await loadKeySlot(this.config.nextPrivateKey, this.config.nextKid));
    }
    return { primary, all };
  }
}

/**
 * Load one ES256 key slot from its configured string. The format is PINNED by content
 * detection — a `-----BEGIN` prefix ⇒ PKCS8 PEM (`importPKCS8`); a `{`-leading JSON ⇒
 * JWK (`importJWK`). Anything else FAILS LOUDLY (never silently disables auth). The
 * public JWK for the JWKS is derived from the private key.
 */
async function loadKeySlot(raw: string, kid: string): Promise<LoadedKey> {
  const trimmed = raw.trim();
  let privateKey: ImportedKey;
  let publicSource: JWK;
  if (trimmed.startsWith('-----BEGIN')) {
    const pem = await importPKCS8(trimmed, ALG, { extractable: true });
    privateKey = pem;
    // Derive the public JWK from the imported private key, then strip the private part.
    publicSource = await exportJWK(pem);
  } else if (trimmed.startsWith('{')) {
    let jwk: JWK;
    try {
      jwk = JSON.parse(trimmed) as JWK;
    } catch (err) {
      throw new Error(
        `TokenIssuer: AUTH_JWT_PRIVATE_KEY looks like JWK JSON but failed to parse: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    privateKey = await importJWK({ ...jwk, alg: ALG }, ALG, { extractable: true });
    publicSource = jwk;
  } else {
    throw new Error(
      'TokenIssuer: AUTH_JWT_PRIVATE_KEY must be a PKCS8 PEM ("-----BEGIN") or a JWK JSON object ("{").',
    );
  }
  // Public JWK only: drop the private scalar `d` (and any other private-only members).
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicJwk } = publicSource;
  return { kid, privateKey, publicJwk: publicJwk as JWK };
}
