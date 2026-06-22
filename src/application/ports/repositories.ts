import type {
  Source,
  DealRecord,
  CrawlRun,
  ManualCaptureTask,
  FieldProposalRecord,
  Change,
  Evidence,
  DealStatus,
  ReviewRecord,
  SourceReviewRecord,
  SubscriptionCatalogEntry,
  CostSummary,
  PublishedQuery,
  PublishedFilters,
  CandidateQuery,
  CandidateDealCounts,
  AdminPublishedQuery,
  VocabularyEntry,
  ReviewAction,
} from '../../domain/index.js';

/**
 * Focused repository ports (ISP): each table has its own small interface so an
 * adapter only implements what it needs and callers depend on the narrow slice
 * they use. A `Database` aggregate bundles them for the composition root.
 */

export interface SourceRepository {
  upsert(source: Source): Promise<void>;
  getById(id: string): Promise<Source | null>;
  /** Sources whose `next_due` is at/before `now` and status is active. */
  listDue(now: Date, limit: number): Promise<Source[]>;
  listByStatus(status: Source['status']): Promise<Source[]>;
  /** Persist an updated reliability score + next_due/last_seen after a crawl. */
  update(source: Source): Promise<void>;
}

export interface DealRepository {
  insert(deal: DealRecord): Promise<void>;
  getById(id: string): Promise<DealRecord | null>;
  listByStatus(status: DealStatus, limit: number): Promise<DealRecord[]>;
  /**
   * Source-scoped, status-filtered lookup — newest first. Used by monitoring so
   * diff-baseline + expiry are deterministic regardless of total table size (no
   * fetch-1000-then-filter-in-JS scaling cliff).
   */
  listBySourceUrl(sourceUrl: string, statuses: DealStatus[], limit: number): Promise<DealRecord[]>;
  /** Find an existing non-rejected deal sharing this dedupe key (canonicalisation). */
  findByDedupeKey(dedupeKey: string): Promise<DealRecord | null>;
  /**
   * Find a non-rejected candidate/in_review deal for this dedupe key whose linked
   * evidence has the given content hash — used to avoid re-queuing an identical
   * candidate when a page's hash changes but the offer hasn't (flapping content).
   */
  findActiveByDedupeKeyAndHash(dedupeKey: string, contentHash: string): Promise<DealRecord | null>;
  updateStatus(
    id: string,
    status: DealStatus,
    verifiedBy: string | null,
    verifiedAt: string | null,
  ): Promise<void>;
  /** Expire every published deal for a source URL in one statement. Returns the count. */
  expirePublishedBySourceUrl(sourceUrl: string, expiredAt: string): Promise<number>;
  update(deal: DealRecord): Promise<void>;
  /**
   * The public read feed: `published` deals only, filtered + sorted + paginated.
   * Backs `GET /v1/deals`. `status = 'published'` is enforced INSIDE this method
   * (the trust boundary — a caller can never widen it), then the optional
   * {@link PublishedFilters} are AND-ed in. Sort is stable: the requested order
   * with `id` as the deterministic tiebreaker, so `offset`-based pagination never
   * skips or repeats a row. Both adapters MUST order identically (LSP).
   */
  listPublished(query: PublishedQuery): Promise<DealRecord[]>;
  /** Total `published` deals matching the same filters — for the feed's `total`. */
  countPublished(filters: PublishedFilters): Promise<number>;
  /**
   * The GATED admin review queue: candidates filtered + paginated. Unlike
   * {@link listPublished} this is NOT locked to one status — `filters.status`
   * narrows to a single status, and ABSENT status defaults to the reviewable pair
   * (`candidate` + `in_review`). Order is stable: `confidence` ascending (lowest
   * first — triage the shakiest extractions) with `id` as the deterministic
   * tiebreaker, so `offset` pagination never skips/repeats. Both adapters MUST
   * order identically (LSP).
   */
  listCandidates(query: CandidateQuery): Promise<DealRecord[]>;
  /**
   * The deal-derived slice of the review-queue counts (ACR-5): over the reviewable
   * statuses (`candidate` + `in_review`), tally the total, the low-confidence subset
   * (`confidence <= LOW_CONFIDENCE_MAX`), the human-edited subset (`human_edited`
   * non-empty), and a per-route breakdown — in ONE pass. `rejected_today` is NOT
   * here (it comes from the reviews audit log, date-bounded). Both adapters MUST
   * return identical numbers for the same data (LSP).
   */
  countCandidates(): Promise<CandidateDealCounts>;
  /**
   * The GATED admin "Published deals" screen (ACR-10): deals in the
   * {@link ADMIN_PUBLISHED_STATUSES} set (`published` + `expired` — publication
   * HISTORY, not just the live feed), ordered newest-published-first
   * (`published_at` desc NULLS LAST) then `id`, paginated. Both adapters MUST order
   * identically (LSP). Distinct from {@link listPublished} (public, published-only,
   * reliability-ranked).
   */
  listAdminPublished(query: AdminPublishedQuery): Promise<DealRecord[]>;
  /** Total deals in the admin-published status set — for the screen's `total`. */
  countAdminPublished(): Promise<number>;
}

