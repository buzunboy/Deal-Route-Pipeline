import { createHash, randomUUID } from 'node:crypto';
import {
  DealStatus,
  DealNotFoundError,
  NotReviewableError,
  MissingApproverError,
  FieldProposalNotFoundError,
  PromotionTargetNotSupportedError,
  ManualCaptureTaskNotFoundError,
  ManualCaptureTaskNotOpenError,
  EvidenceIncompleteError,
  InvalidPatchError,
  applyCandidatePatch,
  LlmExtractedDealSchema,
  validateRecord,
  trueCostMonthly,
  adjustConfidence,
  mustReview,
  missingReferencedEvidence,
  CURRENT_SCHEMA_VERSION,
  CANDIDATES_DEFAULT_LIMIT,
  CANDIDATES_MAX_LIMIT,
  CANDIDATES_MAX_OFFSET,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  toAuditEntry,
  ADMIN_PUBLISHED_DEFAULT_LIMIT,
  ADMIN_PUBLISHED_MAX_LIMIT,
  ADMIN_PUBLISHED_MAX_OFFSET,
  toAdminPublishedDeal,
  type CandidateCounts,
  type AuditEntry,
  type AdminPublishedDeal,
  type DealRecord,
  type Evidence,
  type ManualCaptureTask,
  type FieldProposalRecord,
  type ReviewRecord,
  type CandidateFilters,
  type LlmExtractedDeal,
  type VocabularyEntry,
  type SuffixOracle,
  type Permission,
  type SearchResource,
  type SearchResults,
  SEARCH_RESOURCES,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_USERS_PERMISSION,
} from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';

/** A candidate joined with its evidence, for the review API/console. */
export interface CandidateView {
  deal: DealRecord;
  evidence: Evidence | null;
}

/** Optional filters + pagination for the candidate review queue (all bounded/defaulted). */
export interface ListCandidatesOptions {
  filters?: CandidateFilters;
  limit?: number;
  offset?: number;
}

/** Inputs to promote a recurring field proposal into the condition vocabulary. */
export interface PromoteFieldProposalInput {
  approver: string;
  /** The proposal's `suggested_key` to resolve. */
  suggestedKey: string;
  /** The canonical vocabulary key to create (may differ from the suggested key). */
  canonicalKey: string;
  label: string;
  /** v1 supports only 'vocabulary'; 'field' (a new column) is rejected (deferred). */
  target: 'vocabulary' | 'field';
}

/** The evidence a human attaches when completing a manual-capture task (by reference). */
export interface ManualCaptureEvidenceInput {
  sourceUrl: string;
  screenshotRef: string;
  htmlRef: string;
  termsRef: string;
  termsText: string;
}

/**
 * Human-in-the-loop review. This is the ONLY path by which a deal becomes
 * `published`. Nothing auto-publishes (v1 trust invariant): publication requires
 * an explicit approve call carrying the approver's identity.
 *
 * Evidence metadata is resolved from the `evidence` repository (where the crawl
 * pipeline records each bundle's pointers) — not the artifact store — so review
 * does not depend on where screenshots/HTML physically live.
 */
