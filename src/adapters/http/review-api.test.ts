import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { ReviewApi } from './review-api.js';
import { ReviewUseCase, SourceReviewUseCase } from '../../application/index.js';
import { DealStatus, type DealRecord } from '../../domain/index.js';
import { makeSource } from '../../../test/factories/source.js';
import { InMemoryDb } from '../db/in-memory/in-memory-db.js';
import { LocalFsEvidenceStore } from '../evidence-store/local-fs-evidence-store.js';
import { ConsoleLogger } from '../logger/console-logger.js';
import { SystemClock } from '../../application/ports/index.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Drives the real HTTP server over a real socket end-to-end. */
describe('ReviewApi (HTTP integration)', () => {
  let db: InMemoryDb;
  let api: ReviewApi;
  let base: string;

  async function seedCandidate(): Promise<DealRecord> {
    const evidenceStore = new LocalFsEvidenceStore(mkdtempSync(join(tmpdir(), 'ev-')));
    const ev = await evidenceStore.save({
      sourceUrl: 'https://x.de',
      screenshot: new Uint8Array([1]),
      html: '<html>',
      termsText: 't',
      capturedAt: '2026-06-19T00:00:00.000Z',
      contentHash: 'h',
    });
    await db.evidence.insert(ev);
    const deal: DealRecord = {
      ...makeLlmDeal(),
      id: randomUUID(),
      schema_version: 1,
      true_cost_monthly: 10,
      evidence_id: ev.id,
      status: DealStatus.enum.candidate,
      verified_by: null,
      verified_at: null,
    };
    await db.deals.insert(deal);
    return deal;
  }

  beforeEach(async () => {
    db = new InMemoryDb();
    const review = new ReviewUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const sourceReview = new SourceReviewUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    api = new ReviewApi(review, sourceReview, new ConsoleLogger('error'), {
      staticPageHtml: '<html>page</html>',
    });
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    const port = (api['server'].address() as AddressInfo).port;
    base = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  it('GET /api/health returns ok', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET / serves the test page', async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('page');
  });

  it('GET /api/candidates returns candidates with evidence', async () => {
    const deal = await seedCandidate();
    const items = (await (await fetch(`${base}/api/candidates`)).json()) as {
      deal: DealRecord;
      evidence: { id: string } | null;
    }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.deal.id).toBe(deal.id);
    expect(items[0]!.evidence).not.toBeNull();
  });

  it('POST approve publishes the deal (with approver)', async () => {
    const deal = await seedCandidate();
    const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'reviewer@dealroute' }),
    });
    expect(res.status).toBe(200);
    const stored = (await db.deals.getById(deal.id))!;
    expect(stored.status).toBe('published');
    expect(stored.published_at).not.toBeNull();
    expect(stored.affiliate_disclosure).toBe(true); // defaulted when omitted
  });

  it('POST approve passes the reviewer-supplied affiliate_disclosure through', async () => {
    const deal = await seedCandidate();
    const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'reviewer@dealroute', affiliate_disclosure: false }),
    });
    expect(res.status).toBe(200);
    expect((await db.deals.getById(deal.id))!.affiliate_disclosure).toBe(false);
  });

  it('POST approve without an approver is a 400 (no anonymous publish)', async () => {
    const deal = await seedCandidate();
    const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await db.deals.getById(deal.id))!.status).toBe('candidate');
  });

  it('POST reject archives the deal', async () => {
    const deal = await seedCandidate();
    const res = await fetch(`${base}/api/candidates/${deal.id}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'reviewer', reason: 'not a real bundle' }),
    });
    expect(res.status).toBe(200);
    expect((await db.deals.getById(deal.id))!.status).toBe('rejected');
  });

  it('POST with a malformed JSON body is a clear 400 (no silent swallow)', async () => {
    const deal = await seedCandidate();
    const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/malformed/i);
    expect((await db.deals.getById(deal.id))!.status).toBe('candidate');
  });

  it('unknown route is 404', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
  });

  it('approving a non-existent deal is a 404, not a 500', async () => {
    const res = await fetch(`${base}/api/candidates/${randomUUID()}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'reviewer' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'deal not found' });
  });

  it('approving an already-decided deal is a 409 (conflict), not a 500', async () => {
    const deal = await seedCandidate();
    await db.deals.updateStatus(deal.id, DealStatus.enum.rejected, 'r', '2026-06-19T00:00:00Z');
    const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'reviewer' }),
    });
    expect(res.status).toBe(409);
  });

  it('an oversized body is rejected with 413, not buffered unbounded', async () => {
    const deal = await seedCandidate();
    const huge = JSON.stringify({ approver: 'r', pad: 'x'.repeat(70 * 1024) });
    const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    expect(res.status).toBe(413);
    expect((await db.deals.getById(deal.id))!.status).toBe('candidate');
  });

  it('GET /api/sources/pending lists pending sources; approve → active', async () => {
    const src = makeSource({ status: 'pending_approval', type: 'discovered', tier: 4 });
    await db.sources.upsert(src);

    const pending = (await (await fetch(`${base}/api/sources/pending`)).json()) as { id: string }[];
    expect(pending.map((s) => s.id)).toContain(src.id);

    const res = await fetch(`${base}/api/sources/${src.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'curator@dealroute' }),
    });
    expect(res.status).toBe(200);
    expect((await db.sources.getById(src.id))!.status).toBe('active');
    // …and an audit row was written.
    const history = (await (await fetch(`${base}/api/sources/${src.id}/reviews`)).json()) as {
      action: string;
    }[];
    expect(history[0]!.action).toBe('approve');
  });

  it('rejecting a source → rejected (not re-crawled / re-proposed)', async () => {
    const src = makeSource({ status: 'pending_approval', type: 'discovered', tier: 4 });
    await db.sources.upsert(src);
    const res = await fetch(`${base}/api/sources/${src.id}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'curator', reason: 'irrelevant domain' }),
    });
    expect(res.status).toBe(200);
    expect((await db.sources.getById(src.id))!.status).toBe('rejected');
  });

  it('approving a non-pending source is a 409 (conflict)', async () => {
    const src = makeSource({ status: 'active' });
    await db.sources.upsert(src);
    const res = await fetch(`${base}/api/sources/${src.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'curator' }),
    });
    expect(res.status).toBe(409);
  });

  it('approving a non-existent source is a 404', async () => {
    const res = await fetch(`${base}/api/sources/${randomUUID()}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'curator' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('ReviewApi — auth (bearer token gating state changes)', () => {
  let db: InMemoryDb;
  let api: ReviewApi;
  let base: string;
  let dealId: string;

  beforeEach(async () => {
    db = new InMemoryDb();
    const evidenceStore = new LocalFsEvidenceStore(mkdtempSync(join(tmpdir(), 'ev-')));
    const ev = await evidenceStore.save({
      sourceUrl: 'https://x.de',
      screenshot: new Uint8Array([1]),
      html: '<html>',
      termsText: 't',
      capturedAt: '2026-06-19T00:00:00.000Z',
      contentHash: 'h',
    });
    await db.evidence.insert(ev);
    const deal: DealRecord = {
      ...makeLlmDeal(),
      id: randomUUID(),
      schema_version: 1,
      true_cost_monthly: 10,
      evidence_id: ev.id,
      status: DealStatus.enum.candidate,
      verified_by: null,
      verified_at: null,
    };
    await db.deals.insert(deal);
    dealId = deal.id;

    const review = new ReviewUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const sourceReview = new SourceReviewUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    api = new ReviewApi(review, sourceReview, new ConsoleLogger('error'), {
      authToken: 'secret-token',
    });
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    base = `http://localhost:${(api['server'].address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  it('rejects approve without a bearer token (401) and does not publish', async () => {
    const res = await fetch(`${base}/api/candidates/${dealId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'reviewer' }),
    });
    expect(res.status).toBe(401);
    expect((await db.deals.getById(dealId))!.status).toBe('candidate');
  });

  it('accepts approve with the correct bearer token', async () => {
    const res = await fetch(`${base}/api/candidates/${dealId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify({ approver: 'reviewer' }),
    });
    expect(res.status).toBe(200);
    expect((await db.deals.getById(dealId))!.status).toBe('published');
  });

  it('still serves read endpoints without a token', async () => {
    const res = await fetch(`${base}/api/candidates`);
    expect(res.status).toBe(200);
  });
});
