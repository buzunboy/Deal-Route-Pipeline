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
  LOW_CONFIDENCE_MAX,
  zeroByRoute,
  isRouteType,
  ADMIN_PUBLISHED_STATUSES,
  type CandidateDealCounts,
  type AdminPublishedQuery,
  type ReviewAction,
  type TeamMember,
  type AlertRecord,
  type AlertStatus,
  type SettingOverride,
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
  type User,
  type Role,
  type Permission,
  type StoredRefresh,
  REVIEWABLE_STATUSES,
  UserSchema,
  RoleSchema,
  TeamMemberSchema,
  SYSTEM_ROLES,
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
  TeamRepository,
  AlertRepository,
  SettingsRepository,
  UserRepository,
  RoleRepository,
  RolePermissionRepository,
  RefreshTokenRepository,
  AuthMetaRepository,
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
  // The review repo reaches the deal + evidence repos so it can join a decision to its
  // deal's evidence capture time (ACR-6 throughput latency) — the same deal→evidence
  // join the Postgres adapter does in SQL; LSP-identical.
  reviews: ReviewRepository = new InMemoryReviewRepo(this.deals, this.evidence);
  sourceReviews: SourceReviewRepository = new InMemorySourceReviewRepo();
  catalog: SubscriptionCatalogRepository = new InMemoryCatalogRepo();
  alerts: AlertRepository = new InMemoryAlertRepo();
  settings: SettingsRepository = new InMemorySettingsRepo();
  // Auth/IAM (Phase 1): identity store + RBAC + refresh-token registry. The user repo
  // is built first so the role repo can count users.role_id (the same join the Postgres
  // adapter does in SQL) — keeping countUsers LSP-identical across adapters.
  users: InMemoryUserRepo = new InMemoryUserRepo();
  roles: InMemoryRoleRepo = new InMemoryRoleRepo(this.users);
  rolePermissions: InMemoryRolePermissionRepo = new InMemoryRolePermissionRepo();
  refreshTokens: RefreshTokenRepository = new InMemoryRefreshTokenRepo();
  authMeta: AuthMetaRepository = new InMemoryAuthMetaRepo();
  // The Team screen is a PROJECTION over the SAME users table (role_id → role name via
  // the roles repo). Built after users + roles so a user created via either path is
  // visible through both — the consolidation seam (team_members → users).
  team: TeamRepository = new InMemoryTeamRepo(this.users, this.roles);

  constructor() {
    // Seed the auth baseline the SQL migrations 0020–0023 install into Postgres, so the
    // in-memory adapter starts from the SAME state (LSP) without a migration runner: the
    // two system roles + their permission grants + perm_version=0 (the auth-meta repo
    // already defaults to 0). Keeps `team.upsert(role:'admin')` resolvable and the
    // contract/integration suites identical across adapters.
    for (const role of SYSTEM_ROLES) {
      this.roles.seed({
        id: role.id,
        name: role.name,
        description: role.description,
        is_system: true,
      });
      this.rolePermissions.seed(role.id, [...role.permissions]);
    }
  }
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
  async getByUrl(url: string): Promise<Source | null> {
    const s = this.store.get(url);
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
  async countCandidates(): Promise<CandidateDealCounts> {
    // One pass over the reviewable deals (candidate + in_review), mirroring the
    // Postgres adapter's filtered aggregates exactly (LSP). low_confidence is
    // INCLUSIVE on LOW_CONFIDENCE_MAX; human_edited counts a non-empty array.
    const reviewable = new Set<DealStatus>(REVIEWABLE_STATUSES);
    const by_route = zeroByRoute();
    let all_pending = 0;
    let low_confidence = 0;
    let human_edited = 0;
    for (const d of this.store.values()) {
      if (!reviewable.has(d.status)) continue;
      all_pending++;
      if (d.confidence <= LOW_CONFIDENCE_MAX) low_confidence++;
      if (d.human_edited.length > 0) human_edited++;
      if (isRouteType(d.route_type)) by_route[d.route_type]++;
    }
    return { all_pending, low_confidence, human_edited, by_route };
  }
  async listAdminPublished(query: AdminPublishedQuery): Promise<DealRecord[]> {
    // published + expired (publication history), newest-published-first (published_at
    // desc NULLS LAST) then id asc — mirrors the Postgres adapter exactly (LSP).
    const set = new Set<DealStatus>(ADMIN_PUBLISHED_STATUSES);
    return [...this.store.values()]
      .filter((d) => set.has(d.status))
      .sort((a, b) => comparePublishedAtDesc(a, b) || a.id.localeCompare(b.id))
      .slice(query.offset, query.offset + query.limit)
      .map((d) => ({ ...d }));
  }
  async countAdminPublished(): Promise<number> {
    const set = new Set<DealStatus>(ADMIN_PUBLISHED_STATUSES);
    let n = 0;
    for (const d of this.store.values()) if (set.has(d.status)) n++;
    return n;
  }
  async pendingQueueSignals(): Promise<{ capturedAt: string | null; confidence: number }[]> {
    // The reviewable queue joined to evidence captured_at — mirrors the Postgres
    // adapter's LEFT JOIN exactly (LSP): a deal whose evidence row is missing yields
    // capturedAt null (can't be aged) but is still listed with its confidence.
    const reviewable = new Set<DealStatus>(REVIEWABLE_STATUSES);
    const out: { capturedAt: string | null; confidence: number }[] = [];
    for (const d of this.store.values()) {
      if (!reviewable.has(d.status)) continue;
      const ev = await this.evidence.getById(d.evidence_id);
      out.push({ capturedAt: ev?.captured_at ?? null, confidence: d.confidence });
    }
    return out;
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
/**
 * Compare two deals by `published_at` DESCENDING with NULLS LAST — the admin
 * published screen's primary order. Returns <0 if `a` sorts first. Mirrors the
 * Postgres `published_at desc nulls last`. A 0 means equal (or both null) → the
 * caller falls through to the id tiebreaker.
 */
function comparePublishedAtDesc(a: DealRecord, b: DealRecord): number {
  const av = a.published_at;
  const bv = b.published_at;
  if (av === bv) return 0;
  if (av === null) return 1; // a is null → sorts after b (nulls last)
  if (bv === null) return -1; // b is null → a sorts first
  return bv.localeCompare(av); // newer (greater ISO) first
}

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
  constructor(
    private readonly deals: DealRepository,
    private readonly evidence: EvidenceRepository,
  ) {}
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
  async countByActionSince(action: ReviewAction, since: Date): Promise<number> {
    // decided_at >= since (inclusive), matching the Postgres adapter's gte.
    const sinceMs = since.getTime();
    let n = 0;
    for (const e of this.reviews) {
      if (e.review.action === action && Date.parse(e.review.decided_at) >= sinceMs) n++;
    }
    return n;
  }
  async listRecent(filter: {
    approver?: string;
    dealId?: string;
    since?: Date;
    limit: number;
  }): Promise<ReviewRecord[]> {
    // Optional actor/entity/since filters, newest first (decided_at desc, seq desc as
    // the equal-timestamp tiebreaker) — mirrors the Postgres adapter (id desc there;
    // seq is the in-memory stand-in for monotonic insertion order).
    const sinceMs = filter.since?.getTime();
    return this.reviews
      .filter((e) => {
        if (filter.approver !== undefined && e.review.approver !== filter.approver) return false;
        if (filter.dealId !== undefined && e.review.deal_id !== filter.dealId) return false;
        if (sinceMs !== undefined && Date.parse(e.review.decided_at) < sinceMs) return false;
        return true;
      })
      .sort((a, b) => b.review.decided_at.localeCompare(a.review.decided_at) || b.seq - a.seq)
      .slice(0, filter.limit)
      .map((e) => ({ ...e.review }));
  }
  async countByApprover(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const e of this.reviews) {
      counts.set(e.review.approver, (counts.get(e.review.approver) ?? 0) + 1);
    }
    return counts;
  }
  async listDecisionLatenciesSince(
    since: Date,
  ): Promise<{ action: ReviewAction; latencySeconds: number | null }[]> {
    // decided_at >= since (inclusive), each joined to the deal's evidence captured_at
    // to compute the capture→decision latency — mirrors the Postgres adapter's LEFT
    // JOIN (LSP). A missing deal/evidence yields a null latency (still counted).
    const sinceMs = since.getTime();
    const out: { action: ReviewAction; latencySeconds: number | null }[] = [];
    for (const e of this.reviews) {
      const decidedMs = Date.parse(e.review.decided_at);
      if (decidedMs < sinceMs) continue;
      const deal = await this.deals.getById(e.review.deal_id);
      const ev = deal ? await this.evidence.getById(deal.evidence_id) : null;
      const latencySeconds =
        ev === null ? null : Math.floor((decidedMs - Date.parse(ev.captured_at)) / 1000);
      out.push({ action: e.review.action, latencySeconds });
    }
    return out;
  }
}

