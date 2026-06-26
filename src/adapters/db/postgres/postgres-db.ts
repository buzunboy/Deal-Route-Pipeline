import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, ne, lte, lt, gte, or, isNull, desc, asc, inArray, ilike, sql } from 'drizzle-orm';
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
  SettingsRepository,
  UserRepository,
  RoleRepository,
  RolePermissionRepository,
  RefreshTokenRepository,
  AuthMetaRepository,
  ClaimInputs,
} from '../../../application/ports/index.js';
import {
  ChangeSchema,
  CrawlRunSchema,
  ReviewAction,
  ReviewRecordSchema,
  SourceReviewRecordSchema,
  TeamMemberSchema,
  AlertRecordSchema,
  SettingOverrideSchema,
  SubscriptionCatalogEntrySchema,
  CostSummarySchema,
  UserSchema,
  RoleSchema,
  StoredRefreshSchema,
  Permission,
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
  type SearchResource,
  type SearchResults,
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
  AuditReviewRow,
  SourceReviewRecord,
  TeamMember,
  AlertRecord,
  AlertStatus,
  SettingOverride,
  SubscriptionCatalogEntry,
  PublishedQuery,
  PublishedFilters,
  CandidateQuery,
  CandidateDealCounts,
  AdminPublishedQuery,
  VocabularyEntry,
  User,
  Role,
  StoredRefresh,
} from '../../../domain/index.js';
import type { Logger } from '../../../application/ports/index.js';
import * as schema from './schema.js';
import { dealToRow, rowToDeal, isoTimestamp, isoTimestampOrNull } from './mappers.js';
import { randomUUID } from 'node:crypto';
import { DbRetrier, type DbRetryConfig } from './db-resilience.js';

type Db = NodePgDatabase<typeof schema>;

