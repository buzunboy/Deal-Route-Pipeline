import { describe, it, expect, beforeEach } from 'vitest';
import { ReviewUseCase } from './review.js';
import type { DealRecord } from '../../domain/index.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { makeLlmDeal, makeDealRecord } from '../../../test/factories/deal.js';
import { tldtsSuffixOracle } from '../../adapters/suffix/tldts-suffix-oracle.js';
import { randomUUID } from 'node:crypto';
import type { Evidence } from '../../domain/index.js';

function makeCandidate(
  db: InMemoryDb,
  evidenceId: string,
  overrides: Partial<DealRecord> = {},
): Promise<DealRecord> {
  const deal = makeDealRecord({ evidence_id: evidenceId, status: 'candidate', ...overrides });
  return db.deals.insert(deal).then(() => deal);
}

describe('ReviewUseCase', () => {
  let db: InMemoryDb;
  let uc: ReviewUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    uc = new ReviewUseCase(db, new FixedClock(), new FakeLogger(), tldtsSuffixOracle);
  });

  it('lists candidates joined with their evidence', async () => {
    const ev: Evidence = {
      id: randomUUID(),
      source_url: 'https://x.de',
      screenshot_ref: 's',
      html_ref: 'h',
      terms_ref: 't',
      captured_at: '2026-06-19T00:00:00.000Z',
      content_hash: 'h',
    };
    await db.evidence.insert(ev);
    await makeCandidate(db, ev.id);

    const views = await uc.listCandidates();
    expect(views).toHaveLength(1);
    expect(views[0]!.evidence!.id).toBe(ev.id);
  });

  it('approve → published, stamped with approver + timestamp', async () => {
    const deal = await makeCandidate(db, randomUUID());
    const updated = await uc.approve(deal.id, 'reviewer@dealroute');
    expect(updated.status).toBe('published');
    expect(updated.verified_by).toBe('reviewer@dealroute');
    expect(updated.verified_at).not.toBeNull();

    const stored = await db.deals.getById(deal.id);
    expect(stored!.status).toBe('published');
  });

  it('approve sets published_at (distinct from verified_at) + persists it', async () => {
    const deal = await makeCandidate(db, randomUUID());
    const updated = await uc.approve(deal.id, 'reviewer@dealroute');
    expect(updated.published_at).not.toBeNull();
    expect(updated.published_at).toBe(updated.verified_at); // both = the approve instant
    const stored = await db.deals.getById(deal.id);
    expect(stored!.published_at).not.toBeNull();
  });

  it('approve sets affiliate_disclosure from the reviewer when supplied', async () => {
    const deal = await makeCandidate(db, randomUUID());
    const updated = await uc.approve(deal.id, 'reviewer@dealroute', { affiliateDisclosure: false });
    expect(updated.affiliate_disclosure).toBe(false);
    expect((await db.deals.getById(deal.id))!.affiliate_disclosure).toBe(false);
  });

  it('DEFAULTS affiliate_disclosure=true (over-disclose) + warns when the reviewer omits it', async () => {
    const logger = new FakeLogger();
    const ucWarn = new ReviewUseCase(db, new FixedClock(), logger, tldtsSuffixOracle);
    const deal = await makeCandidate(db, randomUUID());
    const updated = await ucWarn.approve(deal.id, 'reviewer@dealroute'); // no disclosure supplied
    expect(updated.affiliate_disclosure).toBe(true); // safe default — never under-disclose
    expect(
      logger.entries.some((e) => e.level === 'warn' && /affiliate_disclosure/i.test(e.msg)),
    ).toBe(true);
  });

  it('reject → rejected/archived', async () => {
    const deal = await makeCandidate(db, randomUUID());
    const updated = await uc.reject(deal.id, 'reviewer@dealroute', 'not a real bundle');
    expect(updated.status).toBe('rejected');
  });

  it('writes an immutable review audit row on approve and reject', async () => {
    const approved = await makeCandidate(db, randomUUID());
    await uc.approve(approved.id, 'alice');
    const aHistory = await uc.listReviews(approved.id);
    expect(aHistory).toHaveLength(1);
    expect(aHistory[0]).toMatchObject({ action: 'approve', approver: 'alice', reason: null });

    const rejected = await makeCandidate(db, randomUUID());
    await uc.reject(rejected.id, 'bob', 'duplicate of an existing route');
    const rHistory = await uc.listReviews(rejected.id);
    expect(rHistory).toHaveLength(1);
    expect(rHistory[0]).toMatchObject({
      action: 'reject',
      approver: 'bob',
      reason: 'duplicate of an existing route',
    });
  });

  it('refuses to publish without an approver identity (no anonymous publish)', async () => {
    const deal = await makeCandidate(db, randomUUID());
    await expect(uc.approve(deal.id, '   ')).rejects.toThrow(/approver/);
    expect((await db.deals.getById(deal.id))!.status).toBe('candidate');
  });

  it('refuses to re-decide an already-published deal', async () => {
    const deal = await makeCandidate(db, randomUUID());
    await uc.approve(deal.id, 'reviewer');
    await expect(uc.approve(deal.id, 'reviewer')).rejects.toThrow(/not reviewable/);
  });

  // ── editCandidate ─────────────────────────────────────────────────────────
  describe('editCandidate', () => {
    it('applies a patch, tags human_edited, keeps status candidate, and audits the edit', async () => {
      const deal = await makeCandidate(db, randomUUID(), { headline: 'old', human_edited: [] });
      const edited = await uc.editCandidate(deal.id, 'alice', { headline: 'corrected headline' });
      expect(edited.headline).toBe('corrected headline');
      expect(edited.human_edited).toEqual(['headline']);
      expect(edited.status).toBe('candidate'); // owner decision: edit doesn't change status

      const stored = await db.deals.getById(deal.id);
      expect(stored!.headline).toBe('corrected headline');
      expect(stored!.human_edited).toEqual(['headline']);

      const history = await uc.listReviews(deal.id);
      expect(history).toHaveLength(1);
      expect(history[0]!.action).toBe('edit');
      expect(history[0]!.approver).toBe('alice');
      expect(history[0]!.reason).toMatch(/headline/);
    });

    it('KEEPS the model grounding when a field is edited (owner decision) but flags it human_edited', async () => {
      const deal = await makeCandidate(db, randomUUID());
      const before = deal.grounding;
      const edited = await uc.editCandidate(deal.id, 'alice', {
        price: { amount: 5, currency: 'EUR', billing: 'monthly' },
      });
      expect(edited.grounding).toEqual(before); // kept, not dropped
      expect(edited.human_edited).toContain('price');
      // a price edit re-derives true cost
      expect(edited.true_cost_monthly).toBe(5);
    });

    it('accumulates human_edited across successive edits (union)', async () => {
      const deal = await makeCandidate(db, randomUUID(), { human_edited: [] });
      await uc.editCandidate(deal.id, 'a', { headline: 'h1' });
      const second = await uc.editCandidate(deal.id, 'a', { country: 'DE', headline: 'h2' });
      // headline already tagged; second edit adds nothing new for headline, country is no-op (same)
      expect(second.human_edited).toEqual(['headline']);
    });

    it('rejects an edit to a non-editable field (provenance/identity) → InvalidPatchError', async () => {
      const deal = await makeCandidate(db, randomUUID());
      await expect(
        uc.editCandidate(deal.id, 'alice', { source_url: 'https://evil.example' }),
      ).rejects.toThrow(/non-editable|INVALID_PATCH|source_url/i);
      // unchanged
      expect((await db.deals.getById(deal.id))!.source_url).toBe(deal.source_url);
    });

    it('refuses to edit a published (terminal) deal', async () => {
      const deal = await makeCandidate(db, randomUUID());
      await uc.approve(deal.id, 'reviewer');
      await expect(uc.editCandidate(deal.id, 'alice', { headline: 'x' })).rejects.toThrow(
        /not reviewable/,
      );
    });

    it('refuses an edit without an approver', async () => {
      const deal = await makeCandidate(db, randomUUID());
      await expect(uc.editCandidate(deal.id, '  ', { headline: 'x' })).rejects.toThrow(/approver/);
    });

    it('a no-op edit changes nothing and writes no audit row', async () => {
      const deal = await makeCandidate(db, randomUUID(), { headline: 'same', human_edited: [] });
      const out = await uc.editCandidate(deal.id, 'alice', { headline: 'same' });
      expect(out.human_edited).toEqual([]);
      expect(await uc.listReviews(deal.id)).toHaveLength(0);
    });

    it('a subsequent approve publishes the EDITED record', async () => {
      const deal = await makeCandidate(db, randomUUID(), { headline: 'before' });
      await uc.editCandidate(deal.id, 'alice', { headline: 'after edit' });
      const published = await uc.approve(deal.id, 'bob');
      expect(published.status).toBe('published');
      expect(published.headline).toBe('after edit');
      expect(published.human_edited).toContain('headline');
    });
  });

  // ── promoteFieldProposal ──────────────────────────────────────────────────
  describe('promoteFieldProposal', () => {
    async function seedProposal(key: string): Promise<void> {
      await db.fieldProposals.upsertAndCount({
        suggested_key: key,
        label: 'Requires a pet',
        rationale: 'r',
        example_quote: 'q',
        first_seen_at: '2026-06-19T00:00:00.000Z',
        last_seen_at: '2026-06-19T00:00:00.000Z',
      });
    }

    it('adds a vocabulary entry (suggested key as alias), resolves the proposal, audits', async () => {
      await seedProposal('requires_pet');
      const entry = await uc.promoteFieldProposal({
        approver: 'alice',
        suggestedKey: 'requires_pet',
        canonicalKey: 'requires_other_product',
        label: 'Requires another product',
        target: 'vocabulary',
      });
      expect(entry.key).toBe('requires_other_product');
      expect(entry.aliases).toContain('requires_pet');

      expect((await db.conditionVocabulary.getByKey('requires_other_product'))!.label).toBe(
        'Requires another product',
      );
      // proposal resolved out of the open queue
      expect((await db.fieldProposals.getByKey('requires_pet'))!.status).toBe('promoted');
      expect(await uc.listFieldProposals()).toHaveLength(0);
    });

    it('rejects target:"field" as not supported (deferred)', async () => {
      await seedProposal('requires_pet');
      await expect(
        uc.promoteFieldProposal({
          approver: 'alice',
          suggestedKey: 'requires_pet',
          canonicalKey: 'requires_pet',
          label: 'x',
          target: 'field',
        }),
      ).rejects.toThrow(/not supported|PROMOTION_TARGET/i);
    });

    it('404s an unknown proposal key', async () => {
      await expect(
        uc.promoteFieldProposal({
          approver: 'alice',
          suggestedKey: 'no_such',
          canonicalKey: 'x',
          label: 'x',
          target: 'vocabulary',
        }),
      ).rejects.toThrow(/not found|FIELD_PROPOSAL_NOT_FOUND/i);
    });

    it('refuses promotion without an approver', async () => {
      await seedProposal('requires_pet');
      await expect(
        uc.promoteFieldProposal({
          approver: '',
          suggestedKey: 'requires_pet',
          canonicalKey: 'x',
          label: 'x',
          target: 'vocabulary',
        }),
      ).rejects.toThrow(/approver/);
    });
  });

  // ── completeManualCapture ─────────────────────────────────────────────────
  describe('completeManualCapture', () => {
    function evidenceInput(over: Partial<Parameters<typeof uc.completeManualCapture>[3]> = {}) {
      return {
        sourceUrl: 'https://blocked.example/offer',
        screenshotRef: 'manual/s.png',
        htmlRef: 'manual/p.html',
        termsRef: 'manual/t.txt',
        termsText: 'Disney+ ist im Tarif enthalten für 10 EUR pro Monat.',
        ...over,
      };
    }
    async function openTask(): Promise<string> {
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

    it('creates an evidence-backed candidate from human fields, marks the task done, never publishes', async () => {
      const taskId = await openTask();
      const fields = makeLlmDeal({ source_url: 'https://ignored-by-server.example' });
      const candidate = await uc.completeManualCapture(taskId, 'alice', fields, evidenceInput());

      // never auto-published
      expect(['candidate', 'in_review']).toContain(candidate.status);
      // source_url pinned from the EVIDENCE, not the (ignored) fields value
      expect(candidate.source_url).toBe('https://blocked.example/offer');
      // evidence persisted + linked
      const ev = await db.evidence.getById(candidate.evidence_id);
      expect(ev).not.toBeNull();
      expect(ev!.screenshot_ref).toBe('manual/s.png');
      // whole record is human-entered → tagged human_edited
      expect(candidate.human_edited.length).toBeGreaterThan(0);
      expect(candidate.human_edited).toContain('price');
      // task closed
      expect((await db.manualCapture.getById(taskId))!.status).toBe('done');
      // audit row written on the new deal
      const history = await uc.listReviews(candidate.id);
      expect(history).toHaveLength(1);
      expect(history[0]!.action).toBe('edit');
      expect(history[0]!.approver).toBe('alice');
    });

    it('rejects when evidence is incomplete (missing screenshot ref) → 400 + no candidate', async () => {
      const taskId = await openTask();
      const fields = makeLlmDeal();
      await expect(
        uc.completeManualCapture(taskId, 'alice', fields, evidenceInput({ screenshotRef: '' })),
      ).rejects.toThrow(/evidence|EVIDENCE_INCOMPLETE/i);
      // task still open, no deal minted
      expect((await db.manualCapture.getById(taskId))!.status).toBe('open');
    });

    it('rejects malformed human fields at the boundary', async () => {
      const taskId = await openTask();
      await expect(
        uc.completeManualCapture(taskId, 'alice', { not: 'a deal' }, evidenceInput()),
      ).rejects.toThrow();
      expect((await db.manualCapture.getById(taskId))!.status).toBe('open');
    });

    it('404s an unknown task; 409s a task that is already done', async () => {
      await expect(
        uc.completeManualCapture(randomUUID(), 'alice', makeLlmDeal(), evidenceInput()),
      ).rejects.toThrow(/not found|MANUAL_CAPTURE_TASK_NOT_FOUND/i);

      const taskId = await openTask();
      await uc.completeManualCapture(taskId, 'alice', makeLlmDeal(), evidenceInput());
      await expect(
        uc.completeManualCapture(taskId, 'alice', makeLlmDeal(), evidenceInput()),
      ).rejects.toThrow(/not open|MANUAL_CAPTURE_TASK_NOT_OPEN/i);
    });

    it('refuses without an approver', async () => {
      const taskId = await openTask();
      await expect(
        uc.completeManualCapture(taskId, '  ', makeLlmDeal(), evidenceInput()),
      ).rejects.toThrow(/approver/);
    });
  });

  // ── createManualCapture (ACR-12 — ad-hoc, no backing task) ────────────────
  describe('createManualCapture', () => {
    const evidenceInput = () => ({
      sourceUrl: 'https://blocked.example/offer',
      screenshotRef: 'manual/s.png',
      htmlRef: 'manual/p.html',
      termsRef: 'manual/t.txt',
      termsText: 'Disney+ ist im Tarif enthalten für 10 EUR pro Monat.',
    });

    it('mints a done ad_hoc task + an evidence-backed candidate, never publishes', async () => {
      const fields = makeLlmDeal({ source_url: 'https://ignored.example' });
      const candidate = await uc.createManualCapture('alice', fields, evidenceInput());

      // never auto-published; source pinned from evidence; whole record human-edited.
      expect(['candidate', 'in_review']).toContain(candidate.status);
      expect(candidate.source_url).toBe('https://blocked.example/offer');
      expect(candidate.human_edited).toContain('price');
      // evidence linked
      expect(await db.evidence.getById(candidate.evidence_id)).not.toBeNull();
      // a backing ad_hoc task was minted, already done (so it never shows as open work).
      const open = await db.manualCapture.listOpen(50);
      expect(open).toHaveLength(0);
      // audit row written on the new candidate
      const history = await uc.listReviews(candidate.id);
      expect(history).toHaveLength(1);
      expect(history[0]!.action).toBe('edit');
      expect(history[0]!.approver).toBe('alice');
    });

    it('rejects incomplete evidence and malformed fields at the boundary; refuses no approver', async () => {
      await expect(
        uc.createManualCapture('alice', makeLlmDeal(), { ...evidenceInput(), screenshotRef: '' }),
      ).rejects.toThrow(/evidence|EVIDENCE_INCOMPLETE/i);
      await expect(
        uc.createManualCapture('alice', { not: 'a deal' }, evidenceInput()),
      ).rejects.toThrow();
      await expect(uc.createManualCapture('  ', makeLlmDeal(), evidenceInput())).rejects.toThrow(
        /approver/,
      );
    });
  });

  // ── listCandidates filters ────────────────────────────────────────────────
  describe('listCandidates (filters + pagination)', () => {
    it('defaults to the reviewable pair and joins evidence', async () => {
      await makeCandidate(db, randomUUID(), { status: 'candidate' });
      await makeCandidate(db, randomUUID(), { status: 'in_review' });
      await makeCandidate(db, randomUUID(), { status: 'published' });
      const views = await uc.listCandidates();
      expect(views).toHaveLength(2);
    });

    it('filters by status and confidenceMax and paginates', async () => {
      const svc = `svc-${randomUUID()}`;
      await makeCandidate(db, randomUUID(), { service: svc, status: 'candidate', confidence: 0.3 });
      await makeCandidate(db, randomUUID(), { service: svc, status: 'candidate', confidence: 0.9 });
      const low = await uc.listCandidates({ filters: { service: svc, confidenceMax: 0.5 } });
      expect(low).toHaveLength(1);
      expect(low[0]!.deal.confidence).toBe(0.3);

      const page = await uc.listCandidates({ filters: { service: svc }, limit: 1, offset: 0 });
      expect(page).toHaveLength(1);
      // lowest-confidence first
      expect(page[0]!.deal.confidence).toBe(0.3);
    });
  });

  // ── candidateCounts (ACR-5) ──────────────────────────────────────────────
  describe('candidateCounts', () => {
    it('aggregates deal counts + rejected_today (UTC-day bounded)', async () => {
      // FixedClock = 2026-06-19T00:00:00Z, so "today" = 2026-06-19.
      await makeCandidate(db, randomUUID(), {
        status: 'candidate',
        route_type: 'bundle',
        confidence: 0.3,
        human_edited: ['price'],
      });
      await makeCandidate(db, randomUUID(), {
        status: 'in_review',
        route_type: 'promo',
        confidence: 0.9,
      });
      // A published deal is NOT pending and must not be counted.
      await makeCandidate(db, randomUUID(), { status: 'published', route_type: 'bundle' });

      // Two rejects today + one yesterday (excluded).
      const mkReject = (at: string) =>
        db.reviews.insert({
          id: randomUUID(),
          deal_id: randomUUID(),
          action: 'reject',
          approver: 'r',
          reason: null,
          decided_at: at,
        });
      await mkReject('2026-06-19T08:00:00.000Z');
      await mkReject('2026-06-19T20:00:00.000Z');
      await mkReject('2026-06-18T23:59:59.000Z'); // yesterday → excluded

      const counts = await uc.candidateCounts();
      expect(counts.all_pending).toBe(2);
      expect(counts.low_confidence).toBe(1); // only the 0.3 candidate
      expect(counts.human_edited).toBe(1);
      expect(counts.by_route).toEqual({ bundle: 1, standalone: 0, promo: 1, regional: 0 });
      expect(counts.rejected_today).toBe(2);
    });
  });

  // ── auditFeed (ACR-7) ─────────────────────────────────────────────────────
  describe('auditFeed', () => {
    it('projects recent review rows newest-first, filtered by actor/entity, capped', async () => {
      const dealId = randomUUID();
      const mk = (deal_id: string, approver: string, action: 'approve' | 'reject', at: string) =>
        db.reviews.insert({
          id: randomUUID(),
          deal_id,
          action,
          approver,
          reason: action === 'reject' ? 'no good' : null,
          decided_at: at,
        });
      await mk(dealId, 'alice@dealroute', 'approve', '2026-06-19T01:00:00.000Z');
      await mk(dealId, 'alice@dealroute', 'reject', '2026-06-19T05:00:00.000Z');
      await mk(randomUUID(), 'bob@dealroute', 'approve', '2026-06-19T06:00:00.000Z');

      const all = await uc.auditFeed();
      expect(all.map((e) => e.at)).toEqual([
        '2026-06-19T06:00:00.000Z',
        '2026-06-19T05:00:00.000Z',
        '2026-06-19T01:00:00.000Z',
      ]);
      // Projected shape: initials + entity_id + detail.
      expect(all[0]!.initials).toBe('BO');
      expect(all[1]!.detail).toBe('no good');
      expect(all[1]!.entity_id).toBe(dealId);

      // Filtered by actor.
      const byAlice = await uc.auditFeed({ actor: 'alice@dealroute' });
      expect(byAlice.every((e) => e.actor === 'alice@dealroute')).toBe(true);
      expect(byAlice).toHaveLength(2);

      // Filtered by entity.
      const byDeal = await uc.auditFeed({ entityId: dealId });
      expect(byDeal.every((e) => e.entity_id === dealId)).toBe(true);

      // limit caps.
      const one = await uc.auditFeed({ limit: 1 });
      expect(one).toHaveLength(1);
      expect(one[0]!.at).toBe('2026-06-19T06:00:00.000Z');
    });
  });
});
