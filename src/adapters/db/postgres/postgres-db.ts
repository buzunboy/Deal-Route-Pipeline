import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, ne, lte, or, isNull, desc } from 'drizzle-orm';
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
} from '../../../application/ports/index.js';
import type {
  Source,
  DealRecord,
  CrawlRun,
  Evidence,
  ManualCaptureTask,
  FieldProposalRecord,
  Change,
  DealStatus,
} from '../../../domain/index.js';
import * as schema from './schema.js';
import { dealToRow, rowToDeal } from './mappers.js';
import { newId } from '../../../application/shared/id.js';

type Db = NodePgDatabase<typeof schema>;

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

  private constructor(
    private readonly pool: pg.Pool,
    db: Db,
  ) {
    this.sources = new PgSourceRepo(db);
    this.deals = new PgDealRepo(db);
    this.crawlRuns = new PgCrawlRunRepo(db);
    this.evidence = new PgEvidenceRepo(db);
    this.manualCapture = new PgManualCaptureRepo(db);
    this.fieldProposals = new PgFieldProposalRepo(db);
    this.changes = new PgChangeRepo(db);
  }

  static connect(connectionString: string): PostgresDb {
    const pool = new pg.Pool({ connectionString });
    return new PostgresDb(pool, drizzle(pool, { schema }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgSourceRepo implements SourceRepository {
  constructor(private readonly db: Db) {}
  async upsert(s: Source): Promise<void> {
    await this.db.insert(schema.sources).values(toSourceRow(s)).onConflictDoUpdate({
      target: schema.sources.id,
      set: toSourceRow(s),
    });
  }
  async getById(id: string): Promise<Source | null> {
    const rows = await this.db.select().from(schema.sources).where(eq(schema.sources.id, id)).limit(1);
    return rows[0] ? fromSourceRow(rows[0]) : null;
  }
  async listDue(now: Date, limit: number): Promise<Source[]> {
    const rows = await this.db
      .select()
      .from(schema.sources)
      .where(
        and(
          eq(schema.sources.status, 'active'),
          or(isNull(schema.sources.nextDue), lte(schema.sources.nextDue, now.toISOString())),
        ),
      )
      .limit(limit);
    return rows.map(fromSourceRow);
  }
  async listByStatus(status: Source['status']): Promise<Source[]> {
    const rows = await this.db.select().from(schema.sources).where(eq(schema.sources.status, status));
    return rows.map(fromSourceRow);
  }
  async update(s: Source): Promise<void> {
    await this.db.update(schema.sources).set(toSourceRow(s)).where(eq(schema.sources.id, s.id));
  }
}

class PgDealRepo implements DealRepository {
  constructor(private readonly db: Db) {}
  async insert(d: DealRecord): Promise<void> {
    await this.db.insert(schema.deals).values(dealToRow(d));
  }
  async getById(id: string): Promise<DealRecord | null> {
    const rows = await this.db.select().from(schema.deals).where(eq(schema.deals.id, id)).limit(1);
    return rows[0] ? rowToDeal(rows[0]) : null;
  }
  async listByStatus(status: DealStatus, limit: number): Promise<DealRecord[]> {
    const rows = await this.db.select().from(schema.deals).where(eq(schema.deals.status, status)).limit(limit);
    return rows.map(rowToDeal);
  }
  async findByDedupeKey(key: string): Promise<DealRecord | null> {
    // Push the active-row predicate into SQL so a key with many rejected rows
    // can't page the active one out of a JS-side filter.
    const rows = await this.db
      .select()
      .from(schema.deals)
      .where(and(eq(schema.deals.dedupeKey, key), ne(schema.deals.status, 'rejected')))
      .orderBy(desc(schema.deals.confidence))
      .limit(1);
    return rows[0] ? rowToDeal(rows[0]) : null;
  }
  async updateStatus(
    id: string,
    status: DealStatus,
    verifiedBy: string | null,
    verifiedAt: string | null,
  ): Promise<void> {
    await this.db
      .update(schema.deals)
      .set({ status, verifiedBy, verifiedAt })
      .where(eq(schema.deals.id, id));
  }
  async update(d: DealRecord): Promise<void> {
    await this.db.update(schema.deals).set(dealToRow(d)).where(eq(schema.deals.id, d.id));
  }
}

class PgCrawlRunRepo implements CrawlRunRepository {
  constructor(private readonly db: Db) {}
  async insert(r: CrawlRun): Promise<void> {
    await this.db.insert(schema.crawlRuns).values(toRunRow(r));
  }
  async update(r: CrawlRun): Promise<void> {
    await this.db.update(schema.crawlRuns).set(toRunRow(r)).where(eq(schema.crawlRuns.id, r.id));
  }
}

class PgEvidenceRepo implements EvidenceRepository {
  constructor(private readonly db: Db) {}
  async insert(e: Evidence): Promise<void> {
    await this.db.insert(schema.evidence).values(toEvidenceRow(e));
  }
  async getById(id: string): Promise<Evidence | null> {
    const rows = await this.db.select().from(schema.evidence).where(eq(schema.evidence.id, id)).limit(1);
    return rows[0] ? fromEvidenceRow(rows[0]) : null;
  }
}

class PgManualCaptureRepo implements ManualCaptureRepository {
  constructor(private readonly db: Db) {}
  async insert(t: ManualCaptureTask): Promise<void> {
    await this.db.insert(schema.manualCaptureTasks).values({ ...t, sourceId: t.source_id, sourceUrl: t.source_url, createdAt: t.created_at });
  }
  async listOpen(limit: number): Promise<ManualCaptureTask[]> {
    const rows = await this.db
      .select()
      .from(schema.manualCaptureTasks)
      .where(eq(schema.manualCaptureTasks.status, 'open'))
      .limit(limit);
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

class PgFieldProposalRepo implements FieldProposalRepository {
  constructor(private readonly db: Db) {}
  async upsertAndCount(
    p: Omit<FieldProposalRecord, 'id' | 'count' | 'status'>,
  ): Promise<void> {
    await this.db
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
      });
  }
  async listOpen(limit: number): Promise<FieldProposalRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.fieldProposals)
      .where(eq(schema.fieldProposals.status, 'open'))
      .orderBy(desc(schema.fieldProposals.count))
      .limit(limit);
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

class PgChangeRepo implements ChangeRepository {
  constructor(private readonly db: Db) {}
  async insert(c: Change): Promise<void> {
    await this.db.insert(schema.changes).values({
      id: c.id,
      dealId: c.deal_id,
      sourceId: c.source_id,
      kind: c.kind,
      previousHash: c.previous_hash,
      currentHash: c.current_hash,
      detectedAt: c.detected_at,
    });
  }
}

// ── row mappers (small, table-local) ─────────────────────────────────────────

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
import { sql } from 'drizzle-orm';
function sqlIncrement() {
  return sql`${schema.fieldProposals.count} + 1`;
}
