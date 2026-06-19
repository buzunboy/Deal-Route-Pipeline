import type {
  Source,
  DealRecord,
  CrawlRun,
  ManualCaptureTask,
  FieldProposalRecord,
  Change,
  Evidence,
  DealStatus,
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
  /** Find an existing non-rejected deal sharing this dedupe key (canonicalisation). */
  findByDedupeKey(dedupeKey: string): Promise<DealRecord | null>;
  updateStatus(
    id: string,
    status: DealStatus,
    verifiedBy: string | null,
    verifiedAt: string | null,
  ): Promise<void>;
  update(deal: DealRecord): Promise<void>;
}

export interface CrawlRunRepository {
  insert(run: CrawlRun): Promise<void>;
  update(run: CrawlRun): Promise<void>;
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
}
