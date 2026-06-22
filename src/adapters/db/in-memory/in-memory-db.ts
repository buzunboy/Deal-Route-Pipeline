import { randomUUID } from 'node:crypto';
import {
  dedupeKey,
  toEurMicros,
  eurFromMicros,
  SOURCELESS_RUN_BUCKET,
  DealRecordSchema,
  buildReliabilityIndex,
  capByPrimary,
  rankPublished,
  type Source,
  type DealRecord,
  type CrawlRun,
  type CostSummary,
  type Evidence,
  type ManualCaptureTask,
  type FieldProposalRecord,
  type Change,
  type DealStatus,
  type ReviewRecord,
  type SourceReviewRecord,
  type SubscriptionCatalogEntry,
  type PublishedQuery,
  type PublishedFilters,
  type CandidateQuery,
  type VocabularyEntry,
  REVIEWABLE_STATUSES,
} from '../../../domain/index.js';
import type {
  Database,
  SourceRepository,
  DealRepository,
  CrawlRunRepository,
  EvidenceRepository,
  ManualCaptureRepository,
  FieldProposalRepository,
  ConditionVocabularyRepository,
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
  // The deal repo also reaches the source repo so listPublished can blend a
  // source's reliability into the public-feed sort (Step 3) — the deal→source
  // join by registrable domain. Same read both adapters do; LSP-identical.
  deals: DealRepository = new InMemoryDealRepo(this.evidence, this.sources);
  crawlRuns: CrawlRunRepository = new InMemoryCrawlRunRepo();
  manualCapture: ManualCaptureRepository = new InMemoryManualCaptureRepo();
  fieldProposals: FieldProposalRepository = new InMemoryFieldProposalRepo();
  conditionVocabulary: ConditionVocabularyRepository = new InMemoryConditionVocabularyRepo();
  changes: ChangeRepository = new InMemoryChangeRepo();
  reviews: ReviewRepository = new InMemoryReviewRepo();
  sourceReviews: SourceReviewRepository = new InMemorySourceReviewRepo();
  catalog: SubscriptionCatalogRepository = new InMemoryCatalogRepo();
}

class InMemorySourceRepo implements SourceRepository {
  // Keyed by `url` (the natural key), NOT id — so re-upserting the same URL with a
  // fresh id updates the existing row instead of adding a duplicate, matching the
  // Postgres adapter's ON CONFLICT (url). An existing row keeps its original id.
  private store = new Map<string, Source>();
  async upsert(s: Source): Promise<void> {
    const existing = this.store.get(s.url);
    this.store.set(s.url, existing ? { ...s, id: existing.id } : { ...s });
  }
  async getById(id: string): Promise<Source | null> {
    for (const s of this.store.values()) {
      if (s.id === id) return { ...s };
    }
    return null;
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
    // Keyed by url to match the upsert above (the store is url-keyed). The Postgres
    // adapter updates by id; here we locate the existing row's url (it equals s.url
    // for a normal update) and overwrite it.
    this.store.set(s.url, { ...s });
  }
}