/**
 * The Team screen, projected over the SAME `users` + `roles` stores the Auth/IAM repos
 * use (the `team_members → users` consolidation). `TeamMember.role` (a name) maps to/from
 * `users.role_id` via the roles repo; `TeamMember.status` is `User['status']` (widened to
 * include `disabled`). A user created via `db.users.insert` shows up here and vice-versa —
 * there is no parallel store to drift. Mirrors the Postgres `PgTeamRepo` join (LSP).
 */
class InMemoryTeamRepo implements TeamRepository {
  constructor(
    private readonly users: InMemoryUserRepo,
    private readonly roles: InMemoryRoleRepo,
  ) {}
  async upsert(m: TeamMember): Promise<void> {
    // Resolve the role name → role_id (the role must exist — admin/reviewer are seeded).
    const role = await this.roles.getByName(m.role);
    if (role === null) throw new Error(`team.upsert: unknown role "${m.role}"`);
    const existing = this.users.entityByEmail(m.email);
    this.users.upsertProjection({
      id: existing?.id ?? m.id,
      name: m.name,
      email: m.email,
      roleId: role.id,
      status: m.status,
      createdAt: existing?.created_at ?? m.created_at,
    });
  }
  async getById(id: string): Promise<TeamMember | null> {
    const u = this.users.entityById(id);
    return u ? this.project(u) : null;
  }
  async getByEmail(email: string): Promise<TeamMember | null> {
    const u = this.users.entityByEmail(email);
    return u ? this.project(u) : null;
  }
  async list(): Promise<TeamMember[]> {
    const members = await Promise.all(this.users.listEntities().map((u) => this.project(u)));
    return members.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  /** Project a User → TeamMember, mapping role_id → role name. */
  private async project(u: User): Promise<TeamMember> {
    const role = await this.roles.getById(u.role_id);
    return TeamMemberSchema.parse({
      id: u.id,
      name: u.name,
      email: u.email,
      role: role?.name ?? 'reviewer',
      status: u.status,
      created_at: u.created_at,
    });
  }
}

class InMemoryAlertRepo implements AlertRepository {
  private alerts: AlertRecord[] = [];
  async upsertOpen(record: AlertRecord): Promise<void> {
    // One OPEN row per dedupe_key: refresh an existing open row, else insert.
    // Mirrors the Postgres partial-unique upsert (status='open').
    const i = this.alerts.findIndex(
      (a) => a.dedupe_key === record.dedupe_key && a.status === 'open',
    );
    if (i !== -1) {
      this.alerts[i] = {
        ...this.alerts[i]!,
        summary: record.summary,
        context: { ...record.context },
        severity: record.severity,
        title: record.title,
        updated_at: record.updated_at,
      };
    } else {
      this.alerts.push({ ...record, context: { ...record.context } });
    }
  }
  async list(limit: number): Promise<AlertRecord[]> {
    return [...this.alerts]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map((a) => ({ ...a, context: { ...a.context } }));
  }
  async getById(id: string): Promise<AlertRecord | null> {
    const a = this.alerts.find((x) => x.id === id);
    return a ? { ...a, context: { ...a.context } } : null;
  }
  async setStatus(id: string, status: AlertStatus, at: string): Promise<void> {
    const i = this.alerts.findIndex((x) => x.id === id);
    if (i !== -1) this.alerts[i] = { ...this.alerts[i]!, status, updated_at: at };
  }
}

class InMemorySettingsRepo implements SettingsRepository {
  private store = new Map<string, SettingOverride>();
  async get(key: string): Promise<SettingOverride | null> {
    const o = this.store.get(key);
    return o ? { ...o } : null;
  }
  async list(): Promise<SettingOverride[]> {
    return [...this.store.values()].map((o) => ({ ...o }));
  }
  async upsert(o: SettingOverride): Promise<void> {
    this.store.set(o.key, { ...o });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** Internal user row: the domain entity + the adapter-only auth columns (hash, counters). */
interface UserRow {
  user: User;
  passwordHash: string | null;
  failedLoginCount: number;
  lockedUntil: string | null;
}

class InMemoryUserRepo implements UserRepository {
  // Keyed by email (the natural identity), matching the Postgres unique(email).
  private store = new Map<string, UserRow>();

  async insert(user: User, passwordHash: string | null): Promise<void> {
    // Parse on write so schema defaults are applied exactly as the Postgres adapter
    // applies them on read (LSP) — the fake must not be more permissive than prod.
    const parsed = UserSchema.parse(user);
    this.store.set(parsed.email, {
      user: parsed,
      passwordHash,
      failedLoginCount: 0,
      lockedUntil: null,
    });
  }
  async getById(id: string): Promise<User | null> {
    for (const row of this.store.values()) if (row.user.id === id) return { ...row.user };
    return null;
  }
  async getByEmail(email: string): Promise<User | null> {
    const row = this.store.get(email);
    return row ? { ...row.user } : null;
  }
  async getPasswordHashByEmail(email: string): Promise<string | null> {
    return this.store.get(email)?.passwordHash ?? null;
  }
  async list(): Promise<User[]> {
    return [...this.store.values()]
      .map((r) => r.user)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((u) => ({ ...u }));
  }
  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const row = this.rowById(id);
    if (row) row.passwordHash = passwordHash;
  }
  async setStatus(id: string, status: User['status']): Promise<void> {
    const row = this.rowById(id);
    if (row) row.user = { ...row.user, status };
  }
  async bumpTokenVersion(id: string): Promise<number> {
    const row = this.rowById(id);
    if (!row) return 0;
    const next = row.user.token_version + 1;
    row.user = { ...row.user, token_version: next };
    return next;
  }
  async setRole(id: string, roleId: string): Promise<void> {
    const row = this.rowById(id);
    if (row) row.user = { ...row.user, role_id: roleId };
  }
  async recordLogin(id: string, at: string): Promise<void> {
    const row = this.rowById(id);
    if (row) {
      row.failedLoginCount = 0;
      row.lockedUntil = null;
      row.user = { ...row.user };
      this.lastLogin.set(id, at);
    }
  }
  async recordFailedLogin(id: string, _at: string): Promise<number> {
    const row = this.rowById(id);
    if (!row) return 0;
    row.failedLoginCount += 1;
    return row.failedLoginCount;
  }
  async setLockedUntil(id: string, until: string | null): Promise<void> {
    const row = this.rowById(id);
    if (row) row.lockedUntil = until;
  }
  async getLoginState(
    id: string,
  ): Promise<{ failedLoginCount: number; lockedUntil: string | null } | null> {
    const row = this.rowById(id);
    return row ? { failedLoginCount: row.failedLoginCount, lockedUntil: row.lockedUntil } : null;
  }
  /** Count users assigned a role — backs RoleRepository.countUsers (the role-FK join). */
  countByRole(roleId: string): number {
    let n = 0;
    for (const row of this.store.values()) if (row.user.role_id === roleId) n++;
    return n;
  }
  // ── Team-projection helpers (the `users` table also backs the Team screen) ──
  // The team repo is a PROJECTION over the SAME store, so a user created via
  // users.insert appears in team.list and vice-versa (no parallel store to drift).
  /** All users as raw entities, for the team projection (mapped role_id→name by caller). */
  listEntities(): User[] {
    return [...this.store.values()].map((r) => ({ ...r.user }));
  }
  /** Raw user entity by email (or null) — for the team projection. */
  entityByEmail(email: string): User | null {
    const r = this.store.get(email);
    return r ? { ...r.user } : null;
  }
  /** Raw user entity by id (or null) — for the team projection. */
  entityById(id: string): User | null {
    return this.rowById(id)?.user ? { ...this.rowById(id)!.user } : null;
  }
  /**
   * Upsert a user from the Team-screen projection (keyed on email). A new row gets the
   * given role_id + auth defaults (no password yet → `invited`); an existing row keeps
   * its id + auth columns and only refreshes name/role/status. Mirrors the Postgres
   * team.upsert ON CONFLICT (email).
   */
  upsertProjection(input: {
    id: string;
    name: string;
    email: string;
    roleId: string;
    status: User['status'];
    createdAt: string;
  }): void {
    const existing = this.store.get(input.email);
    if (existing) {
      existing.user = {
        ...existing.user,
        name: input.name,
        role_id: input.roleId,
        status: input.status,
      };
      return;
    }
    this.store.set(input.email, {
      user: UserSchema.parse({
        id: input.id,
        name: input.name,
        email: input.email,
        role_id: input.roleId,
        status: input.status,
        auth_provider: 'password',
        google_sub: null,
        token_version: 0,
        created_at: input.createdAt,
      }),
      passwordHash: null,
      failedLoginCount: 0,
      lockedUntil: null,
    });
  }
  // last_login_at is an adapter-only column (not on the User entity); tracked for parity.
  private readonly lastLogin = new Map<string, string>();
  private rowById(id: string): UserRow | undefined {
    for (const row of this.store.values()) if (row.user.id === id) return row;
    return undefined;
  }
}

class InMemoryRoleRepo implements RoleRepository {
  // Keyed by id; the name index is derived on demand (the role set is tiny).
  private store = new Map<string, Role>();
  // Reaches the user repo so countUsers reflects users.role_id — the same join the
  // Postgres adapter does in SQL (LSP). Mirrors how the deal repo reaches sources.
  constructor(private readonly users: InMemoryUserRepo) {}
  /** Synchronous baseline seed (the migration equivalent) — used by the InMemoryDb ctor. */
  seed(role: Role): void {
    this.store.set(role.id, RoleSchema.parse(role));
  }
  async insert(role: Role): Promise<void> {
    this.store.set(role.id, RoleSchema.parse(role));
  }
  async getById(id: string): Promise<Role | null> {
    const r = this.store.get(id);
    return r ? { ...r } : null;
  }
  async getByName(name: string): Promise<Role | null> {
    for (const r of this.store.values()) if (r.name === name) return { ...r };
    return null;
  }
  async list(): Promise<Role[]> {
    return [...this.store.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((r) => ({ ...r }));
  }
  async update(role: Role): Promise<void> {
    const existing = this.store.get(role.id);
    if (existing === undefined) return; // no-op for an unknown id (mirrors a 0-row UPDATE)
    // Defense-in-depth (matches the Postgres CASE): a system role keeps its existing name —
    // it can never be RENAMED at the boundary; only its description (and is_system) ride.
    const name = existing.is_system ? existing.name : role.name;
    this.store.set(role.id, RoleSchema.parse({ ...role, name }));
  }
  async countUsers(roleId: string): Promise<number> {
    return this.users.countByRole(roleId);
  }
  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}

class InMemoryRolePermissionRepo implements RolePermissionRepository {
  // role_id → set of permission keys (a replace-set, mirroring the composite-PK table).
  private store = new Map<string, Set<Permission>>();
  /** Synchronous baseline seed (the migration equivalent) — used by the InMemoryDb ctor. */
  seed(roleId: string, permissions: Permission[]): void {
    this.store.set(roleId, new Set(permissions));
  }
  async permissionsForRole(roleId: string): Promise<Permission[]> {
    return [...(this.store.get(roleId) ?? new Set<Permission>())];
  }
  async list(): Promise<{ roleId: string; permissionKey: Permission }[]> {
    const out: { roleId: string; permissionKey: Permission }[] = [];
    for (const [roleId, keys] of this.store) {
      for (const permissionKey of keys) out.push({ roleId, permissionKey });
    }
    return out;
  }
  async setForRole(roleId: string, permissions: Permission[]): Promise<void> {
    this.store.set(roleId, new Set(permissions));
  }
}

class InMemoryRefreshTokenRepo implements RefreshTokenRepository {
  private store = new Map<string, StoredRefresh>(); // by id
  async issue(token: StoredRefresh): Promise<void> {
    this.store.set(token.id, { ...token });
  }
  async findByHash(tokenHash: string): Promise<StoredRefresh | null> {
    for (const t of this.store.values()) if (t.token_hash === tokenHash) return { ...t };
    return null;
  }
  async rotate(oldId: string, replacement: StoredRefresh): Promise<void> {
    const old = this.store.get(oldId);
    if (old) {
      this.store.set(oldId, {
        ...old,
        revoked_at: replacement.issued_at,
        replaced_by: replacement.id,
      });
    }
    this.store.set(replacement.id, { ...replacement });
  }
  async revokeFamily(familyId: string, at: string): Promise<number> {
    let n = 0;
    for (const [id, t] of this.store) {
      if (t.family_id === familyId && t.revoked_at === null) {
        this.store.set(id, { ...t, revoked_at: at });
        n++;
      }
    }
    return n;
  }
  async revokeAllForUser(userId: string, at: string): Promise<number> {
    let n = 0;
    for (const [id, t] of this.store) {
      if (t.user_id === userId && t.revoked_at === null) {
        this.store.set(id, { ...t, revoked_at: at });
        n++;
      }
    }
    return n;
  }
  async deleteExpired(now: Date): Promise<number> {
    let n = 0;
    for (const [id, t] of this.store) {
      if (Date.parse(t.expires_at) <= now.getTime()) {
        this.store.delete(id);
        n++;
      }
    }
    return n;
  }
}

class InMemoryAuthMetaRepo implements AuthMetaRepository {
  private permVersion = 0;
  async getPermVersion(): Promise<number> {
    return this.permVersion;
  }
  async bumpPermVersion(): Promise<number> {
    this.permVersion += 1;
    return this.permVersion;
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
