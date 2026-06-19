import { randomUUID } from 'node:crypto';
import {
  dedupeKey,
  type Source,
  type DealRecord,
  type CrawlRun,
  type Evidence,
  type ManualCaptureTask,
  type FieldProposalRecord,
  type Change,
  type DealStatus,
  type ReviewRecord,
  type SourceReviewRecord,
  type SubscriptionCatalogEntry,
} from '../../../domain/index.js';
import type {
  Database,
  SourceRepository,
  DealRepository,
  CrawlRunRepository,
  EvidenceRepository,
  ManualCaptureRepository,
  FieldProposalRepository,
  ChangeRepository,
  ReviewRepository,
  SourceReviewRepository,
  SubscriptionCatalogRepository,
} from '../../../application/ports/index.js';

/**
 * In-memory Database adapter. A first-class, shippable implementation of the
 * `Database` port: it lets the whole pipeline run (dry-run, demos, CI) WITHOUT a
 * Postgres instance. It is also the reference the adapter contract suite runs
 * the Postgres adapter against. Not durable — data is lost on process exit.
 */
export class InMemoryDb implements Database {
  sources: SourceRepository = new InMemorySourceRepo();
  // Evidence repo built first so the deal repo can resolve a deal's evidence hash
  // (the content-hash join behind findActiveByDedupeKeyAndHash).
  evidence: InMemoryEvidenceRepo = new InMemoryEvidenceRepo();
  deals: DealRepository = new InMemoryDealRepo(this.evidence);
  crawlRuns: CrawlRunRepository = new InMemoryCrawlRunRepo();
  manualCapture: ManualCaptureRepository = new InMemoryManualCaptureRepo();
  fieldProposals: FieldProposalRepository = new InMemoryFieldProposalRepo();
  changes: ChangeRepository = new InMemoryChangeRepo();
  reviews: ReviewRepository = new InMemoryReviewRepo();
  sourceReviews: SourceReviewRepository = new InMemorySourceReviewRepo();
  catalog: SubscriptionCatalogRepository = new InMemoryCatalogRepo();
}

class InMemorySourceRepo implements SourceRepository {
  private store = new Map<string, Source>();
  async upsert(s: Source): Promise<void> {
    this.store.set(s.id, { ...s });
  }
  async getById(id: string): Promise<Source | null> {
    const s = this.store.get(id);
    return s ? { ...s } : null;
  }
  async listDue(now: Date, limit: number): Promise<Source[]> {
    return [...this.store.values()]
      .filter(
        (s) =>
          s.status === 'active' && (s.next_due === null || Date.parse(s.next_due) <= now.getTime()),
      )
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }
  async listByStatus(status: Source['status']): Promise<Source[]> {
    return [...this.store.values()].filter((s) => s.status === status).map((s) => ({ ...s }));
  }
  async update(s: Source): Promise<void> {
    this.store.set(s.id, { ...s });
  }
}

class InMemoryDealRepo implements DealRepository {
  private store = new Map<string, DealRecord>();
  constructor(private readonly evidence: InMemoryEvidenceRepo) {}
  async insert(d: DealRecord): Promise<void> {
    this.store.set(d.id, { ...d });
  }
  async getById(id: string): Promise<DealRecord | null> {
    const d = this.store.get(id);
    return d ? { ...d } : null;
  }
  async listByStatus(status: DealStatus, limit: number): Promise<DealRecord[]> {
    return [...this.store.values()]
      .filter((d) => d.status === status)
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }
  async listBySourceUrl(
    sourceUrl: string,
    statuses: DealStatus[],
    limit: number,
  ): Promise<DealRecord[]> {
    const set = new Set(statuses);
    return [...this.store.values()]
      .filter((d) => d.source_url === sourceUrl && set.has(d.status))
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }
  async findByDedupeKey(key: string): Promise<DealRecord | null> {
    // Return the highest-confidence non-rejected match, matching PgDealRepo's
    // `orderBy(desc(confidence))` so the canonical-deal choice is identical
    // across adapters (LSP) and a low-confidence row can't shadow the canonical.
    let best: DealRecord | null = null;
    for (const d of this.store.values()) {
      if (d.status === 'rejected' || dedupeKey(d) !== key) continue;
      if (best === null || d.confidence > best.confidence) best = d;
    }
    return best ? { ...best } : null;
  }
  async findActiveByDedupeKeyAndHash(key: string, contentHash: string): Promise<DealRecord | null> {
    for (const d of this.store.values()) {
      if (d.status !== 'candidate' && d.status !== 'in_review') continue;
      if (dedupeKey(d) !== key) continue;
      const ev = await this.evidence.getById(d.evidence_id);
      if (ev && ev.content_hash === contentHash) return { ...d };
    }
    return null;
  }
  async updateStatus(
    id: string,
    status: DealStatus,
    verifiedBy: string | null,
    verifiedAt: string | null,
  ): Promise<void> {
    const d = this.store.get(id);
    if (d) this.store.set(id, { ...d, status, verified_by: verifiedBy, verified_at: verifiedAt });
  }
  async expirePublishedBySourceUrl(sourceUrl: string, expiredAt: string): Promise<number> {
    let n = 0;
    for (const d of this.store.values()) {
      if (d.status === 'published' && d.source_url === sourceUrl) {
        this.store.set(d.id, { ...d, status: 'expired', verified_at: expiredAt });
        n++;
      }
    }
    return n;
  }
  async update(d: DealRecord): Promise<void> {
    this.store.set(d.id, { ...d });
  }
}

