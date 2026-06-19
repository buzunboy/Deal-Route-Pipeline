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
}

export interface FieldProposalRepository {
  /** Insert or bump the count for a proposal keyed by `suggested_key`. */
  upsertAndCount(proposal: Omit<FieldProposalRecord, 'id' | 'count' | 'status'>): Promise<void>;
  listOpen(limit: number): Promise<FieldProposalRecord[]>;
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
  changes: ChangeRepository;
  reviews: ReviewRepository;
  sourceReviews: SourceReviewRepository;
  catalog: SubscriptionCatalogRepository;
}
