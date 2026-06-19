import { z } from 'zod';

export const CrawlRunStatus = z.enum(['running', 'succeeded', 'failed', 'skipped']);
export type CrawlRunStatus = z.infer<typeof CrawlRunStatus>;

/**
 * Which lane produced a run — drives the per-lane run ledger + cost breakdown.
 * `monitor` is intentionally NOT a kind: a monitor pass makes no LLM call (its
 * diff is a hash compare) and any re-crawl it triggers is a separate `crawl` run
 * with its own row, so a monitor row would always be zero-cost noise. Monitor's
 * structured per-pass outcome already lives, richer, in the `changes` table.
 */
export const CrawlRunKind = z.enum(['crawl', 'discover', 'ingest']);
export type CrawlRunKind = z.infer<typeof CrawlRunKind>;

/**
 * Why a capped run stopped. Lane-A crawls have no caps loop and leave this null;
 * the bounded Lane-B/agentic lanes record which cap (or clean completion) ended
 * the run. `daily_budget_cap` is the aggregate €/day guard (Pre-C-3), distinct
 * from the per-run `cost_cap`.
 */
export const CrawlRunStoppedReason = z.enum([
  'completed',
  'page_cap',
  'item_cap',
  'time_cap',
  'cost_cap',
  'daily_budget_cap',
  'error',
]);
export type CrawlRunStoppedReason = z.infer<typeof CrawlRunStoppedReason>;

/** Why a page was routed to manual capture instead of extracted. */
export const ManualCaptureReason = z.enum([
  'login_required',
  'captcha',
  'anti_bot_blocked',
  'fetch_failed',
]);
export type ManualCaptureReason = z.infer<typeof ManualCaptureReason>;

/**
 * A logged crawl attempt for one source. Every run is recorded with context so a
 * failed source/run never crashes the batch and is auditable (`architecture.md`:
 * resilience). Cost is logged per run (guardrails).
 */
export const CrawlRunSchema = z.object({
  id: z.string().uuid(),
  /** Null for Lane-B runs (discover/ingest crawl URLs with no `sources` row). */
  source_id: z.string().uuid().nullable(),
  /** Lane that produced this run; defaults to 'crawl' for backward-compat. */
  run_kind: CrawlRunKind.default('crawl'),
  status: CrawlRunStatus,
  started_at: z.string().min(1),
  finished_at: z.string().nullable().default(null),
  candidates_produced: z.number().int().nonnegative().default(0),
  /** Novel source domains proposed this run (Lane B); 0 elsewhere. */
  proposals_produced: z.number().int().nonnegative().default(0),
  /** Cost of LLM/agent calls in this run, in EUR. */
  cost_eur: z.number().nonnegative().default(0),
  /** Which cap (or clean completion) ended a bounded run; null for Lane A. */
  stopped_reason: CrawlRunStoppedReason.nullable().default(null),
  error: z.string().nullable().default(null),
});
export type CrawlRun = z.infer<typeof CrawlRunSchema>;

/**
 * A task for a human to capture a login-gated / blocked offer by hand. Such
 * offers are NEVER silently dropped (acceptance criterion) and NEVER auto-logged
 * into (public-only v1).
 */
export const ManualCaptureTaskSchema = z.object({
  id: z.string().uuid(),
  /** Registered source this came from, or null for a discovery-origin task (Lane B
   *  hits a blocked page on a URL that has no `sources` row yet). */
  source_id: z.string().uuid().nullable(),
  source_url: z.string().url(),
  reason: ManualCaptureReason,
  created_at: z.string().min(1),
  status: z.enum(['open', 'done', 'skipped']).default('open'),
  note: z.string().nullable().default(null),
});
export type ManualCaptureTask = z.infer<typeof ManualCaptureTaskSchema>;
