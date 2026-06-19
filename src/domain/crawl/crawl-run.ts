import { z } from 'zod';

export const CrawlRunStatus = z.enum(['running', 'succeeded', 'failed', 'skipped']);
export type CrawlRunStatus = z.infer<typeof CrawlRunStatus>;

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
  source_id: z.string().uuid(),
  status: CrawlRunStatus,
  started_at: z.string().min(1),
  finished_at: z.string().nullable().default(null),
  candidates_produced: z.number().int().nonnegative().default(0),
  /** Cost of LLM/agent calls in this run, in EUR. */
  cost_eur: z.number().nonnegative().default(0),
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
  source_id: z.string().uuid(),
  source_url: z.string().url(),
  reason: ManualCaptureReason,
  created_at: z.string().min(1),
  status: z.enum(['open', 'done', 'skipped']).default('open'),
  note: z.string().nullable().default(null),
});
export type ManualCaptureTask = z.infer<typeof ManualCaptureTaskSchema>;
