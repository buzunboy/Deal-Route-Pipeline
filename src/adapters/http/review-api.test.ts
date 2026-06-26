import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { ReviewApi } from './review-api.js';
import {
  ReviewUseCase,
  SourceReviewUseCase,
  TeamUseCase,
  AlertsUseCase,
  MetricsUseCase,
  SettingsUseCase,
  AuthenticateUseCase,
  AuthorizationUseCase,
  ProvisionUserUseCase,
  ManageRolesUseCase,
} from '../../application/index.js';
import { loadConfig } from '../../config/index.js';
import { DealStatus, SYSTEM_ROLE_ADMIN_ID, type DealRecord } from '../../domain/index.js';
import { makeSource } from '../../../test/factories/source.js';
import { InMemoryDb } from '../db/in-memory/in-memory-db.js';
import { LocalFsEvidenceStore } from '../evidence-store/local-fs-evidence-store.js';
import { ConsoleLogger } from '../logger/console-logger.js';
import type { Clock } from '../../application/ports/index.js';
import { SystemClock } from '../../application/ports/index.js';
import { JoseTokenIssuer } from '../security/jose-token-issuer.js';
import { FakePasswordHasher, FakeLogger } from '../../../test/fakes/fakes.js';
import {
  makeTestTokenIssuerFactory,
  seedActiveUser,
  TEST_AUTH_TTLS,
  TEST_LOCKOUT,
  TEST_REALM,
} from '../../../test/fakes/auth-test-support.js';
import { makeLlmDeal, makeDealRecord } from '../../../test/factories/deal.js';
import { tldtsSuffixOracle } from '../suffix/tldts-suffix-oracle.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Auth/IAM Phase 5: per-user JWT is the ONLY way into `/api/*`. This shared helper wires a
 * real (deterministic) ES256 `JoseTokenIssuer` + the auth use-cases into a `ReviewApi`, seeds
 * one ADMIN user (all permissions), mints its access token, and returns a `fetch`-replacing
 * installer so the existing route/DTO/validation tests below — which predate auth — can run
 * against the authenticated surface WITHOUT editing every call site. `installAuthedFetch`
 * patches `globalThis.fetch` to attach `Authorization: Bearer <adminToken>` to same-`base`
 * requests that don't already set one; `restore()` puts the real `fetch` back.
 */
async function buildAuthForTests(
  db: InMemoryDb,
  clock: Clock,
  makeIssuer: (c: Clock) => JoseTokenIssuer,
): Promise<{
  auth: NonNullable<ConstructorParameters<typeof ReviewApi>[8]['auth']>;
  adminToken: string;
}> {
  const issuer = makeIssuer(clock);
  const hasher = new FakePasswordHasher();
  const authorization = new AuthorizationUseCase(db);
  const passwordPolicy = loadConfig({}).auth.passwordPolicy;
  await seedActiveUser(db, hasher, {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'admin@dealroute.de',
    password: 'pw',
    roleId: SYSTEM_ROLE_ADMIN_ID,
  });
  const login = new AuthenticateUseCase(
    db,
    hasher,
    issuer,
    clock,
    new FakeLogger(),
    TEST_AUTH_TTLS,
    TEST_LOCKOUT,
    TEST_REALM,
  );
  const session = await login.authenticate({ email: 'admin@dealroute.de', password: 'pw' });
  return {
    auth: {
      tokenIssuer: issuer,
      db,
      authorization,
      provisionUser: new ProvisionUserUseCase(db, hasher, clock, new FakeLogger(), passwordPolicy),
      manageRoles: new ManageRolesUseCase(db, hasher, clock, new FakeLogger(), passwordPolicy),
    },
    adminToken: session.accessToken,
  };
}

