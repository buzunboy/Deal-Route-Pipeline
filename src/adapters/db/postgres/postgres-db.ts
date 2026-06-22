import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, ne, lte, lt, gte, or, isNull, desc, asc, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import pg from 'pg';
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
} from '../../../application/ports/index.js';
import {
  ChangeSchema,
  CrawlRunSchema,
  ReviewAction,
  ReviewRecordSchema,
  SourceReviewRecordSchema,
  TeamMemberSchema,
  AlertRecordSchema,
  SubscriptionCatalogEntrySchema,
  CostSummarySchema,
  eurFromMicros,
  SOURCELESS_RUN_BUCKET,
  buildReliabilityIndex,
  rankPublished,
  PUBLISHED_FETCH_CAP,
  REVIEWABLE_STATUSES,
  LOW_CONFIDENCE_MAX,
  zeroByRoute,
  isRouteType,
  ADMIN_PUBLISHED_STATUSES,
} from '../../../domain/index.js';
import type {
  Source,
  DealRecord,
  CrawlRun,
  CostSummary,
  Evidence,
  ManualCaptureTask,
  FieldProposalRecord,
  Change,
  DealStatus,
  ReviewRecord,
  SourceReviewRecord,
  TeamMember,
  AlertRecord,
  AlertStatus,
  SubscriptionCatalogEntry,
  PublishedQuery,
  PublishedFilters,
  CandidateQuery,
  CandidateDealCounts,
  AdminPublishedQuery,
  VocabularyEntry,
} from '../../../domain/index.js';
import type { Logger } from '../../../application/ports/index.js';
import * as schema from './schema.js';
import { dealToRow, rowToDeal, isoTimestamp, isoTimestampOrNull } from './mappers.js';
import { newId } from '../../../application/shared/id.js';
import { DbRetrier, type DbRetryConfig } from './db-resilience.js';

type Db = NodePgDatabase<typeof schema>;

/** Pool + retry tuning for the Postgres adapter. All values come from typed config. */
export interface PostgresDbOptions {
  pool: {
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    statementTimeoutMillis: number;
  };
  retry: DbRetryConfig;
  logger: Logger;
}

/**
 * Defaults for `connect(url)` with no options — used by the contract test harness.
 * The fallback logger writes to the console rather than swallowing: a pool-error or
 * retry warning on a trust-critical adapter must never vanish silently (code-style:
 * "no silent catches"). Production always injects the real Logger from the container.
 */
const DEFAULT_OPTIONS: PostgresDbOptions = {
  pool: {
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statementTimeoutMillis: 30_000,
  },
  retry: { retries: 3, baseDelayMs: 100 },
  logger: {
    debug: (msg, ctx) => console.debug(msg, ctx ?? ''),
    info: (msg, ctx) => console.info(msg, ctx ?? ''),
    warn: (msg, ctx) => console.warn(msg, ctx ?? ''),
    error: (msg, ctx) => console.error(msg, ctx ?? ''),
  },
};

/**
 * Postgres Database adapter (drizzle). Implements the same `Database` port as the
 * in-memory adapter and is verified by the same contract suite (LSP). All access
 * goes through typed repositories; reads of deal rows are re-validated via the
 * mappers. Build it with `PostgresDb.connect(url)`.
 */
export class PostgresDb implements Database {
  readonly sources: SourceRepository;
  readonly deals: DealRepository;
  readonly crawlRuns: CrawlRunRepository;
  readonly evidence: EvidenceRepository;
  readonly manualCapture: ManualCaptureRepository;
  readonly fieldProposals: FieldProposalRepository;
  readonly conditionVocabulary: ConditionVocabularyRepository;
  readonly changes: ChangeRepository;
  readonly reviews: ReviewRepository;
  readonly sourceReviews: SourceReviewRepository;
  readonly catalog: SubscriptionCatalogRepository;
  readonly team: TeamRepository;
  readonly alerts: AlertRepository;

  private constructor(
    private readonly pool: pg.Pool,
    db: Db,
    retrier: DbRetrier,
  ) {
    this.sources = new PgSourceRepo(db, retrier);
    // The deal repo reaches the source repo so listPublished can blend a source's
    // reliability into the public-feed sort (Step 3, deal→source registrable-domain
    // join). Same read the in-memory adapter does; ordering stays LSP-identical.
    this.deals = new PgDealRepo(db, retrier, this.sources);
    this.crawlRuns = new PgCrawlRunRepo(db, retrier);
    this.evidence = new PgEvidenceRepo(db, retrier);
    this.manualCapture = new PgManualCaptureRepo(db, retrier);
    this.fieldProposals = new PgFieldProposalRepo(db, retrier);
    this.conditionVocabulary = new PgConditionVocabularyRepo(db, retrier);
    this.changes = new PgChangeRepo(db, retrier);
    this.reviews = new PgReviewRepo(db, retrier);
    this.sourceReviews = new PgSourceReviewRepo(db, retrier);
    this.catalog = new PgCatalogRepo(db, retrier);
    this.team = new PgTeamRepo(db, retrier);
    this.alerts = new PgAlertRepo(db, retrier);
  }

