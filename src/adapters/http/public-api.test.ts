import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { PublicApi } from './public-api.js';
import { InMemoryDb } from '../db/in-memory/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { DealStatus, type DealRecord } from '../../domain/index.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';

/** Drives the real PublicApi handler over a real socket end-to-end. */
describe('PublicApi (/v1 HTTP integration)', () => {
  let db: InMemoryDb;
  let server: Server;
  let base: string;
  const NOW = new Date('2026-06-20T00:00:00.000Z');

  function publishedDeal(overrides: Partial<DealRecord> = {}): DealRecord {
    return {
      ...makeLlmDeal(),
      id: randomUUID(),
      schema_version: 1,
      true_cost_monthly: 10,
      evidence_id: randomUUID(),
      status: DealStatus.enum.published,
      verified_by: 'reviewer',
      verified_at: '2026-06-19T00:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(async () => {
    db = new InMemoryDb();
    const api = new PublicApi(db.deals, new FixedClock(NOW), new FakeLogger(), {
      cdnBaseUrl: 'https://cdn.example.com',
      corsAllowOrigin: '*',
    });
    server = createServer((req, res) => {
      api.handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('GET /v1/health returns ok with CORS', async () => {
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /v1/deals returns ONLY published deals, with total/limit/offset envelope', async () => {
    const service = `svc-${randomUUID()}`;
    await db.deals.insert(publishedDeal({ service }));
    await db.deals.insert(publishedDeal({ service, status: DealStatus.enum.candidate }));
    await db.deals.insert(publishedDeal({ service, status: DealStatus.enum.expired }));

    const res = await fetch(`${base}/v1/deals?service=${service}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deals: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.deals).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it('filters, sorts and paginates', async () => {
    const service = `svc-${randomUUID()}`;
    for (const c of [5, 15, 25]) {
      await db.deals.insert(publishedDeal({ service, true_cost_monthly: c }));
    }
    // priceMax=20 → 5 and 15; sort cost_asc; limit 1 offset 1 → the 15 deal.
    const res = await fetch(
      `${base}/v1/deals?service=${service}&price_max=20&sort=cost_asc&limit=1&offset=1`,
    );
    const body = (await res.json()) as { deals: { true_cost_monthly: number }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.deals.map((d) => d.true_cost_monthly)).toEqual([15]);
  });

  it('GET /v1/deals/:id returns a published deal', async () => {
    const deal = publishedDeal();
    await db.deals.insert(deal);
    const res = await fetch(`${base}/v1/deals/${deal.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deal: { id: string; trust: string; evidence_screenshot_url: string };
    };
    expect(body.deal.id).toBe(deal.id);
    expect(body.deal.trust).toBe('recent'); // verified 1 day before NOW
    expect(body.deal.evidence_screenshot_url).toBe(
      `https://cdn.example.com/${deal.evidence_id}/screenshot.png`,
    );
  });

  it('GET /v1/deals/:id 404s a non-published deal (never leaks it)', async () => {
    const candidate = publishedDeal({ status: DealStatus.enum.candidate });
    await db.deals.insert(candidate);
    const res = await fetch(`${base}/v1/deals/${candidate.id}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(candidate.service);
  });

  it('GET /v1/deals/:id 404s a missing deal', async () => {
    const res = await fetch(`${base}/v1/deals/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('the HTTP response body carries NO internal field', async () => {
    const deal = publishedDeal();
    await db.deals.insert(deal);
    const res = await fetch(`${base}/v1/deals/${deal.id}`);
    const text = await res.text();
    for (const forbidden of [
      'status',
      'confidence',
      'grounding',
      'attributes',
      'raw_conditions_text',
      'unmapped_conditions',
      'field_proposals',
      'schema_version',
      'evidence_id',
      'verified_by',
      'source_quote',
    ]) {
      expect(text, `internal field "${forbidden}" leaked into the HTTP body`).not.toContain(
        `"${forbidden}"`,
      );
    }
  });

  it('malformed query params → 400 (not a silent default, not a 500)', async () => {
    // bad enum, non-numeric limit, unknown param.
    expect((await fetch(`${base}/v1/deals?route_type=nonsense`)).status).toBe(400);
    expect((await fetch(`${base}/v1/deals?limit=abc`)).status).toBe(400);
    expect((await fetch(`${base}/v1/deals?country=US`)).status).toBe(400);
    expect((await fetch(`${base}/v1/deals?bogus=1`)).status).toBe(400);
  });

  it('caps limit above the hard ceiling with a 400 (no unbounded page)', async () => {
    const res = await fetch(`${base}/v1/deals?limit=100000`);
    expect(res.status).toBe(400);
  });

  it('caps offset above the hard ceiling with a 400 (no deep-scan)', async () => {
    const res = await fetch(`${base}/v1/deals?offset=1000000000`);
    expect(res.status).toBe(400);
  });

  it('a caller CANNOT widen the published-only boundary via a status param', async () => {
    // The published-only guarantee leans on the strict() schema rejecting any
    // unknown param. Pin it adversarially: a status/filters passthrough must 400,
    // and must NEVER surface a non-published row. A future loosening of strict()
    // would break this test rather than silently open the trust boundary.
    const candidate = publishedDeal({ status: DealStatus.enum.candidate });
    await db.deals.insert(candidate);
    for (const q of [
      'status=candidate',
      'status=published',
      'filters[status]=candidate',
      'include=all',
    ]) {
      const res = await fetch(`${base}/v1/deals?${q}`);
      expect(res.status, `query "${q}" must be rejected`).toBe(400);
      expect(await res.text()).not.toContain(candidate.service);
    }
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await fetch(`${base}/v1/deals`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('refuses non-GET methods (read-only surface) with 405', async () => {
    const res = await fetch(`${base}/v1/deals`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('an unknown /v1/ path is the public router’s own 404 (total dispatch)', async () => {
    const res = await fetch(`${base}/v1/admin/secret`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('/v1/admin/secret');
  });
});