export interface CrawlRunRepository {
  insert(run: CrawlRun): Promise<void>;
  update(run: CrawlRun): Promise<void>;
  /**
   * Aggregate logged run cost over a half-open `started_at` window: `since`
   * inclusive (`started_at >= since`), `until` exclusive (`started_at < until`).
   * Both bounds are optional and independent — a run whose `started_at` equals
   * `until` is EXCLUDED, one equal to `since` is INCLUDED. Day buckets are UTC
   * (`YYYY-MM-DD`). `per_day` is ascending by day; `per_source` is descending by
   * `cost_eur` then ascending by `source_id`. An empty window returns zeros +
   * empty arrays (never throws). Sums are rounded to cents via the domain
   * `roundEur` helper, applied identically in both adapters.
   */
  costSummary(filter: { since?: Date; until?: Date }): Promise<CostSummary>;
  /**
   * Total logged run cost (EUR) since `since` inclusive (`started_at >= since`),
   * across ALL run kinds. Powers the aggregate daily-budget guard: the caller
   * passes UTC midnight to get spend-so-far-today. Rounded to cents via the same
   * exact micro-euro convention as `costSummary` (order-independent across
   * adapters). An empty window returns 0, never throws.
   */
  spentSince(since: Date): Promise<number>;
  /**
   * Recent runs (any kind) over a half-open `started_at` window — same bounds
   * semantics as `costSummary` (`since` inclusive, `until` exclusive; both
   * optional). Newest first (`started_at` desc, then `id` desc as a deterministic
   * tiebreaker), capped at `limit`. The per-run observability surface: kind,
   * status, candidates/proposals produced, cost, stop-reason.
   */
  recentRuns(filter: { since?: Date; until?: Date; limit: number }): Promise<CrawlRun[]>;
}

export interface EvidenceRepository {
  insert(evidence: Evidence): Promise<void>;
  getById(id: string): Promise<Evidence | null>;
}

export interface ManualCaptureRepository {
  insert(task: ManualCaptureTask): Promise<void>;
  listOpen(limit: number): Promise<ManualCaptureTask[]>;
  /** Load one task by id (any status), or null. For completing a capture. */
  getById(id: string): Promise<ManualCaptureTask | null>;
  /**
   * Mark a task `done` (a human captured the offer by hand), optionally annotating
   * it. Idempotent on the row's existence; the caller asserts the task was `open`
   * first so a capture isn't completed twice (one task → at most one candidate).
   */
  markDone(id: string, note: string | null): Promise<void>;
}

