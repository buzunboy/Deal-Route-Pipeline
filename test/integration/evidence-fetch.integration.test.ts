import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import { ReviewApi } from '../../src/adapters/http/review-api.js';
import { ConsoleLogger } from '../../src/adapters/logger/console-logger.js';
import { SYSTEM_ROLE_REVIEWER_ID, UserSchema } from '../../src/domain/index.js';
import type { Container } from '../../src/composition/container.js';

/**
 * The gated reviewer evidence-fetch endpoint end to end through the REAL composition
 * root + the REAL local-fs EvidenceStore the Container builds:
 *   1. save a real bundle through `container.evidenceStore` (writes screenshot/html/terms
 *      to disk via the production store);
 *   2. drive `GET /api/evidence/:id/:artifact` over a real socket with a real per-user token;
 *   3. assert the bytes round-trip + content-type + the per-user-JWT gate.
 * Covers the store→port→HTTP wiring a unit test with a fake can't (the real local-fs
 * read path back off disk). Auth/IAM Phase 5: the gate is a per-user JWT, not a static token.
 */
const suite = hasDb ? describe : describe.skip;

const overrides = {
  fetcher: new ScriptedFetcher({}),
  llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [] }) }),
};

const SCREENSHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const HTML = '<html><body>archived snapshot</body></html>';
const TERMS = 'Disney+ ist im Tarif enthalten. (verbatim)';

// One real ES256 keypair for the file — the reviewer role holds `evidence:read`.
let pkcs8Pem: string;

suite('gated evidence-fetch endpoint (Container + real local-fs store)', () => {
  beforeAll(async () => {
    if (!hasDb) return;
    await applyMigrations();
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    pkcs8Pem = await exportPKCS8(privateKey);
  });
  beforeEach(resetDb);

  let container: Container;
  let api: ReviewApi;
  let base: string;
  let token: string;

  afterEach(async () => {
    await api?.close();
    await container?.shutdown();
  });

  /** Build the Container, seed a reviewer + mint its token, save a bundle, mount the API. */
  async function setup(): Promise<string> {
    container = makeContainer(overrides, {
      AUTH_JWT_PRIVATE_KEY: pkcs8Pem,
      AUTH_JWT_KID: 'it-key-1',
      AUTH_ACCESS_TTL_SECONDS: '900',
    });
    await container.init();
    // Seed an active reviewer (the reviewer role grants `evidence:read`) and log in for a token.
    const user = UserSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Reviewer Rita',
      email: 'rita@dealroute.de',
      role_id: SYSTEM_ROLE_REVIEWER_ID,
      status: 'active',
      auth_provider: 'password',
      google_sub: null,
      token_version: 0,
      created_at: container.clock.nowIso(),
    });
    await container.db.users.insert(user, await container.passwordHasher.hash('a-strong-password'));
    const session = await container.authenticateUser.authenticate({
      email: 'rita@dealroute.de',
      password: 'a-strong-password',
    });
    token = session.accessToken;
    const ev = await container.evidenceStore.save({
      sourceUrl: 'https://www.telekom.de/magenta-tv',
      screenshot: SCREENSHOT,
      html: HTML,
      termsText: TERMS,
      capturedAt: '2026-06-19T00:00:00.000Z',
      contentHash: 'h',
    });
    api = new ReviewApi(
      container.review,
      container.sourceReview,
      container.team,
      container.alerts,
      container.metrics,
      container.settings,
      container.evidenceStore,
      new ConsoleLogger('error'),
      {
        auth: {
          tokenIssuer: container.tokenIssuer,
          db: container.db,
          authorization: container.authorization,
          provisionUser: container.provisionUser,
          manageRoles: container.manageRoles,
        },
      },
    );
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    base = `http://localhost:${(api['server'].address() as AddressInfo).port}`;
    return ev.id;
  }

  it('streams each artifact back with the right bytes + content-type (with token)', async () => {
    const id = await setup();
    const auth = { authorization: `Bearer ${token}` };

    const shot = await fetch(`${base}/api/evidence/${id}/screenshot`, { headers: auth });
    expect(shot.status).toBe(200);
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect(Array.from(new Uint8Array(await shot.arrayBuffer()))).toEqual(Array.from(SCREENSHOT));

    const html = await fetch(`${base}/api/evidence/${id}/html`, { headers: auth });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await html.text()).toBe(HTML);

    const terms = await fetch(`${base}/api/evidence/${id}/terms`, { headers: auth });
    expect(terms.status).toBe(200);
    expect(terms.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await terms.text()).toBe(TERMS);
  });

  it('401s without the bearer token, 404s an absent bundle', async () => {
    const id = await setup();
    const noAuth = await fetch(`${base}/api/evidence/${id}/terms`);
    expect(noAuth.status).toBe(401);

    const absent = await fetch(
      `${base}/api/evidence/00000000-0000-0000-0000-000000000000/screenshot`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(absent.status).toBe(404);
  });
});