/** Patch `globalThis.fetch` to auto-attach the admin bearer to `base` requests. */
function installAuthedFetch(base: string, adminToken: string): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith(base)) {
      const headers = new Headers(init?.headers);
      if (!headers.has('authorization')) headers.set('authorization', `Bearer ${adminToken}`);
      return realFetch(input, { ...init, headers });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** Drives the real HTTP server over a real socket end-to-end. */
describe('ReviewApi (HTTP integration)', () => {
  let db: InMemoryDb;
  let api: ReviewApi;
  let base: string;
  // One store per test, shared by seedCandidate + the ReviewApi (so the gated
  // /api/evidence endpoint reads back the same bundle seedCandidate wrote).
  let evidenceStore: LocalFsEvidenceStore;
  // Auth/IAM Phase 5: per-user JWT is the only path in. These route/DTO/validation tests
  // predate auth, so we wire a real issuer + seeded admin and auto-attach the admin bearer
  // to every request (`installAuthedFetch`); `restoreFetch` undoes the patch per test.
  let makeIssuer: (c: Clock) => JoseTokenIssuer;
  let restoreFetch: () => void;

  beforeAll(async () => {
    makeIssuer = await makeTestTokenIssuerFactory();
  });

  async function seedCandidate(overrides: Partial<DealRecord> = {}): Promise<DealRecord> {
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
    evidenceStore = new LocalFsEvidenceStore(mkdtempSync(join(tmpdir(), 'ev-')));
    const review = new ReviewUseCase(
      db,
      new SystemClock(),
      new ConsoleLogger('error'),
      tldtsSuffixOracle,
    );
    const sourceReview = new SourceReviewUseCase(
      db,
      new SystemClock(),
      new ConsoleLogger('error'),
      tldtsSuffixOracle,
      'DE',
    );
    const team = new TeamUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const alerts = new AlertsUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const metrics = new MetricsUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const settings = new SettingsUseCase(
      db,
      loadConfig({}),
      new SystemClock(),
      new ConsoleLogger('error'),
    );
    const { auth, adminToken } = await buildAuthForTests(db, new SystemClock(), makeIssuer);
    api = new ReviewApi(
      review,
      sourceReview,
      team,
      alerts,
      metrics,
      settings,
      evidenceStore,
      new ConsoleLogger('error'),
      {
        staticPageHtml: '<html>page</html>',
        auth,
      },
    );
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    const port = (api['server'].address() as AddressInfo).port;
    base = `http://localhost:${port}`;
    restoreFetch = installAuthedFetch(base, adminToken);
  });

  afterEach(async () => {
    restoreFetch();
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

  it('a malformed (non-UUID) :id 404s instead of 500 (uuid-shaped route guard)', async () => {
    // The id maps to a Postgres `uuid` column; a non-UUID would 500 without the guard.
    expect((await fetch(`${base}/api/candidates/not-a-uuid/reviews`)).status).toBe(404);
    const patch = await fetch(`${base}/api/candidates/not-a-uuid`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'a', patch: {} }),
    });
    expect(patch.status).toBe(404);
    // A malformed id on a GATED POST falls through to 404 BEFORE the auth check (the
    // route regex doesn't match) — 404 leaks strictly less than 401 and never hits the DB.
    const approve = await fetch(`${base}/api/candidates/not-a-uuid/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'a' }),
    });
    expect(approve.status).toBe(404);
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

  it('GET /api/candidates/freshness returns the queue age distribution (ACR-9)', async () => {
    // Two pending candidates, captured years ago (2026-06-19) → both land in >3d
    // under SystemClock; the three bands always sum to 100.
    await seedCandidate();
    await seedCandidate({ status: 'in_review' });

    const res = await fetch(`${base}/api/candidates/freshness`);
    expect(res.status).toBe(200);
    const bands = (await res.json()) as { bucket: string; percent: number }[];
    expect(bands.map((b) => b.bucket)).toEqual(['<24h', '1-3d', '>3d']);
    expect(bands.reduce((a, b) => a + b.percent, 0)).toBe(100);
    expect(bands.find((b) => b.bucket === '>3d')!.percent).toBe(100);
  });

  it("GET /api/metrics/throughput returns today's reviewer throughput (ACR-6)", async () => {
    // A candidate whose evidence was captured well before the decision, decided NOW
    // (this UTC day) so it counts under SystemClock; latency is a real positive number.
    const deal = await seedCandidate();
    await db.reviews.insert({
      id: randomUUID(),
      deal_id: deal.id,
      action: 'approve',
      approver: 'mara',
      reason: null,
      decided_at: new Date().toISOString(),
    });

    const res = await fetch(`${base}/api/metrics/throughput?period=today`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      approved: number;
      rejected: number;
      edited: number;
      avg_review_seconds: number | null;
    };
    expect(body.approved).toBe(1);
    expect(body.rejected).toBe(0);
    expect(body.avg_review_seconds).toBeGreaterThan(0); // captured 2026-06-19 → years of latency

    // An unsupported period → 400.
    expect((await fetch(`${base}/api/metrics/throughput?period=week`)).status).toBe(400);
  });

  it('GET /api/metrics returns the KPI / cost / confidence rollup (ACR-10 Metrics)', async () => {
    await seedCandidate({ confidence: 0.9 }); // pending → enters avg + distribution
    await seedCandidate({ confidence: 0.5, status: 'in_review' });

    const res = await fetch(`${base}/api/metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kpis: { key: string; value: string }[];
      cost_per_day: { day: string; cost: number; highlight: boolean }[];
      confidence_distribution: { label: string; percent: number; level: string }[];
    };
    // Four KPI cards present, the cost chart is the dense 14-day series, and the three
    // confidence bands sum to 100.
    expect(body.kpis.map((k) => k.key)).toEqual([
      'crawl-cost',
      'throughput',
      'approval-rate',
      'avg-confidence',
    ]);
    expect(body.cost_per_day).toHaveLength(14);
    expect(body.confidence_distribution.reduce((a, b) => a + b.percent, 0)).toBe(100);
    expect(body.confidence_distribution.map((b) => b.level)).toEqual([
      'success',
      'warning',
      'danger',
    ]);
  });

  it('GET /api/settings + PATCH a writable setting; read-only key → 409 (ACR-10 Settings)', async () => {
    const res = await fetch(`${base}/api/settings`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      groups: { key: string; rows: { key: string; read_only: boolean }[] }[];
    };
    const rows = view.groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.key === 'affiliate_disclosure')!.read_only).toBe(false);
    expect(rows.find((r) => r.key === 'evidence_store')!.read_only).toBe(true);

    // PATCH a writable toggle.
    const ok = await fetch(`${base}/api/settings/affiliate_disclosure`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', value: false }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ key: 'affiliate_disclosure', updated: true });

    // PATCH a read-only key → 409.
    const ro = await fetch(`${base}/api/settings/evidence_store`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', value: 's3' }),
    });
    expect(ro.status).toBe(409);

    // PATCH a wholly-unknown key → 409 (same not-writable path).
    const unknown = await fetch(`${base}/api/settings/nonsense`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', value: 'x' }),
    });
    expect(unknown.status).toBe(409);

    // An invalid value for a writable key → 400.
    const bad = await fetch(`${base}/api/settings/daily_budget_queued`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', value: 'not-a-number' }),
    });
    expect(bad.status).toBe(400);
  });

  it('an affiliate_disclosure=false setting becomes the approve default when omitted (ACR-10)', async () => {
    // Admin turns the default OFF.
    await fetch(`${base}/api/settings/affiliate_disclosure`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice', value: false }),
    });
    // Approve WITHOUT specifying disclosure → picks up the false default.
    const deal = await seedCandidate();
    const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'bob' }),
    });
    expect(res.status).toBe(200);
    const stored = (await db.deals.getById(deal.id))!;
    expect(stored.affiliate_disclosure).toBe(false);
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

  it('POST approve needs no body approver — the actor comes from the token (Phase 5)', async () => {
    // Pre-Phase-5 an empty `approver` was a 400; now the actor is the verified token email,
    // so an empty body publishes (the "no anonymous publish" guard is the token requirement
    // itself — a tokenless approve 401s, covered in the per-user-JWT guard suite).
    const deal = await seedCandidate();
    const res = await fetch(`${base}/api/candidates/${deal.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await db.deals.getById(deal.id))!.status).toBe('published');
    // The approver recorded is the seeded admin (the token email), never a body value.
    const reviews = await db.reviews.listForDeal(deal.id, 10);
    expect(reviews[0]!.approver).toBe('admin@dealroute.de');
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

  it('GET /api/sources lists the operational registry, POST adds one (ACR-10)', async () => {
    await db.sources.upsert(
      makeSource({ url: 'https://active.de', status: 'active', reliability_score: 0.9 }),
    );
    await db.sources.upsert(makeSource({ url: 'https://pending.de', status: 'pending_approval' }));

    const list = (await (await fetch(`${base}/api/sources`)).json()) as {
      sources: { domain: string; kind: string; status: string }[];
    };
    // registry excludes the pending source.
    expect(list.sources.map((s) => s.domain)).toContain('active.de');
    expect(list.sources.map((s) => s.domain)).not.toContain('pending.de');

    // POST a new source → 201 { id, created }, then it shows in the registry.
    const created = await fetch(`${base}/api/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approver: 'curator',
        domain: 'netflix.com',
        kind: 'Provider',
        tier: 1,
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; created: boolean };
    expect(body.created).toBe(true);
    const stored = (await db.sources.getById(body.id))!;
    expect(stored.status).toBe('active');
    expect(stored.registrable_domain).toBe('netflix.com');

    // a bad kind → 400.
    const bad = await fetch(`${base}/api/sources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'curator', domain: 'bank.de', kind: 'Bank', tier: 1 }),
    });
    expect(bad.status).toBe(400);
  });

  it('GET/POST /api/team + PATCH /api/profile (ACR-10 Team + ACR-11 Profile)', async () => {
    // invite a member
    const invited = await fetch(`${base}/api/team`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'admin', name: 'Alice', email: 'alice@dealroute.de' }),
    });
    expect(invited.status).toBe(201);
    const inviteBody = (await invited.json()) as { id: string; invited: boolean; email: string };
    expect(inviteBody.invited).toBe(true);
    expect(inviteBody.email).toBe('alice@dealroute.de');

    // a review by that member → review_count 1 in the list
    await db.reviews.insert({
      id: randomUUID(),
      deal_id: randomUUID(),
      action: 'approve',
      approver: 'alice@dealroute.de',
      reason: null,
      decided_at: new Date().toISOString(),
    });
    const list = (await (await fetch(`${base}/api/team`)).json()) as {
      members: { email: string; review_count: number; name: string }[];
    };
    const alice = list.members.find((m) => m.email === 'alice@dealroute.de')!;
    expect(alice.review_count).toBe(1);

    // PATCH profile name — SELF-only: it edits the TOKEN user's own row (the seeded admin
    // the wrapper authenticates as), never a body-supplied email (Phase 5: no body approver).
    const patched = await fetch(`${base}/api/profile`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin M.' }),
    });
    expect(patched.status).toBe(200);
    expect(
      (await patched.json()) as { updated: boolean; name: string; password_changed: boolean },
    ).toEqual({
      updated: true,
      name: 'Admin M.',
      password_changed: false,
    });
    expect((await db.team.getByEmail('admin@dealroute.de'))!.name).toBe('Admin M.');

    // a bad role → 400
    const bad = await fetch(`${base}/api/team`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', email: 'x@dealroute.de', role: 'root' }),
    });
    expect(bad.status).toBe(400);
  });

  it('GET /api/alerts lists persisted alerts + open_count; POST ack/resolve (ACR-8)', async () => {
    // Seed an open alert directly in the store (the persisting path is unit-tested).
    const id = randomUUID();
    await db.alerts.upsertOpen({
      id,
      dedupe_key: `daily_budget_reached:2026-06-19`,
      kind: 'daily_budget_reached',
      severity: 'warning',
      title: 'Daily budget reached',
      summary: 'budget hit',
      context: { utc_day: '2026-06-19' },
      status: 'open',
      created_at: new Date().toISOString(), // today → stays open under SystemClock
      updated_at: new Date().toISOString(),
    });

    const list = (await (await fetch(`${base}/api/alerts`)).json()) as {
      alerts: { id: string; title: string; status: string }[];
      open_count: number;
    };
    expect(list.alerts.some((a) => a.id === id)).toBe(true);
    expect(list.open_count).toBeGreaterThanOrEqual(1);

    // acknowledge → 200, status reflects it on the next read.
    const ack = await fetch(`${base}/api/alerts/${id}/acknowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice' }),
    });
    expect(ack.status).toBe(200);
    expect((await db.alerts.getById(id))!.status).toBe('acknowledged');

    // resolve → 200.
    const resolved = await fetch(`${base}/api/alerts/${id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver: 'alice' }),
    });
    expect(resolved.status).toBe(200);
    expect((await db.alerts.getById(id))!.status).toBe('resolved');
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

  // ── ACR-13: gated authed-path evidence URLs on the admin evidence ──────────
  it('GET /api/candidates carries gated authed-path evidence URLs + keeps raw refs', async () => {
    const deal = await seedCandidate();
    const ev = (await db.evidence.getById(deal.evidence_id))!;
    const items = (await (await fetch(`${base}/api/candidates`)).json()) as {
      evidence: {
        screenshot_ref: string;
        evidence_screenshot_url: string;
        evidence_html_url: string;
        evidence_terms_url: string;
      } | null;
    }[];
    const got = items[0]!.evidence!;
    // The raw store ref is still present (reviewer console isn't an allow-list)…
    expect(got.screenshot_ref).toBe(ev.screenshot_ref);
    // …and all three artifact URLs point at the gated authed endpoint (NOT the public
    // CDN — html/terms are screenshot-only-403'd there). Relative, keyed by id+kind.
    expect(got.evidence_screenshot_url).toBe(`/api/evidence/${ev.id}/screenshot`);
    expect(got.evidence_html_url).toBe(`/api/evidence/${ev.id}/html`);
    expect(got.evidence_terms_url).toBe(`/api/evidence/${ev.id}/terms`);
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

describe('ReviewApi — auth (per-user JWT gating state changes)', () => {
  let db: InMemoryDb;
  let api: ReviewApi;
  let base: string;
  let dealId: string;
  let evidenceId: string;
  let makeIssuer: (c: Clock) => JoseTokenIssuer;
  let token: string; // a real admin access token (replaces the retired static 'secret-token')

  beforeAll(async () => {
    makeIssuer = await makeTestTokenIssuerFactory();
  });

  beforeEach(async () => {
    db = new InMemoryDb();
    const evidenceStore = new LocalFsEvidenceStore(mkdtempSync(join(tmpdir(), 'ev-')));
    const ev = await evidenceStore.save({
      sourceUrl: 'https://x.de',
      screenshot: new Uint8Array([1, 2, 3, 4]),
      html: '<html>archived</html>',
      termsText: 'verbatim terms',
      capturedAt: '2026-06-19T00:00:00.000Z',
      contentHash: 'h',
    });
    await db.evidence.insert(ev);
    evidenceId = ev.id;
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
    const team = new TeamUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const alerts = new AlertsUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const metrics = new MetricsUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const settings = new SettingsUseCase(
      db,
      loadConfig({}),
      new SystemClock(),
      new ConsoleLogger('error'),
    );
    const { auth: authWiring, adminToken } = await buildAuthForTests(
      db,
      new SystemClock(),
      makeIssuer,
    );
    token = adminToken;
    api = new ReviewApi(
      review,
      sourceReview,
      team,
      alerts,
      metrics,
      settings,
      evidenceStore,
      new ConsoleLogger('error'),
      {
        auth: authWiring,
      },
    );
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
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect((await db.deals.getById(dealId))!.status).toBe('candidate');
  });

  it('accepts approve with a valid per-user token', async () => {
    const res = await fetch(`${base}/api/candidates/${dealId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await db.deals.getById(dealId))!.status).toBe('published');
  });

  it('the OLD static token alone → 401 (dual-accept is GONE), but health stays open', async () => {
    // A read with no token → 401; a read with the RETIRED static token → 401 (no longer
    // accepted); a read with a valid per-user token → 200; the liveness probe stays open.
    expect((await fetch(`${base}/api/candidates`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/candidates`, { headers: { authorization: 'Bearer secret-token' } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/api/candidates`, { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(200);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('gates the new write endpoints (PATCH edit / promote / complete) without a token (401)', async () => {
    const patch = await fetch(`${base}/api/candidates/${dealId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { headline: 'x' } }),
    });
    expect(patch.status).toBe(401);
    expect((await db.deals.getById(dealId))!.headline).not.toBe('x');

    const promote = await fetch(`${base}/api/field-proposals/k/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canonical_key: 'x', label: 'x', target: 'vocabulary' }),
    });
    expect(promote.status).toBe(401);

    const complete = await fetch(`${base}/api/manual-capture-tasks/${randomUUID()}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: {}, evidence: {} }),
    });
    expect(complete.status).toBe(401);
  });

  // ── GET /api/evidence/:id/:artifact (gated reviewer evidence-fetch) ────────
  const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

  it('streams the screenshot bytes with image/png + private no-store (with token)', async () => {
    const res = await fetch(`${base}/api/evidence/${evidenceId}/screenshot`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]); // round-trips exactly
  });

  it('streams the archived HTML with text/html (with token)', async () => {
    const res = await fetch(`${base}/api/evidence/${evidenceId}/html`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<html>archived</html>');
  });

  it('streams the terms text with text/plain (with token)', async () => {
    const res = await fetch(`${base}/api/evidence/${evidenceId}/terms`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('verbatim terms');
  });

  it('GATES the evidence fetch: 401 without a bearer token', async () => {
    const res = await fetch(`${base}/api/evidence/${evidenceId}/terms`);
    expect(res.status).toBe(401);
  });

  it('404s a known-shaped but absent evidence id', async () => {
    const res = await fetch(`${base}/api/evidence/${randomUUID()}/screenshot`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  it('404s an unknown artifact kind (route regex never matches it)', async () => {
    // `evidence.json`/metadata is deliberately NOT exposed; an arbitrary kind falls
    // through to the catch-all 404 and never reaches the store as a path.
    for (const kind of ['evidence.json', 'meta', 'terms.txt', '..']) {
      const res = await fetch(`${base}/api/evidence/${evidenceId}/${kind}`, { headers: auth() });
      expect(res.status).toBe(404);
    }
  });

  it('404s a non-UUID evidence id (UUID-segment guard)', async () => {
    const res = await fetch(`${base}/api/evidence/not-a-uuid/screenshot`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  it('gates the ACR write endpoints (ad-hoc capture / sources / team / profile / alerts) with the bearer token (401)', async () => {
    const json = { 'content-type': 'application/json' };
    // Each is a state-changing endpoint that MUST 401 without a bearer + perform no write.
    const adhoc = await fetch(`${base}/api/manual-capture-tasks`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ approver: 'a', fields: {}, evidence: {} }),
    });
    expect(adhoc.status).toBe(401);
    // No manual-capture task was minted (the ad-hoc create writes a done ad_hoc task).
    expect(await db.manualCapture.listOpen(50)).toHaveLength(0);

    const addSource = await fetch(`${base}/api/sources`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ approver: 'a', domain: 'netflix.com', kind: 'provider', tier: 1 }),
    });
    expect(addSource.status).toBe(401);
    expect(await db.sources.getByUrl('https://netflix.com/')).toBeNull();

    const invite = await fetch(`${base}/api/team`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ approver: 'a', name: 'X', email: 'x@dealroute.de' }),
    });
    expect(invite.status).toBe(401);
    expect(await db.team.getByEmail('x@dealroute.de')).toBeNull();

    const profile = await fetch(`${base}/api/profile`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ approver: 'a', name: 'X' }),
    });
    expect(profile.status).toBe(401);

    // Alerts ack/resolve — seed an open alert, prove an unauth POST leaves it open.
    const id = randomUUID();
    await db.alerts.upsertOpen({
      id,
      dedupe_key: `daily_budget_reached:2026-06-19`,
      kind: 'daily_budget_reached',
      severity: 'warning',
      title: 't',
      summary: 's',
      context: {},
      status: 'open',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const ack = await fetch(`${base}/api/alerts/${id}/acknowledge`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ approver: 'a' }),
    });
    expect(ack.status).toBe(401);
    expect((await db.alerts.getById(id))!.status).toBe('open'); // unchanged

    // Settings PATCH — unauth MUST 401 and write no override.
    const setting = await fetch(`${base}/api/settings/affiliate_disclosure`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ approver: 'a', value: false }),
    });
    expect(setting.status).toBe(401);
    expect(await db.settings.get('affiliate_disclosure')).toBeNull(); // no override written

    // Reads require a valid per-user token (they were open before Phase 2): an
    // unauthenticated GET /api/* is 401, but WITH a valid per-user bearer it serves 200.
    expect((await fetch(`${base}/api/sources`)).status).toBe(401);
    expect((await fetch(`${base}/api/team`)).status).toBe(401);
    expect((await fetch(`${base}/api/alerts`)).status).toBe(401);
    expect((await fetch(`${base}/api/settings`)).status).toBe(401);
    const tok = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/api/sources`, { headers: tok })).status).toBe(200);
    expect((await fetch(`${base}/api/team`, { headers: tok })).status).toBe(200);
    expect((await fetch(`${base}/api/alerts`, { headers: tok })).status).toBe(200);
    expect((await fetch(`${base}/api/settings`, { headers: tok })).status).toBe(200);
  });
});