class InMemoryCrawlRunRepo implements CrawlRunRepository {
  private store = new Map<string, CrawlRun>();
  async insert(r: CrawlRun): Promise<void> {
    this.store.set(r.id, { ...r });
  }
  async update(r: CrawlRun): Promise<void> {
    this.store.set(r.id, { ...r });
  }
}

class InMemoryEvidenceRepo implements EvidenceRepository {
  private store = new Map<string, Evidence>();
  async insert(e: Evidence): Promise<void> {
    this.store.set(e.id, { ...e });
  }
  async getById(id: string): Promise<Evidence | null> {
    const e = this.store.get(id);
    return e ? { ...e } : null;
  }
}

class InMemoryManualCaptureRepo implements ManualCaptureRepository {
  private tasks: ManualCaptureTask[] = [];
  async insert(t: ManualCaptureTask): Promise<void> {
    this.tasks.push({ ...t });
  }
  async listOpen(limit: number): Promise<ManualCaptureTask[]> {
    return this.tasks
      .filter((t) => t.status === 'open')
      .slice(0, limit)
      .map((t) => ({ ...t }));
  }
}

class InMemoryFieldProposalRepo implements FieldProposalRepository {
  private store = new Map<string, FieldProposalRecord>();
  async upsertAndCount(p: Omit<FieldProposalRecord, 'id' | 'count' | 'status'>): Promise<void> {
    const existing = this.store.get(p.suggested_key);
    if (existing) {
      this.store.set(p.suggested_key, {
        ...existing,
        count: existing.count + 1,
        last_seen_at: p.last_seen_at,
      });
    } else {
      this.store.set(p.suggested_key, { ...p, id: randomUUID(), count: 1, status: 'open' });
    }
  }
  async listOpen(limit: number): Promise<FieldProposalRecord[]> {
    return [...this.store.values()]
      .filter((p) => p.status === 'open')
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }
}

class InMemoryChangeRepo implements ChangeRepository {
  private changes: { change: Change; seq: number }[] = [];
  private seq = 0;
  async insert(c: Change): Promise<void> {
    this.changes.push({ change: { ...c }, seq: this.seq++ });
  }
  async recentForSource(sourceId: string, limit: number): Promise<Change[]> {
    // Newest first. Insertion sequence is the tiebreaker so equal timestamps
    // (e.g. a fixed clock) still return the later-inserted change first —
    // monitor's consecutive-disappearance debounce depends on this ordering.
    return this.changes
      .filter((e) => e.change.source_id === sourceId)
      .sort((a, b) => b.change.detected_at.localeCompare(a.change.detected_at) || b.seq - a.seq)
      .slice(0, limit)
      .map((e) => ({ ...e.change }));
  }
}

class InMemoryReviewRepo implements ReviewRepository {
  private reviews: { review: ReviewRecord; seq: number }[] = [];
  private seq = 0;
  async insert(r: ReviewRecord): Promise<void> {
    this.reviews.push({ review: { ...r }, seq: this.seq++ });
  }
  async listForDeal(dealId: string, limit: number): Promise<ReviewRecord[]> {
    // Newest first; insertion sequence breaks equal-timestamp ties (fixed clock).
    return this.reviews
      .filter((e) => e.review.deal_id === dealId)
      .sort((a, b) => b.review.decided_at.localeCompare(a.review.decided_at) || b.seq - a.seq)
      .slice(0, limit)
      .map((e) => ({ ...e.review }));
  }
}

class InMemorySourceReviewRepo implements SourceReviewRepository {
  private reviews: { review: SourceReviewRecord; seq: number }[] = [];
  private seq = 0;
  async insert(r: SourceReviewRecord): Promise<void> {
    this.reviews.push({ review: { ...r }, seq: this.seq++ });
  }
  async listForSource(sourceId: string, limit: number): Promise<SourceReviewRecord[]> {
    return this.reviews
      .filter((e) => e.review.source_id === sourceId)
      .sort((a, b) => b.review.decided_at.localeCompare(a.review.decided_at) || b.seq - a.seq)
      .slice(0, limit)
      .map((e) => ({ ...e.review }));
  }
}

class InMemoryCatalogRepo implements SubscriptionCatalogRepository {
  private store = new Map<string, SubscriptionCatalogEntry>();
  async upsert(e: SubscriptionCatalogEntry): Promise<void> {
    this.store.set(e.service, { ...e });
  }
  async list(): Promise<SubscriptionCatalogEntry[]> {
    return [...this.store.values()].map((e) => ({ ...e }));
  }
}