export interface FieldProposalRepository {
  /** Insert or bump the count for a proposal keyed by `suggested_key`. */
  upsertAndCount(proposal: Omit<FieldProposalRecord, 'id' | 'count' | 'status'>): Promise<void>;
  listOpen(limit: number): Promise<FieldProposalRecord[]>;
  /** Load one proposal by its `suggested_key` (any status), or null. */
  getByKey(suggestedKey: string): Promise<FieldProposalRecord | null>;
  /**
   * Resolve a proposal by marking it `promoted` (a human promoted its key into the
   * `condition_vocabulary`). Idempotent; a no-op if the key doesn't exist. The
   * governed-promotion loop's terminal step — the proposal stops surfacing as open.
   */
  markPromoted(suggestedKey: string): Promise<void>;
}

/**
 * The controlled condition vocabulary (the keys long-tail conditions map to). A
 * `condition_vocabulary` table has existed since the first migration; this port
 * gives the promotion loop a typed seam to read/extend it (the
 * `promote-field-proposal` action). Extending the vocabulary is ADDITIVE and needs
 * no migration — that is the whole point of the governed loop (vs. a first-class
 * column, which does). Both adapters implement it identically (LSP).
 */
export interface ConditionVocabularyRepository {
  /** Load one entry by its canonical key, or null. */
  getByKey(key: string): Promise<VocabularyEntry | null>;
  /** Insert or replace a vocabulary entry (promotion writes here). */
  upsert(entry: VocabularyEntry): Promise<void>;
  /** All entries — the live vocabulary fed to the extractor's condition mapping. */
  list(): Promise<VocabularyEntry[]>;
}

export interface ChangeRepository {
  insert(change: Change): Promise<void>;
  /** Recent changes for a source, newest first — used to debounce auto-expiry. */
  recentForSource(sourceId: string, limit: number): Promise<Change[]>;
}

export interface ReviewRepository {
  /** Append a review decision (immutable audit log). */
  insert(review: ReviewRecord): Promise<void>;
  /** Decision history for one deal, newest first. */
  listForDeal(dealId: string, limit: number): Promise<ReviewRecord[]>;
  /**
   * Count review decisions of a given `action` whose `decided_at` is at/after
   * `since` (inclusive). Powers ACR-5's `rejected_today` (action `reject`, `since`
   * = UTC midnight) — a true date-bounded count the deal row can't express. Both
   * adapters MUST agree for the same data (LSP).
   */
  countByActionSince(action: ReviewAction, since: Date): Promise<number>;
  /**
   * Recent review decisions across ALL deals (the audit feed, ACR-7), newest first.
   * Optional filters: `approver` (exact actor), `dealId` (exact entity), `since`
   * (decided_at >= since). Capped at `limit`. Ordering is `decided_at` desc then
   * `id` desc (deterministic tiebreaker) — both adapters identical (LSP).
   */
  listRecent(filter: {
    approver?: string;
    dealId?: string;
    since?: Date;
    limit: number;
  }): Promise<ReviewRecord[]>;
}

export interface SourceReviewRepository {
  /** Append a source-promotion decision (immutable audit log). */
  insert(review: SourceReviewRecord): Promise<void>;
  /** Decision history for one source, newest first. */
  listForSource(sourceId: string, limit: number): Promise<SourceReviewRecord[]>;
}

export interface SubscriptionCatalogRepository {
  upsert(entry: SubscriptionCatalogEntry): Promise<void>;
  /** All catalog services (drives Tier-3 community keyword matching). */
  list(): Promise<SubscriptionCatalogEntry[]>;
}

/** Aggregate handed to the composition root; groups the focused repositories. */
export interface Database {
  sources: SourceRepository;
  deals: DealRepository;
  crawlRuns: CrawlRunRepository;
  evidence: EvidenceRepository;
  manualCapture: ManualCaptureRepository;
  fieldProposals: FieldProposalRepository;
  conditionVocabulary: ConditionVocabularyRepository;
  changes: ChangeRepository;
  reviews: ReviewRepository;
  sourceReviews: SourceReviewRepository;
  catalog: SubscriptionCatalogRepository;
}