/** Pool + retry tuning for the Postgres adapter. All values come from typed config. */
export interface PostgresDbOptions {
  pool: {
    max: number;
    min: number;
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
    min: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_500,
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
  readonly settings: SettingsRepository;
  readonly users: UserRepository;
  readonly roles: RoleRepository;
  readonly rolePermissions: RolePermissionRepository;
  readonly refreshTokens: RefreshTokenRepository;
  readonly authMeta: AuthMetaRepository;

  private constructor(
    private readonly pool: pg.Pool,
    private readonly db: Db,
    private readonly retrier: DbRetrier,
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
    this.settings = new PgSettingsRepo(db, retrier);
    this.users = new PgUserRepo(db, retrier);
    this.roles = new PgRoleRepo(db, retrier);
    this.rolePermissions = new PgRolePermissionRepo(db, retrier);
    this.refreshTokens = new PgRefreshTokenRepo(db, retrier);
    this.authMeta = new PgAuthMetaRepo(db, retrier);
  }

  static connect(
    connectionString: string,
    options: PostgresDbOptions = DEFAULT_OPTIONS,
  ): PostgresDb {
    const pool = new pg.Pool({
      connectionString,
      max: options.pool.max,
      // Keep `min` warm connections so a checkout after an idle spell doesn't pay a cold
      // connect against the connect-timeout — the auth path's first read benefits most.
      min: options.pool.min,
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

  /**
   * The three claim-minting reads (role permissions, role name, perm_version) in ONE
   * transaction — so login/refresh hold a single pool connection here instead of three.
   * Routed through the retrier like every other op (the whole transaction retries as a
   * unit on a transient). Deny-by-default: an unknown role → `{ [], '', permVersion }`.
   */
  async claimInputsForRole(roleId: string): Promise<ClaimInputs> {
    return this.retrier.run('auth.claimInputsForRole', () =>
      this.db.transaction(async (tx) => {
        const grants = await tx
          .select({ key: schema.rolePermissions.permissionKey })
          .from(schema.rolePermissions)
          .where(eq(schema.rolePermissions.roleId, roleId));
        const roleRows = await tx
          .select({ name: schema.roles.name })
          .from(schema.roles)
          .where(eq(schema.roles.id, roleId))
          .limit(1);
        const metaRows = await tx
          .select({ value: schema.authMeta.value })
          .from(schema.authMeta)
          .where(eq(schema.authMeta.key, PERM_VERSION_KEY))
          .limit(1);
        return {
          // Re-validate the free-text key column at the boundary (reject a non-enum key).
          permissions: grants.map((r) => Permission.parse(r.key)),
          roleName: roleRows[0]?.name ?? '',
          permVersion: metaRows[0] ? Number(metaRows[0].value) : 0,
        };
      }),
    );
  }

  /**
   * Unified-search ILIKE queries (the frozen /api/search contract). One case-insensitive
   * substring query per requested resource, projecting straight to `{ id, title, subtitle }`
   * (subtitle composed in SQL so the row already carries the contract shape). Each is capped
   * at `limit`. `q` is assumed already-trimmed + length-validated by the caller
   * (ReviewUseCase.search), which also does the permission scoping.
   *
   * ponytail: plain ILIKE '%q%' substring match — no index, a sequential scan per resource.
   * Fine at the current corpus (a handful of reviewers, low-thousands of rows). Upgrade path
   * when it bites: a generated tsvector column + GIN index (or pg_trgm GIN for substring),
   * matched with `@@`/`%` instead of ILIKE — same projection, swap the WHERE.
   *
   * The title/subtitle FORMATS below are composed in SQL (so the row already carries the
   * contract shape) and MUST mirror the pure projectors in `domain/search/search-projection.ts`
   * — `dealToSearchItem` ("provider · country"), `sourceToSearchItem` ("Tier N · status"),
   * `captureToSearchItem` ("reason · status"). Those projectors are the source of truth for the
   * in-memory adapter; keep these `sql` expressions in lockstep if a format ever changes.
   */
  async search(opts: {
    q: string;
    resources: Set<SearchResource>;
    limit: number;
  }): Promise<SearchResults> {
    const { resources, limit } = opts;
    // Escape ILIKE wildcards so a literal % or _ in the query isn't treated as a pattern.
    const pattern = `%${opts.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const out: SearchResults = {};

    if (resources.has('candidates') || resources.has('published')) {
      const dealMatch = or(
        ilike(schema.deals.service, pattern),
        ilike(schema.deals.provider, pattern),
        ilike(schema.deals.headline, pattern),
      );
      const dealSelect = (statuses: string[]) =>
        this.db
          .select({
            id: schema.deals.id,
            title: schema.deals.service,
            subtitle: sql<string>`${schema.deals.provider} || ' · ' || ${schema.deals.country}`,
          })
          .from(schema.deals)
          .where(and(inArray(schema.deals.status, statuses), dealMatch))
          .limit(limit);
      if (resources.has('candidates')) {
        out.candidates = await this.retrier.run('search.candidates', () =>
          dealSelect(['candidate', 'in_review']),
        );
      }
      if (resources.has('published')) {
        out.published = await this.retrier.run('search.published', () => dealSelect(['published']));
      }
    }

    if (resources.has('sources')) {
      out.sources = await this.retrier.run('search.sources', () =>
        this.db
          .select({
            id: schema.sources.id,
            title: sql<string>`coalesce(${schema.sources.registrableDomain}, ${schema.sources.url})`,
            subtitle: sql<string>`'Tier ' || ${schema.sources.tier} || ' · ' || ${schema.sources.status}`,
          })
          .from(schema.sources)
          .where(
            or(
              ilike(schema.sources.registrableDomain, pattern),
              ilike(schema.sources.url, pattern),
            ),
          )
          .limit(limit),
      );
    }

    if (resources.has('captures')) {
      out.captures = await this.retrier.run('search.captures', () =>
        this.db
          .select({
            id: schema.manualCaptureTasks.id,
            title: schema.manualCaptureTasks.sourceUrl,
            subtitle: sql<string>`${schema.manualCaptureTasks.reason} || ' · ' || ${schema.manualCaptureTasks.status}`,
          })
          .from(schema.manualCaptureTasks)
          .where(ilike(schema.manualCaptureTasks.sourceUrl, pattern))
          .limit(limit),
      );
    }

    if (resources.has('users')) {
      out.users = await this.retrier.run('search.users', () =>
        this.db
          .select({
            id: schema.users.id,
            title: schema.users.name,
            subtitle: schema.users.email,
          })
          .from(schema.users)
          .where(or(ilike(schema.users.name, pattern), ilike(schema.users.email, pattern)))
          .limit(limit),
      );
    }

    return out;
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
          id: randomUUID(),
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
  }): Promise<AuditReviewRow[]> {
    const predicates: SQL[] = [];
    if (filter.approver !== undefined)
      predicates.push(eq(schema.reviews.approver, filter.approver));
    if (filter.dealId !== undefined) predicates.push(eq(schema.reviews.dealId, filter.dealId));
    if (filter.since) predicates.push(gte(schema.reviews.decidedAt, filter.since.toISOString()));
    const where = predicates.length > 0 ? and(...predicates) : undefined;
    // LEFT JOIN deals so each audit row carries the decided deal's service/provider
    // for the panel's `detail` label. LEFT (not INNER) keeps decisions whose deal was
    // hard-deleted — they still count, just with null label fields (ACR-7).
    const rows = await this.run('reviews.listRecent', () =>
      this.db
        .select({
          review: schema.reviews,
          service: schema.deals.service,
          provider: schema.deals.provider,
        })
        .from(schema.reviews)
        .leftJoin(schema.deals, eq(schema.reviews.dealId, schema.deals.id))
        .where(where)
        .orderBy(desc(schema.reviews.decidedAt), desc(schema.reviews.id))
        .limit(filter.limit),
    );
    return rows.map((r) => ({
      ...rowToReview(r.review),
      deal_service: r.service,
      deal_provider: r.provider,
    }));
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

/**
 * The Team screen, projected over `users` + `roles` (the `team_members → users`
 * consolidation). `TeamMember.role` (a name) maps to/from `users.role_id` via a join;
 * a new member row carries the auth defaults (no password yet → `invited`). Shares the
 * SAME table the `PgUserRepo` uses, so a user created via either path is visible through
 * both. Mirrors the in-memory `InMemoryTeamRepo` projection (LSP).
 */
class PgTeamRepo extends PgRepo implements TeamRepository {
  async upsert(m: TeamMember): Promise<void> {
    await this.run('team.upsert', async () => {
      const role = await this.db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.name, m.role))
        .limit(1);
      const roleId = role[0]?.id;
      if (!roleId) throw new Error(`team.upsert: unknown role "${m.role}"`);
      // Conflict on `email` (the natural identity): re-inviting/updating the same person
      // updates name/role/status in place and keeps the id + auth columns (mirrors
      // sources.upsert). A first insert gets the auth defaults (no password → invited).
      await this.db
        .insert(schema.users)
        .values({
          id: m.id,
          name: m.name,
          email: m.email,
          roleId,
          status: m.status,
          passwordHash: null,
          authProvider: 'password',
          tokenVersion: 0,
          failedLoginCount: 0,
          createdAt: m.created_at,
        })
        .onConflictDoUpdate({
          target: schema.users.email,
          set: { name: m.name, roleId, status: m.status },
        });
    });
  }
  async getById(id: string): Promise<TeamMember | null> {
    const rows = await this.run('team.getById', () => this.selectMembers(eq(schema.users.id, id)));
    return rows[0] ? rowToTeamMember(rows[0]) : null;
  }
  async getByEmail(email: string): Promise<TeamMember | null> {
    const rows = await this.run('team.getByEmail', () =>
      this.selectMembers(eq(schema.users.email, email)),
    );
    return rows[0] ? rowToTeamMember(rows[0]) : null;
  }
  async list(): Promise<TeamMember[]> {
    const rows = await this.run('team.list', () =>
      this.selectMembers(undefined).orderBy(asc(schema.users.name), asc(schema.users.id)),
    );
    return rows.map(rowToTeamMember);
  }
  /** The shared users⨝roles projection select (role_id → role name). */
  private selectMembers(where: SQL | undefined) {
    return this.db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        roleName: schema.roles.name,
        status: schema.users.status,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .leftJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
      .where(where);
  }
}

/** Re-validate a users⨝roles projection row at the boundary into a TeamMember. */
function rowToTeamMember(r: {
  id: string;
  name: string;
  email: string;
  roleName: string | null;
  status: string;
  createdAt: string;
}): TeamMember {
  return TeamMemberSchema.parse({
    id: r.id,
    name: r.name,
    email: r.email,
    // An unmapped/custom role projects to 'reviewer' (TeamMember.role is the admin|reviewer
    // enum; custom roles surface via the Phase-3 /api/users screen, not the Team view).
    role: r.roleName === 'admin' ? 'admin' : 'reviewer',
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

class PgSettingsRepo extends PgRepo implements SettingsRepository {
  async get(key: string): Promise<SettingOverride | null> {
    const rows = await this.run('settings.get', () =>
      this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1),
    );
    return rows[0] ? rowToSetting(rows[0]) : null;
  }
  async list(): Promise<SettingOverride[]> {
    const rows = await this.run('settings.list', () => this.db.select().from(schema.settings));
    return rows.map(rowToSetting);
  }
  async upsert(o: SettingOverride): Promise<void> {
    const v = SettingOverrideSchema.parse(o); // validate at the boundary
    const row = {
      key: v.key,
      value: v.value,
      deploymentId: v.deployment_id,
      updatedAt: v.updated_at,
      updatedBy: v.updated_by,
    };
    await this.run('settings.upsert', () =>
      this.db
        .insert(schema.settings)
        .values(row)
        .onConflictDoUpdate({ target: schema.settings.key, set: row }),
    );
  }
  async delete(key: string): Promise<void> {
    await this.run('settings.delete', () =>
      this.db.delete(schema.settings).where(eq(schema.settings.key, key)),
    );
  }
}

/** Re-validate a settings row at the boundary; normalise updated_at to ISO-Z. */
function rowToSetting(r: typeof schema.settings.$inferSelect): SettingOverride {
  return SettingOverrideSchema.parse({
    key: r.key,
    value: r.value,
    deployment_id: r.deploymentId,
    updated_at: isoTimestamp(r.updatedAt),
    updated_by: r.updatedBy,
  });
}

// ── Auth/IAM repos (Phase 1) ──────────────────────────────────────────────────

class PgUserRepo extends PgRepo implements UserRepository {
  async insert(user: User, passwordHash: string | null): Promise<void> {
    const u = UserSchema.parse(user); // boundary-validate before write
    await this.run(
      'users.insert',
      () =>
        this.db.insert(schema.users).values({
          id: u.id,
          name: u.name,
          email: u.email,
          roleId: u.role_id,
          status: u.status,
          passwordHash,
          authProvider: u.auth_provider,
          googleSub: u.google_sub,
          tokenVersion: u.token_version,
          failedLoginCount: 0,
          createdAt: u.created_at,
        }),
      false,
    );
  }
  async getById(id: string): Promise<User | null> {
    const rows = await this.run('users.getById', () =>
      this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1),
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }
  async getByEmail(email: string): Promise<User | null> {
    const rows = await this.run('users.getByEmail', () =>
      this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1),
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }
  async getPasswordHashByEmail(email: string): Promise<string | null> {
    const rows = await this.run('users.getPasswordHashByEmail', () =>
      this.db
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1),
    );
    return rows[0]?.passwordHash ?? null;
  }
  async list(): Promise<User[]> {
    const rows = await this.run('users.list', () =>
      this.db.select().from(schema.users).orderBy(asc(schema.users.name), asc(schema.users.id)),
    );
    return rows.map(rowToUser);
  }
  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.run('users.updatePasswordHash', () =>
      this.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, id)),
    );
  }
  async setStatus(id: string, status: User['status']): Promise<void> {
    await this.run('users.setStatus', () =>
      this.db.update(schema.users).set({ status }).where(eq(schema.users.id, id)),
    );
  }
  async bumpTokenVersion(id: string): Promise<number> {
    const rows = await this.run('users.bumpTokenVersion', () =>
      this.db
        .update(schema.users)
        .set({ tokenVersion: sql`${schema.users.tokenVersion} + 1` })
        .where(eq(schema.users.id, id))
        .returning({ tokenVersion: schema.users.tokenVersion }),
    );
    return rows[0]?.tokenVersion ?? 0;
  }
  async setRole(id: string, roleId: string): Promise<void> {
    await this.run('users.setRole', () =>
      this.db.update(schema.users).set({ roleId }).where(eq(schema.users.id, id)),
    );
  }
  async recordLogin(id: string, at: string): Promise<void> {
    await this.run('users.recordLogin', () =>
      this.db
        .update(schema.users)
        .set({ lastLoginAt: at, failedLoginCount: 0, lockedUntil: null })
        .where(eq(schema.users.id, id)),
    );
  }
  async recordFailedLogin(id: string, _at: string): Promise<number> {
    const rows = await this.run(
      'users.recordFailedLogin',
      () =>
        this.db
          .update(schema.users)
          .set({ failedLoginCount: sql`${schema.users.failedLoginCount} + 1` })
          .where(eq(schema.users.id, id))
          .returning({ failedLoginCount: schema.users.failedLoginCount }),
      false,
    );
    return rows[0]?.failedLoginCount ?? 0;
  }
  async setLockedUntil(id: string, until: string | null): Promise<void> {
    await this.run('users.setLockedUntil', () =>
      this.db.update(schema.users).set({ lockedUntil: until }).where(eq(schema.users.id, id)),
    );
  }
  async getLoginState(
    id: string,
  ): Promise<{ failedLoginCount: number; lockedUntil: string | null } | null> {
    const rows = await this.run('users.getLoginState', () =>
      this.db
        .select({
          failedLoginCount: schema.users.failedLoginCount,
          lockedUntil: schema.users.lockedUntil,
        })
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1),
    );
    const r = rows[0];
    return r
      ? { failedLoginCount: r.failedLoginCount, lockedUntil: isoTimestampOrNull(r.lockedUntil) }
      : null;
  }
}

/**
 * Re-validate a users row at the boundary into the `User` entity — DROPPING the
 * password hash + the adapter-only login counters (they are never on `User`, so they
 * can't leak through a DTO/log). The free-text status/auth_provider columns are
 * enforced by the schema, not just the column types.
 */
function rowToUser(r: typeof schema.users.$inferSelect): User {
  return UserSchema.parse({
    id: r.id,
    name: r.name,
    email: r.email,
    // role_id is nullable at the column level (pre-roles rows) but the domain requires
    // it; a NULL here is a real data error worth failing loudly on (post-0020 backfill
    // guarantees it's set). Coerce undefined → fail the schema rather than silently ''.
    role_id: r.roleId ?? undefined,
    status: r.status,
    auth_provider: r.authProvider,
    google_sub: r.googleSub,
    token_version: r.tokenVersion,
    created_at: isoTimestamp(r.createdAt),
  });
}

class PgRoleRepo extends PgRepo implements RoleRepository {
  async insert(role: Role): Promise<void> {
    const r = RoleSchema.parse(role); // boundary-validate before write
    await this.run(
      'roles.insert',
      () =>
        this.db
          .insert(schema.roles)
          .values({ id: r.id, name: r.name, description: r.description, isSystem: r.is_system }),
      false,
    );
  }
  async getById(id: string): Promise<Role | null> {
    const rows = await this.run('roles.getById', () =>
      this.db.select().from(schema.roles).where(eq(schema.roles.id, id)).limit(1),
    );
    return rows[0] ? rowToRole(rows[0]) : null;
  }
  async getByName(name: string): Promise<Role | null> {
    const rows = await this.run('roles.getByName', () =>
      this.db.select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1),
    );
    return rows[0] ? rowToRole(rows[0]) : null;
  }
  async list(): Promise<Role[]> {
    const rows = await this.run('roles.list', () =>
      this.db.select().from(schema.roles).orderBy(asc(schema.roles.name), asc(schema.roles.id)),
    );
    return rows.map(rowToRole);
  }
  async update(role: Role): Promise<void> {
    const r = RoleSchema.parse(role); // boundary-validate before write
    // Update the role's `description` (and `name` for a NON-system role). Defense-in-depth:
    // the `name` is only set when the row is non-system, so a system role can never be
    // RENAMED at the boundary (a CASE keeps its existing name) even if a future caller skips
    // the use-case guard; the `description` edit the use-case relies on still applies.
    await this.run('roles.update', () =>
      this.db
        .update(schema.roles)
        .set({
          name: sql`CASE WHEN ${schema.roles.isSystem} THEN ${schema.roles.name} ELSE ${r.name} END`,
          description: r.description,
        })
        .where(eq(schema.roles.id, r.id)),
    );
  }
  async countUsers(roleId: string): Promise<number> {
    const rows = await this.run('roles.countUsers', () =>
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.users)
        .where(eq(schema.users.roleId, roleId)),
    );
    return rows[0]?.n ?? 0;
  }
  async delete(id: string): Promise<void> {
    await this.run('roles.delete', () =>
      this.db.delete(schema.roles).where(eq(schema.roles.id, id)),
    );
  }
}

function rowToRole(r: typeof schema.roles.$inferSelect): Role {
  return RoleSchema.parse({
    id: r.id,
    name: r.name,
    description: r.description,
    is_system: r.isSystem,
  });
}

class PgRolePermissionRepo extends PgRepo implements RolePermissionRepository {
  async permissionsForRole(roleId: string): Promise<Permission[]> {
    const rows = await this.run('rolePermissions.permissionsForRole', () =>
      this.db
        .select({ key: schema.rolePermissions.permissionKey })
        .from(schema.rolePermissions)
        .where(eq(schema.rolePermissions.roleId, roleId)),
    );
    // Re-validate the free-text key column at the boundary (drop any non-enum key).
    return rows.map((r) => Permission.parse(r.key));
  }
  async list(): Promise<{ roleId: string; permissionKey: Permission }[]> {
    const rows = await this.run('rolePermissions.list', () =>
      this.db.select().from(schema.rolePermissions),
    );
    return rows.map((r) => ({
      roleId: r.roleId,
      permissionKey: Permission.parse(r.permissionKey),
    }));
  }
  async setForRole(roleId: string, permissions: Permission[]): Promise<void> {
    // Replace-set: delete the role's grants then insert the new set, in ONE transaction
    // so a reader never sees a half-applied permission set.
    await this.run('rolePermissions.setForRole', () =>
      this.db.transaction(async (tx) => {
        await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
        if (permissions.length > 0) {
          await tx
            .insert(schema.rolePermissions)
            .values(permissions.map((permissionKey) => ({ roleId, permissionKey })));
        }
      }),
    );
  }
}

class PgRefreshTokenRepo extends PgRepo implements RefreshTokenRepository {
  async issue(token: StoredRefresh): Promise<void> {
    const t = StoredRefreshSchema.parse(token); // boundary-validate before write
    await this.run(
      'refreshTokens.issue',
      () => this.db.insert(schema.refreshTokens).values(toRefreshRow(t)),
      false,
    );
  }
  async findByHash(tokenHash: string): Promise<StoredRefresh | null> {
    const rows = await this.run('refreshTokens.findByHash', () =>
      this.db
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, tokenHash))
        .limit(1),
    );
    return rows[0] ? rowToRefresh(rows[0]) : null;
  }
  async rotate(oldId: string, replacement: StoredRefresh): Promise<void> {
    const r = StoredRefreshSchema.parse(replacement);
    // Atomic: stamp the predecessor (revoked_at + replaced_by) and insert the successor
    // in one transaction so there is no window where both are current.
    await this.run('refreshTokens.rotate', () =>
      this.db.transaction(async (tx) => {
        await tx
          .update(schema.refreshTokens)
          .set({ revokedAt: r.issued_at, replacedBy: r.id })
          .where(eq(schema.refreshTokens.id, oldId));
        await tx.insert(schema.refreshTokens).values(toRefreshRow(r));
      }),
    );
  }
  async revokeFamily(familyId: string, at: string): Promise<number> {
    const rows = await this.run('refreshTokens.revokeFamily', () =>
      this.db
        .update(schema.refreshTokens)
        .set({ revokedAt: at })
        .where(
          and(eq(schema.refreshTokens.familyId, familyId), isNull(schema.refreshTokens.revokedAt)),
        )
        .returning({ id: schema.refreshTokens.id }),
    );
    return rows.length;
  }
  async revokeAllForUser(userId: string, at: string): Promise<number> {
    const rows = await this.run('refreshTokens.revokeAllForUser', () =>
      this.db
        .update(schema.refreshTokens)
        .set({ revokedAt: at })
        .where(and(eq(schema.refreshTokens.userId, userId), isNull(schema.refreshTokens.revokedAt)))
        .returning({ id: schema.refreshTokens.id }),
    );
    return rows.length;
  }
  async deleteExpired(now: Date): Promise<number> {
    const rows = await this.run('refreshTokens.deleteExpired', () =>
      this.db
        .delete(schema.refreshTokens)
        .where(lte(schema.refreshTokens.expiresAt, now.toISOString()))
        .returning({ id: schema.refreshTokens.id }),
    );
    return rows.length;
  }
}

function toRefreshRow(t: StoredRefresh): typeof schema.refreshTokens.$inferInsert {
  return {
    id: t.id,
    userId: t.user_id,
    tokenHash: t.token_hash,
    familyId: t.family_id,
    issuedAt: t.issued_at,
    expiresAt: t.expires_at,
    revokedAt: t.revoked_at,
    replacedBy: t.replaced_by,
    userAgent: t.user_agent,
    ip: t.ip,
  };
}

function rowToRefresh(r: typeof schema.refreshTokens.$inferSelect): StoredRefresh {
  return StoredRefreshSchema.parse({
    id: r.id,
    user_id: r.userId,
    token_hash: r.tokenHash,
    family_id: r.familyId,
    issued_at: isoTimestamp(r.issuedAt),
    expires_at: isoTimestamp(r.expiresAt),
    revoked_at: isoTimestampOrNull(r.revokedAt),
    replaced_by: r.replacedBy,
    user_agent: r.userAgent,
    ip: r.ip,
  });
}

/** The single `auth_meta` row key holding the global permission-version counter. */
const PERM_VERSION_KEY = 'perm_version';

class PgAuthMetaRepo extends PgRepo implements AuthMetaRepository {
  async getPermVersion(): Promise<number> {
    const rows = await this.run('authMeta.getPermVersion', () =>
      this.db
        .select({ value: schema.authMeta.value })
        .from(schema.authMeta)
        .where(eq(schema.authMeta.key, PERM_VERSION_KEY))
        .limit(1),
    );
    return rows[0] ? Number(rows[0].value) : 0;
  }
  async bumpPermVersion(): Promise<number> {
    // Atomic increment via upsert: an existing row's value text is cast to int, +1,
    // back to text; a missing row seeds to 1. Returns the new value.
    const rows = await this.run(
      'authMeta.bumpPermVersion',
      () =>
        this.db
          .insert(schema.authMeta)
          .values({ key: PERM_VERSION_KEY, value: '1' })
          .onConflictDoUpdate({
            target: schema.authMeta.key,
            set: { value: sql`(${schema.authMeta.value}::int + 1)::text` },
          })
          .returning({ value: schema.authMeta.value }),
      false,
    );
    return Number(rows[0]?.value ?? 0);
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