describe('ReviewApi — CORS for the browser admin panel', () => {
  const ORIGIN = 'https://admin.dealroute.example';
  let db: InMemoryDb;
  let makeIssuer: (c: Clock) => JoseTokenIssuer;

  /**
   * Spin up an API with the given CORS option and return its base URL + a valid per-user
   * admin token (Phase 5: every `/api/*` request needs one). Auth is ALWAYS wired — the
   * CORS behaviour under test is independent of whether the request is authenticated.
   */
  async function start(opts: { corsAllowOrigin?: string }): Promise<{
    api: ReviewApi;
    base: string;
    token: string;
  }> {
    const review = new ReviewUseCase(
      db,
      new SystemClock(),
      new ConsoleLogger('error'),
      tldtsSuffixOracle,
    );
    const sourceReview = new SourceReviewUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const team = new TeamUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const alerts = new AlertsUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const metrics = new MetricsUseCase(db, new SystemClock(), new ConsoleLogger('error'));
    const settings = new SettingsUseCase(
      db,
      loadConfig({}),
      new SystemClock(),
      new ConsoleLogger('error'),
    );
    const { auth, adminToken } = await buildAuthForTests(db, new SystemClock(), makeIssuer);
    const api = new ReviewApi(
      review,
      sourceReview,
      team,
      alerts,
      metrics,
      settings,
      new LocalFsEvidenceStore(mkdtempSync(join(tmpdir(), 'ev-'))),
      new ConsoleLogger('error'),
      { corsAllowOrigin: opts.corsAllowOrigin, auth },
    );
    await api.listen(0);
    // @ts-expect-error reach into the underlying server for the assigned port
    const base = `http://localhost:${(api['server'].address() as AddressInfo).port}`;
    return { api, base, token: adminToken };
  }

  beforeAll(async () => {
    makeIssuer = await makeTestTokenIssuerFactory();
  });

  beforeEach(() => {
    db = new InMemoryDb();
  });

  it('answers an OPTIONS preflight 204 with the configured origin + Authorization allowed', async () => {
    const { api, base } = await start({ corsAllowOrigin: ORIGIN });
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
    const { api, base } = await start({ corsAllowOrigin: ORIGIN });
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
    const { api, base, token } = await start({ corsAllowOrigin: ORIGIN });
    try {
      const res = await fetch(`${base}/api/candidates`, {
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    } finally {
      await api.close();
    }
  });

  it('includes the CORS origin even on an error response (401), so the browser can read it', async () => {
    // Without CORS headers on the 401 the browser surfaces an opaque network error
    // instead of the real status — the panel could never show "unauthorized".
    const { api, base } = await start({ corsAllowOrigin: ORIGIN });
    try {
      const res = await fetch(`${base}/api/candidates/${randomUUID()}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({}), // no token → 401
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    } finally {
      await api.close();
    }
  });

  it('emits NO CORS headers when no origin is configured (same-origin default)', async () => {
    const { api, base, token } = await start({});
    try {
      const res = await fetch(`${base}/api/candidates`, {
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      });
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