  static connect(
    connectionString: string,
    options: PostgresDbOptions = DEFAULT_OPTIONS,
  ): PostgresDb {
    const pool = new pg.Pool({
      connectionString,
      max: options.pool.max,
      idleTimeoutMillis: options.pool.idleTimeoutMillis,
      connectionTimeoutMillis: options.pool.connectionTimeoutMillis,
      // Caps any single statement server-side so a wedged query frees its
      // connection instead of pinning it for the life of the pool.
      statement_timeout: options.pool.statementTimeoutMillis,
    });

    // An idle-client error (e.g. the DB killed the connection) is emitted on the
    // pool, not on any awaited call. Without a handler Node treats it as an
    // unhandled 'error' event and crashes the process — log and let the pool
    // evict/replace the client instead (resilience: a transient never crashes us).
    pool.on('error', (err) => {
      options.logger.error('db: idle pool client error (connection evicted)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const retrier = new DbRetrier(options.retry, options.logger);
    return new PostgresDb(pool, drizzle(pool, { schema }), retrier);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Base for every Pg repo: holds the drizzle handle + the shared retrier. Repo
 * methods route their DB calls through `run(op, fn, idempotent?)` so transient
 * errors retry with backoff and non-idempotent inserts stay safe under retry.
 */
abstract class PgRepo {
  constructor(
    protected readonly db: Db,
    private readonly retrier: DbRetrier,
  ) {}
  protected run<T>(op: string, fn: () => Promise<T>, idempotent = true): Promise<T> {
    return this.retrier.run(op, fn, idempotent);
  }
}

class PgSourceRepo extends PgRepo implements SourceRepository {
  async upsert(s: Source): Promise<void> {
    // Conflict on `url`, NOT `id`: a source IS its URL (the natural key). seed-import
    // mints a fresh random id per run, so keying on id never collides and re-seeding
    // would INSERT duplicates (49→98). On a url conflict we update everything EXCEPT
    // the id, so an existing row keeps its identity (and anything that references it)
    // while its mutable fields refresh.
    const row = toSourceRow(s);
    const { id: _id, ...mutable } = row;
    await this.run('sources.upsert', () =>
      this.db.insert(schema.sources).values(row).onConflictDoUpdate({
        target: schema.sources.url,
        set: mutable,
      }),
    );
  }
  async getById(id: string): Promise<Source | null> {
    const rows = await this.run('sources.getById', () =>
      this.db.select().from(schema.sources).where(eq(schema.sources.id, id)).limit(1),
    );
    return rows[0] ? fromSourceRow(rows[0]) : null;
  }
  async getByUrl(url: string): Promise<Source | null> {
    const rows = await this.run('sources.getByUrl', () =>
      this.db.select().from(schema.sources).where(eq(schema.sources.url, url)).limit(1),
    );
    return rows[0] ? fromSourceRow(rows[0]) : null;
  }
  async listDue(now: Date, limit: number): Promise<Source[]> {
    const rows = await this.run('sources.listDue', () =>
      this.db
        .select()
        .from(schema.sources)
        .where(
          and(
            eq(schema.sources.status, 'active'),
            or(isNull(schema.sources.nextDue), lte(schema.sources.nextDue, now.toISOString())),
          ),
        )
        .limit(limit),
    );
    return rows.map(fromSourceRow);
  }
  async listByStatus(status: Source['status']): Promise<Source[]> {
    const rows = await this.run('sources.listByStatus', () =>
      this.db.select().from(schema.sources).where(eq(schema.sources.status, status)),
    );
    return rows.map(fromSourceRow);
  }
  async update(s: Source): Promise<void> {
    await this.run('sources.update', () =>
      this.db.update(schema.sources).set(toSourceRow(s)).where(eq(schema.sources.id, s.id)),
    );
  }
}

class PgDealRepo extends PgRepo implements DealRepository {
  constructor(
    db: Db,
    retrier: DbRetrier,
    private readonly sources: SourceRepository,
  ) {
    super(db, retrier);
  }
  async insert(d: DealRecord): Promise<void> {
    // Idempotent under the (dedupe_key, evidence_id) unique index: a concurrent
    // duplicate insert for the same offer+capture is a no-op rather than a dupe row.
    await this.run('deals.insert', () =>
      this.db.insert(schema.deals).values(dealToRow(d)).onConflictDoNothing(),
    );
  }
  async getById(id: string): Promise<DealRecord | null> {
    const rows = await this.run('deals.getById', () =>
      this.db.select().from(schema.deals).where(eq(schema.deals.id, id)).limit(1),
    );
    return rows[0] ? rowToDeal(rows[0]) : null;
  }
  async listByStatus(status: DealStatus, limit: number): Promise<DealRecord[]> {
    const rows = await this.run('deals.listByStatus', () =>
      this.db.select().from(schema.deals).where(eq(schema.deals.status, status)).limit(limit),
    );
    return rows.map(rowToDeal);
  }
  async listBySourceUrl(
    sourceUrl: string,
    statuses: DealStatus[],
    limit: number,
  ): Promise<DealRecord[]> {
    if (statuses.length === 0) return [];
    const rows = await this.run('deals.listBySourceUrl', () =>
      this.db
        .select()
        .from(schema.deals)
        .where(and(eq(schema.deals.sourceUrl, sourceUrl), inArray(schema.deals.status, statuses)))
        .orderBy(desc(schema.deals.id))
        .limit(limit),
    );
    return rows.map(rowToDeal);
  }
  async findActiveByDedupeKeyAndHash(key: string, contentHash: string): Promise<DealRecord | null> {
    // Join to the linked evidence and match its content hash — done in SQL so it
    // scales regardless of how many candidates share the dedupe key.
    const rows = await this.run('deals.findActiveByDedupeKeyAndHash', () =>
      this.db
        .select({ deal: schema.deals })
        .from(schema.deals)
        .innerJoin(schema.evidence, eq(schema.deals.evidenceId, schema.evidence.id))
        .where(
          and(
            eq(schema.deals.dedupeKey, key),
            inArray(schema.deals.status, ['candidate', 'in_review']),
            eq(schema.evidence.contentHash, contentHash),
          ),
        )
        .limit(1),
    );
    return rows[0] ? rowToDeal(rows[0].deal) : null;
  }
  async findByDedupeKey(key: string): Promise<DealRecord | null> {
    // Push the active-row predicate into SQL so a key with many rejected rows
    // can't page the active one out of a JS-side filter.
    const rows = await this.run('deals.findByDedupeKey', () =>
      this.db
        .select()
        .from(schema.deals)
        .where(and(eq(schema.deals.dedupeKey, key), ne(schema.deals.status, 'rejected')))
        .orderBy(desc(schema.deals.confidence))
        .limit(1),
    );
    return rows[0] ? rowToDeal(rows[0]) : null;
  }
  async updateStatus(
    id: string,
    status: DealStatus,
    verifiedBy: string | null,
    verifiedAt: string | null,
  ): Promise<void> {
    await this.run('deals.updateStatus', () =>
      this.db
        .update(schema.deals)
        .set({ status, verifiedBy, verifiedAt })
        .where(eq(schema.deals.id, id)),
    );
  }
  async expirePublishedBySourceUrl(sourceUrl: string, expiredAt: string): Promise<number> {
    const rows = await this.run('deals.expirePublishedBySourceUrl', () =>
      this.db
        .update(schema.deals)
        .set({ status: 'expired', verifiedAt: expiredAt })
        .where(and(eq(schema.deals.sourceUrl, sourceUrl), eq(schema.deals.status, 'published')))
        .returning({ id: schema.deals.id }),
    );
    return rows.length;
  }
  async update(d: DealRecord): Promise<void> {
    await this.run('deals.update', () =>
      this.db.update(schema.deals).set(dealToRow(d)).where(eq(schema.deals.id, d.id)),
    );
  }
  async listPublished(query: PublishedQuery): Promise<DealRecord[]> {
    const { sort } = query;
    // status='published' is the FIRST predicate (the trust boundary), then the
    // optional filters AND in — same conditional-predicate idiom as listBySourceUrl.
    const where = and(
      eq(schema.deals.status, 'published'),
      ...publishedFilterPredicates(query.filters),
    );
    // SQL does status + filters + a DETERMINISTIC primary-key-ordered bounded fetch
    // ONLY. The final order (reliability tiebreak) + LIMIT/OFFSET happen in the
    // shared pure ranker, so both adapters order byte-identically without
    // reimplementing the deal→source registrableDomain join in SQL.
    //
    // The fetch is capped at PUBLISHED_FETCH_CAP rows taken in PRIMARY-key order
    // (the deepest reachable page is [offset=PUBLISHED_MAX_OFFSET, +MAX_LIMIT) — the
    // HTTP boundary 400s anything past the offset cap). The cap MUST be applied in a
    // deterministic order (hence the ORDER BY before the LIMIT) so a >cap published
    // corpus yields the same capped candidate set as the in-memory adapter; the
    // reliability tiebreak only permutes rows within equal-primary groups, so it can
    // never move a row across the cap boundary. select() returns deal columns only —
    // reliability is never selected, so it can't reach rowToDeal / the public DTO.
    const orderBy =
      sort === 'verified_desc'
        ? [sql`${schema.deals.verifiedAt} desc nulls last`, asc(schema.deals.id)]
        : [asc(schema.deals.trueCostMonthly), asc(schema.deals.id)];
    const rows = await this.run('deals.listPublished', () =>
      this.db
        .select()
        .from(schema.deals)
        .where(where)
        .orderBy(...orderBy)
        .limit(PUBLISHED_FETCH_CAP),
    );
    const deals = rows.map(rowToDeal);
    const byDomain = buildReliabilityIndex(await this.sources.listByStatus('active'));
    return rankPublished(deals, byDomain, query);
  }
  async countPublished(filters: PublishedFilters): Promise<number> {
    const where = and(eq(schema.deals.status, 'published'), ...publishedFilterPredicates(filters));
    const rows = await this.run('deals.countPublished', () =>
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.deals)
        .where(where),
    );
    return rows[0]?.n ?? 0;
  }
  async listCandidates(query: CandidateQuery): Promise<DealRecord[]> {
    // status set (single filter status, or the default reviewable pair) + optional
    // service/confidenceMax, ordered confidence ASC then id ASC, then the page.
    // Mirrors the in-memory adapter step-for-step (LSP). confidenceMax is inclusive.
    const statuses = query.filters.status ? [query.filters.status] : [...REVIEWABLE_STATUSES];
    const predicates: SQL[] = [inArray(schema.deals.status, statuses)];
    if (query.filters.service !== undefined)
      predicates.push(eq(schema.deals.service, query.filters.service));
    if (query.filters.confidenceMax !== undefined)
      predicates.push(lte(schema.deals.confidence, query.filters.confidenceMax));
    const rows = await this.run('deals.listCandidates', () =>
      this.db
        .select()
        .from(schema.deals)
        .where(and(...predicates))
        .orderBy(asc(schema.deals.confidence), asc(schema.deals.id))
        .limit(query.limit)
        .offset(query.offset),
    );
    return rows.map(rowToDeal);
  }
  async countCandidates(): Promise<CandidateDealCounts> {
    // One grouped pass over the reviewable statuses: per route_type, the total +
    // the low-confidence + human-edited subsets. The JS reduce below folds the
    // grouped rows into the totals + the by-route map, mirroring the in-memory
    // adapter's single-pass tally exactly (LSP). low_confidence is INCLUSIVE on
    // LOW_CONFIDENCE_MAX; human_edited counts a non-empty jsonb array.
    const rows = await this.run('deals.countCandidates', () =>
      this.db
        .select({
          routeType: schema.deals.routeType,
          total: sql<number>`count(*)::int`,
          low: sql<number>`count(*) filter (where ${schema.deals.confidence} <= ${LOW_CONFIDENCE_MAX})::int`,
          edited: sql<number>`count(*) filter (where jsonb_array_length(${schema.deals.humanEdited}) > 0)::int`,
        })
        .from(schema.deals)
        .where(inArray(schema.deals.status, [...REVIEWABLE_STATUSES]))
        .groupBy(schema.deals.routeType),
    );
    const by_route = zeroByRoute();
    let all_pending = 0;
    let low_confidence = 0;
    let human_edited = 0;
    for (const r of rows) {
      const total = Number(r.total);
      all_pending += total;
      low_confidence += Number(r.low);
      human_edited += Number(r.edited);
      // A stored route_type outside the known enum can't reach a typed bucket; it
      // still counts toward all_pending (matching the in-memory adapter, where an
      // unknown route increments all_pending but no by_route key).
      if (isRouteType(r.routeType)) by_route[r.routeType] += total;
    }
    return { all_pending, low_confidence, human_edited, by_route };
  }
  async listAdminPublished(query: AdminPublishedQuery): Promise<DealRecord[]> {
    // published + expired (publication history), newest-published-first then id —
    // mirrors the in-memory adapter step-for-step (LSP).
    const rows = await this.run('deals.listAdminPublished', () =>
      this.db
        .select()
        .from(schema.deals)
        .where(inArray(schema.deals.status, [...ADMIN_PUBLISHED_STATUSES]))
        .orderBy(sql`${schema.deals.publishedAt} desc nulls last`, asc(schema.deals.id))
        .limit(query.limit)
        .offset(query.offset),
    );
    return rows.map(rowToDeal);
  }
  async countAdminPublished(): Promise<number> {
    const rows = await this.run('deals.countAdminPublished', () =>
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.deals)
        .where(inArray(schema.deals.status, [...ADMIN_PUBLISHED_STATUSES])),
    );
    return rows[0]?.n ?? 0;
  }
  async pendingQueueSignals(): Promise<{ capturedAt: string | null; confidence: number }[]> {
    // The reviewable queue LEFT JOINed to its evidence captured_at — mirrors the
    // in-memory adapter (LSP): a deal with no evidence row yields capturedAt null but
    // is still listed with its confidence. `mode: 'string'` returns captured_at as the
    // stored ISO timestamp; confidence is a double.
    const rows = await this.run('deals.pendingQueueSignals', () =>
      this.db
        .select({
          capturedAt: schema.evidence.capturedAt,
          confidence: schema.deals.confidence,
        })
        .from(schema.deals)
        .leftJoin(schema.evidence, eq(schema.deals.evidenceId, schema.evidence.id))
        .where(inArray(schema.deals.status, [...REVIEWABLE_STATUSES])),
    );
    // Normalise captured_at to canonical ISO-Z (node-postgres returns libpq text form)
    // so the timestamp is byte-identical to the in-memory adapter — the freshness
    // age math keys on a real Date, but LSP parity wants identical strings too.
    return rows.map((r) => ({
      capturedAt: isoTimestampOrNull(r.capturedAt),
      confidence: Number(r.confidence),
    }));
  }
}

/**
 * Build the optional published-feed filter predicates (AND-ed by the caller after
 * the always-on `status='published'`). Absent filter ⇒ no predicate. Mirrors the
 * in-memory `matchesPublishedFilters` exactly so both adapters return the same set.
 */
function publishedFilterPredicates(filters: PublishedFilters): SQL[] {
  const predicates: SQL[] = [];
  if (filters.service !== undefined) predicates.push(eq(schema.deals.service, filters.service));
  if (filters.country !== undefined) predicates.push(eq(schema.deals.country, filters.country));
  if (filters.routeType !== undefined)
    predicates.push(eq(schema.deals.routeType, filters.routeType));
  if (filters.priceMax !== undefined)
    predicates.push(lte(schema.deals.trueCostMonthly, filters.priceMax));
  return predicates;
}

class PgCrawlRunRepo extends PgRepo implements CrawlRunRepository {
  async insert(r: CrawlRun): Promise<void> {
    // Plain insert (PK = id): not idempotent, so a retry treats a unique violation
    // as "the prior attempt committed" rather than a new failure.
    await this.run(
      'crawlRuns.insert',
      () => this.db.insert(schema.crawlRuns).values(toRunRow(r)),
      false,
    );
  }
  async update(r: CrawlRun): Promise<void> {
    await this.run('crawlRuns.update', () =>
      this.db.update(schema.crawlRuns).set(toRunRow(r)).where(eq(schema.crawlRuns.id, r.id)),
    );
  }
  async recentRuns(filter: { since?: Date; until?: Date; limit: number }): Promise<CrawlRun[]> {
    const predicates: SQL[] = [];
    if (filter.since) predicates.push(gte(schema.crawlRuns.startedAt, filter.since.toISOString()));
    if (filter.until) predicates.push(lt(schema.crawlRuns.startedAt, filter.until.toISOString()));
    const where = predicates.length > 0 ? and(...predicates) : undefined;
    return this.run('crawlRuns.recentRuns', async () => {
      const rows = await this.db
        .select()
        .from(schema.crawlRuns)
        .where(where)
        // Newest first; id desc is the deterministic tiebreaker (matches in-memory).
        .orderBy(desc(schema.crawlRuns.startedAt), desc(schema.crawlRuns.id))
        .limit(filter.limit);
      // Boundary discipline: re-validate each row through the schema before use.
      return rows.map((r) => fromRunRow(r));
    });
  }
  async spentSince(since: Date): Promise<number> {
    // Exact integer micro-euro sum (numeric, order-independent), rounded once to
    // cents — identical convention to costSummary so the guard agrees with stats.
    return this.run('crawlRuns.spentSince', async () => {
      const rows = await this.db
        .select({
          micros: sql<number>`coalesce(sum(round((${schema.crawlRuns.costEur} * 1000000)::numeric)), 0)::bigint`,
        })
        .from(schema.crawlRuns)
        .where(gte(schema.crawlRuns.startedAt, since.toISOString()));
      return eurFromMicros(Number(rows[0]?.micros ?? 0));
    });
  }
  async costSummary(filter: { since?: Date; until?: Date }): Promise<CostSummary> {
    // Half-open window on started_at: since inclusive (gte), until exclusive (lt).
    // started_at is timestamptz mode:'string'; compare against an ISO string exactly
    // like sources.listDue does, so the boundary matches the in-memory adapter.
    const predicates: SQL[] = [];
    if (filter.since) predicates.push(gte(schema.crawlRuns.startedAt, filter.since.toISOString()));
    if (filter.until) predicates.push(lt(schema.crawlRuns.startedAt, filter.until.toISOString()));
    const where = predicates.length > 0 ? and(...predicates) : undefined;

    // UTC calendar-day bucket as YYYY-MM-DD — identical string to the in-memory
    // adapter's `new Date(started_at).toISOString().slice(0,10)`.
    const dayExpr = sql<string>`to_char(${schema.crawlRuns.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

    // Sum EXACT integer micro-euros, not raw floats: round each row to micro-euros
    // (numeric `round` of the double product cost_eur*1000000 — byte-identical to
    // the in-memory adapter's `Math.round(cost_eur*1e6)`), then `sum` as numeric,
    // which is exact and order-independent. Defeats float-add order divergence
    // between adapters. `::bigint` makes the result a plain integer for JS.
    // See CostSummarySchema's rounding-convention note.
    const microSumExpr = sql<number>`coalesce(sum(round((${schema.crawlRuns.costEur} * 1000000)::numeric)), 0)::bigint`;

    // Null source_id (Lane-B) → the shared sentinel string, matching the in-memory
    // adapter. The uuid column is cast to text FIRST so coalesce doesn't try to
    // parse the sentinel as a uuid (it isn't one — which is what stops collisions).
    const sourceBucketExpr = sql<string>`coalesce(${schema.crawlRuns.sourceId}::text, ${SOURCELESS_RUN_BUCKET})`;

    return this.run('crawlRuns.costSummary', async () => {
      const [totalsRows, perDayRows, perSourceRows] = await Promise.all([
        // (1) totals — coalesce so an empty window returns 0, not NULL.
        this.db
          .select({
            micros: microSumExpr,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.crawlRuns)
          .where(where),
        // (2) per-day — group + order by the same UTC to_char expression.
        this.db
          .select({
            day: dayExpr,
            micros: microSumExpr,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.crawlRuns)
          .where(where)
          .groupBy(dayExpr)
          .orderBy(asc(dayExpr)),
        // (3) per-source — final sort done in JS on the ROUNDED cost (below).
        // Null source_id (Lane-B runs) folds under the shared sentinel via coalesce
        // so the grouping matches the in-memory adapter's `?? SOURCELESS_RUN_BUCKET`.
        this.db
          .select({
            sourceId: sourceBucketExpr,
            micros: microSumExpr,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.crawlRuns)
          .where(where)
          // Group by the bare column, not the coalesce expression: the sentinel
          // bucket is functionally determined by source_id (NULL is its own
          // group, mapped to the sentinel only in the projection), so this is
          // semantically identical while avoiding Postgres's "must appear in
          // GROUP BY" error — Drizzle renders the inline-param coalesce expr
          // differently in SELECT vs GROUP BY, so the two never textually match.
          .groupBy(schema.crawlRuns.sourceId),
      ]);

      const totals = totalsRows[0] ?? { micros: 0, count: 0 };
      const summary = {
        total_eur: eurFromMicros(Number(totals.micros)),
        run_count: Number(totals.count),
        per_day: perDayRows.map((r) => ({
          day: r.day,
          cost_eur: eurFromMicros(Number(r.micros)),
          run_count: Number(r.count),
        })),
        per_source: perSourceRows
          .map((r) => ({
            source_id: r.sourceId,
            cost_eur: eurFromMicros(Number(r.micros)),
            run_count: Number(r.count),
          }))
          // Sort on the ROUNDED cost (desc) so ties break identically to the
          // in-memory adapter, then source_id ascending as the tiebreaker.
          .sort((a, b) => b.cost_eur - a.cost_eur || a.source_id.localeCompare(b.source_id)),
      };
      // Boundary discipline: re-validate the assembled object before returning.
      return CostSummarySchema.parse(summary);
    });
  }
}

class PgEvidenceRepo extends PgRepo implements EvidenceRepository {
  async insert(e: Evidence): Promise<void> {
    await this.run(
      'evidence.insert',
      () => this.db.insert(schema.evidence).values(toEvidenceRow(e)),
      false,
    );
  }
  async getById(id: string): Promise<Evidence | null> {
    const rows = await this.run('evidence.getById', () =>
      this.db.select().from(schema.evidence).where(eq(schema.evidence.id, id)).limit(1),
    );
    return rows[0] ? fromEvidenceRow(rows[0]) : null;
  }
}

class PgManualCaptureRepo extends PgRepo implements ManualCaptureRepository {
  async insert(t: ManualCaptureTask): Promise<void> {
    await this.run(
      'manualCapture.insert',
      () => this.db.insert(schema.manualCaptureTasks).values(toManualCaptureRow(t)),
      false,
    );
  }
  async listOpen(limit: number): Promise<ManualCaptureTask[]> {
    const rows = await this.run('manualCapture.listOpen', () =>
      this.db
        .select()
        .from(schema.manualCaptureTasks)
        .where(eq(schema.manualCaptureTasks.status, 'open'))
        .limit(limit),
    );
    return rows.map(rowToManualCaptureTask);
  }
  async getById(id: string): Promise<ManualCaptureTask | null> {
    const rows = await this.run('manualCapture.getById', () =>
      this.db.select().from(schema.manualCaptureTasks).where(eq(schema.manualCaptureTasks.id, id)),
    );
    return rows[0] ? rowToManualCaptureTask(rows[0]) : null;
  }
  async markDone(id: string, note: string | null): Promise<void> {
    await this.run('manualCapture.markDone', () =>
      this.db
        .update(schema.manualCaptureTasks)
        .set({ status: 'done', note })
        .where(eq(schema.manualCaptureTasks.id, id)),
    );
  }
}

class PgFieldProposalRepo extends PgRepo implements FieldProposalRepository {
  async upsertAndCount(p: Omit<FieldProposalRecord, 'id' | 'count' | 'status'>): Promise<void> {
    // Single-statement upsert: count = count + 1 on conflict, first_seen_at set
    // only on the insert branch (preserved on repeat). Idempotent under retry only
    // in the sense that the ON CONFLICT path is safe; an over-count on a retried
    // commit is acceptable (a proposal tally is advisory, not trust-critical).
    await this.run('fieldProposals.upsertAndCount', () =>
      this.db
        .insert(schema.fieldProposals)
        .values({
          id: newId(),
          suggestedKey: p.suggested_key,
          label: p.label,
          rationale: p.rationale,
          exampleQuote: p.example_quote,
          count: 1,
          status: 'open',
          firstSeenAt: p.first_seen_at,
          lastSeenAt: p.last_seen_at,
        })
        .onConflictDoUpdate({
          target: schema.fieldProposals.suggestedKey,
          set: {
            count: sqlIncrement(),
            lastSeenAt: p.last_seen_at,
          },
        }),
    );
  }
  async listOpen(limit: number): Promise<FieldProposalRecord[]> {
    const rows = await this.run('fieldProposals.listOpen', () =>
      this.db
        .select()
        .from(schema.fieldProposals)
        .where(eq(schema.fieldProposals.status, 'open'))
        .orderBy(desc(schema.fieldProposals.count))
        .limit(limit),
    );
    return rows.map(rowToFieldProposal);
  }
  async getByKey(suggestedKey: string): Promise<FieldProposalRecord | null> {
    const rows = await this.run('fieldProposals.getByKey', () =>
      this.db
        .select()
        .from(schema.fieldProposals)
        .where(eq(schema.fieldProposals.suggestedKey, suggestedKey)),
    );
    return rows[0] ? rowToFieldProposal(rows[0]) : null;
  }
  async markPromoted(suggestedKey: string): Promise<void> {
    await this.run('fieldProposals.markPromoted', () =>
      this.db
        .update(schema.fieldProposals)
        .set({ status: 'promoted' })
        .where(eq(schema.fieldProposals.suggestedKey, suggestedKey)),
    );
  }
}

class PgConditionVocabularyRepo extends PgRepo implements ConditionVocabularyRepository {
  async getByKey(key: string): Promise<VocabularyEntry | null> {
    const rows = await this.run('conditionVocabulary.getByKey', () =>
      this.db
        .select()
        .from(schema.conditionVocabulary)
        .where(eq(schema.conditionVocabulary.key, key)),
    );
    return rows[0] ? rowToVocabularyEntry(rows[0]) : null;
  }
  async upsert(entry: VocabularyEntry): Promise<void> {
    // Idempotent: re-promoting the same key updates label/aliases/version rather
    // than erroring (the promotion action is safe to retry).
    await this.run('conditionVocabulary.upsert', () =>
      this.db
        .insert(schema.conditionVocabulary)
        .values({
          key: entry.key,
          label: entry.label,
          aliases: entry.aliases,
          version: entry.version,
        })
        .onConflictDoUpdate({
          target: schema.conditionVocabulary.key,
          set: { label: entry.label, aliases: entry.aliases, version: entry.version },
        }),
    );
  }
  async list(): Promise<VocabularyEntry[]> {
    const rows = await this.run('conditionVocabulary.list', () =>
      this.db.select().from(schema.conditionVocabulary),
    );
    return rows.map(rowToVocabularyEntry);
  }
}

class PgChangeRepo extends PgRepo implements ChangeRepository {
  async insert(c: Change): Promise<void> {
    await this.run(
      'changes.insert',
      () =>
        this.db.insert(schema.changes).values({
          id: c.id,
          dealId: c.deal_id,
          sourceId: c.source_id,
          kind: c.kind,
          previousHash: c.previous_hash,
          currentHash: c.current_hash,
          detectedAt: c.detected_at,
        }),
      false,
    );
  }
  async recentForSource(sourceId: string, limit: number): Promise<Change[]> {
    const rows = await this.run('changes.recentForSource', () =>
      this.db
        .select()
        .from(schema.changes)
        .where(eq(schema.changes.sourceId, sourceId))
        // `id` is a deterministic tiebreaker for equal timestamps (matches the
        // in-memory adapter's contract: newest first, stable).
        .orderBy(desc(schema.changes.detectedAt), desc(schema.changes.id))
        .limit(limit),
    );
    return rows.map(rowToChange);
  }
}

function rowToChange(r: typeof schema.changes.$inferSelect): Change {
  // Re-validate the free-text `kind` column at the boundary rather than casting
  // blindly — never trust stored data even though we own every write.
  return ChangeSchema.parse({
    id: r.id,
    deal_id: r.dealId,
    source_id: r.sourceId,
    kind: r.kind,
    previous_hash: r.previousHash,
    current_hash: r.currentHash,
    detected_at: isoTimestamp(r.detectedAt),
  });
}

class PgReviewRepo extends PgRepo implements ReviewRepository {
  async insert(r: ReviewRecord): Promise<void> {
    await this.run(
      'reviews.insert',
      () =>
        this.db.insert(schema.reviews).values({
          id: r.id,
          dealId: r.deal_id,
          action: r.action,
          approver: r.approver,
          reason: r.reason,
          decidedAt: r.decided_at,
        }),
      false,
    );
  }
  async listForDeal(dealId: string, limit: number): Promise<ReviewRecord[]> {
    const rows = await this.run('reviews.listForDeal', () =>
      this.db
        .select()
        .from(schema.reviews)
        .where(eq(schema.reviews.dealId, dealId))
        .orderBy(desc(schema.reviews.decidedAt), desc(schema.reviews.id))
        .limit(limit),
    );
    // Re-validate the free-text `action` column at the boundary (matches rowToChange).
    return rows.map((r) => rowToReview(r));
  }
  async countByActionSince(action: ReviewAction, since: Date): Promise<number> {
    const rows = await this.run('reviews.countByActionSince', () =>
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.reviews)
        .where(
          and(
            eq(schema.reviews.action, action),
            gte(schema.reviews.decidedAt, since.toISOString()),
          ),
        ),
    );
    return rows[0]?.n ?? 0;
  }
  async listRecent(filter: {
    approver?: string;
    dealId?: string;
    since?: Date;
    limit: number;
  }): Promise<ReviewRecord[]> {
    const predicates: SQL[] = [];
    if (filter.approver !== undefined)
      predicates.push(eq(schema.reviews.approver, filter.approver));
    if (filter.dealId !== undefined) predicates.push(eq(schema.reviews.dealId, filter.dealId));
    if (filter.since) predicates.push(gte(schema.reviews.decidedAt, filter.since.toISOString()));
    const where = predicates.length > 0 ? and(...predicates) : undefined;
    const rows = await this.run('reviews.listRecent', () =>
      this.db
        .select()
        .from(schema.reviews)
        .where(where)
        .orderBy(desc(schema.reviews.decidedAt), desc(schema.reviews.id))
        .limit(filter.limit),
    );
    return rows.map((r) => rowToReview(r));
  }
  async countByApprover(): Promise<Map<string, number>> {
    const rows = await this.run('reviews.countByApprover', () =>
      this.db
        .select({ approver: schema.reviews.approver, n: sql<number>`count(*)::int` })
        .from(schema.reviews)
        .groupBy(schema.reviews.approver),
    );
    return new Map(rows.map((r) => [r.approver, Number(r.n)]));
  }
  async listDecisionLatenciesSince(
    since: Date,
  ): Promise<{ action: ReviewAction; latencySeconds: number | null }[]> {
    // decided_at >= since (inclusive), each LEFT JOINed reviews→deals→evidence so the
    // capture→decision latency is computed in SQL (epoch seconds, floored). A missing
    // deal/evidence yields a null latency — mirrors the in-memory adapter (LSP). The
    // join order matters: an INNER join would silently drop decisions whose deal was
    // hard-deleted; LEFT keeps the count honest (the decision still counts).
    const rows = await this.run('reviews.listDecisionLatenciesSince', () =>
      this.db
        .select({
          action: schema.reviews.action,
          latencySeconds: sql<
            number | null
          >`floor(extract(epoch from (${schema.reviews.decidedAt} - ${schema.evidence.capturedAt})))::int`,
        })
        .from(schema.reviews)
        .leftJoin(schema.deals, eq(schema.reviews.dealId, schema.deals.id))
        .leftJoin(schema.evidence, eq(schema.deals.evidenceId, schema.evidence.id))
        .where(gte(schema.reviews.decidedAt, since.toISOString())),
    );
    return rows.map((r) => ({
      // Re-validate the free-text `action` column at the boundary (matches rowToReview).
      action: ReviewAction.parse(r.action),
      latencySeconds: r.latencySeconds === null ? null : Number(r.latencySeconds),
    }));
  }
}

/** Re-validate a reviews row at the boundary (the free-text `action` column). */
function rowToReview(r: typeof schema.reviews.$inferSelect): ReviewRecord {
  return ReviewRecordSchema.parse({
    id: r.id,
    deal_id: r.dealId,
    action: r.action,
    approver: r.approver,
    reason: r.reason,
    decided_at: isoTimestamp(r.decidedAt),
  });
}

class PgSourceReviewRepo extends PgRepo implements SourceReviewRepository {
  async insert(r: SourceReviewRecord): Promise<void> {
    await this.run(
      'sourceReviews.insert',
      () =>
        this.db.insert(schema.sourceReviews).values({
          id: r.id,
          sourceId: r.source_id,
          action: r.action,
          approver: r.approver,
          reason: r.reason,
          decidedAt: r.decided_at,
        }),
      false,
    );
  }
  async listForSource(sourceId: string, limit: number): Promise<SourceReviewRecord[]> {
    const rows = await this.run('sourceReviews.listForSource', () =>
      this.db
        .select()
        .from(schema.sourceReviews)
        .where(eq(schema.sourceReviews.sourceId, sourceId))
        .orderBy(desc(schema.sourceReviews.decidedAt), desc(schema.sourceReviews.id))
        .limit(limit),
    );
    return rows.map((r) =>
      SourceReviewRecordSchema.parse({
        id: r.id,
        source_id: r.sourceId,
        action: r.action,
        approver: r.approver,
        reason: r.reason,
        decided_at: isoTimestamp(r.decidedAt),
      }),
    );
  }
}

class PgTeamRepo extends PgRepo implements TeamRepository {
  async upsert(m: TeamMember): Promise<void> {
    // Conflict on `email` (the natural identity): re-inviting/updating the same
    // person updates in place and keeps the original id, mirroring sources.upsert.
    const row = {
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      status: m.status,
      createdAt: m.created_at,
    };
    await this.run('team.upsert', () =>
      this.db
        .insert(schema.teamMembers)
        .values(row)
        .onConflictDoUpdate({
          target: schema.teamMembers.email,
          set: { name: m.name, role: m.role, status: m.status },
        }),
    );
  }
  async getById(id: string): Promise<TeamMember | null> {
    const rows = await this.run('team.getById', () =>
      this.db.select().from(schema.teamMembers).where(eq(schema.teamMembers.id, id)).limit(1),
    );
    return rows[0] ? rowToTeamMember(rows[0]) : null;
  }
  async getByEmail(email: string): Promise<TeamMember | null> {
    const rows = await this.run('team.getByEmail', () =>
      this.db.select().from(schema.teamMembers).where(eq(schema.teamMembers.email, email)).limit(1),
    );
    return rows[0] ? rowToTeamMember(rows[0]) : null;
  }
  async list(): Promise<TeamMember[]> {
    const rows = await this.run('team.list', () =>
      this.db
        .select()
        .from(schema.teamMembers)
        .orderBy(asc(schema.teamMembers.name), asc(schema.teamMembers.id)),
    );
    return rows.map(rowToTeamMember);
  }
}

function rowToTeamMember(r: typeof schema.teamMembers.$inferSelect): TeamMember {
  // Re-validate at the boundary (free-text role/status columns) — never trust the row.
  return TeamMemberSchema.parse({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    status: r.status,
    created_at: isoTimestamp(r.createdAt),
  });
}

class PgAlertRepo extends PgRepo implements AlertRepository {
  async upsertOpen(r: AlertRecord): Promise<void> {
    // One OPEN row per dedupe_key via the partial unique index (status='open'):
    // a repeat refreshes the open row; a first sighting (or a re-open after a prior
    // resolve) inserts. Idempotent under retry (the conflict path is a safe update).
    await this.run('alerts.upsertOpen', () =>
      this.db
        .insert(schema.alertEvents)
        .values({
          id: r.id,
          dedupeKey: r.dedupe_key,
          kind: r.kind,
          severity: r.severity,
          title: r.title,
          summary: r.summary,
          context: r.context,
          status: r.status,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })
        .onConflictDoUpdate({
          target: schema.alertEvents.dedupeKey,
          targetWhere: sql`${schema.alertEvents.status} = 'open'`,
          set: {
            summary: r.summary,
            context: r.context,
            severity: r.severity,
            title: r.title,
            updatedAt: r.updated_at,
          },
        }),
    );
  }
  async list(limit: number): Promise<AlertRecord[]> {
    const rows = await this.run('alerts.list', () =>
      this.db
        .select()
        .from(schema.alertEvents)
        .orderBy(desc(schema.alertEvents.createdAt), desc(schema.alertEvents.id))
        .limit(limit),
    );
    return rows.map(rowToAlert);
  }
  async getById(id: string): Promise<AlertRecord | null> {
    const rows = await this.run('alerts.getById', () =>
      this.db.select().from(schema.alertEvents).where(eq(schema.alertEvents.id, id)).limit(1),
    );
    return rows[0] ? rowToAlert(rows[0]) : null;
  }
  async setStatus(id: string, status: AlertStatus, at: string): Promise<void> {
    await this.run('alerts.setStatus', () =>
      this.db
        .update(schema.alertEvents)
        .set({ status, updatedAt: at })
        .where(eq(schema.alertEvents.id, id)),
    );
  }
}

function rowToAlert(r: typeof schema.alertEvents.$inferSelect): AlertRecord {
  return AlertRecordSchema.parse({
    id: r.id,
    dedupe_key: r.dedupeKey,
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    summary: r.summary,
    context: r.context,
    status: r.status,
    created_at: isoTimestamp(r.createdAt),
    updated_at: isoTimestamp(r.updatedAt),
  });
}

class PgCatalogRepo extends PgRepo implements SubscriptionCatalogRepository {
  async upsert(entry: SubscriptionCatalogEntry): Promise<void> {
    const e = SubscriptionCatalogEntrySchema.parse(entry); // validate at the boundary
    const row = {
      service: e.service,
      category: e.category,
      providerUrl: e.provider_url,
      country: e.country,
    };
    await this.run('catalog.upsert', () =>
      this.db
        .insert(schema.subscriptionCatalog)
        .values(row)
        .onConflictDoUpdate({ target: schema.subscriptionCatalog.service, set: row }),
    );
  }
  async list(): Promise<SubscriptionCatalogEntry[]> {
    const rows = await this.run('catalog.list', () =>
      this.db.select().from(schema.subscriptionCatalog),
    );
    return rows.map((r) => ({
      service: r.service,
      category: r.category,
      provider_url: r.providerUrl,
      country: r.country as SubscriptionCatalogEntry['country'],
    }));
  }
}

// ── row mappers (small, table-local) ─────────────────────────────────────────

function toManualCaptureRow(t: ManualCaptureTask): typeof schema.manualCaptureTasks.$inferInsert {
  return {
    id: t.id,
    sourceId: t.source_id,
    sourceUrl: t.source_url,
    reason: t.reason,
    createdAt: t.created_at,
    status: t.status,
    note: t.note,
  };
}

function rowToManualCaptureTask(
  r: typeof schema.manualCaptureTasks.$inferSelect,
): ManualCaptureTask {
  return {
    id: r.id,
    source_id: r.sourceId,
    source_url: r.sourceUrl,
    reason: r.reason as ManualCaptureTask['reason'],
    created_at: isoTimestamp(r.createdAt),
    status: r.status as ManualCaptureTask['status'],
    note: r.note,
  };
}

function rowToFieldProposal(r: typeof schema.fieldProposals.$inferSelect): FieldProposalRecord {
  return {
    id: r.id,
    suggested_key: r.suggestedKey,
    label: r.label,
    rationale: r.rationale,
    example_quote: r.exampleQuote,
    count: r.count,
    status: r.status as FieldProposalRecord['status'],
    first_seen_at: isoTimestamp(r.firstSeenAt),
    last_seen_at: isoTimestamp(r.lastSeenAt),
  };
}

function rowToVocabularyEntry(r: typeof schema.conditionVocabulary.$inferSelect): VocabularyEntry {
  return {
    key: r.key,
    label: r.label,
    aliases: r.aliases as string[],
    version: r.version,
  };
}

function toSourceRow(s: Source): typeof schema.sources.$inferInsert {
  return {
    id: s.id,
    url: s.url,
    type: s.type,
    tier: s.tier,
    country: s.country,
    subscriptionService: s.subscription_service,
    cadenceDays: s.cadence_days,
    reliabilityScore: s.reliability_score,
    status: s.status,
    lastSeen: s.last_seen,
    nextDue: s.next_due,
    resolvedUrl: s.resolved_url,
    registrableDomain: s.registrable_domain,
    proposalReason: s.proposal_reason,
  };
}
function fromSourceRow(r: typeof schema.sources.$inferSelect): Source {
  return {
    id: r.id,
    url: r.url,
    type: r.type as Source['type'],
    tier: r.tier as Source['tier'],
    country: r.country as Source['country'],
    subscription_service: r.subscriptionService,
    cadence_days: r.cadenceDays,
    reliability_score: r.reliabilityScore,
    status: r.status as Source['status'],
    last_seen: isoTimestampOrNull(r.lastSeen),
    next_due: isoTimestampOrNull(r.nextDue),
    resolved_url: r.resolvedUrl,
    registrable_domain: r.registrableDomain,
    proposal_reason: r.proposalReason,
  };
}
function toRunRow(r: CrawlRun): typeof schema.crawlRuns.$inferInsert {
  return {
    id: r.id,
    sourceId: r.source_id,
    runKind: r.run_kind,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    candidatesProduced: r.candidates_produced,
    proposalsProduced: r.proposals_produced,
    costEur: r.cost_eur,
    stoppedReason: r.stopped_reason,
    error: r.error,
  };
}
function fromRunRow(r: typeof schema.crawlRuns.$inferSelect): CrawlRun {
  // Re-validate at the boundary (never trust the row shape blindly): the enums +
  // nullability are enforced by CrawlRunSchema, not just the column types.
  return CrawlRunSchema.parse({
    id: r.id,
    source_id: r.sourceId,
    run_kind: r.runKind,
    status: r.status,
    // Normalize timestamptz text → ISO-Z so recentRuns is byte-identical to the
    // in-memory adapter (see isoTimestamp).
    started_at: isoTimestamp(r.startedAt),
    finished_at: isoTimestampOrNull(r.finishedAt),
    candidates_produced: r.candidatesProduced,
    proposals_produced: r.proposalsProduced,
    cost_eur: r.costEur,
    stopped_reason: r.stoppedReason,
    error: r.error,
  });
}
function toEvidenceRow(e: Evidence): typeof schema.evidence.$inferInsert {
  return {
    id: e.id,
    sourceUrl: e.source_url,
    screenshotRef: e.screenshot_ref,
    htmlRef: e.html_ref,
    termsRef: e.terms_ref,
    capturedAt: e.captured_at,
    contentHash: e.content_hash,
  };
}
function fromEvidenceRow(r: typeof schema.evidence.$inferSelect): Evidence {
  return {
    id: r.id,
    source_url: r.sourceUrl,
    screenshot_ref: r.screenshotRef,
    html_ref: r.htmlRef,
    terms_ref: r.termsRef,
    captured_at: isoTimestamp(r.capturedAt),
    content_hash: r.contentHash,
  };
}

// drizzle helper to express `count = count + 1` without a raw string everywhere.
function sqlIncrement() {
  return sql`${schema.fieldProposals.count} + 1`;
}
