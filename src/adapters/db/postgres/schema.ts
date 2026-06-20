import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema for the DealRoute pipeline (Postgres). Mirrors the data model in
 * the handoff. Typed-core eligibility/validity flags are columns; the open
 * `conditions`/`attributes`/grounding/proposals live in JSONB — extensible
 * without migrating existing rows (`schema_version` allows later re-parsing).
 */

export const subscriptionCatalog = pgTable('subscription_catalog', {
  service: text('service').primaryKey(),
  category: text('category').notNull(),
  providerUrl: text('provider_url').notNull(),
  country: text('country').notNull(),
});

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey(),
    url: text('url').notNull(),
    type: text('type').notNull(),
    tier: integer('tier').notNull(),
    country: text('country').notNull(),
    subscriptionService: text('subscription_service'),
    cadenceDays: integer('cadence_days').notNull(),
    reliabilityScore: doublePrecision('reliability_score').notNull(),
    status: text('status').notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true, mode: 'string' }),
    nextDue: timestamp('next_due', { withTimezone: true, mode: 'string' }),
    // The post-redirect URL this source resolves to (= a deal's source_url), set on
    // the first successful crawl/monitor pass. Nullable; monitor matches its
    // source-scoped expiry/baseline lookups on resolved_url ?? url (Prereq A).
    resolvedUrl: text('resolved_url'),
  },
  (t) => ({
    dueIdx: index('sources_due_idx').on(t.status, t.nextDue),
  }),
);

export const evidence = pgTable('evidence', {
  id: uuid('id').primaryKey(),
  sourceUrl: text('source_url').notNull(),
  screenshotRef: text('screenshot_ref').notNull(),
  htmlRef: text('html_ref').notNull(),
  termsRef: text('terms_ref').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'string' }).notNull(),
  contentHash: text('content_hash').notNull(),
});

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
    service: text('service').notNull(),
    routeType: text('route_type').notNull(),
    provider: text('provider').notNull(),
    headline: text('headline').notNull(),
    priceAmount: doublePrecision('price_amount').notNull(),
    priceCurrency: text('price_currency').notNull(),
    priceBilling: text('price_billing').notNull(),
    // For billing='prepaid' only: the page-stated term the up-front amount covers
    // (months). Nullable — absent/not-applicable for other billing modes.
    pricePrepaidMonths: integer('price_prepaid_months'),
    trueCostMonthly: doublePrecision('true_cost_monthly').notNull(),
    country: text('country').notNull(),
    // Typed-core eligibility flags (nullable = unknown).
    newCustomerOnly: boolean('new_customer_only'),
    residencyKyc: boolean('residency_kyc'),
    planTierRequired: text('plan_tier_required'),
    minSpend: doublePrecision('min_spend'),
    stackable: boolean('stackable'),
    // Typed-core validity.
    validityStart: text('validity_start'),
    validityEnd: text('validity_end'),
    recheckDays: integer('recheck_days').notNull(),
    // Open extension areas + grounding + proposals.
    eligibilityConditions: jsonb('eligibility_conditions').notNull(),
    validityConditions: jsonb('validity_conditions').notNull(),
    includedItems: jsonb('included_items').notNull(),
    attributes: jsonb('attributes').notNull(),
    rawConditionsText: text('raw_conditions_text').notNull(),
    grounding: jsonb('grounding').notNull(),
    fieldProposals: jsonb('field_proposals').notNull(),
    unmappedConditions: boolean('unmapped_conditions').notNull(),
    // Identity, evidence, trust.
    sourceUrl: text('source_url').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status').notNull(),
    verifiedBy: text('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
    // EU-Omnibus disclosure at publish (Step 2). `affiliate_disclosure` defaults true
    // (over-disclose); `published_at` is the publish instant, distinct from verified_at.
    affiliateDisclosure: boolean('affiliate_disclosure').notNull().default(true),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => ({
    statusIdx: index('deals_status_idx').on(t.status),
    dedupeIdx: index('deals_dedupe_idx').on(t.dedupeKey),
    sourceUrlIdx: index('deals_source_url_idx').on(t.sourceUrl, t.status),
    // Serves the public read feed (GET /v1/deals): status='published' is always
    // the leading predicate, then country/service are the common filters. Keeps
    // the filtered+sorted published query off a full table scan as deals grow.
    publishedIdx: index('deals_published_idx').on(t.status, t.country, t.service),
    // One candidate per (route, evidence bundle): blocks the read-then-write race
    // where two concurrent crawls of the same offer both insert. A content change
    // produces a NEW evidence id, so the legitimate candidate+in_review pair for a
    // route still coexists; only true duplicates from the same capture collide.
    dedupeEvidenceUnique: uniqueIndex('deals_dedupe_evidence_unique').on(t.dedupeKey, t.evidenceId),
  }),
);