export class ReviewUseCase {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /**
     * The PSL oracle (Step 6) — pins a manual-captured candidate's registrable
     * domain from its source URL, exactly as extract does, so the dedupe key + the
     * reliability join read a consistent value. Injected from the composition root.
     */
    private readonly suffixOracle: SuffixOracle,
  ) {}

  /**
   * List deals awaiting review, each with its evidence bundle, ordered
   * lowest-confidence-first so a reviewer triages the shakiest extractions first.
   *
   * With no options this reproduces the original behaviour: the reviewable pair
   * (`candidate` + `in_review`). Options narrow by a single `status` (including a
   * terminal one, for auditing published/rejected/expired deals), `service`, or
   * `confidenceMax`, and bound the page. `limit`/`offset` are clamped to the domain
   * caps (never trust a raw caller value) — the HTTP boundary 400s an over-cap
   * offset, but a programmatic caller is clamped here as a floor guard.
   */
  async listCandidates(opts: ListCandidatesOptions = {}): Promise<CandidateView[]> {
    const limit = clamp(opts.limit ?? CANDIDATES_DEFAULT_LIMIT, 1, CANDIDATES_MAX_LIMIT);
    const offset = clamp(opts.offset ?? 0, 0, CANDIDATES_MAX_OFFSET);
    const deals = await this.db.deals.listCandidates({
      filters: opts.filters ?? {},
      limit,
      offset,
    });
    return Promise.all(
      deals.map(async (deal) => ({
        deal,
        evidence: deal.evidence_id ? await this.db.evidence.getById(deal.evidence_id) : null,
      })),
    );
  }

  /**
   * Aggregate counts for the review-queue view-cards + filter rail (ACR-5). Combines
   * the deal-derived counts (over the reviewable statuses) with `rejected_today` from
   * the reviews audit log, date-bounded to the current UTC day. One read per source —
   * no per-card filtered list reads, and a true "today" bound the deal row can't give.
   */
  async candidateCounts(): Promise<CandidateCounts> {
    const dealCounts = await this.db.deals.countCandidates();
    const rejectedToday = await this.db.reviews.countByActionSince(
      'reject',
      utcMidnight(this.clock.now()),
    );
    return { ...dealCounts, rejected_today: rejectedToday };
  }

  /**
   * The cross-deal audit feed (ACR-7) — recent human review decisions, newest first,
   * projected to the panel's audit-entry shape. Backs both the Dashboard
   * "recent activity" card (latest slice) and the Audit-log screen (with filters).
   * Optional filters: `actor` (approver), `entityId` (deal), `since`. The page size
   * is clamped to the domain caps (a floor guard; the HTTP boundary 400s an over-cap
   * limit). Only the persisted review actions (`approve|reject|edit`) appear — see
   * {@link toAuditEntry}.
   */
  async auditFeed(
    opts: {
      actor?: string;
      entityId?: string;
      since?: Date;
      limit?: number;
    } = {},
  ): Promise<AuditEntry[]> {
    const limit = clamp(opts.limit ?? AUDIT_DEFAULT_LIMIT, 1, AUDIT_MAX_LIMIT);
    const rows = await this.db.reviews.listRecent({
      approver: opts.actor,
      dealId: opts.entityId,
      since: opts.since,
      limit,
    });
    return rows.map(toAuditEntry);
  }

  /**
   * The gated admin "Published deals" screen (ACR-10): publication HISTORY — live
   * (`published`) + unpublished (`expired`) deals — newest-published-first, projected
   * to the panel's row shape, with a `total`. Page size/offset clamped to the domain
   * caps (floor guard; the HTTP boundary 400s an over-cap value).
   */
  async adminPublished(
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ deals: AdminPublishedDeal[]; total: number }> {
    const limit = clamp(opts.limit ?? ADMIN_PUBLISHED_DEFAULT_LIMIT, 1, ADMIN_PUBLISHED_MAX_LIMIT);
    const offset = clamp(opts.offset ?? 0, 0, ADMIN_PUBLISHED_MAX_OFFSET);
    const [deals, total] = await Promise.all([
      this.db.deals.listAdminPublished({ limit, offset }),
      this.db.deals.countAdminPublished(),
    ]);
    return { deals: deals.map(toAdminPublishedDeal), total };
  }

  /**
   * Unified search across the panel's resources (the frozen /api/search contract).
   * Owns the trust + contract rules; the DB layer is the dumb ILIKE executor:
   *   - q shorter than {@link SEARCH_MIN_QUERY_LENGTH} (after trim) ⇒ `{}` with NO DB hit.
   *   - `resource` absent ⇒ every resource the caller may see; present ⇒ only that one.
   *   - the `users` category is included ONLY when the caller holds `team:manage`; an
   *     under-permissioned caller gets NO `users` key (never an empty array — absent).
   *   - `limit` is clamped to [1, {@link SEARCH_MAX_LIMIT}], default {@link SEARCH_DEFAULT_LIMIT}.
   * Caller (the route handler) has already rejected an unknown `resource` with a 400.
   */
  async search(opts: {
    q: string;
    resource?: SearchResource;
    limit?: number;
    permissions: Set<Permission>;
  }): Promise<SearchResults> {
    const q = opts.q.trim();
    if (q.length < SEARCH_MIN_QUERY_LENGTH) return {};

    const limit = clamp(opts.limit ?? SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);

    // Build the permitted resource set: the requested one (or all), minus `users` unless
    // the caller can manage the team. `users` is the only permission-scoped category today.
    const requested = opts.resource ? [opts.resource] : [...SEARCH_RESOURCES];
    const resources = new Set<SearchResource>(
      requested.filter((r) => r !== 'users' || opts.permissions.has(SEARCH_USERS_PERMISSION)),
    );
    if (resources.size === 0) return {};

    return this.db.search({ q, resources, limit });
  }

  /**
   * Apply a reviewer's correction to a candidate's extracted fields, BEFORE approve.
   *
   * The candidate must still be reviewable (`candidate`/`in_review`). The patch is
   * limited by {@link applyCandidatePatch} to reviewer-correctable fields — never
   * identity/provenance/status — and re-validated through the deal schema + sanity
   * rules (currency-vs-country, price band, dates, …). Every changed field is added
   * to `human_edited` so a corrected value is never read as model-grounded (the
   * model `grounding` quotes are KEPT — an owner decision — but `human_edited`
   * flags which fields they no longer back). Status STAYS a candidate; a later
   * approve publishes the edited record. The edit is recorded in the immutable
   * audit log (`action: 'edit'`) with an old→new summary + who + when.
   */
  async editCandidate(dealId: string, approver: string, patch: unknown): Promise<DealRecord> {
    this.assertApprover(approver, 'edit');
    const deal = await this.requireDeal(dealId);
    this.assertReviewable(deal);

    // Pure: enforce the allowlist, validate sub-objects, merge, re-derive true cost.
    const { deal: patched, changed } = applyCandidatePatch(deal, patch);
    if (changed.length === 0) {
      // A no-op edit isn't an error, but it shouldn't mint an audit row or re-touch
      // the record — return the candidate unchanged.
      this.logger.info('editCandidate: no fields changed — no-op', { dealId, approver });
      return deal;
    }

    // Re-run sanity validation on the edited record (currency-vs-country, price
    // band, billing/prepaid, date ordering). We do NOT pass the page text here, so
    // grounding is reported as not-verifiable — the reviewer is the human in the
    // loop and the model quotes are kept-but-flagged via human_edited. A failing
    // sanity rule is logged but never BLOCKS the edit (the owner kept status =
    // candidate); it surfaces in the audit summary for the approver.
    const validation = validateRecord(patched);
    if (!validation.ok) {
      this.logger.warn('editCandidate: edited record fails a sanity rule (kept for review)', {
        dealId,
        approver,
        failures: validation.failures.map((f) => f.rule),
      });
    }

    // Merge changed paths into human_edited (union, stable order) — the trust trail.
    const humanEdited = unionPaths(deal.human_edited, changed);
    const at = this.clock.nowIso();
    const summary = changed.map((f) => editSummary(f, deal, patched)).join('; ');

    // Log-before-act: append the audit row FIRST (the durable decision record).
    await this.recordReview(
      dealId,
      'edit',
      approver,
      `edited ${changed.join(', ')}: ${summary}`,
      at,
    );
    const edited: DealRecord = { ...patched, human_edited: humanEdited };
    await this.db.deals.update(edited);
    this.logger.info('candidate edited by reviewer', { dealId, approver, changed });
    return edited;
  }

  /**
   * Promote a recurring field proposal into the controlled `condition_vocabulary`
   * (the API form of the `promote-field-proposal` skill). Adds a vocabulary entry
   * keyed by `canonicalKey` (the suggested key as an alias so existing `key:"other"`
   * conditions re-map), marks the matching proposal `promoted` (out of the open
   * queue), and audits it. Extending the vocabulary is ADDITIVE — no migration.
   *
   * `target: 'field'` (a first-class typed column) needs a schema migration and is
   * NOT supported in v1 — it throws {@link PromotionTargetNotSupportedError} (400).
   */
  async promoteFieldProposal(input: PromoteFieldProposalInput): Promise<VocabularyEntry> {
    this.assertApprover(input.approver, 'promote');
    if (input.target !== 'vocabulary') {
      throw new PromotionTargetNotSupportedError(input.target);
    }
    const proposal = await this.db.fieldProposals.getByKey(input.suggestedKey);
    if (proposal === null) throw new FieldProposalNotFoundError(input.suggestedKey);

    // The suggested key becomes an alias of the canonical key, so conditions the
    // extractor previously emitted under it now map cleanly (vocab-mapping matches
    // on key OR alias). Existing entry → merge the alias; new → version 1.
    const existing = await this.db.conditionVocabulary.getByKey(input.canonicalKey);
    const aliases = unionPaths(existing?.aliases ?? [], [input.suggestedKey]);
    const entry: VocabularyEntry = {
      key: input.canonicalKey,
      label: input.label,
      aliases,
      version: existing?.version ?? 1,
    };
    await this.db.conditionVocabulary.upsert(entry);
    await this.db.fieldProposals.markPromoted(input.suggestedKey);
    this.logger.info('field proposal promoted to vocabulary', {
      approver: input.approver,
      suggestedKey: input.suggestedKey,
      canonicalKey: input.canonicalKey,
    });
    return entry;
  }

  /**
   * Complete a manual-capture task: a human captured a blocked/captcha-gated offer
   * by hand. Persists the (referenced) evidence bundle, mints a `candidate` deal
   * from the human-entered fields, marks the task `done`, and audits it. NEVER
   * publishes — the candidate flows through normal review/edit/approve.
   *
   * Trust: evidence is REQUIRED (a missing ref / terms text → 400, no candidate);
   * the source URL is pinned from the evidence, never trusted from the fields;
   * EVERY field path supplied is recorded in `human_edited` (the whole record is
   * human-entered, so none of it is model-grounded); the record runs through the
   * SAME sanity/grounding validation as an extraction, and a failure routes it to
   * `in_review`.
   */
  async completeManualCapture(
    taskId: string,
    approver: string,
    fields: unknown,
    evidence: ManualCaptureEvidenceInput,
  ): Promise<DealRecord> {
    this.assertApprover(approver, 'complete-manual-capture');
    const task = await this.requireManualCaptureTask(taskId);
    if (task.status !== 'open') {
      throw new ManualCaptureTaskNotOpenError(taskId, task.status);
    }

    const candidate = await this.mintCandidateFromCapture(
      approver,
      fields,
      evidence,
      `manual capture from task ${taskId} (${task.reason})`,
    );
    await this.db.manualCapture.markDone(taskId, `captured by ${approver}`);
    this.logger.info('manual-capture task completed → candidate created', {
      taskId,
      dealId: candidate.id,
      approver,
      status: candidate.status,
    });
    return candidate;
  }

  /**
   * Create a candidate from an AD-HOC manual capture (ACR-12) — a deal a reviewer
   * enters from scratch with NO backing crawler "couldn't read" task. Mints a
   * `done` manual-capture task (reason `ad_hoc`, so the provenance is auditable) AND
   * the evidence-backed candidate in one call. Same trust contract as
   * {@link completeManualCapture}: evidence REQUIRED, source_url pinned from the
   * evidence, the whole record tagged `human_edited`, validated, NEVER auto-published.
   */
  async createManualCapture(
    approver: string,
    fields: unknown,
    evidence: ManualCaptureEvidenceInput,
  ): Promise<DealRecord> {
    this.assertApprover(approver, 'create-manual-capture');
    // Mint the backing task FIRST (status done, reason ad_hoc) so the candidate's
    // audit line can reference it and the capture has a durable provenance row.
    const taskId = randomUUID();
    await this.db.manualCapture.insert({
      id: taskId,
      source_id: null,
      source_url: evidence.sourceUrl,
      reason: 'ad_hoc',
      created_at: this.clock.nowIso(),
      status: 'done',
      note: `ad-hoc capture by ${approver}`,
    });
    const candidate = await this.mintCandidateFromCapture(
      approver,
      fields,
      evidence,
      `ad-hoc manual capture (task ${taskId})`,
    );
    this.logger.info('ad-hoc manual capture → candidate created', {
      taskId,
      dealId: candidate.id,
      approver,
      status: candidate.status,
    });
    return candidate;
  }

  /**
   * Shared core of the two manual-capture paths: validate the referenced evidence +
   * the human fields, persist the evidence bundle, mint a must-review candidate
   * (source_url pinned from evidence, registrable domain pinned, whole record tagged
   * `human_edited`), and write the audit row BEFORE the deal (log-before-act). Never
   * publishes. The caller owns the task lifecycle (close an existing one / mint a new
   * one) and its own log line.
   */
  private async mintCandidateFromCapture(
    approver: string,
    fields: unknown,
    evidence: ManualCaptureEvidenceInput,
    auditReason: string,
  ): Promise<DealRecord> {
    // Evidence-required invariant: reject a hollow referenced capture up front.
    const missing = missingReferencedEvidence({
      sourceUrl: evidence.sourceUrl,
      screenshotRef: evidence.screenshotRef,
      htmlRef: evidence.htmlRef,
      termsRef: evidence.termsRef,
      termsText: evidence.termsText,
      capturedAt: this.clock.nowIso(),
    });
    if (missing.length > 0) throw new EvidenceIncompleteError(missing);

    // Validate the human-entered deal fields through the deal-record boundary schema
    // (LlmExtractedDealSchema) — a manual capture is a from-scratch human entry of
    // the same core an extractor would propose. The boundary rejects garbage/missing
    // fields (400) before any persistence. We never trust raw input, human or LLM.
    const parsed = LlmExtractedDealSchema.safeParse(fields);
    if (!parsed.success) {
      throw new InvalidPatchError(
        `Manual-capture fields failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        parsed.error.issues.map((i) => i.path.join('.')),
      );
    }
    // Pin source_url from the EVIDENCE (provenance we control), never the fields.
    const filled: LlmExtractedDeal = { ...parsed.data, source_url: evidence.sourceUrl };

    // Persist the referenced evidence bundle as metadata (the bytes live wherever
    // the human uploaded them — we store the refs + a server-computed content hash
    // over the terms text, the same region monitoring diffs on). NOT via
    // EvidenceStore.save (that needs bytes); directly via the evidence repository.
    const at = this.clock.nowIso();
    const evidenceRecord: Evidence = {
      id: randomUUID(),
      source_url: evidence.sourceUrl,
      screenshot_ref: evidence.screenshotRef,
      html_ref: evidence.htmlRef,
      terms_ref: evidence.termsRef,
      captured_at: at,
      content_hash: sha256(evidence.termsText),
    };
    await this.db.evidence.insert(evidenceRecord);

    // Re-derive true cost, run the SAME sanity/grounding validation as an extraction
    // (grounding verified against the captured terms text) → must-review, and pin
    // the registrable domain. A human-captured record is NEVER auto-trusted.
    const validation = validateRecord(filled, evidence.termsText);
    const adjusted = adjustConfidence(filled, validation.failures.length);
    const review = mustReview(adjusted, validation.failures.length);
    const sourceRegistrableDomain = this.suffixOracle(evidence.sourceUrl);
    const candidate: DealRecord = {
      ...filled,
      id: randomUUID(),
      schema_version: CURRENT_SCHEMA_VERSION,
      true_cost_monthly: trueCostMonthly(filled.price),
      confidence: adjusted,
      evidence_id: evidenceRecord.id,
      status: review ? DealStatus.enum.in_review : DealStatus.enum.candidate,
      verified_by: null,
      verified_at: null,
      affiliate_disclosure: true,
      published_at: null,
      source_registrable_domain: sourceRegistrableDomain,
      // The ENTIRE record was entered by a human (no model proposed any of it), so
      // every human-entered field — not just the reviewer-editable subset — is
      // tagged: none of it is model-grounded. Identity/provenance/derived fields
      // (id/evidence_id/source_url/true_cost/status/…) are pipeline-set, not human,
      // so they're excluded.
      human_edited: [...MANUAL_CAPTURE_HUMAN_FIELDS],
    };

    // Log-before-act (as in approve/reject/editCandidate): the candidate's id is
    // already generated above, so write the audit row FIRST. A mid-call failure
    // then leaves at worst an orphan audit row — never an un-audited candidate.
    await this.recordReview(candidate.id, 'edit', approver, auditReason, at);
    await this.db.deals.insert(candidate);
    return candidate;
  }

  /**
   * Approve a candidate → published. Requires an approver (no anonymous publish).
   *
   * At publish we set the EU-Omnibus disclosure fields (Step 2): `published_at` (the
   * approve instant, distinct from `verified_at`) and `affiliate_disclosure`. The
   * reviewer supplies the disclosure; when omitted it **defaults to `true`** (the
   * safe, over-disclosing side) and we LOG a flag so a defaulted publish is visible,
   * never silent. The fields are set here by the human — never LLM-proposed.
   */
  async approve(
    dealId: string,
    approver: string,
    opts: { affiliateDisclosure?: boolean } = {},
  ): Promise<DealRecord> {
    this.assertApprover(approver, 'approve');
    const deal = await this.requireDeal(dealId);
    this.assertReviewable(deal);

    const at = this.clock.nowIso();
    const affiliateDisclosure = opts.affiliateDisclosure ?? true;
    if (opts.affiliateDisclosure === undefined) {
      this.logger.warn(
        'deal published with DEFAULTED affiliate_disclosure=true (reviewer omitted)',
        {
          dealId,
          approver,
        },
      );
    }

    // Log-before-act: append the audit row FIRST, so the worst case on a mid-call
    // failure is an orphan review row — never a published deal with no audit trail.
    await this.recordReview(dealId, 'approve', approver, null, at);
    // Persist the full updated record (update() is the all-fields writer; updateStatus
    // only touches status/verified_*, so it can't carry the disclosure + published_at).
    const published: DealRecord = {
      ...deal,
      status: DealStatus.enum.published,
      verified_by: approver,
      verified_at: at,
      published_at: at,
      affiliate_disclosure: affiliateDisclosure,
    };
    await this.db.deals.update(published);
    this.logger.info('deal approved → published', { dealId, approver, affiliateDisclosure });
    return published;
  }

  /**
   * Reject a candidate → rejected (archived). Requires an approver (symmetric with
   * approve — no anonymous state changes). The rejection reason is recorded both in
   * the immutable `reviews` audit log and on the record's `attributes` (an open
   * JSONB area) for at-a-glance context, without inventing a column.
   */
  async reject(dealId: string, approver: string, reason?: string): Promise<DealRecord> {
    this.assertApprover(approver, 'reject');
    const deal = await this.requireDeal(dealId);
    this.assertReviewable(deal);

    const at = this.clock.nowIso();
    const trimmedReason = reason && reason.trim() !== '' ? reason.trim() : null;
    // Log-before-act (see approve): the audit row is the durable record of the
    // decision, written before any status mutation.
    await this.recordReview(dealId, 'reject', approver, trimmedReason, at);
    if (trimmedReason !== null) {
      await this.db.deals.update({
        ...deal,
        attributes: { ...deal.attributes, rejection_reason: trimmedReason },
      });
    }
    await this.db.deals.updateStatus(dealId, DealStatus.enum.rejected, approver, at);
    this.logger.info('deal rejected → archived', { dealId, approver, reason: trimmedReason });
    return { ...deal, status: DealStatus.enum.rejected, verified_by: approver, verified_at: at };
  }

  /** The append-only decision history for one deal (newest first). */
  async listReviews(dealId: string, limit = 50): Promise<ReviewRecord[]> {
    return this.db.reviews.listForDeal(dealId, limit);
  }

  private async recordReview(
    dealId: string,
    action: ReviewRecord['action'],
    approver: string,
    reason: string | null,
    at: string,
  ): Promise<void> {
    await this.db.reviews.insert({
      id: randomUUID(),
      deal_id: dealId,
      action,
      approver,
      reason,
      decided_at: at,
    });
  }

  private assertApprover(approver: string, action: string): void {
    if (approver.trim() === '') {
      throw new MissingApproverError(action);
    }
  }

  async listFieldProposals(limit = 50): Promise<FieldProposalRecord[]> {
    return this.db.fieldProposals.listOpen(limit);
  }

  async listManualCaptureTasks(limit = 50): Promise<ManualCaptureTask[]> {
    return this.db.manualCapture.listOpen(limit);
  }

  private async requireDeal(dealId: string): Promise<DealRecord> {
    const deal = await this.db.deals.getById(dealId);
    if (deal === null) throw new DealNotFoundError(dealId);
    return deal;
  }

  private async requireManualCaptureTask(taskId: string): Promise<ManualCaptureTask> {
    const task = await this.db.manualCapture.getById(taskId);
    if (task === null) throw new ManualCaptureTaskNotFoundError(taskId);
    return task;
  }

  /** Only pre-approval states can be approved/rejected — never re-decide a terminal deal. */
  private assertReviewable(deal: DealRecord): void {
    const reviewable: DealStatus[] = [DealStatus.enum.candidate, DealStatus.enum.in_review];
    if (!reviewable.includes(deal.status)) {
      throw new NotReviewableError(deal.id, deal.status);
    }
  }
}

/**
 * The field paths a manual capture marks `human_edited` — every part of the deal a
 * HUMAN entered (the whole LLM-proposable core + confidence), since no model
 * proposed any of it. Excludes pipeline-set identity/provenance/derived fields
 * (id/evidence_id/source_url/true_cost/status/…) which the human did NOT author.
 */
const MANUAL_CAPTURE_HUMAN_FIELDS: readonly string[] = [
  'service',
  'provider',
  'headline',
  'price',
  'country',
  'eligibility',
  'validity',
  'included_items',
  'attributes',
  'confidence',
];

/** Clamp `n` into [min, max] — a floor guard for paging values reaching the repo. */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Midnight (00:00:00.000Z) of the UTC day containing `at` — the "today" bound. */
function utcMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Union two path lists preserving the existing order, appending new ones once. */
function unionPaths(existing: readonly string[], added: readonly string[]): string[] {
  const out = [...existing];
  for (const p of added) if (!out.includes(p)) out.push(p);
  return out;
}

/** A compact old→new summary of one changed field, for the audit reason. */
function editSummary(field: string, before: DealRecord, after: DealRecord): string {
  const b = (before as Record<string, unknown>)[field];
  const a = (after as Record<string, unknown>)[field];
  return `${field}: ${compact(b)} → ${compact(a)}`;
}

/** Render a field value compactly for an audit line (bounded length). */
function compact(v: unknown): string {
  const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/** SHA-256 hex of UTF-8 text — matches the crawl path's content-hash convention. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
