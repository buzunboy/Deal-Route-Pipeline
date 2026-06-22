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
import { makeLlmDeal, makeDealRecord } from '../../../test/factories/deal.js';
import { tldtsSuffixOracle } from '../suffix/tldts-suffix-oracle.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Drives the real HTTP server over a real socket end-to-end. */
describe('ReviewApi (HTTP integration)', () => {
  let db: InMemoryDb;
  let api: ReviewApi;
  let base: string;

  async function seedCandidate(overrides: Partial<DealRecord> = {}): Promise<DealRecord> {
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
    const deal = makeDealRecord({ evidence_id: ev.id, status: 'candidate', ...overrides });
    await db.deals.insert(deal);
    return deal;
  }

  beforeEach(async () => {
    db = new InMemoryDb();
    const review = new ReviewUseCase(
      db,
      new SystemClock(),
      new ConsoleLogger('error'),
      tldtsSuffixOracle,
    );
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

  it('GET /api/candidates/counts returns the aggregate review-queue counts (ACR-5)', async () => {
    await seedCandidate({ route_type: 'bundle', confidence: 0.3, human_edited: ['price'] });
    await seedCandidate({ status: 'in_review', route_type: 'promo', confidence: 0.9 });
    // A reject decided "now" (this UTC day) so rejected_today counts it under SystemClock.
    await db.reviews.insert({
      id: randomUUID(),
      deal_id: randomUUID(),
      action: 'reject',
      approver: 'r',
      reason: null,
      decided_at: new Date().toISOString(),
    });
    const res = await fetch(`${base}/api/candidates/counts`);
    expect(res.status).toBe(200);
    const counts = (await res.json()) as {
      all_pending: number;
      low_confidence: number;
      human_edited: number;
      rejected_today: number;
      by_route: Record<string, number>;
    };
    expect(counts.all_pending).toBe(2);
    expect(counts.low_confidence).toBe(1);
    expect(counts.human_edited).toBe(1);
    expect(counts.rejected_today).toBe(1);
    expect(counts.by_route.bundle).toBe(1);
    expect(counts.by_route.promo).toBe(1);
  });

  it('GET /api/audit returns the recent-activity feed, filterable (ACR-7)', async () => {
    const dealId = randomUUID();
    const insertReview = (approver: string, action: 'approve' | 'reject', at: string) =>
      db.reviews.insert({
        id: randomUUID(),
        deal_id: dealId,
        action,
        approver,
        reason: null,
        decided_at: at,
      });
    await insertReview('alice@dealroute', 'approve', '2026-06-19T01:00:00.000Z');
    await insertReview('bob@dealroute', 'reject', '2026-06-19T05:00:00.000Z');

    const res = await fetch(`${base}/api/audit?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { actor: string; initials: string; action: string; entity_id: string; at: string }[];
    };
    expect(body.entries.map((e) => e.at)).toEqual([
      '2026-06-19T05:00:00.000Z',
      '2026-06-19T01:00:00.000Z',
    ]);
    expect(body.entries[0]!.initials).toBe('BO');

    // actor filter + a bad `since` → 400.
    const filtered = await fetch(`${base}/api/audit?actor=alice@dealroute`);
    const filteredBody = (await filtered.json()) as { entries: { actor: string }[] };
    expect(filteredBody.entries.every((e) => e.actor === 'alice@dealroute')).toBe(true);
    expect((await fetch(`${base}/api/audit?since=not-a-date`)).status).toBe(400);
  });

  it('GET /api/published returns the admin publication-history screen (ACR-10)', async () => {
    await seedCandidate({ status: 'published', published_at: '2026-06-10T00:00:00.000Z' });
    await seedCandidate({ status: 'expired', published_at: '2026-05-01T00:00:00.000Z' });
    await seedCandidate({ status: 'candidate' }); // excluded

    const res = await fetch(`${base}/api/published?limit=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deals: { status: string; geo: string; true_monthly: number; published_at: string }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.deals.map((d) => d.status)).toEqual(['live', 'unpublished']); // newest first
    expect(body.deals[0]!.geo).toBeDefined();

    // out-of-range limit → 400.
    expect((await fetch(`${base}/api/published?limit=9999`)).status).toBe(400);
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

  it('GET /api/sources/pending surfaces the proposal_reason (ACR-15)', async () => {
    const src = makeSource({
      status: 'pending_approval',
      type: 'discovered',
      tier: 4,
      proposal_reason: 'Linked from telekom.de bundle page; mentions Disney+',
    });
    await db.sources.upsert(src);
    const pending = (await (await fetch(`${base}/api/sources/pending`)).json()) as {
      id: string;
      proposal_reason: string | null;
    }[];
    const got = pending.find((s) => s.id === src.id)!;
    expect(got.proposal_reason).toBe('Linked from telekom.de bundle page; mentions Disney+');
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

  // ── PATCH /api/candidates/:id (reviewer edit) ────────────────────────────
  it('PATCH edits a candidate, tags human_edited, and a later approve publishes the edited record', async () => {
    const deal = await seedCandidate({ headline: 'before' });
    const patchRes = await fetch(`${base}/api/candidates/${deal.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', patch: { headline: 'after edit' } }),
    });
    expect(patchRes.status).toBe(200);
    const { deal: edited } = (await patchRes.json()) as { deal: DealRecord };
    expect(edited.headline).toBe('after edit');
    expect(edited.human_edited).toContain('headline');
    expect(edited.status).toBe('candidate');

    // approve publishes the edited version
    const approveRes = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'bob' }),
    });
    expect(approveRes.status).toBe(200);
    const stored = (await db.deals.getById(deal.id))!;
    expect(stored.status).toBe('published');
    expect(stored.headline).toBe('after edit');

    // the edit is in the audit trail
    const history = (await (await fetch(`${base}/api/candidates/${deal.id}/reviews`)).json()) as {
      action: string;
    }[];
    expect(history.map((h) => h.action)).toContain('edit');
  });

  it('PATCH to a non-editable field is a 400 and changes nothing', async () => {
    const deal = await seedCandidate();
    const res = await fetch(`${base}/api/candidates/${deal.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', patch: { source_url: 'https://evil.example' } }),
    });
    expect(res.status).toBe(400);
    expect((await db.deals.getById(deal.id))!.source_url).toBe(deal.source_url);
  });

  it('PATCH a non-existent candidate is a 404', async () => {
    const res = await fetch(`${base}/api/candidates/${randomUUID()}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', patch: { headline: 'x' } }),
    });
    expect(res.status).toBe(404);
  });

  // ── GET /api/candidates filters + pagination ─────────────────────────────
  it('GET /api/candidates filters by status + confidence_max and paginates', async () => {
    const svc = `svc-${randomUUID()}`;
    await seedCandidate({ service: svc, status: 'candidate', confidence: 0.3 });
    await seedCandidate({ service: svc, status: 'candidate', confidence: 0.9 });

    const low = (await (
      await fetch(`${base}/api/candidates?service=${svc}&confidence_max=0.5`)
    ).json()) as { deal: DealRecord }[];
    expect(low).toHaveLength(1);
    expect(low[0]!.deal.confidence).toBe(0.3);

    const page = (await (
      await fetch(`${base}/api/candidates?service=${svc}&limit=1&offset=0`)
    ).json()) as { deal: DealRecord }[];
    expect(page).toHaveLength(1);
    expect(page[0]!.deal.confidence).toBe(0.3); // lowest first
  });

  it('GET /api/candidates with an over-cap limit is a 400', async () => {
    const res = await fetch(`${base}/api/candidates?limit=99999`);
    expect(res.status).toBe(400);
  });

  // ── ACR-13: resolved evidence screenshot/html URLs on the admin evidence ──
  it('GET /api/candidates resolves evidence URLs from the configured CDN base', async () => {
    const deal = await seedCandidate();
    const ev = (await db.evidence.getById(deal.evidence_id))!;
    const withCdn = new ReviewApi(
      new ReviewUseCase(db, new SystemClock(), new ConsoleLogger('error'), tldtsSuffixOracle),
      new SourceReviewUseCase(db, new SystemClock(), new ConsoleLogger('error')),
      new ConsoleLogger('error'),
      { evidenceCdnBaseUrl: 'https://cdn.dealroute.example' },
    );
    await withCdn.listen(0);
    try {
      // @ts-expect-error reach into the underlying server for the assigned port
      const port = (withCdn['server'].address() as AddressInfo).port;
      const items = (await (await fetch(`http://localhost:${port}/api/candidates`)).json()) as {
        evidence: {
          screenshot_ref: string;
          evidence_screenshot_url: string | null;
          evidence_html_url: string | null;
        } | null;
      }[];
      const got = items[0]!.evidence!;
      // the raw store ref is still present (reviewer console isn't an allow-list)…
      expect(got.screenshot_ref).toBe(ev.screenshot_ref);
      // …and the resolvable CDN URLs are added (ACR-13).
      expect(got.evidence_screenshot_url).toBe(
        `https://cdn.dealroute.example/${ev.screenshot_ref}`,
      );
      expect(got.evidence_html_url).toBe(`https://cdn.dealroute.example/${ev.html_ref}`);
    } finally {
      await withCdn.close();
    }
  });

  it('GET /api/candidates evidence URLs are null when no CDN base is configured', async () => {
    await seedCandidate();
    const items = (await (await fetch(`${base}/api/candidates`)).json()) as {
      evidence: { evidence_screenshot_url: string | null } | null;
    }[];
    expect(items[0]!.evidence!.evidence_screenshot_url).toBeNull();
  });

  // ── POST /api/field-proposals/:key/promote ───────────────────────────────
  it('POST promote adds a vocabulary entry and resolves the proposal', async () => {
    await db.fieldProposals.upsertAndCount({
      suggested_key: 'requires_pet',
      label: 'Pet required',
      rationale: 'r',
      example_quote: 'q',
      first_seen_at: '2026-06-19T00:00:00.000Z',
      last_seen_at: '2026-06-19T00:00:00.000Z',
    });
    const res = await fetch(`${base}/api/field-proposals/requires_pet/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approver: 'alice',
        canonical_key: 'requires_other_product',
        label: 'Requires another product',
        target: 'vocabulary',
      }),
    });
    expect(res.status).toBe(200);
    const { vocabulary_entry } = (await res.json()) as { vocabulary_entry: { key: string } };
    expect(vocabulary_entry.key).toBe('requires_other_product');
    expect((await db.fieldProposals.getByKey('requires_pet'))!.status).toBe('promoted');
  });

  it('POST promote with target=field is a 400 (not supported)', async () => {
    await db.fieldProposals.upsertAndCount({
      suggested_key: 'requires_pet',
      label: 'Pet required',
      rationale: 'r',
      example_quote: 'q',
      first_seen_at: '2026-06-19T00:00:00.000Z',
      last_seen_at: '2026-06-19T00:00:00.000Z',
    });
    const res = await fetch(`${base}/api/field-proposals/requires_pet/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'a', canonical_key: 'x', label: 'x', target: 'field' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST promote for an unknown proposal key is a 404', async () => {
    const res = await fetch(`${base}/api/field-proposals/no_such/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'a', canonical_key: 'x', label: 'x', target: 'vocabulary' }),
    });
    expect(res.status).toBe(404);
  });

  // ── POST /api/manual-capture-tasks/:id/complete ──────────────────────────
  async function openManualTask(): Promise<string> {
    const id = randomUUID();
    await db.manualCapture.insert({
      id,
      source_id: null,
      source_url: 'https://blocked.example/offer',
      reason: 'captcha',
      created_at: '2026-06-19T00:00:00.000Z',
      status: 'open',
      note: null,
    });
    return id;
  }
  const manualEvidence = {
    source_url: 'https://blocked.example/offer',
    screenshot_ref: 'manual/s.png',
    html_ref: 'manual/p.html',
    terms_ref: 'manual/t.txt',
    terms_text: 'Disney+ ist im Tarif enthalten für 10 EUR pro Monat.',
  };

  it('POST complete creates an evidence-backed candidate (never publishes) and closes the task', async () => {
    const taskId = await openManualTask();
    const res = await fetch(`${base}/api/manual-capture-tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approver: 'alice',
        fields: makeLlmDeal(),
        evidence: manualEvidence,
      }),
    });
    expect(res.status).toBe(200);
    const { deal } = (await res.json()) as { deal: DealRecord };
    expect(['candidate', 'in_review']).toContain(deal.status);
    expect(deal.source_url).toBe('https://blocked.example/offer'); // pinned from evidence
    expect(deal.human_edited.length).toBeGreaterThan(0);
    expect(await db.evidence.getById(deal.evidence_id)).not.toBeNull();
    expect((await db.manualCapture.getById(taskId))!.status).toBe('done');
  });

  it('POST /api/manual-capture-tasks (ad-hoc, ACR-12) creates a candidate → 201 { created, candidate_id }', async () => {
    const res = await fetch(`${base}/api/manual-capture-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', fields: makeLlmDeal(), evidence: manualEvidence }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean; candidate_id: string };
    expect(body.created).toBe(true);
    const deal = (await db.deals.getById(body.candidate_id))!;
    expect(['candidate', 'in_review']).toContain(deal.status); // never published
    expect(deal.source_url).toBe('https://blocked.example/offer'); // pinned from evidence
    // a done ad_hoc task was minted (nothing left open).
    expect(await db.manualCapture.listOpen(50)).toHaveLength(0);
  });

  it('POST /api/manual-capture-tasks (ad-hoc) with incomplete evidence is a 400, no candidate', async () => {
    const res = await fetch(`${base}/api/manual-capture-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approver: 'alice',
        fields: makeLlmDeal(),
        evidence: { ...manualEvidence, terms_text: '' },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST complete with incomplete evidence is a 400 and leaves the task open', async () => {
    const taskId = await openManualTask();
    const res = await fetch(`${base}/api/manual-capture-tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approver: 'alice',
        fields: makeLlmDeal(),
        evidence: { ...manualEvidence, screenshot_ref: '' },
      }),
    });
    expect(res.status).toBe(400);
    expect((await db.manualCapture.getById(taskId))!.status).toBe('open');
  });

  it('POST complete on an unknown task is a 404; on a done task is a 409', async () => {
    const missing = await fetch(`${base}/api/manual-capture-tasks/${randomUUID()}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'a', fields: makeLlmDeal(), evidence: manualEvidence }),
    });
    expect(missing.status).toBe(404);

    const taskId = await openManualTask();
    await fetch(`${base}/api/manual-capture-tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'a', fields: makeLlmDeal(), evidence: manualEvidence }),
    });
    const again = await fetch(`${base}/api/manual-capture-tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'a', fields: makeLlmDeal(), evidence: manualEvidence }),
    });
    expect(again.status).toBe(409);
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
    const deal = makeDealRecord({ evidence_id: ev.id, status: 'candidate' });
    await db.deals.insert(deal);
    dealId = deal.id;

    const review = new ReviewUseCase(
      db,
      new SystemClock(),
      new ConsoleLogger('error'),
      tldtsSuffixOracle,
    );
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

  it('gates the new write endpoints (PATCH edit / promote / complete) with the bearer token (401)', async () => {
    const patch = await fetch(`${base}/api/candidates/${dealId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', patch: { headline: 'x' } }),
    });
    expect(patch.status).toBe(401);
    expect((await db.deals.getById(dealId))!.headline).not.toBe('x');

    const promote = await fetch(`${base}/api/field-proposals/k/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'a', canonical_key: 'x', label: 'x', target: 'vocabulary' }),
    });
    expect(promote.status).toBe(401);

    const complete = await fetch(`${base}/api/manual-capture-tasks/${randomUUID()}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'a', fields: {}, evidence: {} }),
    });
    expect(complete.status).toBe(401);
  });
});

describe('ReviewApi — CORS for the browser admin panel', () => {
  const ORIGIN = 'https://admin.dealroute.example';
  let db: InMemoryDb;

  /** Spin up an API with the given options and return its base URL. */
  async function start(options: ConstructorParameters<typeof ReviewApi>[3]): Promise<{
    api: ReviewApi;
    base: string;
  }> {
    const review = new ReviewUseCase(
      db,
      new SystemClock(),
      new ConsoleLogger('error'),
      tldtsSuffixOracle,
    );
    const sourceReview = new SourceReviewUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const api = new ReviewApi(review, sourceReview, new ConsoleLogger('error'), options);
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    const base = `http://localhost:${(api['server'].address() as AddressInfo).port}`;
    return { api, base };
  }

  beforeEach(() => {
    db = new InMemoryDb();
  });

  it('answers an OPTIONS preflight 204 with the configured origin + Authorization allowed', async () => {
    const { api, base } = await start({ corsAllowOrigin: ORIGIN, authToken: 'secret-token' });
    try {
      const res = await fetch(`${base}/api/candidates/${randomUUID()}/approve`, {
        method: 'OPTIONS',
        headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      // The panel must be allowed to send the bearer + the state-changing methods.
      expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
      expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
      expect(res.headers.get('vary')).toContain('Origin');
    } finally {
      await api.close();
    }
  });

  it('does NOT require a bearer on the preflight (OPTIONS carries no Authorization)', async () => {
    // A browser preflight is unauthenticated by spec; gating it would break CORS.
    const { api, base } = await start({ corsAllowOrigin: ORIGIN, authToken: 'secret-token' });
    try {
      const res = await fetch(`${base}/api/candidates/${randomUUID()}/approve`, {
        method: 'OPTIONS',
        headers: { origin: ORIGIN },
      });
      expect(res.status).toBe(204);
    } finally {
      await api.close();
    }
  });

  it('echoes the CORS origin on a normal GET response', async () => {
    const { api, base } = await start({ corsAllowOrigin: ORIGIN });
    try {
      const res = await fetch(`${base}/api/candidates`, { headers: { origin: ORIGIN } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    } finally {
      await api.close();
    }
  });

  it('includes the CORS origin even on an error response (401), so the browser can read it', async () => {
    // Without CORS headers on the 401 the browser surfaces an opaque network error
    // instead of the real status — the panel could never show "unauthorized".
    const { api, base } = await start({ corsAllowOrigin: ORIGIN, authToken: 'secret-token' });
    try {
      const res = await fetch(`${base}/api/candidates/${randomUUID()}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ approver: 'a' }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    } finally {
      await api.close();
    }
  });

  it('emits NO CORS headers when no origin is configured (same-origin default)', async () => {
    const { api, base } = await start({});
    try {
      const res = await fetch(`${base}/api/candidates`, { headers: { origin: ORIGIN } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await api.close();
    }
  });

  it('refuses OPTIONS with 405 when no origin is configured (no preflight support)', async () => {
    const { api, base } = await start({});
    try {
      const res = await fetch(`${base}/api/candidates`, { method: 'OPTIONS' });
      expect(res.status).toBe(405);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await api.close();
    }
  });
});
