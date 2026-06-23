import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import { ReviewApi } from '../../src/adapters/http/review-api.js';
import { ConsoleLogger } from '../../src/adapters/logger/console-logger.js';
import type { Container } from '../../src/composition/container.js';

/**
 * The gated reviewer evidence-fetch endpoint end to end through the REAL composition
 * root + the REAL local-fs EvidenceStore the Container builds:
 *   1. save a real bundle through `container.evidenceStore` (writes screenshot/html/terms
 *      to disk via the production store);
 *   2. drive `GET /api/evidence/:id/:artifact` over a real socket;
 *   3. assert the bytes round-trip + content-type + the bearer gate.
 * Covers the store→port→HTTP wiring a unit test with a fake can't (the real local-fs
 * read path back off disk).
 */
const suite = hasDb ? describe : describe.skip;

const overrides = {
  fetcher: new ScriptedFetcher({}),
  llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [] }) }),
};

const SCREENSHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const HTML = '<html><body>archived snapshot</body></html>';
const TERMS = 'Disney+ ist im Tarif enthalten. (verbatim)';
const TOKEN = 'it-secret-token';

suite('gated evidence-fetch endpoint (Container + real local-fs store)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  let api: ReviewApi;
  let base: string;

  afterEach(async () => {
    await api?.close();
    await container?.shutdown();
  });

  /** Build the Container, save a real bundle, mount a ReviewApi over its store, listen. */
  async function setup(): Promise<string> {
    container = makeContainer(overrides);
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
      { authToken: TOKEN },
    );
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    base = `http://localhost:${(api['server'].address() as AddressInfo).port}`;
    return ev.id;
  }

  it('streams each artifact back with the right bytes + content-type (with token)', async () => {
    const id = await setup();
    const auth = { authorization: `Bearer ${TOKEN}` };

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
        headers: { authorization: `Bearer ${TOKEN}` },
      },
    );
    expect(absent.status).toBe(404);
  });
});