export const crawlRuns = pgTable(
  'crawl_runs',
  {
    id: uuid('id').primaryKey(),
    // Nullable: Lane-B runs (discover/ingest) crawl arbitrary URLs with no
    // `sources` row. Lane-A always sets it. Cost aggregation buckets null-source
    // runs under a stable sentinel (see CostSummary).
    sourceId: uuid('source_id'),
    // Which lane produced this run: 'crawl' (Lane A) | 'discover' | 'ingest' |
    // 'discover_broad' (Tier-4 agentic). Free text — new lanes widen CrawlRunKind
    // with no migration. Lets the run ledger + cost stats break down by lane.
    // (Monitor is deliberately not a kind — it makes no LLM call; see CrawlRunKind.)
    runKind: text('run_kind').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
    candidatesProduced: integer('candidates_produced').notNull(),
    // Novel source domains proposed this run (Lane B); 0 for Lane A / monitor.
    proposalsProduced: integer('proposals_produced').notNull().default(0),
    costEur: doublePrecision('cost_eur').notNull(),
    // Why a capped (Lane-B/agentic) run stopped; null for Lane A (no caps loop).
    stoppedReason: text('stopped_reason'),
    error: text('error'),
  },
  // costSummary + the daily-budget guard filter/group by started_at; a btree serves
  // the window scan, the per-day grouping, and the spent-since-midnight sum.
  (t) => ({
    startedAtIdx: index('crawl_runs_started_at_idx').on(t.startedAt),
  }),
);

export const manualCaptureTasks = pgTable('manual_capture_tasks', {
  id: uuid('id').primaryKey(),
  // Nullable: discovery-origin tasks reference a URL with no registered source row.
  sourceId: uuid('source_id'),
  sourceUrl: text('source_url').notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  status: text('status').notNull(),
  note: text('note'),
});

export const conditionVocabulary = pgTable('condition_vocabulary', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  aliases: jsonb('aliases').notNull(),
  version: integer('version').notNull(),
});

export const fieldProposals = pgTable('field_proposals', {
  id: uuid('id').primaryKey(),
  suggestedKey: text('suggested_key').notNull().unique(),
  label: text('label').notNull(),
  rationale: text('rationale').notNull(),
  exampleQuote: text('example_quote').notNull(),
  count: integer('count').notNull(),
  status: text('status').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'string' }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const changes = pgTable('changes', {
  id: uuid('id').primaryKey(),
  dealId: uuid('deal_id'),
  sourceId: uuid('source_id').notNull(),
  kind: text('kind').notNull(),
  previousHash: text('previous_hash'),
  currentHash: text('current_hash'),
  detectedAt: timestamp('detected_at', { withTimezone: true, mode: 'string' }).notNull(),
});

// Append-only audit log of human review decisions (who/what/when/why).
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey(),
    dealId: uuid('deal_id').notNull(),
    action: text('action').notNull(),
    approver: text('approver').notNull(),
    reason: text('reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  // The sole access path is the deal-scoped, time-ordered history (listForDeal).
  (t) => ({ dealIdx: index('reviews_deal_idx').on(t.dealId, t.decidedAt) }),
);

// Append-only audit log of source-promotion decisions (promote/reject a proposed source).
export const sourceReviews = pgTable(
  'source_reviews',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id').notNull(),
    action: text('action').notNull(),
    approver: text('approver').notNull(),
    reason: text('reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => ({ sourceIdx: index('source_reviews_source_idx').on(t.sourceId, t.decidedAt) }),
);
