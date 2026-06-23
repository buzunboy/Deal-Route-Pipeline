import type { AccessClaims } from '../../domain/index.js';

/**
 * A single JSON Web Key (the public-key fields a JWKS exposes). Kept as a vendor-free
 * structural type so the port doesn't depend on `jose` or the DOM lib — the adapter
 * maps its concrete JWK onto this. Only PUBLIC members ever appear (never the private
 * scalar `d`); the index signature carries the curve-specific public fields (`crv`,
 * `x`, `y` for EC).
 */
export interface PublicJwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  [field: string]: unknown;
}

/**
 * A JSON Web Key Set — the public-key material served at `GET /.well-known/jwks.json`.
 * Only PUBLIC keys ever appear here. Plain JSON so the domain/use-cases stay
 * vendor-free; the adapter builds it from the loaded key(s).
 */
export interface JsonWebKeySet {
  keys: PublicJwk[];
}

/**
 * TokenIssuer port (Auth/IAM). Signs + verifies the ES256 access token and exposes the
 * public JWKS. Program to THIS; the concrete `JoseTokenIssuer` (the `jose` library) is
 * injected from the one composition root (DIP) — no use-case or HTTP guard touches `jose`.
 *
 * The verifier is the trust boundary: `verifyAccess` MUST pin `algorithms: ['ES256']`
 * and validate `iss`/`aud`/`exp`, throwing on a bad alg (`none`/HS256), wrong issuer/
 * audience, expiry, or a tampered signature — alg-confusion-safe by construction. It
 * returns the validated, re-parsed `AccessClaims` (boundary-validated, never a raw decode).
 */
export interface TokenIssuer {
  /** Sign the claims into an ES256 JWS compact string (with the current `kid`). */
  signAccess(claims: AccessClaims): Promise<string>;
  /** Verify + re-parse a token to `AccessClaims`; throws on any verification failure. */
  verifyAccess(token: string): Promise<AccessClaims>;
  /** The public key set for verifiers (public-only; current + any rotation `kid`). */
  jwks(): Promise<JsonWebKeySet>;
  /** The key id stamped into newly-signed tokens' protected header. */
  currentKid(): string;
}