class InMemoryDealRepo implements DealRepository {
  private store = new Map<string, DealRecord>();
  constructor(
    private readonly evidence: InMemoryEvidenceRepo,
    private readonly sources: SourceRepository,
  ) {}
  async insert(d: DealRecord): Promise<void> {
    // Parse on write so schema defaults (e.g. affiliate_disclosure=true) are applied
    // exactly as the Postgres adapter applies them on read — substitutability (LSP):
    // the fake must not be more permissive than prod (a deal can't be stored with a
    // defaulted field left undefined here but defaulted there).
    this.store.set(d.id, DealRecordSchema.parse(d));
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
  async listPublished(query: PublishedQuery): Promise<DealRecord[]> {
    // Mirror the Postgres adapter step-for-step so the two order identically (LSP):
    //  1. status='published' (the trust boundary) + the optional filters,
    //  2. take the top PUBLISHED_FETCH_CAP rows in deterministic PRIMARY-key order
    //     (the in-memory twin of Postgres's `ORDER BY <primary>, id LIMIT CAP` — so a
    //     >cap corpus is the same capped candidate set on both sides),
    //  3. blend each deal's source reliability (registrable-domain join) as the
    //     TIEBREAKER and slice the requested page — all in the shared pure ranker.
    const matches = [...this.store.values()].filter(
      (d) => d.status === 'published' && matchesPublishedFilters(d, query.filters),
    );
    const capped = capByPrimary(matches, query.sort);
    const byDomain = buildReliabilityIndex(await this.sources.listByStatus('active'));
    return rankPublished(capped, byDomain, query);
  }
  async countPublished(filters: PublishedFilters): Promise<number> {
    let n = 0;
    for (const d of this.store.values()) {
      if (d.status === 'published' && matchesPublishedFilters(d, filters)) n++;
    }
    return n;
  }
  async listCandidates(query: CandidateQuery): Promise<DealRecord[]> {
    // Mirror the Postgres adapter exactly (LSP): status set (single filter status,
    // or the default reviewable pair) → optional service/confidenceMax → order by
    // confidence ASC then id ASC → page. confidenceMax is inclusive.
    const statuses = new Set<DealStatus>(
      query.filters.status ? [query.filters.status] : REVIEWABLE_STATUSES,
    );
    return [...this.store.values()]
      .filter((d) => {
        if (!statuses.has(d.status)) return false;
        if (query.filters.service !== undefined && d.service !== query.filters.service)
          return false;
        if (query.filters.confidenceMax !== undefined && d.confidence > query.filters.confidenceMax)
          return false;
        return true;
      })
      .sort((a, b) => a.confidence - b.confidence || a.id.localeCompare(b.id))
      .slice(query.offset, query.offset + query.limit)
      .map((d) => ({ ...d }));
  }
  async findByDedupeKey(key: string): Promise<DealRecord | null> {
    // Return the highest-confidence non-rejected match, matching PgDealRepo's
    // `orderBy(desc(confidence))` so the canonical-deal choice is identical
    // across adapters (LSP) and a low-confidence row can't shadow the canonical.
    let best: DealRecord | null = null;
    for (const d of this.store.values()) {
      if (d.status === 'rejected' || dedupeKey(d, d.source_registrable_domain) !== key) continue;
      if (best === null || d.confidence > best.confidence) best = d;
    }
    return best ? { ...best } : null;
  }
  async findActiveByDedupeKeyAndHash(key: string, contentHash: string): Promise<DealRecord | null> {
    for (const d of this.store.values()) {
      if (d.status !== 'candidate' && d.status !== 'in_review') continue;
      if (dedupeKey(d, d.source_registrable_domain) !== key) continue;
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
    // Parse on write too (see insert) — defaults applied identically to Postgres.
    this.store.set(d.id, DealRecordSchema.parse(d));
  }
}

/**
 * True when a deal satisfies every supplied published filter (absent filter ⇒ no
 * constraint). Mirrors the Postgres adapter's AND-ed predicates exactly so the two
 * return the same set (LSP). `priceMax` is inclusive on `true_cost_monthly`.
 */
function matchesPublishedFilters(d: DealRecord, f: PublishedFilters): boolean {
  if (f.service !== undefined && d.service !== f.service) return false;
  if (f.country !== undefined && d.country !== f.country) return false;
  if (f.routeType !== undefined && d.route_type !== f.routeType) return false;
  if (f.priceMax !== undefined && d.true_cost_monthly > f.priceMax) return false;
  return true;
}

class InMemoryCrawlRunRepo implements CrawlRunRepository {
  private store = new Map<string, CrawlRun>();
  async insert(r: CrawlRun): Promise<void> {
    this.store.set(r.id, { ...r });
  }
  async update(r: CrawlRun): Promise<void> {
    this.store.set(r.id, { ...r });
  }
  async recentRuns(filter: { since?: Date; until?: Date; limit: number }): Promise<CrawlRun[]> {
    // Half-open window on started_at (since inclusive, until exclusive), newest
    // first with id as the deterministic tiebreaker — mirrors the Postgres adapter.
    const sinceMs = filter.since?.getTime();
    const untilMs = filter.until?.getTime();
    return [...this.store.values()]
      .filter((r) => {
        const t = Date.parse(r.started_at);
        if (sinceMs !== undefined && t < sinceMs) return false;
        if (untilMs !== undefined && t >= untilMs) return false;
        return true;
      })
      .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id))
      .slice(0, filter.limit)
      .map((r) => ({ ...r }));
  }
  async spentSince(since: Date): Promise<number> {
    // Sum exact micro-euros (order-independent) over runs at/after `since`, then
    // round once — same convention as costSummary so the two never disagree.
    const sinceMs = since.getTime();
    let micros = 0;
    for (const r of this.store.values()) {
      if (Date.parse(r.started_at) < sinceMs) continue;
      micros += toEurMicros(r.cost_eur);
    }
    return eurFromMicros(micros);
  }
  async costSummary(filter: { since?: Date; until?: Date }): Promise<CostSummary> {
    // Half-open window on started_at: since inclusive, until exclusive. Mirrors
    // the Postgres adapter exactly (see CrawlRunRepository.costSummary JSDoc).
    const sinceMs = filter.since?.getTime();
    const untilMs = filter.until?.getTime();

    let totalMicros = 0;
    let runCount = 0;
    // Accumulate EXACT integer micro-euros per bucket (order-independent), then
    // round once to cents at the end. Mirrors the Postgres adapter's numeric SUM
    // of round((cost_eur*1000000)::numeric) — see CostSummarySchema rounding note.
    const perDay = new Map<string, { micros: number; count: number }>();
    const perSource = new Map<string, { micros: number; count: number }>();

    for (const r of this.store.values()) {
      const t = Date.parse(r.started_at);
      if (sinceMs !== undefined && t < sinceMs) continue;
      if (untilMs !== undefined && t >= untilMs) continue;

      const micros = toEurMicros(r.cost_eur);
      totalMicros += micros;
      runCount += 1;

      const day = new Date(r.started_at).toISOString().slice(0, 10);
      const d = perDay.get(day) ?? { micros: 0, count: 0 };
      d.micros += micros;
      d.count += 1;
      perDay.set(day, d);

      // Null source_id (Lane-B runs) folds under the shared sentinel bucket so the
      // per-source breakdown matches the Postgres adapter exactly (LSP).
      const sourceKey = r.source_id ?? SOURCELESS_RUN_BUCKET;
      const s = perSource.get(sourceKey) ?? { micros: 0, count: 0 };
      s.micros += micros;
      s.count += 1;
      perSource.set(sourceKey, s);
    }

    const perDayArr = [...perDay.entries()]
      .map(([day, v]) => ({ day, cost_eur: eurFromMicros(v.micros), run_count: v.count }))
      .sort((a, b) => a.day.localeCompare(b.day)); // ascending by day

    const perSourceArr = [...perSource.entries()]
      .map(([source_id, v]) => ({
        source_id,
        cost_eur: eurFromMicros(v.micros),
        run_count: v.count,
      }))
      // Sort on the ROUNDED cost (desc) so ties break identically to Postgres, then
      // source_id ascending as the deterministic tiebreaker.
      .sort((a, b) => b.cost_eur - a.cost_eur || a.source_id.localeCompare(b.source_id));

    return {
      total_eur: eurFromMicros(totalMicros),
      run_count: runCount,
      per_day: perDayArr,
      per_source: perSourceArr,
    };
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
  async getById(id: string): Promise<ManualCaptureTask | null> {
    const t = this.tasks.find((x) => x.id === id);
    return t ? { ...t } : null;
  }
  async markDone(id: string, note: string | null): Promise<void> {
    const i = this.tasks.findIndex((x) => x.id === id);
    if (i !== -1) this.tasks[i] = { ...this.tasks[i]!, status: 'done', note };
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
  async getByKey(suggestedKey: string): Promise<FieldProposalRecord | null> {
    const p = this.store.get(suggestedKey);
    return p ? { ...p } : null;
  }
  async markPromoted(suggestedKey: string): Promise<void> {
    const p = this.store.get(suggestedKey);
    if (p) this.store.set(suggestedKey, { ...p, status: 'promoted' });
  }
}

class InMemoryConditionVocabularyRepo implements ConditionVocabularyRepository {
  private store = new Map<string, VocabularyEntry>();
  async getByKey(key: string): Promise<VocabularyEntry | null> {
    const e = this.store.get(key);
    return e ? { ...e } : null;
  }
  async upsert(entry: VocabularyEntry): Promise<void> {
    this.store.set(entry.key, { ...entry });
  }
  async list(): Promise<VocabularyEntry[]> {
    return [...this.store.values()].map((e) => ({ ...e }));
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
