/**
 * Queue port — enqueue + handle named jobs. pg-boss (Postgres-backed) is the
 * default adapter; the in-memory fake drives tests. Jobs are idempotent and
 * retried by the adapter (`architecture.md`: resilience).
 */
export interface Job<T> {
  name: string;
  data: T;
}

export type JobHandler<T> = (data: T) => Promise<void>;

export interface Queue {
  /** Enqueue a job by name. */
  publish<T>(name: string, data: T): Promise<void>;
  /** Register a handler for a named job type. */
  subscribe<T>(name: string, handler: JobHandler<T>): Promise<void>;
  /** Start processing (no-op for the in-memory fake until a job is published). */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Canonical job names (avoids stringly-typed drift across producers/consumers). */
export const JobNames = {
  CrawlSource: 'crawl-source',
  MonitorSource: 'monitor-source',
  Discover: 'discover',
} as const;
