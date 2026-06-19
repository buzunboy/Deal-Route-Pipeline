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
  ChangeRepository,
  ReviewRepository,
  SourceReviewRepository,
  SubscriptionCatalogRepository,
} from '../../../application/ports/index.js';
import {
  ChangeSchema,
  ReviewRecordSchema,
  SourceReviewRecordSchema,
  SubscriptionCatalogEntrySchema,
  CostSummarySchema,
  eurFromMicros,
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
  SubscriptionCatalogEntry,
} from '../../../domain/index.js';
import type { Logger } from '../../../application/ports/index.js';
import * as schema from './schema.js';
import { dealToRow, rowToDeal } from './mappers.js';
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
  readonly changes: ChangeRepository;
  readonly reviews: ReviewRepository;
  readonly sourceReviews: SourceReviewRepository;
  readonly catalog: SubscriptionCatalogRepository;

  private constructor(
    private readonly pool: pg.Pool,
    db: Db,
    retrier: DbRetrier,
  ) {
    this.sources = new PgSourceRepo(db, retrier);
    this.deals = new PgDealRepo(db, retrier);
    this.crawlRuns = new PgCrawlRunRepo(db, retrier);
    this.evidence = new PgEvidenceRepo(db, retrier);
    this.manualCapture = new PgManualCaptureRepo(db, retrier);
    this.fieldProposals = new PgFieldProposalRepo(db, retrier);
    this.changes = new PgChangeRepo(db, retrier);
    this.reviews = new PgReviewRepo(db, retrier);
    this.sourceReviews = new PgSourceReviewRepo(db, retrier);
    this.catalog = new PgCatalogRepo(db, retrier);
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
    await this.run('sources.upsert', () =>
      this.db
        .insert(schema.sources)
        .values(toSourceRow(s))
        .onConflictDoUpdate({
          target: schema.sources.id,
          set: toSourceRow(s),
        }),
    );
  }
  async getById(id: string): Promise<Source | null> {
    const rows = await this.run('sources.getById', () =>
      this.db.select().from(schema.sources).where(eq(schema.sources.id, id)).limit(1),
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
        this.db
          .select({
            sourceId: schema.crawlRuns.sourceId,
            micros: microSumExpr,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.crawlRuns)
          .where(where)
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
    return rows.map((r) => ({
      id: r.id,
      source_id: r.sourceId,
      source_url: r.sourceUrl,
      reason: r.reason as ManualCaptureTask['reason'],
      created_at: r.createdAt,
      status: r.status as ManualCaptureTask['status'],
      note: r.note,
    }));
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
    return rows.map((r) => ({
      id: r.id,
      suggested_key: r.suggestedKey,
      label: r.label,
      rationale: r.rationale,
      example_quote: r.exampleQuote,
      count: r.count,
      status: r.status as FieldProposalRecord['status'],
      first_seen_at: r.firstSeenAt,
      last_seen_at: r.lastSeenAt,
    }));
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
    detected_at: r.detectedAt,
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
    return rows.map((r) =>
      ReviewRecordSchema.parse({
        id: r.id,
        deal_id: r.dealId,
        action: r.action,
        approver: r.approver,
        reason: r.reason,
        decided_at: r.decidedAt,
      }),
    );
  }
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
        decided_at: r.decidedAt,
      }),
    );
  }
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
    last_seen: r.lastSeen,
    next_due: r.nextDue,
  };
}
function toRunRow(r: CrawlRun): typeof schema.crawlRuns.$inferInsert {
  return {
    id: r.id,
    sourceId: r.source_id,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    candidatesProduced: r.candidates_produced,
    costEur: r.cost_eur,
    error: r.error,
  };
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
    captured_at: r.capturedAt,
    content_hash: r.contentHash,
  };
}

// drizzle helper to express `count = count + 1` without a raw string everywhere.
function sqlIncrement() {
  return sql`${schema.fieldProposals.count} + 1`;
}
