import { describe, it, expect } from 'vitest';
import { SignJWT, type JWK } from 'jose';
import type { TokenIssuer, Clock } from '../../src/application/ports/index.js';
import type { AccessClaims } from '../../src/domain/index.js';

/**
 * Shared contract suite for the TokenIssuer port — the auth trust boundary. Every
 * implementation must: round-trip sign↔verify to the EXACT claims; REJECT `alg:none`,
 * an HS256-swapped token, an expired token, a wrong `iss`/`aud`, and a tampered
 * signature; and expose a public-only JWKS with the right `kid`. These are the
 * adversarial boundary tests `testing.md` mandates for a new parser/verifier.
 *
 * `makeIssuer(clock)` returns the issuer under test wired to the given Clock (so `exp`
 * can be crossed deterministically). `iss`/`aud` are the issuer's configured values.
 * `attackerPublicJwk()` returns the public key the verifier would resolve — used to
 * forge an HS256 token signed with the public key (the classic alg-confusion attack).
 */
export interface TokenIssuerContractDeps {
  name: string;
  iss: string;
  aud: string;
  makeIssuer: (clock: Clock) => TokenIssuer | Promise<TokenIssuer>;
  /** The public key material (JWK) the issuer publishes — for forging an alg-swap token. */
  publicJwk: () => Promise<JWK>;
}

class StubClock implements Clock {
  constructor(private d: Date) {}
  set(d: Date): void {
    this.d = d;
  }
  now(): Date {
    return this.d;
  }
  nowIso(): string {
    return this.d.toISOString();
  }
}

export function tokenIssuerContract(deps: TokenIssuerContractDeps): void {
  const NOW = new Date('2026-06-19T00:00:00.000Z');
  const iatSec = Math.floor(NOW.getTime() / 1000);

  function claims(overrides: Partial<AccessClaims> = {}): AccessClaims {
    return {
      iss: deps.iss,
      aud: deps.aud,
      sub: '33333333-3333-3333-3333-333333333333',
      email: 'reviewer@dealroute.de',
      name: 'Reviewer Rita',
      role: 'reviewer',
      perms: ['candidate:approve', 'candidate:reject'],
      token_version: 3,
      perm_version: 12,
      iat: iatSec,
      exp: iatSec + 900,
      jti: 'jti-1',
      ...overrides,
    };
  }

  describe(`TokenIssuer contract: ${deps.name}`, () => {
    it('sign → verify round-trips to the exact claims', async () => {
      const issuer = await deps.makeIssuer(new StubClock(NOW));
      const token = await issuer.signAccess(claims());
      const verified = await issuer.verifyAccess(token);
      expect(verified).toEqual(claims());
    });

    it('rejects an alg:none token', async () => {
      const issuer = await deps.makeIssuer(new StubClock(NOW));
      // Hand-craft an unsigned (alg:none) JWT with otherwise-valid claims.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ ...claims(), iss: deps.iss, aud: deps.aud }),
      ).toString('base64url');
      const noneToken = `${header}.${payload}.`;
      await expect(issuer.verifyAccess(noneToken)).rejects.toBeTruthy();
    });

    it('rejects an HS256 token signed with the public key (alg confusion)', async () => {
      const issuer = await deps.makeIssuer(new StubClock(NOW));
      const pub = await deps.publicJwk();
      // Use the public JWK's bytes as an HMAC secret — the classic confusion attack.
      const secret = new TextEncoder().encode(JSON.stringify(pub));
      const forged = await new SignJWT({
        email: 'attacker@evil',
        name: 'x',
        role: 'admin',
        perms: [],
        token_version: 0,
        perm_version: 0,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(deps.iss)
        .setAudience(deps.aud)
        .setSubject('00000000-0000-0000-0000-000000000000')
        .setIssuedAt(iatSec)
        .setExpirationTime(iatSec + 900)
        .setJti('forged')
        .sign(secret);
      await expect(issuer.verifyAccess(forged)).rejects.toBeTruthy();
    });

    it('rejects an expired token (clock advanced past exp)', async () => {
      const clock = new StubClock(NOW);
      const issuer = await deps.makeIssuer(clock);
      const token = await issuer.signAccess(claims({ exp: iatSec + 60 }));
      clock.set(new Date((iatSec + 3600) * 1000)); // an hour later, well past exp + tolerance
      await expect(issuer.verifyAccess(token)).rejects.toBeTruthy();
    });

    it('rejects a wrong issuer', async () => {
      const issuer = await deps.makeIssuer(new StubClock(NOW));
      const token = await issuer.signAccess(claims({ iss: 'evil-issuer' }));
      await expect(issuer.verifyAccess(token)).rejects.toBeTruthy();
    });

    it('rejects a wrong audience', async () => {
      const issuer = await deps.makeIssuer(new StubClock(NOW));
      const token = await issuer.signAccess(claims({ aud: 'evil-audience' }));
      await expect(issuer.verifyAccess(token)).rejects.toBeTruthy();
    });

    it('rejects a tampered signature', async () => {
      const issuer = await deps.makeIssuer(new StubClock(NOW));
      const token = await issuer.signAccess(claims());
      const [h, p] = token.split('.');
      const tampered = `${h}.${p}.AAAAtamperedAAAA`;
      await expect(issuer.verifyAccess(tampered)).rejects.toBeTruthy();
    });

    it('jwks() exposes public-only keys with the right kid and no private scalar', async () => {
      const issuer = await deps.makeIssuer(new StubClock(NOW));
      const jwks = await issuer.jwks();
      expect(jwks.keys.length).toBeGreaterThanOrEqual(1);
      const key = jwks.keys.find((k) => k.kid === issuer.currentKid());
      expect(key).toBeTruthy();
      expect(key!.kty).toBe('EC');
      expect((key as Record<string, unknown>).crv).toBe('P-256');
      expect(key!.alg).toBe('ES256');
      expect(key!.use).toBe('sig');
      // Never leak the private scalar.
      expect('d' in (key as Record<string, unknown>)).toBe(false);
    });
  });
}
