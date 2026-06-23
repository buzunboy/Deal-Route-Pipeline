import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportPKCS8, exportJWK, SignJWT, importPKCS8, type JWK } from 'jose';
import { JoseTokenIssuer, type JoseKeyConfig } from './jose-token-issuer.js';
import { tokenIssuerContract } from '../../../test/contracts/token-issuer-contract.js';
import type { Clock } from '../../application/ports/index.js';

const ISS = 'dealroute-pipeline';
const AUD = 'dealroute-panel';
const KID = 'test-key-1';

// One ES256 keypair generated once for the whole file, materialised as both PEM (PKCS8)
// and JWK so we can exercise both key-load formats the adapter pins.
let pkcs8Pem: string;
let privateJwkJson: string;
let publicJwk: JWK;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  pkcs8Pem = await exportPKCS8(privateKey);
  const jwk = await exportJWK(privateKey);
  privateJwkJson = JSON.stringify(jwk);
  const { d: _d, ...pub } = jwk;
  publicJwk = pub;
});

function baseConfig(overrides: Partial<JoseKeyConfig> = {}): JoseKeyConfig {
  return {
    privateKey: pkcs8Pem,
    kid: KID,
    iss: ISS,
    aud: AUD,
    clockToleranceSeconds: 5,
    ...overrides,
  };
}

// Run the shared port-contract suite against the PEM-keyed issuer.
tokenIssuerContract({
  name: 'JoseTokenIssuer (PEM key)',
  iss: ISS,
  aud: AUD,
  makeIssuer: (clock: Clock) => new JoseTokenIssuer(baseConfig(), clock),
  publicJwk: async () => publicJwk,
});

// And against the JWK-keyed issuer, proving both key formats are substitutable.
tokenIssuerContract({
  name: 'JoseTokenIssuer (JWK key)',
  iss: ISS,
  aud: AUD,
  makeIssuer: (clock: Clock) =>
    new JoseTokenIssuer(baseConfig({ privateKey: privateJwkJson }), clock),
  publicJwk: async () => publicJwk,
});

class FixedClock implements Clock {
  constructor(private readonly d: Date) {}
  now(): Date {
    return this.d;
  }
  nowIso(): string {
    return this.d.toISOString();
  }
}

const NOW = new Date('2026-06-19T00:00:00.000Z');
const iatSec = Math.floor(NOW.getTime() / 1000);

describe('JoseTokenIssuer — key loading + boot guard', () => {
  it('fails loudly when the signing key is unset (auth disabled)', async () => {
    const issuer = new JoseTokenIssuer(baseConfig({ privateKey: undefined }), new FixedClock(NOW));
    await expect(issuer.ensureReady()).rejects.toThrow(/AUTH_JWT_PRIVATE_KEY/);
  });

  it('fails loudly on a malformed key (never silently disables auth)', async () => {
    const issuer = new JoseTokenIssuer(
      baseConfig({ privateKey: 'this is neither PEM nor JWK' }),
      new FixedClock(NOW),
    );
    await expect(issuer.ensureReady()).rejects.toThrow(/PKCS8 PEM .* JWK JSON/);
  });

  it('fails loudly on JWK-looking but unparseable JSON', async () => {
    const issuer = new JoseTokenIssuer(
      baseConfig({ privateKey: '{ not valid json' }),
      new FixedClock(NOW),
    );
    await expect(issuer.ensureReady()).rejects.toThrow(/JWK JSON but failed to parse/);
  });

  it('currentKid is the configured kid', () => {
    const issuer = new JoseTokenIssuer(baseConfig(), new FixedClock(NOW));
    expect(issuer.currentKid()).toBe(KID);
  });
});

describe('JoseTokenIssuer — rotation overlap', () => {
  let nextPkcs8: string;
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    nextPkcs8 = await exportPKCS8(privateKey);
  });

  it('jwks() publishes BOTH kids during overlap; a token signed by the previous primary still verifies', async () => {
    // Issuer A signs with the soon-to-be-previous key (KID).
    const issuerOld = new JoseTokenIssuer(baseConfig(), new FixedClock(NOW));
    const token = await issuerOld.signAccess({
      iss: ISS,
      aud: AUD,
      sub: '33333333-3333-3333-3333-333333333333',
      email: 'rita@dealroute.de',
      name: 'Rita',
      role: 'reviewer',
      perms: ['candidate:approve'],
      token_version: 1,
      perm_version: 0,
      iat: iatSec,
      exp: iatSec + 900,
      jti: 'rot-1',
    });
    // Issuer B has promoted the NEW key to primary but keeps the OLD key in the NEXT slot,
    // so JWKS serves both and the old-kid token still verifies.
    const issuerNew = new JoseTokenIssuer(
      baseConfig({
        privateKey: nextPkcs8,
        kid: 'test-key-2',
        nextPrivateKey: pkcs8Pem,
        nextKid: KID,
      }),
      new FixedClock(NOW),
    );
    const jwks = await issuerNew.jwks();
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual(['test-key-1', 'test-key-2']);
    const verified = await issuerNew.verifyAccess(token);
    expect(verified.jti).toBe('rot-1');
    expect(issuerNew.currentKid()).toBe('test-key-2');
  });
});

describe('JoseTokenIssuer — schema guard on a cryptographically-valid token', () => {
  it('rejects a properly-signed token that is missing a required claim', async () => {
    const issuer = new JoseTokenIssuer(baseConfig(), new FixedClock(NOW));
    // Sign with the REAL private key, but omit `perms`/`token_version`/`perm_version`.
    const key = await importPKCS8(pkcs8Pem, 'ES256');
    const incomplete = await new SignJWT({
      email: 'rita@dealroute.de',
      name: 'Rita',
      role: 'reviewer',
    })
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject('33333333-3333-3333-3333-333333333333')
      .setIssuedAt(iatSec)
      .setExpirationTime(iatSec + 900)
      .setJti('incomplete')
      .sign(key);
    // It verifies cryptographically, but the AccessClaimsSchema re-parse rejects it.
    await expect(issuer.verifyAccess(incomplete)).rejects.toBeTruthy();
  });
});
