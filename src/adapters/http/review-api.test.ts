import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { ReviewApi } from './review-api.js';
import { ReviewUseCase } from '../../application/index.js';
import { DealStatus, type DealRecord } from '../../domain/index.js';
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
    api = new ReviewApi(review, new ConsoleLogger('error'), '<html>page</html>');
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
    expect((await db.deals.getById(deal.id))!.status).toBe('published');
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
    expect((await res.json()).error).toMatch(/malformed/i);
    expect((await db.deals.getById(deal.id))!.status).toBe('candidate');
  });

  it('unknown route is 404', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
  });
});
